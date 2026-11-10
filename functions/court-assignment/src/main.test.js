import { beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Account, Databases } from 'node-appwrite';
import { switchPlayerIds } from './switchRounders.js';

for (const name of [
  'DATABASE_ID',
  'GAMES_COLLECTION_ID',
  'TOURNAMENTS_COLLECTION_ID',
  'ENTRIES_COLLECTION_ID',
  'LOCKS_COLLECTION_ID',
])
  process.env[name] = name;
process.env.APPWRITE_FUNCTION_API_ENDPOINT = 'https://example.invalid/v1';
process.env.APPWRITE_FUNCTION_PROJECT_ID = 'test-project';
const { default: handler } = await import('./main.js');

let tournament;
let entries;
let games;
let locks;
let pageReads;

function collection(id) {
  if (id === 'ENTRIES_COLLECTION_ID') return entries;
  if (id === 'GAMES_COLLECTION_ID') return games;
  throw new Error(`Unexpected collection: ${id}`);
}

beforeEach(() => {
  mock.restoreAll();
  tournament = {
    $id: 'tournament',
    tournament_type: 'switch_rounders',
    team_type: 'doubles',
    tournament_state: 'in_progress',
    current_phase: 'rounders',
    courts: 1,
    rounder_rounds: 4,
  };
  entries = Array.from({ length: 17 }, (_, n) => ({
    $id: `entry-${String(n).padStart(3, '0')}`,
    user: `player-${n}`,
    tournament: 'tournament',
    status: 'checked_in',
  }));
  games = [];
  locks = new Map();
  pageReads = 0;
  mock.method(Account.prototype, 'get', async () => ({ $id: 'user' }));
  mock.method(
    Databases.prototype,
    'getDocument',
    async ({ collectionId, documentId }) => {
      if (collectionId === 'TOURNAMENTS_COLLECTION_ID')
        return { ...tournament };
      if (locks.has(documentId)) return locks.get(documentId);
      throw Object.assign(new Error('Not found'), { code: 404 });
    }
  );
  mock.method(
    Databases.prototype,
    'createDocument',
    async ({ collectionId, documentId, data }) => {
      if (collectionId === 'LOCKS_COLLECTION_ID') {
        if (locks.has(documentId))
          throw Object.assign(new Error('Conflict'), { code: 409 });
        locks.set(documentId, { ...data, $id: documentId });
        return locks.get(documentId);
      }
      const game = { ...data, $id: documentId };
      games.push(game);
      return { ...game };
    }
  );
  mock.method(Databases.prototype, 'deleteDocument', async ({ documentId }) => {
    locks.delete(documentId);
  });
  mock.method(
    Databases.prototype,
    'updateDocument',
    async ({ collectionId, documentId, data }) => {
      const row =
        collectionId === 'TOURNAMENTS_COLLECTION_ID'
          ? tournament
          : games.find((g) => g.$id === documentId);
      assert.ok(row);
      Object.assign(row, data);
      return { ...row };
    }
  );
  mock.method(
    Databases.prototype,
    'listDocuments',
    async ({ collectionId, queries }) => {
      pageReads++;
      let rows = [...collection(collectionId)];
      let limit = 25;
      for (const raw of queries) {
        const { method, attribute, values } = JSON.parse(raw);
        if (method === 'equal')
          rows = rows.filter((r) => values.includes(r[attribute]));
        if (method === 'notEqual')
          rows = rows.filter((r) => !values.includes(r[attribute]));
        if (method === 'orderAsc')
          rows.sort((a, b) => a[attribute].localeCompare(b[attribute]));
        if (method === 'cursorAfter')
          rows = rows.slice(rows.findIndex((r) => r.$id === values[0]) + 1);
        if (method === 'limit') limit = values[0];
      }
      return { documents: rows.slice(0, limit).map((g) => ({ ...g })) };
    }
  );
});

async function call(body = {}) {
  return handler({
    req: {
      body: JSON.stringify({
        tournamentId: 'tournament',
        session: 'test-session',
        ...body,
      }),
      headers: {},
    },
    res: { json: (data) => data },
    log: () => {},
    error: () => {},
  });
}

describe('Switch Rounders through the real cloud handler', () => {
  it('continues past four matches and claims completion once across concurrent callers', async () => {
    for (let n = 0; n < 17; n++) {
      const result = await call();
      assert.equal(result.success, true);
      assert.equal(result.assigned, 1, `match ${n + 1}`);
      games.at(-1).status = 'complete';
    }
    const results = await Promise.all([
      call({ completeIfFinished: true }),
      call({ completeIfFinished: true }),
    ]);
    assert.equal(results.filter((r) => r.completionClaimed).length, 1);
    assert.equal(tournament.tournament_state, 'completed');
    assert.equal(games.length, 17);
    assert.equal(locks.size, 0);
    for (const { user } of entries) {
      assert.equal(
        games.filter((g) => switchPlayerIds(g).includes(user)).length,
        4
      );
    }
  });

  it('serializes competing polls without assigning players or courts twice', async () => {
    tournament.courts = 4;
    const results = await Promise.all([call(), call()]);
    assert.equal(
      results.reduce((sum, r) => sum + r.assigned, 0),
      4
    );
    assert.equal(games.length, 4);
    assert.equal(new Set(games.flatMap(switchPlayerIds)).size, 16);
    assert.equal(new Set(games.map((g) => g.court)).size, 4);
  });

  it('does not generate while paused and resumes without resetting games', async () => {
    tournament.tournament_state = 'paused';
    assert.equal((await call()).reason, 'paused');
    assert.equal(games.length, 0);
    tournament.tournament_state = 'in_progress';
    assert.equal((await call()).assigned, 1);
  });

  it('paginates checked-in entries and history beyond the old limits', async () => {
    entries = Array.from({ length: 105 }, (_, n) => ({
      $id: `entry-${String(n).padStart(3, '0')}`,
      user: `player-${n}`,
      tournament: 'tournament',
      status: 'checked_in',
    }));
    games = Array.from({ length: 405 }, (_, n) => ({
      $id: `cancelled-${String(n).padStart(3, '0')}`,
      tournament_id: 'tournament',
      phase: 'rounders',
      status: 'cancelled',
    }));
    assert.equal((await call()).assigned, 1);
    assert.ok(pageReads >= 7);
  });

  it('leaves other formats in the existing reconcile branches', async () => {
    tournament.tournament_type = 'single_elimination';
    tournament.current_phase = 'elimination';
    assert.equal((await call()).assigned, 0);
    assert.equal(games.length, 0);
  });

  it('returns an explicit failure for an insufficient roster and releases the lock', async () => {
    entries = entries.slice(0, 3);
    const result = await call();
    assert.equal(result.success, false);
    assert.match(result.error, /four checked-in players/);
    assert.equal(locks.size, 0);
    assert.equal(games.length, 0);
  });
});
