/**
 * Appwrite Function: court-assignment
 *
 * Single source of truth for "which queued/ready game gets which free court",
 * including dynamic singles random-rounders game generation. Runs under a
 * per-tournament lock (court_assignment_locks collection) so concurrent
 * clients can no longer race to assign the same court to two games.
 *
 * Action: reconcile
 * Body: { tournamentId: string, session: string }
 *
 * Required Environment Variables:
 * - DATABASE_ID, GAMES_COLLECTION_ID, TOURNAMENTS_COLLECTION_ID,
 *   ENTRIES_COLLECTION_ID, LOCKS_COLLECTION_ID
 */

import { Client, Databases, Account, Query, ID } from 'node-appwrite';

const DATABASE_ID = process.env.DATABASE_ID;
const GAMES_COLLECTION_ID = process.env.GAMES_COLLECTION_ID;
const TOURNAMENTS_COLLECTION_ID = process.env.TOURNAMENTS_COLLECTION_ID;
const ENTRIES_COLLECTION_ID = process.env.ENTRIES_COLLECTION_ID;
const LOCKS_COLLECTION_ID = process.env.LOCKS_COLLECTION_ID;

const REQUIRED_ENV_VARS = {
  DATABASE_ID,
  GAMES_COLLECTION_ID,
  TOURNAMENTS_COLLECTION_ID,
  ENTRIES_COLLECTION_ID,
  LOCKS_COLLECTION_ID,
};

// Function timeout is 30s — treat a lock older than this as abandoned (crashed execution).
const LOCK_STALE_MS = 25000;
const LOCK_RETRY_DELAY_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findMissingEnvVars() {
  return Object.entries(REQUIRED_ENV_VARS)
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function requireSessionUser(endpoint, projectId, session) {
  if (!session) {
    const err = new Error('Unauthorized: missing session');
    err.status = 401;
    throw err;
  }
  const client = new Client()
    .setEndpoint(endpoint)
    .setProject(projectId)
    .setSession(session);
  try {
    return await new Account(client).get();
  } catch {
    const err = new Error('Unauthorized: invalid or expired session');
    err.status = 401;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Locking — createDocument's ID uniqueness IS the lock (409 = already locked)
// ---------------------------------------------------------------------------

async function acquireLock(databases, tournamentId, executionId, log) {
  try {
    await databases.createDocument({
      databaseId: DATABASE_ID,
      collectionId: LOCKS_COLLECTION_ID,
      documentId: tournamentId,
      data: {
        locked_at: new Date().toISOString(),
        execution_id: executionId,
      },
    });
    return true;
  } catch (err) {
    if (err?.code !== 409) throw err;

    // Lock already held — check whether it's abandoned (crashed execution).
    try {
      const existing = await databases.getDocument({
        databaseId: DATABASE_ID,
        collectionId: LOCKS_COLLECTION_ID,
        documentId: tournamentId,
      });
      const age = Date.now() - new Date(existing.locked_at).getTime();
      if (age <= LOCK_STALE_MS) return false;

      log(
        `[lock] stale lock for ${tournamentId} (age ${age}ms) — forcing unlock`
      );
      await databases.deleteDocument({
        databaseId: DATABASE_ID,
        collectionId: LOCKS_COLLECTION_ID,
        documentId: tournamentId,
      });
      await databases.createDocument({
        databaseId: DATABASE_ID,
        collectionId: LOCKS_COLLECTION_ID,
        documentId: tournamentId,
        data: {
          locked_at: new Date().toISOString(),
          execution_id: executionId,
        },
      });
      return true;
    } catch {
      // Someone else won the race to recover the stale lock — treat as locked.
      return false;
    }
  }
}

async function releaseLock(databases, tournamentId, log) {
  try {
    await databases.deleteDocument({
      databaseId: DATABASE_ID,
      collectionId: LOCKS_COLLECTION_ID,
      documentId: tournamentId,
    });
  } catch (err) {
    log(`[lock] failed to release lock for ${tournamentId}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Double-elimination losers-bracket balance (ported from doubleElimBalance.ts)
// ---------------------------------------------------------------------------

function getDoubleElimBracketType(game) {
  const pos = game.bracket_position || '';
  if (pos.startsWith('WB-')) return 'WB';
  if (pos.startsWith('LB-')) return 'LB';
  if (pos.startsWith('GF-')) return 'GF';
  return null;
}

function getBracketRound(game) {
  const pos = game.bracket_position || '';
  const match = pos.match(/^[A-Z]+-R(\d+)-M\d+$/);
  if (match) return parseInt(match[1], 10);
  return game.round || 0;
}

function isReadyQueuedGame(game) {
  return (
    game.status === 'queued' &&
    !game.is_bye &&
    !game.court &&
    !!game.team1_player1 &&
    !!game.team2_player1
  );
}

function shouldPrioritizeLosersBracket(games) {
  let wbDepth = 0;
  let lbDepth = 0;
  let wbReady = 0;
  let lbReady = 0;

  for (const game of games) {
    const bracketType = getDoubleElimBracketType(game);
    if (!bracketType) continue;

    if (game.status === 'complete') {
      const round = getBracketRound(game);
      if (bracketType === 'WB') wbDepth = Math.max(wbDepth, round);
      if (bracketType === 'LB') lbDepth = Math.max(lbDepth, round);
    }

    if (isReadyQueuedGame(game)) {
      if (bracketType === 'WB') wbReady += 1;
      if (bracketType === 'LB') lbReady += 1;
    }
  }

  const gap = Math.max(0, wbDepth - lbDepth);
  return gap >= 2 && wbReady > 0 && lbReady > 0;
}

// ---------------------------------------------------------------------------
// Elimination (Bracket) — ported from BracketCourtAssignment.ts
// ---------------------------------------------------------------------------

function isFinalsGame(game) {
  const pos = game.bracket_position || '';
  return pos === 'Finals' || pos.includes('Finals') || pos.startsWith('GF-');
}

function isConsolationGame(game) {
  const pos = game.bracket_position || '';
  return (
    pos.includes('3rd') ||
    pos.includes('4th') ||
    pos.includes('consolation') ||
    pos.includes('Consolation') ||
    pos.includes('third') ||
    pos.includes('Fourth') ||
    (pos.startsWith('LB-') && !game.feeds_to)
  );
}

function bothTeamsFilled(game) {
  const team1Ready =
    game.team1_player1 !== null && game.team1_player1 !== undefined;
  const team2Ready =
    game.team2_player1 !== null && game.team2_player1 !== undefined;
  if (game.is_doubles) {
    return (
      team1Ready &&
      game.team1_player2 !== null &&
      game.team1_player2 !== undefined &&
      team2Ready &&
      game.team2_player2 !== null &&
      game.team2_player2 !== undefined
    );
  }
  return team1Ready && team2Ready;
}

function sortEliminationCandidates(games, prioritizeLosersBracket) {
  return [...games].sort((a, b) => {
    if (prioritizeLosersBracket) {
      const aIsLb = getDoubleElimBracketType(a) === 'LB';
      const bIsLb = getDoubleElimBracketType(b) === 'LB';
      if (aIsLb !== bIsLb) return aIsLb ? -1 : 1;
    }

    if (a.round !== b.round) return (a.round || 0) - (b.round || 0);

    const aIsFinals = isFinalsGame(a);
    const bIsFinals = isFinalsGame(b);
    const aIsConsolation = isConsolationGame(a);
    const bIsConsolation = isConsolationGame(b);

    if (aIsFinals && !bIsFinals) return 1;
    if (!aIsFinals && bIsFinals) return -1;
    if (aIsConsolation && !bIsConsolation) return -1;
    if (!aIsConsolation && bIsConsolation) return 1;

    const aReady = a.ready_at || a.$createdAt || '';
    const bReady = b.ready_at || b.$createdAt || '';
    if (aReady !== bReady) return aReady.localeCompare(bReady);

    return (a.bracket_position || '').localeCompare(b.bracket_position || '');
  });
}

// ---------------------------------------------------------------------------
// Random/switch/blind-draw rounders dynamic generation (singles only) —
// ported from RandomRoundersCourtAssignment.generateAndAssignNextGame()
// ---------------------------------------------------------------------------

function entryUserId(entry) {
  return typeof entry.user === 'string' ? entry.user : entry.user?.$id;
}

function buildActivePlayersSet(games) {
  const active = new Set();
  for (const game of games) {
    if (game.team1_player1) active.add(game.team1_player1);
    if (game.team1_player2) active.add(game.team1_player2);
    if (game.team2_player1) active.add(game.team2_player1);
    if (game.team2_player2) active.add(game.team2_player2);
  }
  return active;
}

function findBestPair(players, gamesPlayed, recentOpponents) {
  let best = null;
  let lowest = Infinity;
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const userId1 = entryUserId(players[i]);
      const userId2 = entryUserId(players[j]);
      if (recentOpponents?.get(userId1)?.has(userId2)) continue;
      const total =
        (gamesPlayed.get(userId1) || 0) + (gamesPlayed.get(userId2) || 0);
      if (total < lowest) {
        lowest = total;
        best = { player1: players[i], player2: players[j] };
      }
    }
  }
  return best;
}

async function generateNextGame(
  databases,
  tournament,
  court,
  entries,
  existingGames,
  gamesPerPlayer,
  log
) {
  const gamesPlayed = new Map();
  const recentOpponents = new Map();
  for (const entry of entries) {
    const userId = entryUserId(entry);
    gamesPlayed.set(userId, 0);
    recentOpponents.set(userId, new Set());
  }

  // Only count COMPLETED games (avoids inflating counts from queued/pending games).
  const activePlayers = buildActivePlayersSet(
    existingGames.filter(
      (g) =>
        g.status === 'pending' ||
        g.status === 'in_progress' ||
        g.status === 'queued'
    )
  );

  for (const game of existingGames) {
    if (game.status !== 'complete') continue;
    const p1 = game.team1_player1;
    const p2 = game.team2_player1;
    if (p1) {
      gamesPlayed.set(p1, (gamesPlayed.get(p1) || 0) + 1);
      recentOpponents.get(p1)?.add(p2 || '');
    }
    if (p2) {
      gamesPlayed.set(p2, (gamesPlayed.get(p2) || 0) + 1);
      recentOpponents.get(p2)?.add(p1 || '');
    }
  }

  const playersNeedingGames = entries.filter((entry) => {
    const userId = entryUserId(entry);
    return (
      (gamesPlayed.get(userId) || 0) < gamesPerPlayer &&
      !activePlayers.has(userId)
    );
  });

  if (playersNeedingGames.length < 2) return null;

  // Prefer unique matchups; fall back to rematches if no unique pairing exists.
  let bestMatchup = findBestPair(
    playersNeedingGames,
    gamesPlayed,
    recentOpponents
  );
  if (!bestMatchup)
    bestMatchup = findBestPair(playersNeedingGames, gamesPlayed, null);
  if (!bestMatchup) return null;

  const userId1 = entryUserId(bestMatchup.player1);
  const userId2 = entryUserId(bestMatchup.player2);

  const completedCounts = Array.from(gamesPlayed.values());
  const minGamesPlayed =
    completedCounts.length > 0 ? Math.min(...completedCounts) : 0;
  const currentRound = minGamesPlayed + 1;

  const game = await databases.createDocument({
    databaseId: DATABASE_ID,
    collectionId: GAMES_COLLECTION_ID,
    documentId: ID.unique(),
    data: {
      tournament_id: tournament.$id,
      round: currentRound,
      is_doubles: false,
      team1_player1: userId1,
      team2_player1: userId2,
      team1_score: 0,
      team2_score: 0,
      status: 'pending',
      phase: 'rounders',
      court,
    },
  });

  log(
    `[reconcile] generated new game ${game.$id} (round ${currentRound}) -> court ${court}`
  );
  return game;
}

// ---------------------------------------------------------------------------
// Court availability — ported from TournamentManager.getCourtStatus()
// ---------------------------------------------------------------------------

async function computeAvailableCourts(databases, tournament) {
  const courtCount = tournament.courts || 4;
  const inUse = new Set();

  const activeGames = await databases.listDocuments({
    databaseId: DATABASE_ID,
    collectionId: GAMES_COLLECTION_ID,
    queries: [
      Query.equal('tournament_id', tournament.$id),
      Query.notEqual('status', 'complete'),
      Query.notEqual('status', 'cancelled'),
      Query.limit(100),
    ],
  });

  for (const game of activeGames.documents) {
    if (game.court) inUse.add(game.court);
  }

  const available = [];
  for (let i = 1; i <= courtCount; i++) {
    if (!inUse.has(i)) available.push(i);
  }
  return available;
}

function getRoundersType(format) {
  if (format === 'random_rounders') return 'random';
  if (format === 'ranked_rounders') return 'ranked';
  if (format === 'switch_rounders') return 'switch';
  if (format === 'blind_draw') return 'blind_draw';
  if (format === 'blind_draw_ranked') return 'blind_draw_ranked';
  return null;
}

// ---------------------------------------------------------------------------
// Core reconcile — runs once per execution, while the lock is held
// ---------------------------------------------------------------------------

async function reconcile(databases, tournamentId, log) {
  const tournament = await databases.getDocument({
    databaseId: DATABASE_ID,
    collectionId: TOURNAMENTS_COLLECTION_ID,
    documentId: tournamentId,
  });

  if (tournament.tournament_state === 'paused') {
    log(`[reconcile] tournament ${tournamentId} is paused, skipping`);
    return { assigned: 0, reason: 'paused' };
  }

  const phase = tournament.current_phase;
  if (phase !== 'rounders' && phase !== 'elimination') {
    log(
      `[reconcile] tournament ${tournamentId} phase '${phase}' not active, skipping`
    );
    return { assigned: 0, reason: 'inactive_phase' };
  }

  const availableCourts = await computeAvailableCourts(databases, tournament);
  if (availableCourts.length === 0) {
    log(`[reconcile] tournament ${tournamentId}: no available courts`);
    return { assigned: 0, reason: 'no_available_courts' };
  }

  const queuedGamesResponse = await databases.listDocuments({
    databaseId: DATABASE_ID,
    collectionId: GAMES_COLLECTION_ID,
    queries: [
      Query.equal('tournament_id', tournamentId),
      Query.equal('status', 'queued'),
      Query.limit(200),
    ],
  });
  const queuedGames = queuedGamesResponse.documents;
  const queueDepthBefore = queuedGames.length;

  let assignedCount = 0;
  const assignedGameIds = new Set();

  if (phase === 'elimination') {
    let prioritizeLosersBracket = false;
    if (tournament.tournament_type === 'double_elimination') {
      const elimGamesResponse = await databases.listDocuments({
        databaseId: DATABASE_ID,
        collectionId: GAMES_COLLECTION_ID,
        queries: [
          Query.equal('tournament_id', tournamentId),
          Query.equal('phase', 'elimination'),
          Query.limit(200),
        ],
      });
      prioritizeLosersBracket = shouldPrioritizeLosersBracket(
        elimGamesResponse.documents
      );
    }

    const candidates = sortEliminationCandidates(
      queuedGames.filter((g) => !g.is_on_hold && bothTeamsFilled(g)),
      prioritizeLosersBracket
    );

    for (const court of availableCourts) {
      // Finals always goes to centre court (1), 3rd/4th place to court 2, when ready.
      let chosen =
        court === 1
          ? candidates.find(
              (g) => !assignedGameIds.has(g.$id) && isFinalsGame(g)
            )
          : court === 2
            ? candidates.find(
                (g) => !assignedGameIds.has(g.$id) && isConsolationGame(g)
              )
            : null;
      if (!chosen) chosen = candidates.find((g) => !assignedGameIds.has(g.$id));
      if (!chosen) continue;

      await databases.updateDocument({
        databaseId: DATABASE_ID,
        collectionId: GAMES_COLLECTION_ID,
        documentId: chosen.$id,
        data: {
          court,
          status: 'pending',
        },
      });
      assignedGameIds.add(chosen.$id);
      assignedCount++;
      log(
        `[reconcile] elimination: court ${court} -> game ${chosen.$id} (${chosen.bracket_position || `R${chosen.round}`})`
      );
    }
  } else {
    const roundersType = getRoundersType(tournament.tournament_type);
    const isRanked =
      roundersType === 'ranked' || roundersType === 'blind_draw_ranked';

    if (isRanked) {
      const pendingResponse = await databases.listDocuments({
        databaseId: DATABASE_ID,
        collectionId: GAMES_COLLECTION_ID,
        queries: [
          Query.equal('tournament_id', tournamentId),
          Query.equal('status', 'pending'),
          Query.limit(200),
        ],
      });

      const activeRounds = [...queuedGames, ...pendingResponse.documents]
        .map((g) => g.round)
        .filter((round) => round !== undefined && round !== null);

      if (activeRounds.length > 0) {
        const currentRound = Math.min(...activeRounds);
        const candidates = queuedGames
          .filter((g) => g.round === currentRound)
          .sort(
            (a, b) =>
              new Date(a.$createdAt).getTime() -
              new Date(b.$createdAt).getTime()
          );

        for (const court of availableCourts) {
          const chosen = candidates.find((g) => !assignedGameIds.has(g.$id));
          if (!chosen) break;
          await databases.updateDocument({
            databaseId: DATABASE_ID,
            collectionId: GAMES_COLLECTION_ID,
            documentId: chosen.$id,
            data: {
              court,
              status: 'pending',
            },
          });
          assignedGameIds.add(chosen.$id);
          assignedCount++;
          log(
            `[reconcile] ranked rounders: court ${court} -> game ${chosen.$id} (round ${currentRound})`
          );
        }
      }
    } else {
      // random / switch / blind_draw: assign existing ready queued games FIFO first.
      const candidates = [...queuedGames].sort(
        (a, b) =>
          new Date(a.$createdAt).getTime() - new Date(b.$createdAt).getTime()
      );

      for (const court of availableCourts) {
        const chosen = candidates.find((g) => !assignedGameIds.has(g.$id));
        if (!chosen) break;
        await databases.updateDocument({
          databaseId: DATABASE_ID,
          collectionId: GAMES_COLLECTION_ID,
          documentId: chosen.$id,
          data: {
            court,
            status: 'pending',
          },
        });
        assignedGameIds.add(chosen.$id);
        assignedCount++;
        log(
          `[reconcile] rounders (${roundersType}): court ${court} -> game ${chosen.$id}`
        );
      }

      // Dynamic game generation for any courts still free (singles only — doubles
      // team-formation for switch/blind-draw stays client-side, out of scope here).
      const isDoubles =
        tournament.team_type === 'doubles' || tournament.team_type === 'team';
      const stillAvailable = availableCourts.slice(assignedCount);

      if (
        !isDoubles &&
        tournament.rounder_rounds &&
        stillAvailable.length > 0
      ) {
        const entriesResponse = await databases.listDocuments({
          databaseId: DATABASE_ID,
          collectionId: ENTRIES_COLLECTION_ID,
          queries: [
            Query.equal('tournament', tournamentId),
            Query.equal('status', 'checked_in'),
            Query.limit(100),
          ],
        });
        const entries = entriesResponse.documents;

        for (const court of stillAvailable) {
          const gamesResponse = await databases.listDocuments({
            databaseId: DATABASE_ID,
            collectionId: GAMES_COLLECTION_ID,
            queries: [
              Query.equal('tournament_id', tournamentId),
              Query.equal('phase', 'rounders'),
              Query.limit(400),
            ],
          });
          const generated = await generateNextGame(
            databases,
            tournament,
            court,
            entries,
            gamesResponse.documents,
            tournament.rounder_rounds,
            log
          );
          if (!generated) break;
          assignedCount++;
        }
      }
    }
  }

  log(
    `[reconcile] tournament ${tournamentId}: queueDepthBefore=${queueDepthBefore}, assigned=${assignedCount}, availableCourts=${availableCourts.length}`
  );
  return { assigned: assignedCount };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async ({ req, res, log, error }) => {
  const missingEnvVars = findMissingEnvVars();
  if (missingEnvVars.length > 0) {
    error(
      `Missing required environment variable(s): ${missingEnvVars.join(', ')}`
    );
    return res.json(
      {
        success: false,
        error: `Missing required environment variable(s): ${missingEnvVars.join(', ')}`,
      },
      500
    );
  }

  const endpoint = process.env.APPWRITE_FUNCTION_API_ENDPOINT;
  const projectId = process.env.APPWRITE_FUNCTION_PROJECT_ID;
  const apiKey = req.headers['x-appwrite-key'] ?? '';

  let body;
  try {
    body = JSON.parse(req.body || '{}');
  } catch {
    return res.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const { tournamentId, session } = body;
  if (!tournamentId) {
    return res.json({ success: false, error: 'Missing tournamentId' }, 400);
  }

  try {
    await requireSessionUser(endpoint, projectId, session);
  } catch (authErr) {
    return res.json(
      { success: false, error: authErr.message },
      authErr.status || 401
    );
  }

  const client = new Client()
    .setEndpoint(endpoint)
    .setProject(projectId)
    .setKey(apiKey);
  const databases = new Databases(client);
  const executionId = req.headers['x-appwrite-execution-id'] || ID.unique();

  let locked = await acquireLock(databases, tournamentId, executionId, log);
  if (!locked) {
    await sleep(LOCK_RETRY_DELAY_MS);
    locked = await acquireLock(databases, tournamentId, executionId, log);
  }
  if (!locked) {
    log(
      `[lock] conflict: tournament ${tournamentId} is locked by another execution`
    );
    return res.json({ success: false, assigned: 0, reason: 'locked' }, 409);
  }

  const startedAt = Date.now();
  try {
    const result = await reconcile(databases, tournamentId, log);
    return res.json({ success: true, ...result });
  } catch (err) {
    error(`[reconcile] tournament ${tournamentId} failed: ${err.message}`);
    return res.json({ success: false, error: err.message }, 500);
  } finally {
    await releaseLock(databases, tournamentId, log);
    log(
      `[reconcile] tournament ${tournamentId} completed in ${Date.now() - startedAt}ms`
    );
  }
};
