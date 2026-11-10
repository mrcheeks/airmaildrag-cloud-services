import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileSwitch } from './reconcileSwitch.js';
import { switchPlayerIds } from './switchRounders.js';

function fixture(count = 17, courts = 1) {
  const tournament = {
    $id: 'switch-tournament',
    courts,
    rounder_rounds: 4,
    current_phase: 'rounders',
    tournament_state: 'in_progress',
  };
  const entries = Array.from({ length: count }, (_, n) => ({
    user: `player-${n}`,
  }));
  const games = [];
  let completions = 0;
  return {
    tournament,
    entries,
    games,
    createGame: async (data) => ({ ...data, $id: `game-${games.length}` }),
    assignGame: async (game, court) => ({ ...game, court, status: 'pending' }),
    completeTournament: async () => {
      completions++;
    },
    get completions() {
      return completions;
    },
  };
}

describe('lock-scoped Switch Rounders reconciliation', () => {
  it('creates a fifth match after four completed matches, then finishes at 17', async () => {
    const state = fixture();
    for (let n = 0; n < 17; n++) {
      const result = await reconcileSwitch(state);
      assert.equal(result.assigned, 1, `match ${n + 1}`);
      assert.equal(result.phaseComplete, false);
      const repeated = await reconcileSwitch(state);
      assert.equal(repeated.assigned, 0);
      state.games.at(-1).status = 'complete';
    }
    const result = await reconcileSwitch(state);
    assert.equal(result.phaseComplete, true);
    assert.equal(result.completionClaimed, false);
    assert.equal(state.completions, 0);
    await reconcileSwitch({ ...state, completeIfFinished: true });
    assert.equal(state.completions, 1);
    for (const { user } of state.entries) {
      assert.equal(
        state.games.filter((g) => switchPlayerIds(g).includes(user)).length,
        4
      );
    }
  });

  it('updates the in-memory reservations between courts', async () => {
    const state = fixture(17, 4);
    const result = await reconcileSwitch(state);
    assert.equal(result.assigned, 4);
    assert.equal(new Set(state.games.flatMap(switchPlayerIds)).size, 16);
    assert.equal((await reconcileSwitch(state)).assigned, 0);
  });

  it('assigns a queued match rather than generating overlapping games', async () => {
    const state = fixture(4);
    state.games.push({
      $id: 'queued',
      status: 'queued',
      team1_player1: 'player-0',
      team1_player2: 'player-1',
      team2_player1: 'player-2',
      team2_player2: 'player-3',
    });
    const result = await reconcileSwitch(state);
    assert.equal(result.assigned, 1);
    assert.equal(state.games.length, 1);
    assert.equal(state.games[0].court, 1);
  });
});
