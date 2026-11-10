/**
 * Appwrite Function: elo-stats-update
 *
 * Updates a player's cumulative user_stats (games_played, games_won, streak, PPR/DPR) and
 * Elo rating for one completed game, plus saved-team Elo for doubles elimination
 * games. Every player (singles or doubles) is rated only on their own head-to-head
 * rounds against each opponent they threw against — each opponent is a singles-style
 * match scored by points share. Saved-team Elo is the average of the two players'
 * new ratings. Called server-to-server by the
 * game-complete function after it commits the core game-completion cascade.
 *
 * Action: update
 * Body: {
 *   session: string,
 *   tournamentType: string,
 *   game: { $id, team1_player1, team1_player2, team2_player1, team2_player2, round_scores },
 *   winnerId: string
 * }
 *
 * Concurrency: each player's user_stats row is updated inside its own short
 * read-compute-stage-commit transaction, retried on conflict (another game for the
 * same player committing at the same time) rather than using a lock — this is
 * exactly what Appwrite's transaction conflict detection is for.
 *
 * Required Environment Variables:
 * - DATABASE_ID, USER_STATS_COLLECTION_ID, TEAMS_COLLECTION_ID
 */

import { Client, TablesDB, Account, Query, ID } from 'node-appwrite';
import {
  DEFAULT_ELO_RATING,
  calculateMatchupElo,
  getTeamAverageRating,
} from './elo.js';
import {
  computePlayerRoundContribution,
  getPlayerMatchups,
  nextStreak,
} from './playerRoundStats.js';

const DATABASE_ID = process.env.DATABASE_ID;
const USER_STATS_COLLECTION_ID = process.env.USER_STATS_COLLECTION_ID;
const TEAMS_COLLECTION_ID = process.env.TEAMS_COLLECTION_ID;

const REQUIRED_ENV_VARS = {
  DATABASE_ID,
  USER_STATS_COLLECTION_ID,
  TEAMS_COLLECTION_ID,
};
const MAX_CONFLICT_RETRIES = 3;

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
// user_stats lookup
// ---------------------------------------------------------------------------

async function getOrCreateStats(tablesDB, userId) {
  const existing = await tablesDB.listRows({
    databaseId: DATABASE_ID,
    tableId: USER_STATS_COLLECTION_ID,
    queries: [Query.equal('user_id', userId), Query.limit(1)],
  });
  if (existing.rows.length > 0) return existing.rows[0];

  return tablesDB.createRow({
    databaseId: DATABASE_ID,
    tableId: USER_STATS_COLLECTION_ID,
    rowId: ID.unique(),
    data: {
      user_id: userId,
      games_played: 0,
      games_won: 0,
      total_round_points: 0,
      total_rounds_played: 0,
      total_differential_points: 0,
      ppr_current: 0,
      dpr_current: 0,
      streak: 0,
      elo_rating: DEFAULT_ELO_RATING,
      elo_peak: DEFAULT_ELO_RATING,
      elo_games_played: 0,
    },
  });
}

// ---------------------------------------------------------------------------
// Per-player stats + Elo update, retried on transaction conflict
// ---------------------------------------------------------------------------

/**
 * computeElo(currentRating, eloGamesPlayed) → { newRating, matchesPlayed } | null.
 * Opponent ratings are captured by the caller from a pre-game snapshot so update
 * order (and conflict retries) can't feed one player's new rating into another's.
 * null = no Elo change for this game (player threw no rounds).
 */
async function updatePlayerStats(
  tablesDB,
  game,
  playerId,
  isWinner,
  computeElo,
  log
) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
    const stats = await getOrCreateStats(tablesDB, playerId);

    const { roundPoints, opponentPoints, roundsCount } =
      computePlayerRoundContribution(game, playerId);
    const newTotalRoundPoints = (stats.total_round_points || 0) + roundPoints;
    const newTotalRoundsPlayed = (stats.total_rounds_played || 0) + roundsCount;
    const newTotalDifferentialPoints =
      (stats.total_differential_points || 0) + (roundPoints - opponentPoints);
    const newPpr =
      newTotalRoundsPlayed > 0 ? newTotalRoundPoints / newTotalRoundsPlayed : 0;
    const newDpr =
      newTotalRoundsPlayed > 0
        ? newTotalDifferentialPoints / newTotalRoundsPlayed
        : 0;

    const currentRating = stats.elo_rating || DEFAULT_ELO_RATING;
    const currentGamesPlayed = stats.elo_games_played || 0;
    const eloResult = computeElo(currentRating, currentGamesPlayed);
    const newRating = eloResult ? eloResult.newRating : currentRating;
    const eloData = eloResult
      ? {
          elo_rating: newRating,
          elo_peak: Math.max(newRating, stats.elo_peak || DEFAULT_ELO_RATING),
          elo_games_played: currentGamesPlayed + eloResult.matchesPlayed,
        }
      : {};

    const tx = await tablesDB.createTransaction({ ttl: 60 });
    try {
      await tablesDB.updateRow({
        databaseId: DATABASE_ID,
        tableId: USER_STATS_COLLECTION_ID,
        rowId: stats.$id,
        data: {
          games_played: (stats.games_played || 0) + 1,
          games_won: isWinner
            ? (stats.games_won || 0) + 1
            : stats.games_won || 0,
          total_round_points: newTotalRoundPoints,
          total_rounds_played: newTotalRoundsPlayed,
          total_differential_points: newTotalDifferentialPoints,
          ppr_current: newPpr,
          dpr_current: newDpr,
          streak: nextStreak(stats.streak, isWinner),
          ...eloData,
        },
        transactionId: tx.$id,
      });
      const commit = await tablesDB.updateTransaction({
        transactionId: tx.$id,
        commit: true,
      });
      if (commit.status !== 'committed') {
        throw Object.assign(new Error(`transaction ${commit.status}`), {
          code: 409,
        });
      }
      return {
        playerId,
        oldRating: currentRating,
        newRating,
        change: newRating - currentRating,
      };
    } catch (err) {
      lastError = err;
      log(
        `[elo-stats-update] conflict updating ${playerId} (attempt ${attempt}/${MAX_CONFLICT_RETRIES}): ${err.message}`
      );
    }
  }
  throw (
    lastError ||
    new Error(`Failed to update stats for ${playerId} after retries`)
  );
}

// ---------------------------------------------------------------------------
// Team Elo (doubles elimination only)
// ---------------------------------------------------------------------------

function getOrderedPlayerIds(playerId1, playerId2) {
  return playerId1 < playerId2
    ? [playerId1, playerId2]
    : [playerId2, playerId1];
}

async function findTeamByPlayers(tablesDB, playerId1, playerId2) {
  const [p1, p2] = getOrderedPlayerIds(playerId1, playerId2);
  const response = await tablesDB.listRows({
    databaseId: DATABASE_ID,
    tableId: TEAMS_COLLECTION_ID,
    queries: [
      Query.equal('player1_id', p1),
      Query.equal('player2_id', p2),
      Query.limit(1),
    ],
  });
  return response.rows[0] || null;
}

async function updateTeamElo(
  tablesDB,
  team1Ids,
  team2Ids,
  team1Won,
  newRatings,
  log
) {
  const [savedTeam1, savedTeam2] = await Promise.all([
    findTeamByPlayers(tablesDB, team1Ids[0], team1Ids[1]),
    findTeamByPlayers(tablesDB, team2Ids[0], team2Ids[1]),
  ]);

  // Team Elo = average of the two players' new individual ratings.
  for (const [team, isTeam1, ids] of [
    [savedTeam1, true, team1Ids],
    [savedTeam2, false, team2Ids],
  ]) {
    if (!team) continue;
    const teamWon = isTeam1 ? team1Won : !team1Won;
    const newRating = getTeamAverageRating(
      newRatings[ids[0]] ?? DEFAULT_ELO_RATING,
      newRatings[ids[1]] ?? DEFAULT_ELO_RATING
    );
    try {
      await tablesDB.updateRow({
        databaseId: DATABASE_ID,
        tableId: TEAMS_COLLECTION_ID,
        rowId: team.$id,
        data: {
          games_played: team.games_played + 1,
          games_won: team.games_won + (teamWon ? 1 : 0),
          elo_rating: newRating,
          elo_peak: Math.max(team.elo_peak, newRating),
        },
      });
    } catch (err) {
      log(
        `[elo-stats-update] failed to update team ${team.$id}: ${err.message}`
      );
    }
  }
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

  const { session, tournamentType, game, winnerId } = body;
  if (!game || !winnerId) {
    return res.json({ success: false, error: 'Missing game or winnerId' }, 400);
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
  const startedAt = Date.now();

  const playerIds = [
    game.team1_player1,
    game.team1_player2,
    game.team2_player1,
    game.team2_player2,
  ].filter(Boolean);
  const isDoubles = playerIds.length === 4;
  const team1Won =
    winnerId === game.team1_player1 || winnerId === game.team1_player2;
  const winnerIds = team1Won
    ? [game.team1_player1, game.team1_player2].filter(Boolean)
    : [game.team2_player1, game.team2_player2].filter(Boolean);

  try {
    const eloDeltas = {};

    // Snapshot pre-game ratings so neither update order nor conflict retries
    // feed one player's new rating into another player's calculation.
    const preGameRating = {};
    for (const playerId of playerIds) {
      const stats = await getOrCreateStats(tablesDB, playerId);
      preGameRating[playerId] = stats.elo_rating || DEFAULT_ELO_RATING;
    }

    // Every player — singles or doubles — is rated only on their head-to-head
    // rounds vs each opponent they threw against; each opponent is its own
    // singles-style match (points share vs that opponent's pre-game rating).
    const newRatings = {};
    for (const playerId of playerIds) {
      const matchups = getPlayerMatchups(game, playerId).map((m) => ({
        opponentRating: preGameRating[m.opponentId] ?? DEFAULT_ELO_RATING,
        myPoints: m.myPoints,
        opponentPoints: m.opponentPoints,
        rounds: m.rounds,
      }));
      const result = await updatePlayerStats(
        tablesDB,
        game,
        playerId,
        winnerIds.includes(playerId),
        (currentRating, gamesPlayed) =>
          calculateMatchupElo(currentRating, gamesPlayed, matchups),
        log
      );
      eloDeltas[playerId] = result;
      newRatings[playerId] = result.newRating;
    }

    if (isDoubles && tournamentType && tournamentType.includes('elimination')) {
      const team1 = [game.team1_player1, game.team1_player2];
      const team2 = [game.team2_player1, game.team2_player2];
      await updateTeamElo(tablesDB, team1, team2, team1Won, newRatings, log);
    }

    log(
      `[elo-stats-update] game ${game.$id}: updated ${playerIds.length} player(s) in ${Date.now() - startedAt}ms`
    );
    return res.json({ success: true, eloDeltas });
  } catch (err) {
    error(`[elo-stats-update] game ${game.$id} failed: ${err.message}`);
    return res.json({ success: false, error: err.message }, 500);
  }
};
