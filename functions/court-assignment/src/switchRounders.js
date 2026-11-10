const activeStatuses = new Set(['pending', 'in_progress', 'queued', 'paused']);

export function switchPlayerIds(game) {
  return [
    game.team1_player1,
    game.team1_player2,
    game.team2_player1,
    game.team2_player2,
  ].filter(Boolean);
}

export function switchProgress(entries, games, target) {
  if (!Number.isInteger(target) || target < 1) {
    throw new Error(
      'Switch Rounders games per player must be a positive integer'
    );
  }
  const counts = new Map();
  for (const entry of entries) {
    const id = typeof entry.user === 'string' ? entry.user : entry.user?.$id;
    if (!id || counts.has(id)) {
      throw new Error(
        'Switch Rounders requires a unique user for every checked-in entry'
      );
    }
    counts.set(id, { completed: 0, reserved: 0 });
  }
  if (counts.size < 4) {
    throw new Error(
      'Switch Rounders requires at least four checked-in players'
    );
  }
  const active = new Set();
  for (const game of games) {
    if (game.status !== 'complete' && !activeStatuses.has(game.status))
      continue;
    const ids = switchPlayerIds(game);
    if (ids.length !== 4 || new Set(ids).size !== 4) {
      throw new Error(
        `Switch Rounders game ${game.$id || ''} must have four distinct players`
      );
    }
    for (const id of ids) {
      if (activeStatuses.has(game.status)) active.add(id);
      const count = counts.get(id);
      if (!count) continue;
      count.reserved++;
      if (game.status === 'complete') count.completed++;
    }
  }
  return {
    counts,
    active,
    complete:
      [...counts.values()].every((c) => c.completed >= target) &&
      active.size === 0,
  };
}

function pairKey(a, b) {
  return [a, b].sort().join('\0');
}

export function selectSwitchMatchup(entries, games, target) {
  const { counts, active } = switchProgress(entries, games, target);
  const deficits = new Map(
    [...counts].map(([id, count]) => [id, Math.max(0, target - count.reserved)])
  );
  const total = [...deficits.values()].reduce((sum, n) => sum + n, 0);
  if (!total) return null;

  // A player can appear only once per match. Keep the smallest feasible remaining
  // match budget, even when a late joiner needs more catch-up games than others.
  const matches = Math.max(Math.ceil(total / 4), ...deficits.values());
  const available = [...counts.keys()].filter((id) => !active.has(id));
  if (available.length < 4) return null;
  for (let i = available.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [available[i], available[j]] = [available[j], available[i]];
  }
  available.sort(
    (a, b) =>
      deficits.get(b) - deficits.get(a) ||
      counts.get(a).reserved - counts.get(b).reserved
  );
  const selected = available.slice(0, 4);
  const remaining = [...deficits].map(([id, deficit]) =>
    Math.max(0, deficit - Number(selected.includes(id)))
  );
  if (
    Math.max(...remaining) > matches - 1 ||
    remaining.reduce((sum, n) => sum + n, 0) > 4 * (matches - 1)
  ) {
    return null; // Required catch-up players are still on another court.
  }

  const partners = new Map();
  const opponents = new Map();
  const increment = (map, a, b) => {
    const key = pairKey(a, b);
    map.set(key, (map.get(key) || 0) + 1);
  };
  for (const game of games) {
    if (game.status !== 'complete' && !activeStatuses.has(game.status))
      continue;
    const [a, b, c, d] = switchPlayerIds(game);
    increment(partners, a, b);
    increment(partners, c, d);
    for (const x of [a, b]) for (const y of [c, d]) increment(opponents, x, y);
  }
  const quartets = [selected];
  for (const candidate of available.slice(4)) {
    for (let i = 0; i < selected.length; i++) {
      if (
        deficits.get(candidate) !== deficits.get(selected[i]) ||
        counts.get(candidate).reserved !== counts.get(selected[i]).reserved
      )
        continue;
      const alternative = [...selected];
      alternative[i] = candidate;
      quartets.push(alternative);
    }
  }
  const pairings = quartets.flatMap(([a, b, c, d]) => [
    [a, b, c, d],
    [a, c, b, d],
    [a, d, b, c],
  ]);
  const score = ([p, q, r, s]) => [
    (partners.get(pairKey(p, q)) || 0) + (partners.get(pairKey(r, s)) || 0),
    [p, q].reduce(
      (sum, x) =>
        sum +
        [r, s].reduce((n, y) => n + (opponents.get(pairKey(x, y)) || 0), 0),
      0
    ),
  ];
  pairings.sort((x, y) => {
    const sx = score(x);
    const sy = score(y);
    return sx[0] - sy[0] || sx[1] - sy[1];
  });
  const [t1p1, t1p2, t2p1, t2p2] = pairings[0];
  return {
    team1_player1: t1p1,
    team1_player2: t1p2,
    team2_player1: t2p1,
    team2_player2: t2p2,
    round: Math.min(...[...counts.values()].map((c) => c.completed)) + 1,
  };
}
