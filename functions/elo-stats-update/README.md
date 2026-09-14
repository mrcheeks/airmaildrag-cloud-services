# elo-stats-update

Updates a player's cumulative `user_stats` (games_played, games_won, PPR/DPR) and
Elo rating for one completed game, plus saved-team Elo for doubles elimination
games. Called server-to-server by `game-complete` after it commits the core
game-completion cascade — not intended to be called directly by clients. See
[GAME_COMPLETION_ARCHITECTURE.md](../../GAME_COMPLETION_ARCHITECTURE.md) for the
full design.

## 🧰 Usage

### POST /

Action: `update`

**Body**

```json
{
  "session": "<Appwrite session token of the requesting user>",
  "tournamentType": "single_elimination",
  "game": {
    "$id": "...",
    "team1_player1": "...",
    "team1_player2": null,
    "team2_player1": "...",
    "team2_player2": null,
    "round_scores": "[...]"
  },
  "winnerId": "..."
}
```

**Response**

Sample `200` Response:

```json
{
  "success": true,
  "eloDeltas": { "<playerId>": { "oldRating": 512, "newRating": 524, "change": 12 } }
}
```

### GET /ping

- Returns a "Pong" message (Appwrite platform health check).

## 🔒 Concurrency

No lock collection. Each player's `user_stats` row is updated inside its own short
read → compute → stage → commit transaction, retried up to 3 times on a commit
conflict (another game for the same player completing concurrently) — this relies
on Appwrite's built-in transaction conflict detection instead of a dedicated lock.

## ⚙️ Configuration

| Setting           | Value         |
| ----------------- | ------------- |
| Runtime           | Node (25.0)   |
| Entrypoint        | `src/main.js` |
| Build Commands    | `npm install` |
| Permissions       | `users`       |
| Timeout (Seconds) | 30            |

## 🔒 Environment Variables

| Variable                    | Purpose                          |
| ---------------------------- | ----------------------------------- |
| `DATABASE_ID`               | Appwrite database ID              |
| `USER_STATS_COLLECTION_ID`  | `user_stats` collection ID        |
| `TEAMS_COLLECTION_ID`       | `teams` collection ID (saved Elo) |

> **Note:** the `"variables"` key in the repo's `appwrite.config.json` does **not**
> sync via `appwrite push function` — these must be set manually in the Appwrite
> Console under Functions → elo-stats-update → Settings → Environment Variables.
