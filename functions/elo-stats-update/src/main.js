/**
 * Appwrite Function: elo-stats-update
 *
 * Updates a player's cumulative user_stats (games_played, games_won, PPR/DPR) and
 * Elo rating for one completed game, plus saved-team Elo for doubles elimination
 * games. Called server-to-server by the game-complete function after it commits
 * the core game-completion cascade.
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
  calculateGameElo,
  calculateDoublesIndividualElo,
  getTeamAverageRating,
} from './elo.js';

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
      elo_rating: DEFAULT_ELO_RATING,
      elo_peak: DEFAULT_ELO_RATING,
      elo_games_played: 0,
    },
  });
}

// ---------------------------------------------------------------------------
// Per-game PPR/DPR contribution from round_scores
// ---------------------------------------------------------------------------

function computeRoundContribution(game, playerId) {
  let roundPoints = 0;
  let opponentPoints = 0;
  let roundsCount = 0;

  if (game.round_scores) {
    try {
      const rounds = JSON.parse(game.round_scores);
      const isTeam1 =
        game.team1_player1 === playerId || game.team1_player2 === playerId;
      roundsCount = rounds.length;
      for (const round of rounds) {
        if (isTeam1) {
          roundPoints += round.team1RoundScore || 0;
          opponentPoints += round.team2RoundScore || 0;
        } else {
          roundPoints += round.team2RoundScore || 0;
          opponentPoints += round.team1RoundScore || 0;
        }
      }
    } catch {
      // Malformed round_scores — treat as no rounds rather than failing the update.
    }
  }

  return { roundPoints, opponentPoints, roundsCount };
}

// ---------------------------------------------------------------------------
// Per-player stats + Elo update, retried on transaction conflict
// ---------------------------------------------------------------------------

async function updatePlayerStats(
  tablesDB,
  game,
  playerId,
  isWinner,
  eloContext,
  opponentRating,
  log
) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
    const stats = await getOrCreateStats(tablesDB, playerId);

    const { roundPoints, opponentPoints, roundsCount } =
      computeRoundContribution(game, playerId);
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
    const eloResult =
      eloContext === 'tournament_singles'
        ? calculateGameElo({
            winnerId: isWinner ? playerId : 'opponent',
            loserId: isWinner ? 'opponent' : playerId,
            winnerRating: isWinner ? currentRating : opponentRating,
            loserRating: isWinner ? opponentRating : currentRating,
            winnerGamesPlayed: isWinner ? currentGamesPlayed : 0,
            loserGamesPlayed: isWinner ? 0 : currentGamesPlayed,
            context: eloContext,
          })
        : null;
    const newRating = eloResult
      ? isWinner
        ? eloResult.winner.newRating
        : eloResult.loser.newRating
      : calculateDoublesIndividualElo(
          currentRating,
          currentGamesPlayed,
          opponentRating,
          isWinner
        ).newRating;

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
          elo_rating: newRating,
          elo_peak: Math.max(newRating, stats.elo_peak || DEFAULT_ELO_RATING),
          elo_games_played: currentGamesPlayed + 1,
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
  team1AvgRating,
  team2AvgRating,
  log
) {
  const [savedTeam1, savedTeam2] = await Promise.all([
    findTeamByPlayers(tablesDB, team1Ids[0], team1Ids[1]),
    findTeamByPlayers(tablesDB, team2Ids[0], team2Ids[1]),
  ]);

  for (const [team, isTeam1, opponentAvg] of [
    [savedTeam1, true, team2AvgRating],
    [savedTeam2, false, team1AvgRating],
  ]) {
    if (!team) continue;
    const teamWon = isTeam1 ? team1Won : !team1Won;
    const result = calculateGameElo({
      winnerId: 'team',
      loserId: 'opponent',
      winnerRating: teamWon ? team.elo_rating : opponentAvg,
      loserRating: teamWon ? opponentAvg : team.elo_rating,
      winnerGamesPlayed: teamWon ? team.games_played : 0,
      loserGamesPlayed: teamWon ? 0 : team.games_played,
      context: 'tournament_doubles',
    });
    const newRating = teamWon
      ? result.winner.newRating
      : result.loser.newRating;
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

    if (!isDoubles) {
      // Singles: direct head-to-head Elo.
      const [player1Id, player2Id] = playerIds;
      const opponentIdOf = { [player1Id]: player2Id, [player2Id]: player1Id };
      for (const playerId of playerIds) {
        const opponentStats = await getOrCreateStats(
          tablesDB,
          opponentIdOf[playerId]
        );
        const result = await updatePlayerStats(
          tablesDB,
          game,
          playerId,
          winnerIds.includes(playerId),
          'tournament_singles',
          opponentStats.elo_rating || DEFAULT_ELO_RATING,
          log
        );
        eloDeltas[playerId] = result;
      }
    } else {
      // Doubles: each player's individual Elo vs opponent team average.
      const team1 = [game.team1_player1, game.team1_player2].filter(Boolean);
      const team2 = [game.team2_player1, game.team2_player2].filter(Boolean);
      const allStats = {};
      for (const playerId of playerIds) {
        allStats[playerId] = await getOrCreateStats(tablesDB, playerId);
      }
      const team1AvgRating = getTeamAverageRating(
        allStats[team1[0]]?.elo_rating || DEFAULT_ELO_RATING,
        allStats[team1[1]]?.elo_rating || DEFAULT_ELO_RATING
      );
      const team2AvgRating = getTeamAverageRating(
        allStats[team2[0]]?.elo_rating || DEFAULT_ELO_RATING,
        allStats[team2[1]]?.elo_rating || DEFAULT_ELO_RATING
      );

      for (const playerId of playerIds) {
        const isTeam1 = team1.includes(playerId);
        const opponentAvg = isTeam1 ? team2AvgRating : team1AvgRating;
        const result = await updatePlayerStats(
          tablesDB,
          game,
          playerId,
          winnerIds.includes(playerId),
          'tournament_individual',
          opponentAvg,
          log
        );
        eloDeltas[playerId] = result;
      }

      if (tournamentType && tournamentType.includes('elimination')) {
        await updateTeamElo(
          tablesDB,
          team1,
          team2,
          team1Won,
          team1AvgRating,
          team2AvgRating,
          log
        );
      }
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
