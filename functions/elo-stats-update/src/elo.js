/**
 * Elo rating pure functions — ported verbatim from src/lib/utils/elo.ts.
 * Keep in sync with that file if the rating algorithm changes.
 */

export const MIN_ELO_RATING = 0;
export const MAX_ELO_RATING = 1000;
export const DEFAULT_ELO_RATING = 500;

const BASE_K_FACTORS = {
  tournament_singles: 20,
  tournament_doubles: 16,
  tournament_individual: 10,
  solo_game: 5,
  rival_game: 12,
};

export function getKFactor(gamesPlayed, context = 'tournament_singles') {
  let k = BASE_K_FACTORS[context];
  if (gamesPlayed < 10) {
    k *= 1.5;
  } else if (gamesPlayed < 30) {
    k *= 1.2;
  } else if (gamesPlayed > 100) {
    k *= 0.8;
  }
  return Math.round(k);
}

export function getExpectedScore(playerRating, opponentRating) {
  return 1 / (1 + Math.pow(10, (opponentRating - playerRating) / 200));
}

export function calculateNewRating(
  currentRating,
  opponentRating,
  actualScore,
  kFactor
) {
  const expectedScore = getExpectedScore(currentRating, opponentRating);
  const change = Math.round(kFactor * (actualScore - expectedScore));
  const newRating = currentRating + change;
  return {
    newRating: Math.min(MAX_ELO_RATING, Math.max(MIN_ELO_RATING, newRating)),
    change,
  };
}

export function calculateGameElo(result) {
  const context = result.context || 'tournament_singles';
  const winnerK = getKFactor(result.winnerGamesPlayed, context);
  const loserK = getKFactor(result.loserGamesPlayed, context);

  const winnerScore = result.isDraw ? 0.5 : 1;
  const loserScore = result.isDraw ? 0.5 : 0;

  const winner = calculateNewRating(
    result.winnerRating,
    result.loserRating,
    winnerScore,
    winnerK
  );
  const loser = calculateNewRating(
    result.loserRating,
    result.winnerRating,
    loserScore,
    loserK
  );

  return { winner, loser };
}

export function getTeamAverageRating(player1Rating, player2Rating) {
  return Math.round((player1Rating + player2Rating) / 2);
}

export function calculateDoublesIndividualElo(
  playerRating,
  playerGamesPlayed,
  opponentTeamAvgRating,
  won
) {
  const kFactor = getKFactor(playerGamesPlayed, 'tournament_individual');
  const actualScore = won ? 1 : 0;
  return calculateNewRating(
    playerRating,
    opponentTeamAvgRating,
    actualScore,
    kFactor
  );
}
