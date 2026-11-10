import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectSwitchMatchup } from './switchRounders.js';

const players = (count) =>
  Array.from({ length: count }, (_, i) => ({ user: `player-${i}` }));
const ids = (game) => [
  game.team1_player1,
  game.team1_player2,
  game.team2_player1,
  game.team2_player2,
];

function simulate(count, target, courts = 1, initial = []) {
  const entries = players(count);
  const games = initial.map((g) => ({ ...g }));
  for (let step = 0; step < 1000; step++) {
    const active = games.filter((g) => g.status === 'pending');
    while (active.length < courts) {
      const matchup = selectSwitchMatchup(entries, games, target);
      if (!matchup) break;
      const game = { ...matchup, status: 'pending' };
      assert.equal(new Set(ids(game)).size, 4);
      const busy = new Set(active.flatMap(ids));
      assert.ok(ids(game).every((id) => !busy.has(id)));
      active.push(game);
      games.push(game);
    }
    if (!active.length) {
      const counts = entries.map(
        ({ user }) =>
          games.filter((g) => g.status === 'complete' && ids(g).includes(user))
            .length
      );
      assert.ok(
        counts.every((n) => n >= target),
        JSON.stringify(counts)
      );
      return { games, counts };
    }
    // Alternate completion order to exercise temporarily unavailable players.
    active[step % active.length].status = 'complete';
  }
  assert.fail('Scheduling did not terminate');
}

describe('Switch Rounders per-player targets', () => {
  for (const count of [4, 5, 8, 16, 17]) {
    for (const courts of [1, 2, 4]) {
      it(`${count} players reach exactly four games on ${courts} courts`, () => {
        const { games, counts } = simulate(count, 4, courts);
        assert.equal(games.length, count);
        assert.deepEqual(counts, Array(count).fill(4));
      });
    }
  }

  it('continues after four completed matches instead of stopping', () => {
    const initial = simulate(17, 4).games.slice(0, 4);
    const { games, counts } = simulate(17, 4, 1, initial);
    assert.equal(games.length, 17);
    assert.ok(counts.every((n) => n === 4));
  });

  it('uses the minimum one excess appearance for five players at three games', () => {
    const { games, counts } = simulate(5, 3, 2);
    assert.equal(games.length, 4);
    assert.deepEqual([...counts].sort(), [3, 3, 3, 3, 4]);
  });

  it('catches up a late joiner without stranding them', () => {
    const initial = simulate(4, 4).games.slice(0, 2);
    const { games, counts } = simulate(5, 4, 2, initial);
    assert.equal(games.length, 6);
    assert.ok(counts.every((n) => n >= 4));
  });

  it('ignores cancelled matches and reserves pending/queued/in-progress players', () => {
    const game = {
      team1_player1: 'player-0',
      team1_player2: 'player-1',
      team2_player1: 'player-2',
      team2_player2: 'player-3',
    };
    for (const status of ['pending', 'queued', 'in_progress']) {
      assert.equal(
        selectSwitchMatchup(players(4), [{ ...game, status }], 4),
        null
      );
    }
    assert.ok(
      selectSwitchMatchup(players(4), [{ ...game, status: 'cancelled' }], 1)
    );
  });

  it('waits rather than consuming the remaining minimum-match budget incorrectly', () => {
    const games = [
      {
        team1_player1: 'player-0',
        team1_player2: 'player-1',
        team2_player1: 'player-2',
        team2_player2: 'player-3',
        status: 'pending',
      },
    ];
    assert.equal(selectSwitchMatchup(players(5), games, 1), null);
  });

  it('changes partners before falling back to repeats', () => {
    const { games } = simulate(4, 4);
    const partners = games.slice(0, 3).map((g) => {
      const team = [g.team1_player1, g.team1_player2].includes('player-0')
        ? [g.team1_player1, g.team1_player2]
        : [g.team2_player1, g.team2_player2];
      return team.find((id) => id !== 'player-0');
    });
    assert.equal(new Set(partners).size, 3);
  });

  it('rejects invalid targets and rosters explicitly', () => {
    assert.throws(() => selectSwitchMatchup(players(3), [], 4), /four/);
    assert.throws(
      () => selectSwitchMatchup(players(4), [], 0),
      /positive integer/
    );
  });

  it('minimizes excess appearances across roster sizes and arbitrary targets', () => {
    for (let count = 4; count <= 25; count++) {
      for (let target = 1; target <= 7; target++) {
        const { games, counts } = simulate(count, target, 4);
        assert.equal(
          games.length,
          Math.ceil((count * target) / 4),
          `${count} players / ${target} games`
        );
        assert.equal(
          counts.reduce((sum, n) => sum + n, 0),
          4 * games.length
        );
      }
    }
  });
});
