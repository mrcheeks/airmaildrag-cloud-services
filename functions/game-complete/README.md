# game-complete

Single source of truth for completing a game: marks it complete, advances the
winner/loser through the bracket (single- and double-elimination), recalculates
rounders standings (all 5 formats), then triggers Elo/stats updates, notifications,
and court reassignment. The bracket-critical writes are staged in a single Appwrite
Transaction and committed atomically. See
[GAME_COMPLETION_ARCHITECTURE.md](../../GAME_COMPLETION_ARCHITECTURE.md) for the
full design.

## 🧰 Usage

### POST /

Action: `complete`

**Body**

```json
{
  "gameId": "...",
  "winnerId": "...",
  "team1Score": 21,
  "team2Score": 14,
  "session": "<Appwrite session token of the requesting user>"
}
```

**Response**

Sample `200` Response:

```json
{
  "success": true,
  "tournamentId": "...",
  "gameId": "...",
  "winner": "...",
  "eloDeltas": { "<playerId>": { "oldRating": 512, "newRating": 524, "change": 12 } },
  "nextGameAssigned": true
}
```

Sample lock-conflict response (a duplicate submission for the same game — rejected,
not retried):

```json
{ "success": false, "reason": "already_processing" }
```

### GET /ping

- Returns a "Pong" message (Appwrite platform health check).

## 🔒 Locking

Per-**game** lock via `createRow` in the `game_complete_locks` collection (row ID =
`gameId`; a 409 means already locked). Unlike `court-assignment`'s retry-once
pattern, a conflict here is rejected immediately — a second concurrent submission
for the same game is a duplicate, not a harmless simultaneous poll. Stale locks
(crashed execution) are force-unlocked after 25s.

## ⚙️ Configuration

| Setting           | Value         |
| ----------------- | ------------- |
| Runtime           | Node (25.0)   |
| Entrypoint        | `src/main.js` |
| Build Commands    | `npm install` |
| Permissions       | `users`       |
| Timeout (Seconds) | 30            |

## 🔒 Environment Variables

| Variable                        | Purpose                                              |
| --------------------------------- | ------------------------------------------------------- |
| `DATABASE_ID`                   | Appwrite database ID                                 |
| `GAMES_COLLECTION_ID`           | `games` collection ID                                |
| `TOURNAMENTS_COLLECTION_ID`     | `tournaments` collection ID                           |
| `ENTRIES_COLLECTION_ID`         | `entries` collection ID (rounders standings)         |
| `NOTIFICATIONS_COLLECTION_ID`   | `notifications` collection ID                        |
| `USERS_COLLECTION_ID`           | `users` collection ID (double-elim legacy stats)     |
| `LOCKS_COLLECTION_ID`           | `game_complete_locks` collection ID                  |
| `ELO_STATS_UPDATE_FUNCTION_ID`  | Function ID of `elo-stats-update`                    |
| `COURT_ASSIGNMENT_FUNCTION_ID`  | Function ID of `court-assignment`                    |
| `SEND_PUSH_FUNCTION_ID`         | Function ID/name of `send-push-notification`          |

> **Note:** the `"variables"` key in the repo's `appwrite.config.json` does **not**
> sync via `appwrite push function` — these must be set manually in the Appwrite
> Console under Functions → game-complete → Settings → Environment Variables.
