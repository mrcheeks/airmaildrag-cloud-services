# court-assignment

Single source of truth for "which queued/ready game gets which free court" across
all tournament formats, including dynamic singles random-rounders game generation.
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
