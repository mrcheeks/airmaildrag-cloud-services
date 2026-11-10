# court-assignment

Single source of truth for "which queued/ready game gets which free court" across
all tournament formats, including dynamic singles random-rounders game generation.
Switch Rounders doubles generation also runs here, under the same tournament lock.
Runs under a per-tournament lock so concurrent clients (tablets, phones, dashboard)
can't race to assign the same court twice. See
[COURT_ASSIGNMENT_ARCHITECTURE.md](../../COURT_ASSIGNMENT_ARCHITECTURE.md) for the
full design.

## 🧰 Usage

### POST /

Action: `reconcile`

**Body**

```json
{
  "tournamentId": "...",
  "session": "<Appwrite session token of the requesting user>"
}
```

**Response**

Sample `200` Response:

```json
{ "success": true }
```

Sample lock-conflict response (retried once client-side after 250ms, not an error):

```json
{ "success": false, "reason": "locked" }
```

### GET /ping

- Returns a "Pong" message (Appwrite platform health check).

## Switch Rounders

Initial generation, continuation, resume and waiting-court recovery all use this
function. The full checked-in roster and rounders history are paginated. Completed
games count toward the per-player target; pending/in-progress/queued/paused games
reserve their players. Prefer fresh partners/opponents, allowing repeats as needed.
Preserve the minimum remaining match budget to avoid stranding catch-up players.

Four games is recommended. Every player, including late joiners, reaches the
target; if equal counts are impossible, use the minimum excess appearances.
Seventeen players at four games must produce exactly seventeen doubles matches.
Fewer than four checked-in players returns an explicit error.

Responses include `assignedGames` and `phaseComplete`. An optional
`completeIfFinished: true` claims terminal completion under the lock and returns
`completionClaimed: true` only to the winning caller. That client performs the
existing tournament statistics/result-notification follow-ups; other callers
must not repeat them.

Run regression tests with `npm test` (Node's built-in test runner).

## 🔒 Locking

Per-**tournament** lock via `createDocument` in the `court_assignment_locks`
collection (document ID = `tournamentId`; a 409 means already locked). Conflicts
retry once after 250ms — near-simultaneous polling from multiple clients is
expected and harmless. Stale locks (crashed execution) are force-unlocked after 25s.

## ⚙️ Configuration

| Setting           | Value         |
| ----------------- | ------------- |
| Runtime           | Node (25.0)   |
| Entrypoint        | `src/main.js` |
| Build Commands    | `npm install` |
| Permissions       | `users`       |
| Timeout (Seconds) | 30            |

## 🔒 Environment Variables

| Variable                    | Purpose                                  |
| ---------------------------- | ------------------------------------------ |
| `DATABASE_ID`               | Appwrite database ID                     |
| `GAMES_COLLECTION_ID`       | `games` collection ID                    |
| `TOURNAMENTS_COLLECTION_ID` | `tournaments` collection ID               |
| `ENTRIES_COLLECTION_ID`     | `entries` collection ID                  |
| `LOCKS_COLLECTION_ID`       | `court_assignment_locks` collection ID   |

> **Note:** the `"variables"` key in the repo's `appwrite.config.json` does **not**
> sync via `appwrite push function` — these must be set manually in the Appwrite
> Console under Functions → court-assignment → Settings → Environment Variables.
