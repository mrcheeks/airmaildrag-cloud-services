import { beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Account, TablesDB, Functions } from 'node-appwrite';

for (const name of [
  'DATABASE_ID',
  'GAMES_COLLECTION_ID',
  'TOURNAMENTS_COLLECTION_ID',
  'ENTRIES_COLLECTION_ID',
  'NOTIFICATIONS_COLLECTION_ID',
  'USERS_COLLECTION_ID',
  'LOCKS_COLLECTION_ID',
  'ELO_STATS_UPDATE_FUNCTION_ID',
  'COURT_ASSIGNMENT_FUNCTION_ID',
  'SEND_PUSH_FUNCTION_ID',
])
  process.env[name] = name;
process.env.APPWRITE_FUNCTION_API_ENDPOINT = 'https://example.invalid/v1';
process.env.APPWRITE_FUNCTION_PROJECT_ID = 'test-project';
const { default: handler } = await import('./main.js');

let format;
let executions;
let updates;
let assignmentError;
beforeEach(() => {
  mock.restoreAll();
  format = 'switch_rounders';
  executions = [];
  updates = [];
  assignmentError = null;
  mock.method(Account.prototype, 'get', async () => ({ $id: 'user' }));
  mock.method(TablesDB.prototype, 'createRow', async () => ({ $id: 'lock' }));
  mock.method(TablesDB.prototype, 'deleteRow', async () => {});
  mock.method(TablesDB.prototype, 'createTransaction', async () => ({
    $id: 'tx',
  }));
  mock.method(TablesDB.prototype, 'updateTransaction', async () => ({
    status: 'committed',
  }));
  mock.method(TablesDB.prototype, 'getRow', async ({ tableId }) => {
    if (tableId === 'TOURNAMENTS_COLLECTION_ID') {
      return { $id: 'tournament', tournament_type: format };
    }
    if (tableId === 'USERS_COLLECTION_ID') return { is_guest: true };
    return {
      $id: 'game',
      tournament_id: 'tournament',
      phase: 'rounders',
      status: 'in_progress',
      team1_player1: 'a',
      team1_player2: 'b',
      team2_player1: 'c',
      team2_player2: 'd',
    };
  });
  mock.method(TablesDB.prototype, 'listRows', async () => ({ rows: [] }));
  mock.method(TablesDB.prototype, 'updateRow', async (args) => {
    updates.push(args);
    return args.data;
  });
  mock.method(Functions.prototype, 'createExecution', async (args) => {
    executions.push(args);
    if (args.functionId === 'COURT_ASSIGNMENT_FUNCTION_ID') {
      if (assignmentError) throw assignmentError;
      return {
        responseBody: JSON.stringify({
          success: true,
          assigned: 1,
          assignedGames: [{ $id: 'next-game', court: 1 }],
        }),
      };
    }
    return { responseBody: JSON.stringify({ success: true, eloDeltas: {} }) };
  });
});

async function call() {
  return handler({
    req: {
      headers: {},
      body: JSON.stringify({
        gameId: 'game',
        winnerId: 'a',
        team1Score: 21,
        team2Score: 10,
        session: 'test-session',
      }),
    },
    res: { json: (body) => body },
    log: () => {},
    error: () => {},
  });
}

describe('game completion hands Switch Rounders to server reconciliation', () => {
  it('waits for assignment and returns it without replaying the game write', async () => {
    const result = await call();
    assert.equal(result.success, true);
    assert.equal(result.courtAssignment.assignedGames[0].$id, 'next-game');
    assert.equal(
      executions.find((e) => e.functionId === 'COURT_ASSIGNMENT_FUNCTION_ID')
        .async,
      false
    );
    assert.equal(
      updates.filter((u) => u.tableId === 'GAMES_COLLECTION_ID').length,
      1
    );
    assert.equal(
      executions.filter((e) => e.functionId === 'ELO_STATS_UPDATE_FUNCTION_ID')
        .length,
      1
    );
  });

  it('keeps the game saved if continuation fails and returns an explicit assignment error', async () => {
    assignmentError = new Error('Assignment unavailable');
    const result = await call();
    assert.equal(result.success, true);
    assert.equal(result.courtAssignment.success, false);
    assert.equal(result.courtAssignment.error, 'Assignment unavailable');
    assert.equal(updates[0].data.status, 'complete');
  });

  it('retains asynchronous court reassignment for other rounders formats', async () => {
    format = 'random_rounders';
    const result = await call();
    assert.equal(result.success, true);
    assert.equal(result.courtAssignment, undefined);
    assert.equal(
      executions.find((e) => e.functionId === 'COURT_ASSIGNMENT_FUNCTION_ID')
        .async,
      true
    );
  });
});
