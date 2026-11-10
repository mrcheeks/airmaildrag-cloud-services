/**
 * Per-player round attribution for user_stats PPR/DPR and streaks.
 *
 * JS port of airmaildrag-web-app `src/lib/utils/playerRoundStats.ts` — keep in sync.
 *
 * Singles: the player throws every round.
 * Doubles: only one player per team throws each round (`team1_active_player` /
 * `team2_active_player`). Each player is credited only with the rounds they threw;
 * their differential is measured against the opposing team's thrower in that round.
 * Rounds recorded before `*_active_player` existed fall back to alternation
 * (player 1 throws odd rounds, player 2 throws even rounds).
 * `getPlayerMatchups` groups those rounds by opposing thrower for doubles Elo.
 */

export function isDoublesGame(game) {
  return !!(game.team1_player2 || game.team2_player2);
}

export function getPlayerSlot(game, playerId) {
  if (!playerId) return null;
  if (game.team1_player1 === playerId) return { team: 1, position: 1 };
  if (game.team1_player2 === playerId) return { team: 1, position: 2 };
  if (game.team2_player1 === playerId) return { team: 2, position: 1 };
  if (game.team2_player2 === playerId) return { team: 2, position: 2 };
  return null;
}

export function parseRounds(roundScores) {
  if (!roundScores) return [];
  if (Array.isArray(roundScores)) return roundScores;
  try {
    const parsed = JSON.parse(roundScores);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function getActiveThrower(round, roundIndex, team) {
  const recorded =
    team === 1 ? round.team1_active_player : round.team2_active_player;
  if (recorded === 1 || recorded === 2) return recorded;
  const roundNumber =
    typeof round.roundNumber === 'number' && round.roundNumber > 0
      ? round.roundNumber
      : roundIndex + 1;
  return roundNumber % 2 === 1 ? 1 : 2;
}

export function isPlayerThrowingRound(game, round, roundIndex, slot) {
  if (!isDoublesGame(game)) return true;
  // A team with only one player in a doubles game throws every round for that team.
  const teammate = slot.team === 1 ? game.team1_player2 : game.team2_player2;
  if (!teammate) return true;
  return getActiveThrower(round, roundIndex, slot.team) === slot.position;
}

export function computePlayerRoundContribution(game, playerId) {
  const result = { roundPoints: 0, opponentPoints: 0, roundsCount: 0 };
  const slot = getPlayerSlot(game, playerId);
  if (!slot) return result;

  parseRounds(game.round_scores).forEach((round, index) => {
    if (!round || !isPlayerThrowingRound(game, round, index, slot)) return;
    const isTeam1 = slot.team === 1;
    result.roundPoints +=
      (isTeam1 ? round.team1RoundScore : round.team2RoundScore) || 0;
    result.opponentPoints +=
      (isTeam1 ? round.team2RoundScore : round.team1RoundScore) || 0;
    result.roundsCount++;
  });

  return result;
}

function getOpposingThrowerId(game, round, roundIndex, opposingTeam) {
  const p1 = opposingTeam === 1 ? game.team1_player1 : game.team2_player1;
  const p2 = opposingTeam === 1 ? game.team1_player2 : game.team2_player2;
  if (!p2) return p1 || null;
  if (!p1) return p2;
  return getActiveThrower(round, roundIndex, opposingTeam) === 1 ? p1 : p2;
}

/**
 * Head-to-head round matchups for a player: for each opposing thrower they faced,
 * the raw round points each side scored and the number of rounds, counting only
 * the rounds this player threw.
 */
export function getPlayerMatchups(game, playerId) {
  const slot = getPlayerSlot(game, playerId);
  if (!slot) return [];

  const opposingTeam = slot.team === 1 ? 2 : 1;
  const byOpponent = new Map();

  parseRounds(game.round_scores).forEach((round, index) => {
    if (!round || !isPlayerThrowingRound(game, round, index, slot)) return;
    const opponentId = getOpposingThrowerId(game, round, index, opposingTeam);
    if (!opponentId) return;

    const isTeam1 = slot.team === 1;
    const matchup = byOpponent.get(opponentId) ?? {
      opponentId,
      myPoints: 0,
      opponentPoints: 0,
      rounds: 0,
    };
    matchup.myPoints +=
      (isTeam1 ? round.team1RoundScore : round.team2RoundScore) || 0;
    matchup.opponentPoints +=
      (isTeam1 ? round.team2RoundScore : round.team1RoundScore) || 0;
    matchup.rounds++;
    byOpponent.set(opponentId, matchup);
  });

  return [...byOpponent.values()];
}

/** Positive = consecutive wins, negative = consecutive losses. */
export function nextStreak(current, won) {
  const streak = current || 0;
  if (won) return streak > 0 ? streak + 1 : 1;
  return streak < 0 ? streak - 1 : -1;
}
