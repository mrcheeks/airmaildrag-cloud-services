import {
  selectSwitchMatchup,
  switchProgress,
  switchPlayerIds,
} from './switchRounders.js';

export async function reconcileSwitch({
  tournament,
  entries,
  games,
  createGame,
  assignGame,
  completeTournament,
  completeIfFinished = false,
}) {
  const target = tournament.rounder_rounds ?? 4;
  const progress = switchProgress(entries, games, target);
  if (progress.complete) {
    if (completeIfFinished) await completeTournament();
    return {
      assigned: 0,
      assignedGames: [],
      phaseComplete: true,
      completionClaimed: completeIfFinished,
    };
  }
  const assignedGames = [];
  const inUse = new Set(
    games
      .filter((g) => !['complete', 'cancelled'].includes(g.status))
      .map((g) => g.court)
  );
  const queue = games.filter((g) => g.status === 'queued' && !g.court);
  for (let court = 1; court <= (tournament.courts || 1); court++) {
    if (inUse.has(court)) continue;
    const busy = new Set(
      games
        .filter((g) => ['pending', 'in_progress', 'paused'].includes(g.status))
        .flatMap(switchPlayerIds)
    );
    const queued = queue.find((g) =>
      switchPlayerIds(g).every((id) => !busy.has(id))
    );
    let game;
    if (queued) {
      game = await assignGame(queued, court);
      Object.assign(queued, game);
      queue.splice(queue.indexOf(queued), 1);
    } else {
      const matchup = selectSwitchMatchup(entries, games, target);
      if (!matchup) continue;
      game = await createGame({
        ...matchup,
        tournament_id: tournament.$id,
        is_doubles: true,
        team1_score: 0,
        team2_score: 0,
        status: 'pending',
        phase: 'rounders',
        court,
      });
      games.push(game);
    }
    assignedGames.push(game);
  }
  return {
    assigned: assignedGames.length,
    assignedGames,
    phaseComplete: false,
    completionClaimed: false,
  };
}
