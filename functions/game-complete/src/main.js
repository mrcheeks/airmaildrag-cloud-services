/**
 * Appwrite Function: game-complete
 *
 * Single source of truth for completing a game: marks it complete, advances the
 * winner/loser through the bracket (feeds_to/loser_feeds_to, including BYE-chain
 * recursion; double-elimination additionally routes losers to the losers bracket
 * and handles grand-final resets), recalculates rounders standings, then triggers
 * Elo/stats updates, notifications, and court reassignment. The bracket-critical
 * writes are staged in a single Appwrite Transaction and committed atomically — if
 * any staged write fails, none of them apply, so a mid-cascade failure can no
 * longer leave the bracket half-advanced.
 *
 * Action: complete
 * Body: { gameId: string, winnerId: string, team1Score: number, team2Score: number, session: string }
 *
 * SCOPE: single-elimination, double-elimination, and all 5 rounders formats
 * (random/ranked/switch/blind_draw/blind_draw_ranked) are handled here.
 * All games get individual per-player Elo (doubles: vs opponent team average) and
 * round-based PPR/DPR stats via elo-stats-update. Double-elimination additionally
 * keeps its own legacy games_played/games_won counter on the `users` collection
 * (preserved as-is from the original DoubleEliminationManager, purely additive).
 * NOT handled here (still client-side): dynamic doubles team-formation for
 * continuous-flow rounders (switch_rounders/blind_draw), and phase-transition
 * bracket generation (checkPhaseCompletion's actual elimination-phase kickoff).
 *
 * Required Environment Variables:
 * - DATABASE_ID, GAMES_COLLECTION_ID, TOURNAMENTS_COLLECTION_ID, ENTRIES_COLLECTION_ID,
 *   NOTIFICATIONS_COLLECTION_ID, USERS_COLLECTION_ID, LOCKS_COLLECTION_ID,
 *   ELO_STATS_UPDATE_FUNCTION_ID, COURT_ASSIGNMENT_FUNCTION_ID, SEND_PUSH_FUNCTION_ID
 */

import { Client, TablesDB, Functions, Account, Query, ID } from 'node-appwrite';
import { updateRoundersStandings } from './standings.js';

const DATABASE_ID = process.env.DATABASE_ID;
const GAMES_COLLECTION_ID = process.env.GAMES_COLLECTION_ID;
const TOURNAMENTS_COLLECTION_ID = process.env.TOURNAMENTS_COLLECTION_ID;
const ENTRIES_COLLECTION_ID = process.env.ENTRIES_COLLECTION_ID;
const NOTIFICATIONS_COLLECTION_ID = process.env.NOTIFICATIONS_COLLECTION_ID;
const USERS_COLLECTION_ID = process.env.USERS_COLLECTION_ID;
const LOCKS_COLLECTION_ID = process.env.LOCKS_COLLECTION_ID;
const ELO_STATS_UPDATE_FUNCTION_ID = process.env.ELO_STATS_UPDATE_FUNCTION_ID;
const COURT_ASSIGNMENT_FUNCTION_ID = process.env.COURT_ASSIGNMENT_FUNCTION_ID;
const SEND_PUSH_FUNCTION_ID = process.env.SEND_PUSH_FUNCTION_ID;

const REQUIRED_ENV_VARS = {
  DATABASE_ID,
  GAMES_COLLECTION_ID,
  TOURNAMENTS_COLLECTION_ID,
  ENTRIES_COLLECTION_ID,
  NOTIFICATIONS_COLLECTION_ID,
  USERS_COLLECTION_ID,
  LOCKS_COLLECTION_ID,
  ELO_STATS_UPDATE_FUNCTION_ID,
  COURT_ASSIGNMENT_FUNCTION_ID,
  SEND_PUSH_FUNCTION_ID,
};

// Function timeout is 30s — treat a lock older than this as abandoned (crashed execution).
const LOCK_STALE_MS = 25000;

function findMissingEnvVars() {
  return Object.entries(REQUIRED_ENV_VARS)
    .filter(([, value]) => !value)
    .map(([key]) => key);
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
// Locking — per-game, reject (not retry) on conflict: a second submit for the
// same game is a duplicate, not a near-simultaneous poll like court-assignment.
// ---------------------------------------------------------------------------

async function acquireLock(tablesDB, gameId, executionId, log) {
  try {
    await tablesDB.createRow({
      databaseId: DATABASE_ID,
      tableId: LOCKS_COLLECTION_ID,
      rowId: gameId,
      data: { locked_at: new Date().toISOString(), execution_id: executionId },
    });
    return true;
  } catch (err) {
    if (err?.code !== 409) throw err;

    try {
      const existing = await tablesDB.getRow({
        databaseId: DATABASE_ID,
        tableId: LOCKS_COLLECTION_ID,
        rowId: gameId,
      });
      const age = Date.now() - new Date(existing.locked_at).getTime();
      if (age <= LOCK_STALE_MS) return false;

      log(
        `[lock] stale lock for game ${gameId} (age ${age}ms) — forcing unlock`
      );
      await tablesDB.deleteRow({
        databaseId: DATABASE_ID,
        tableId: LOCKS_COLLECTION_ID,
        rowId: gameId,
      });
      await tablesDB.createRow({
        databaseId: DATABASE_ID,
        tableId: LOCKS_COLLECTION_ID,
        rowId: gameId,
        data: {
          locked_at: new Date().toISOString(),
          execution_id: executionId,
        },
      });
      return true;
    } catch {
      return false;
    }
  }
}

async function releaseLock(tablesDB, gameId, log) {
  try {
    await tablesDB.deleteRow({
      databaseId: DATABASE_ID,
      tableId: LOCKS_COLLECTION_ID,
      rowId: gameId,
    });
  } catch (err) {
    log(`[lock] failed to release lock for game ${gameId}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Bracket advancement — ported from TournamentManager.recordGameResult() /
// isOtherSlotABye() / advanceByeWinnerRecursively()
// ---------------------------------------------------------------------------

function isOtherSlotABye(targetGame, feedingGames, fillingTeam1) {
  const sortedFeeders = [...feedingGames].sort((a, b) =>
    (a.bracket_position || '').localeCompare(b.bracket_position || '')
  );
  const otherFeederIndex = fillingTeam1 ? 1 : 0;
  const otherFeeder = sortedFeeders[otherFeederIndex];
  if (!otherFeeder) return false;

  return Boolean(
    otherFeeder.is_bye &&
    otherFeeder.status === 'complete' &&
    !otherFeeder.team1_player1 &&
    !otherFeeder.team2_player1 &&
    !otherFeeder.winnerId
  );
}

async function advanceByeWinnerRecursively(
  tablesDB,
  transactionId,
  nextGameId,
  winnerPlayer1,
  winnerPlayer2,
  allGames,
  log
) {
  const nextGame = allGames.find((g) => g.$id === nextGameId);
  if (!nextGame) return;

  const feedingGames = allGames.filter((g) => g.feeds_to === nextGameId);
  const fillTeam1 = !nextGame.team1_player1;
  const updates = fillTeam1
    ? { team1_player1: winnerPlayer1, team1_player2: winnerPlayer2 }
    : { team2_player1: winnerPlayer1, team2_player2: winnerPlayer2 };

  const team1HasPlayer =
    nextGame.team1_player1 !== null && nextGame.team1_player1 !== undefined;
  const team2HasPlayer =
    nextGame.team2_player1 !== null && nextGame.team2_player1 !== undefined;
  const otherTeamHasPlayer = fillTeam1 ? team2HasPlayer : team1HasPlayer;
  const otherSlotIsBye = isOtherSlotABye(nextGame, feedingGames, fillTeam1);

  if (otherSlotIsBye && !otherTeamHasPlayer) {
    updates.status = 'complete';
    updates.is_bye = true;
    updates.winnerId = winnerPlayer1;
    updates.team1_score = fillTeam1 ? 21 : 10;
    updates.team2_score = fillTeam1 ? 10 : 21;
    await tablesDB.updateRow({
      databaseId: DATABASE_ID,
      tableId: GAMES_COLLECTION_ID,
      rowId: nextGameId,
      data: updates,
      transactionId,
    });
    log(
      `[game-complete] BYE-chain advanced ${winnerPlayer1} into ${nextGameId}`
    );
    if (nextGame.feeds_to) {
      await advanceByeWinnerRecursively(
        tablesDB,
        transactionId,
        nextGame.feeds_to,
        winnerPlayer1,
        winnerPlayer2,
        allGames,
        log
      );
    }
    return;
  }

  if (otherTeamHasPlayer) {
    updates.ready_at = new Date().toISOString();
  }
  await tablesDB.updateRow({
    databaseId: DATABASE_ID,
    tableId: GAMES_COLLECTION_ID,
    rowId: nextGameId,
    data: updates,
    transactionId,
  });
}

async function advanceWinnerAndLoser(
  tablesDB,
  transactionId,
  game,
  winnerId,
  log
) {
  const winnerIsTeam1 =
    winnerId === game.team1_player1 || winnerId === game.team1_player2;

  const allGamesResponse = await tablesDB.listRows({
    databaseId: DATABASE_ID,
    tableId: GAMES_COLLECTION_ID,
    queries: [
      Query.equal('tournament_id', game.tournament_id),
      Query.equal('phase', 'elimination'),
      Query.limit(500),
    ],
  });
  const allGames = allGamesResponse.rows;

  let nextGameAssigned = false;

  if (game.feeds_to) {
    const nextGame = allGames.find((g) => g.$id === game.feeds_to);
    if (nextGame) {
      const feedingGames = allGames.filter((g) => g.feeds_to === game.feeds_to);
      const fillTeam1 = !nextGame.team1_player1;

      const winnerPlayer1 = winnerIsTeam1
        ? game.team1_player1
        : game.team2_player1;
      const winnerPlayer2 = winnerIsTeam1
        ? game.team1_player2
        : game.team2_player2;

      const team1HasPlayer =
        nextGame.team1_player1 !== null && nextGame.team1_player1 !== undefined;
      const team2HasPlayer =
        nextGame.team2_player1 !== null && nextGame.team2_player1 !== undefined;
      const otherTeamHasPlayer = fillTeam1 ? team2HasPlayer : team1HasPlayer;
      const otherSlotIsBye = isOtherSlotABye(nextGame, feedingGames, fillTeam1);

      // Correctly build the update object per slot (fillTeam1 selects team1 vs team2 fields).
      const updates = fillTeam1
        ? { team1_player1: winnerPlayer1, team1_player2: winnerPlayer2 }
        : { team2_player1: winnerPlayer1, team2_player2: winnerPlayer2 };

      if (otherSlotIsBye && !otherTeamHasPlayer) {
        updates.status = 'complete';
        updates.is_bye = true;
        updates.winnerId = winnerPlayer1;
        await tablesDB.updateRow({
          databaseId: DATABASE_ID,
          tableId: GAMES_COLLECTION_ID,
          rowId: game.feeds_to,
          data: updates,
          transactionId,
        });
        if (nextGame.feeds_to) {
          await advanceByeWinnerRecursively(
            tablesDB,
            transactionId,
            nextGame.feeds_to,
            winnerPlayer1,
            winnerPlayer2,
            allGames,
            log
          );
        }
      } else {
        if (otherTeamHasPlayer) updates.ready_at = new Date().toISOString();
        await tablesDB.updateRow({
          databaseId: DATABASE_ID,
          tableId: GAMES_COLLECTION_ID,
          rowId: game.feeds_to,
          data: updates,
          transactionId,
        });
      }
      nextGameAssigned = true;
      log(
        `[game-complete] advanced winner ${winnerPlayer1} -> game ${game.feeds_to}`
      );
    }
  }

  if (game.loser_feeds_to) {
    const consolationGame = allGames.find((g) => g.$id === game.loser_feeds_to);
    if (consolationGame) {
      const loserPlayer1 = winnerIsTeam1
        ? game.team2_player1
        : game.team1_player1;
      const loserPlayer2 = winnerIsTeam1
        ? game.team2_player2
        : game.team1_player2;

      if (loserPlayer1) {
        const fillTeam1 = !consolationGame.team1_player1;
        const otherHasPlayer = fillTeam1
          ? !!consolationGame.team2_player1
          : !!consolationGame.team1_player1;

        const updates = fillTeam1
          ? { team1_player1: loserPlayer1, team1_player2: loserPlayer2 }
          : { team2_player1: loserPlayer1, team2_player2: loserPlayer2 };
        if (otherHasPlayer) updates.ready_at = new Date().toISOString();

        await tablesDB.updateRow({
          databaseId: DATABASE_ID,
          tableId: GAMES_COLLECTION_ID,
          rowId: game.loser_feeds_to,
          data: updates,
          transactionId,
        });
        log(
          `[game-complete] advanced loser ${loserPlayer1} -> consolation game ${game.loser_feeds_to}`
        );
      }
    }
  }

  return nextGameAssigned;
}

// ---------------------------------------------------------------------------
// Double-elimination bracket advancement — ported from
// DoubleEliminationManager.recordGameResult() and its helpers. NOTE: double-elim
// does NOT use the brackets-manager library for scoring (only for initial bracket
// generation) — it uses the same hand-rolled feeds_to/loser_feeds_to advancement
// pattern as single-elimination, plus WB->LB routing and grand-final reset.
// ---------------------------------------------------------------------------

function isOtherSlotAByeDoubleElim(feedingGames, fillingTeam1) {
  const sorted = [...feedingGames].sort((a, b) =>
    (a.bracket_position || '').localeCompare(b.bracket_position || '')
  );
  const otherFeeder = sorted[fillingTeam1 ? 1 : 0];
  if (!otherFeeder) return false;
  return Boolean(
    otherFeeder.is_bye &&
    otherFeeder.status === 'complete' &&
    !otherFeeder.team1_player1 &&
    !otherFeeder.team2_player1 &&
    !otherFeeder.winnerId
  );
}

function isOtherSlotAByeForLB(targetGame, allGames) {
  const loserFeeders = allGames.filter(
    (g) => g.loser_feeds_to === targetGame.$id
  );
  if (
    loserFeeders.some((g) => g.is_bye && g.status === 'complete' && !g.winnerId)
  )
    return true;

  const winnerFeeders = allGames.filter((g) => g.feeds_to === targetGame.$id);
  if (
    winnerFeeders.some(
      (g) =>
        g.is_bye &&
        g.status === 'complete' &&
        !g.team1_player1 &&
        !g.team2_player1 &&
        !g.winnerId
    )
  ) {
    return true;
  }
  return false;
}

function checkLoserSlotForBye(lbGame, sourceGame, allGames, isTopSlot) {
  const loserFeeders = allGames.filter((g) => g.loser_feeds_to === lbGame.$id);
  if (loserFeeders.some((g) => g.is_bye && g.$id !== sourceGame.$id))
    return true;

  const sourcePos = sourceGame.bracket_position || '';
  const wbR1Match = sourcePos.match(/WB-R1-M(\d+)/);
  if (wbR1Match) {
    const sourceMatchNum = parseInt(wbR1Match[1], 10);
    const siblingNum =
      sourceMatchNum % 2 === 1 ? sourceMatchNum + 1 : sourceMatchNum - 1;
    const siblingPos = `WB-R1-M${siblingNum}`;
    const sibling = allGames.find((g) => g.bracket_position === siblingPos);
    if (sibling?.is_bye) return true;
  }

  const winnerFeeders = allGames.filter((g) => g.feeds_to === lbGame.$id);
  if (
    winnerFeeders.some(
      (g) => g.is_bye && g.status === 'complete' && !g.winnerId
    )
  )
    return true;

  const lbMatch = (lbGame.bracket_position || '').match(/LB-R(\d+)-M(\d+)/);
  if (lbMatch && !isTopSlot) {
    const lbRound = parseInt(lbMatch[1], 10);
    if (lbRound % 2 === 0) {
      const prevLbPos = `LB-R${lbRound - 1}-M${lbMatch[2]}`;
      const prevLbGame = allGames.find((g) => g.bracket_position === prevLbPos);
      if (
        prevLbGame?.is_bye &&
        prevLbGame.status === 'complete' &&
        !prevLbGame.winnerId
      )
        return true;
    }
  }
  return false;
}

function determineSlotFromSource(sourceGame, targetGame, allGames) {
  const sourcePos = sourceGame.bracket_position || '';
  const targetPos = targetGame.bracket_position || '';
  const sourceLb = sourcePos.match(/LB-R(\d+)-M(\d+)/);
  const targetLb = targetPos.match(/LB-R(\d+)-M(\d+)/);

  if (sourceLb && targetLb) {
    const sourceRound = parseInt(sourceLb[1], 10);
    const sourceMatchNum = parseInt(sourceLb[2], 10);
    const targetRound = parseInt(targetLb[1], 10);

    if (sourceRound % 2 === 0 && targetRound % 2 === 1)
      return sourceMatchNum % 2 === 1;
    if (sourceRound % 2 === 1 && targetRound % 2 === 0) return true;
    if (sourceRound % 2 === 1 && targetRound % 2 === 1)
      return sourceMatchNum % 2 === 1;
  }

  const feeders = allGames
    .filter((g) => g.feeds_to === targetGame.$id)
    .sort((a, b) =>
      (a.bracket_position || '').localeCompare(b.bracket_position || '')
    );
  const sourceIndex = feeders.findIndex((g) => g.$id === sourceGame.$id);
  if (sourceIndex !== -1) return sourceIndex === 0;

  return !targetGame.team1_player1;
}

async function advanceDoubleElimPlayerRecursively(
  tablesDB,
  transactionId,
  nextGameId,
  p1,
  p2,
  allGames,
  sourceGame,
  log
) {
  const nextGame = allGames.find((g) => g.$id === nextGameId);
  if (!nextGame) return;

  const team1Has = !!nextGame.team1_player1;
  const team2Has = !!nextGame.team2_player1;
  const fillTeam1 = sourceGame
    ? determineSlotFromSource(sourceGame, nextGame, allGames)
    : !team1Has;

  const isLBGame = (nextGame.bracket_position || '').startsWith('LB-');
  const otherSlotIsBye = isLBGame
    ? isOtherSlotAByeForLB(nextGame, allGames)
    : isOtherSlotAByeDoubleElim(
        allGames.filter((g) => g.feeds_to === nextGameId),
        fillTeam1
      );

  const updates = fillTeam1
    ? { team1_player1: p1, team1_player2: p2 }
    : { team2_player1: p1, team2_player2: p2 };
  const otherHas = fillTeam1 ? team2Has : team1Has;

  if (otherSlotIsBye && !otherHas) {
    updates.status = 'complete';
    updates.is_bye = true;
    updates.winnerId = p1;
    await tablesDB.updateRow({
      databaseId: DATABASE_ID,
      tableId: GAMES_COLLECTION_ID,
      rowId: nextGameId,
      data: updates,
      transactionId,
    });
    log(
      `[game-complete] double-elim BYE-chain advanced ${p1} into ${nextGameId}`
    );
    if (nextGame.feeds_to) {
      await advanceDoubleElimPlayerRecursively(
        tablesDB,
        transactionId,
        nextGame.feeds_to,
        p1,
        p2,
        allGames,
        nextGame,
        log
      );
    }
    return;
  }

  if (otherHas) updates.ready_at = new Date().toISOString();
  await tablesDB.updateRow({
    databaseId: DATABASE_ID,
    tableId: GAMES_COLLECTION_ID,
    rowId: nextGameId,
    data: updates,
    transactionId,
  });
}

async function advanceDoubleElimination(
  tablesDB,
  transactionId,
  game,
  winnerId,
  log
) {
  const winnerIsTeam1 =
    winnerId === game.team1_player1 || winnerId === game.team1_player2;
  const winnerP1 = winnerIsTeam1 ? game.team1_player1 : game.team2_player1;
  const winnerP2 = winnerIsTeam1 ? game.team1_player2 : game.team2_player2;
  const loserP1 = winnerIsTeam1 ? game.team2_player1 : game.team1_player1;
  const loserP2 = winnerIsTeam1 ? game.team2_player2 : game.team1_player2;

  const bracketPos = game.bracket_position || '';
  const isWB = bracketPos.startsWith('WB-');
  const isGF = bracketPos.startsWith('GF-');

  const allGamesResponse = await tablesDB.listRows({
    databaseId: DATABASE_ID,
    tableId: GAMES_COLLECTION_ID,
    queries: [
      Query.equal('tournament_id', game.tournament_id),
      Query.equal('phase', 'elimination'),
      Query.limit(500),
    ],
  });
  const allGames = allGamesResponse.rows;

  let nextGameAssigned = false;

  // Advance winner
  if (game.feeds_to) {
    const nextGame = allGames.find((g) => g.$id === game.feeds_to);
    if (nextGame) {
      const feeders = allGames.filter((g) => g.feeds_to === game.feeds_to);
      const isTopSlot = feeders.findIndex((g) => g.$id === game.$id) === 0;
      const otherSlotIsBye = isOtherSlotAByeDoubleElim(feeders, isTopSlot);
      const otherHas = isTopSlot
        ? !!nextGame.team2_player1
        : !!nextGame.team1_player1;

      const updates = isTopSlot
        ? { team1_player1: winnerP1, team1_player2: winnerP2 }
        : { team2_player1: winnerP1, team2_player2: winnerP2 };

      if (otherSlotIsBye && !otherHas) {
        updates.status = 'complete';
        updates.is_bye = true;
        updates.winnerId = winnerP1;
        await tablesDB.updateRow({
          databaseId: DATABASE_ID,
          tableId: GAMES_COLLECTION_ID,
          rowId: game.feeds_to,
          data: updates,
          transactionId,
        });
        if (nextGame.feeds_to) {
          await advanceDoubleElimPlayerRecursively(
            tablesDB,
            transactionId,
            nextGame.feeds_to,
            winnerP1,
            winnerP2,
            allGames,
            nextGame,
            log
          );
        }
      } else {
        if (otherHas) updates.ready_at = new Date().toISOString();
        await tablesDB.updateRow({
          databaseId: DATABASE_ID,
          tableId: GAMES_COLLECTION_ID,
          rowId: game.feeds_to,
          data: updates,
          transactionId,
        });
      }
      nextGameAssigned = true;
      log(
        `[game-complete] double-elim: advanced winner ${winnerP1} -> ${game.feeds_to}`
      );
    }
  }

  // Drop loser to LB (only from WB)
  if (isWB && loserP1 && game.loser_feeds_to) {
    const lbGame = allGames.find((g) => g.$id === game.loser_feeds_to);
    if (lbGame) {
      const sourcePos = bracketPos;
      const sourceRound = parseInt(
        sourcePos.match(/WB-R(\d+)/)?.[1] || '1',
        10
      );
      const sourceMatchNum = parseInt(
        sourcePos.match(/M(\d+)/)?.[1] || '1',
        10
      );
      const isTopSlot = sourceRound === 1 ? sourceMatchNum % 2 === 1 : false;

      const otherSlotIsBye = checkLoserSlotForBye(
        lbGame,
        game,
        allGames,
        isTopSlot
      );
      const otherHas = isTopSlot
        ? !!lbGame.team2_player1
        : !!lbGame.team1_player1;

      const updates = isTopSlot
        ? { team1_player1: loserP1, team1_player2: loserP2 }
        : { team2_player1: loserP1, team2_player2: loserP2 };

      if (otherSlotIsBye && !otherHas) {
        updates.status = 'complete';
        updates.is_bye = true;
        updates.winnerId = loserP1;
        await tablesDB.updateRow({
          databaseId: DATABASE_ID,
          tableId: GAMES_COLLECTION_ID,
          rowId: game.loser_feeds_to,
          data: updates,
          transactionId,
        });
        if (lbGame.feeds_to) {
          await advanceDoubleElimPlayerRecursively(
            tablesDB,
            transactionId,
            lbGame.feeds_to,
            loserP1,
            loserP2,
            allGames,
            lbGame,
            log
          );
        }
      } else {
        if (otherHas) updates.ready_at = new Date().toISOString();
        await tablesDB.updateRow({
          databaseId: DATABASE_ID,
          tableId: GAMES_COLLECTION_ID,
          rowId: game.loser_feeds_to,
          data: updates,
          transactionId,
        });
      }
      log(
        `[game-complete] double-elim: dropped loser ${loserP1} -> LB ${game.loser_feeds_to}`
      );
    }
  }

  // Grand Finals reset
  if (isGF && bracketPos === 'GF-R1-M1') {
    const resetMatch = allGames.find((g) => g.bracket_position === 'GF-R2-M1');
    if (resetMatch) {
      if (winnerIsTeam1) {
        // WB champ (team1) won — no reset needed.
        await tablesDB.updateRow({
          databaseId: DATABASE_ID,
          tableId: GAMES_COLLECTION_ID,
          rowId: resetMatch.$id,
          data: { status: 'complete', is_bye: true, winnerId },
          transactionId,
        });
        log(
          '[game-complete] double-elim: WB champion won GF-M1, no reset needed'
        );
      } else {
        // LB champ (team2) won GF-M1 — copy both players to the reset match.
        await tablesDB.updateRow({
          databaseId: DATABASE_ID,
          tableId: GAMES_COLLECTION_ID,
          rowId: resetMatch.$id,
          data: {
            team1_player1: game.team1_player1,
            team1_player2: game.team1_player2,
            team2_player1: game.team2_player1,
            team2_player2: game.team2_player2,
            ready_at: new Date().toISOString(),
          },
          transactionId,
        });
        log('[game-complete] double-elim: Grand Finals reset triggered');
      }
    }
  }

  return nextGameAssigned;
}

async function updateDoubleElimUserStats(tablesDB, game, winnerId, log) {
  const playerIds = [
    game.team1_player1,
    game.team1_player2,
    game.team2_player1,
    game.team2_player2,
  ].filter(Boolean);
  const team1Won =
    winnerId === game.team1_player1 || winnerId === game.team1_player2;
  const winnerIds = team1Won
    ? [game.team1_player1, game.team1_player2].filter(Boolean)
    : [game.team2_player1, game.team2_player2].filter(Boolean);

  for (const playerId of playerIds) {
    try {
      const user = await tablesDB.getRow({
        databaseId: DATABASE_ID,
        tableId: USERS_COLLECTION_ID,
        rowId: playerId,
      });
      await tablesDB.updateRow({
        databaseId: DATABASE_ID,
        tableId: USERS_COLLECTION_ID,
        rowId: playerId,
        data: {
          games_played: (user.games_played || 0) + 1,
          games_won:
            (user.games_won || 0) + (winnerIds.includes(playerId) ? 1 : 0),
        },
      });
    } catch (err) {
      log(
        `[game-complete] double-elim: failed to update user stats for ${playerId}: ${err.message}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Notifications — ported from src/lib/api/notification.ts (reused, not reinvented)
// ---------------------------------------------------------------------------

const WIN_MESSAGES = [
  'Bagged and tagged. {score}. Case closed.',
  "Sacked 'em. {score}. They never saw it comin'.",
  'Bag secured. {score}. Another day, another W.',
  "That's how it's done. {score}. Clean.",
];
const WIN_PUSH_TITLES = [
  'Bagged and tagged! 🏆',
  "Sacked 'em! 🌽",
  'Bag secured. W.',
  'Clean game. You win.',
];
const LOSS_MESSAGES = [
  'Rough one. {score}. Shake it off and come back swinging.',
  'They got you this time. {score}. Revenge is a dish best served next round.',
  "{score}. The bags weren't feeling it today.",
  'Ouch. {score}. The scoreboard is being cruel.',
];
const LOSS_PUSH_TITLES = [
  'Rough game today.',
  'They got you this time.',
  "The bags weren't feeling it.",
  'Ouch. That one stung.',
];

async function filterOutGuestUsers(tablesDB, userIds) {
  const nonGuestIds = [];
  for (const userId of userIds) {
    try {
      const user = await tablesDB.getRow({
        databaseId: DATABASE_ID,
        tableId: USERS_COLLECTION_ID,
        rowId: userId,
      });
      if (user && !user.is_guest) nonGuestIds.push(userId);
    } catch {
      // Not found or inaccessible — skip notifying this user.
    }
  }
  return nonGuestIds;
}

async function sendGameResultNotifications(
  tablesDB,
  functionsClient,
  game,
  winnerId,
  log
) {
  const allPlayerIds = [
    game.team1_player1,
    game.team1_player2,
    game.team2_player1,
    game.team2_player2,
  ].filter(Boolean);
  const playerIds = await filterOutGuestUsers(tablesDB, allPlayerIds);
  if (playerIds.length === 0) return;

  const team1Players = [game.team1_player1, game.team1_player2].filter(Boolean);

  await Promise.all(
    playerIds.map(async (playerId) => {
      const isTeam1 = team1Players.includes(playerId);
      const playerScore = isTeam1 ? game.team1_score : game.team2_score;
      const opponentScore = isTeam1 ? game.team2_score : game.team1_score;
      const playerIsWinner = isTeam1
        ? winnerId === game.team1_player1 || winnerId === game.team1_player2
        : winnerId === game.team2_player1 || winnerId === game.team2_player2;

      const msgArray = playerIsWinner ? WIN_MESSAGES : LOSS_MESSAGES;
      const titleArray = playerIsWinner ? WIN_PUSH_TITLES : LOSS_PUSH_TITLES;
      const idx = Math.floor(Math.random() * msgArray.length);
      const message = msgArray[idx].replace(
        '{score}',
        `${playerScore}-${opponentScore}`
      );
      const pushTitle = titleArray[idx];

      try {
        await tablesDB.createRow({
          databaseId: DATABASE_ID,
          tableId: NOTIFICATIONS_COLLECTION_ID,
          rowId: ID.unique(),
          data: {
            user_id: playerId,
            type: 'game_result',
            message,
            read: false,
            tournament_id: game.tournament_id,
          },
        });
      } catch (err) {
        log(
          `[game-complete] failed to create notification for ${playerId}: ${err.message}`
        );
      }

      try {
        await functionsClient.createExecution({
          functionId: SEND_PUSH_FUNCTION_ID,
          body: JSON.stringify({
            userIds: [playerId],
            title: pushTitle,
            body: message,
            data: {
              type: 'game_result',
              tournamentId: game.tournament_id,
              gameId: game.$id,
            },
            url: `/tournaments/find/${game.tournament_id}`,
          }),
          async: true,
        });
      } catch (err) {
        log(
          `[game-complete] failed to send push for ${playerId}: ${err.message}`
        );
      }
    })
  );
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

  const { gameId, winnerId, team1Score, team2Score, session } = body;
  if (!gameId || !winnerId) {
    return res.json(
      { success: false, error: 'Missing gameId or winnerId' },
      400
    );
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
  const tablesDB = new TablesDB(client);
  const functionsClient = new Functions(client);
  const executionId = req.headers['x-appwrite-execution-id'] || ID.unique();

  const locked = await acquireLock(tablesDB, gameId, executionId, log);
  if (!locked) {
    log(`[lock] conflict: game ${gameId} is already being processed`);
    return res.json({ success: false, reason: 'already_processing' }, 409);
  }

  const startedAt = Date.now();
  try {
    const game = await tablesDB.getRow({
      databaseId: DATABASE_ID,
      tableId: GAMES_COLLECTION_ID,
      rowId: gameId,
    });

    if (game.status === 'complete') {
      log(`[game-complete] game ${gameId} already complete, skipping`);
      return res.json({ success: true, reason: 'already_complete' });
    }

    const tournament = await tablesDB.getRow({
      databaseId: DATABASE_ID,
      tableId: TOURNAMENTS_COLLECTION_ID,
      rowId: game.tournament_id,
    });

    const isDoubleElim =
      game.phase === 'elimination' &&
      tournament.tournament_type === 'double_elimination';

    const tx = await tablesDB.createTransaction({ ttl: 60 });
    let nextGameAssigned = false;
    try {
      await tablesDB.updateRow({
        databaseId: DATABASE_ID,
        tableId: GAMES_COLLECTION_ID,
        rowId: gameId,
        data: {
          winnerId,
          team1_score: team1Score,
          team2_score: team2Score,
          status: 'complete',
          endTime: new Date().toISOString(),
        },
        transactionId: tx.$id,
      });

      if (isDoubleElim) {
        nextGameAssigned = await advanceDoubleElimination(
          tablesDB,
          tx.$id,
          game,
          winnerId,
          log
        );
      } else if (
        game.phase === 'elimination' &&
        (game.feeds_to || game.loser_feeds_to)
      ) {
        nextGameAssigned = await advanceWinnerAndLoser(
          tablesDB,
          tx.$id,
          game,
          winnerId,
          log
        );
      }

      const commit = await tablesDB.updateTransaction({
        transactionId: tx.$id,
        commit: true,
      });
      if (commit.status !== 'committed') {
        throw new Error(`transaction ${commit.status}`);
      }
    } catch (err) {
      try {
        await tablesDB.updateTransaction({
          transactionId: tx.$id,
          rollback: true,
        });
      } catch {
        // Best-effort rollback — transaction may already be in a terminal state.
      }
      throw err;
    }

    // Post-commit, non-transactional best-effort follow-ups.
    let eloDeltas = null;
    if (isDoubleElim) {
      // Legacy simple games_played/games_won counter on the users collection —
      // preserved as-is from the original DoubleEliminationManager, additive only.
      await updateDoubleElimUserStats(tablesDB, game, winnerId, log);
    }
    if (game.phase === 'rounders') {
      try {
        const [entriesResponse, gamesResponse] = await Promise.all([
          tablesDB.listRows({
            databaseId: DATABASE_ID,
            tableId: ENTRIES_COLLECTION_ID,
            queries: [
              Query.equal('tournament', game.tournament_id),
              Query.equal('status', 'checked_in'),
              Query.limit(100),
            ],
          }),
          tablesDB.listRows({
            databaseId: DATABASE_ID,
            tableId: GAMES_COLLECTION_ID,
            queries: [
              Query.equal('tournament_id', game.tournament_id),
              Query.equal('phase', 'rounders'),
              Query.limit(400),
            ],
          }),
        ]);
        await updateRoundersStandings(
          tablesDB,
          DATABASE_ID,
          ENTRIES_COLLECTION_ID,
          getRoundersType(tournament.tournament_type),
          entriesResponse.rows,
          gamesResponse.rows,
          log
        );
      } catch (err) {
        log(
          `[game-complete] failed to update rounders standings: ${err.message}`
        );
      }
    }
    try {
      const eloExecution = await functionsClient.createExecution({
        functionId: ELO_STATS_UPDATE_FUNCTION_ID,
        body: JSON.stringify({
          session,
          tournamentType: tournament.tournament_type,
          game: {
            $id: game.$id,
            team1_player1: game.team1_player1,
            team1_player2: game.team1_player2,
            team2_player1: game.team2_player1,
            team2_player2: game.team2_player2,
            round_scores: game.round_scores,
          },
          winnerId,
        }),
        async: false,
      });
      const eloResult = JSON.parse(eloExecution.responseBody || '{}');
      if (eloResult.success) eloDeltas = eloResult.eloDeltas;
      else log(`[game-complete] elo-stats-update failed: ${eloResult.error}`);
    } catch (err) {
      log(`[game-complete] failed to call elo-stats-update: ${err.message}`);
    }

    await sendGameResultNotifications(
      tablesDB,
      functionsClient,
      { ...game, winnerId },
      winnerId,
      log
    );

    try {
      await functionsClient.createExecution({
        functionId: COURT_ASSIGNMENT_FUNCTION_ID,
        body: JSON.stringify({ tournamentId: game.tournament_id, session }),
        async: true,
      });
    } catch (err) {
      log(`[game-complete] failed to trigger court-assignment: ${err.message}`);
    }

    const summary = {
      tournamentId: game.tournament_id,
      gameId,
      winner: winnerId,
      eloDeltas,
      nextGameAssigned,
    };
    log(
      `[game-complete] ${JSON.stringify(summary)} (${Date.now() - startedAt}ms)`
    );
    return res.json({ success: true, ...summary });
  } catch (err) {
    error(`[game-complete] game ${gameId} failed: ${err.message}`);
    return res.json({ success: false, error: err.message }, 500);
  } finally {
    await releaseLock(tablesDB, gameId, log);
  }
};
