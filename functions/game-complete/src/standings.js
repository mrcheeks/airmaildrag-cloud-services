/**
 * Rounders standings — ported from the 5 rounders format managers'
 * calculateStandings()/updateStandings() methods (RandomRoundersManager,
 * RankedRoundersManager, SwitchRoundersManager, BlindDrawManager,
 * BlindDrawRankedManager). Each format has genuinely different aggregation
 * rules (points system, sort tiebreakers, rank dedup for fixed-team formats),
 * ported faithfully per format rather than unified into one generic algorithm.
 *
 * ONE BUG FIXED DURING PORTING: the original RandomRoundersManager compared
 * `standings.find(s => s.participantId === player1Id)` directly — but
 * `participantId` is the Entry's $id while `player1Id` is a user ID, so this
 * never actually matched anything (standings always stayed at 0). The other
 * 4 formats correctly resolve the user ID via a two-step entry lookup first.
 * This port uses the correct two-step lookup for random_rounders too.
 */

function entryUserId(entry) {
  return typeof entry.user === 'string' ? entry.user : entry.user?.$id;
}

function findStandingByUserId(standings, participants, playerId) {
  return standings.find((s) => {
    const entry = participants.find((p) => p.$id === s.participantId);
    return entry && entryUserId(entry) === playerId;
  });
}

// ---------------------------------------------------------------------------
// random_rounders / ranked_rounders — identical algorithm
// ---------------------------------------------------------------------------

function calculateStandardRoundersStandings(participants, games) {
  const standings = participants.map((p) => ({
    participantId: p.$id,
    rank: 0,
    wins: 0,
    losses: 0,
    points: 0,
    pointDifferential: 0,
    gamesPlayed: 0,
  }));

  for (const game of games) {
    if (game.status !== 'complete') continue;

    const player1Id = game.team1_player1;
    const player2Id = game.team2_player1;
    const player1Standing = findStandingByUserId(
      standings,
      participants,
      player1Id
    );
    const player2Standing = findStandingByUserId(
      standings,
      participants,
      player2Id
    );

    if (game.is_bye) {
      if (player1Standing) {
        player1Standing.gamesPlayed++;
        player1Standing.wins++;
        player1Standing.points += 2;
        player1Standing.byeCount = (player1Standing.byeCount || 0) + 1;
      }
      continue;
    }

    if (!player1Standing || !player2Standing) continue;

    player1Standing.gamesPlayed++;
    player2Standing.gamesPlayed++;

    if (game.winnerId === player1Id) {
      player1Standing.wins++;
      player1Standing.points += 2;
      player2Standing.losses++;
    } else if (game.winnerId === player2Id) {
      player2Standing.wins++;
      player2Standing.points += 2;
      player1Standing.losses++;
    }

    player1Standing.pointDifferential += game.team1_score - game.team2_score;
    player2Standing.pointDifferential += game.team2_score - game.team1_score;
  }

  standings.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.pointDifferential !== a.pointDifferential)
      return b.pointDifferential - a.pointDifferential;
    return a.gamesPlayed - b.gamesPlayed;
  });
  standings.forEach((s, i) => (s.rank = i + 1));
  return standings;
}

// ---------------------------------------------------------------------------
// switch_rounders — all 4 players processed (rotating partners)
// ---------------------------------------------------------------------------

function calculateSwitchRoundersStandings(participants, games) {
  const standings = participants.map((p) => ({
    participantId: p.$id,
    rank: 0,
    wins: 0,
    losses: 0,
    points: 0,
    pointDifferential: 0,
    gamesPlayed: 0,
  }));

  for (const game of games) {
    if (game.status !== 'complete') continue;

    const team1Score = game.team1_score || 0;
    const team2Score = game.team2_score || 0;
    const team1Won = team1Score > team2Score;

    for (const playerId of [game.team1_player1, game.team1_player2]) {
      if (!playerId) continue;
      const standing = findStandingByUserId(standings, participants, playerId);
      if (!standing) continue;
      standing.gamesPlayed++;
      standing.points += team1Score;
      standing.pointDifferential += team1Score - team2Score;
      if (team1Won) standing.wins++;
      else standing.losses++;
      if (game.is_bye) standing.byeCount = (standing.byeCount || 0) + 1;
    }

    for (const playerId of [game.team2_player1, game.team2_player2]) {
      if (!playerId) continue;
      const standing = findStandingByUserId(standings, participants, playerId);
      if (!standing) continue;
      standing.gamesPlayed++;
      standing.points += team2Score;
      standing.pointDifferential += team2Score - team1Score;
      if (!team1Won) standing.wins++;
      else standing.losses++;
    }
  }

  standings.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.pointDifferential !== a.pointDifferential)
      return b.pointDifferential - a.pointDifferential;
    return b.points - a.points;
  });
  standings.forEach((s, i) => (s.rank = i + 1));
  return standings;
}

// ---------------------------------------------------------------------------
// blind_draw — fixed teams, aggregated by team_id, partners share rank
// ---------------------------------------------------------------------------

function calculateBlindDrawStandings(participants, games) {
  const teamStats = new Map();
  const teamByeCounts = new Map();

  for (const game of games) {
    if (game.status !== 'complete') continue;

    const team1Score = game.team1_score || 0;
    const team2Score = game.team2_score || 0;
    const team1Won = team1Score > team2Score;

    const team1Entry = participants.find(
      (p) => entryUserId(p) === game.team1_player1
    );
    const team2Entry = participants.find(
      (p) => entryUserId(p) === game.team2_player1
    );

    if (team1Entry?.team_id) {
      if (!teamStats.has(team1Entry.team_id)) {
        teamStats.set(team1Entry.team_id, {
          wins: 0,
          losses: 0,
          points: 0,
          pointDiff: 0,
          gamesPlayed: 0,
        });
      }
      const stats = teamStats.get(team1Entry.team_id);
      stats.gamesPlayed++;
      stats.points += team1Score;
      stats.pointDiff += team1Score - team2Score;
      if (team1Won) stats.wins++;
      else stats.losses++;
      if (game.is_bye) {
        teamByeCounts.set(
          team1Entry.team_id,
          (teamByeCounts.get(team1Entry.team_id) || 0) + 1
        );
      }
    }

    if (team2Entry?.team_id) {
      if (!teamStats.has(team2Entry.team_id)) {
        teamStats.set(team2Entry.team_id, {
          wins: 0,
          losses: 0,
          points: 0,
          pointDiff: 0,
          gamesPlayed: 0,
        });
      }
      const stats = teamStats.get(team2Entry.team_id);
      stats.gamesPlayed++;
      stats.points += team2Score;
      stats.pointDiff += team2Score - team1Score;
      if (!team1Won) stats.wins++;
      else stats.losses++;
    }
  }

  const standings = participants.map((p) => {
    const teamId = p.team_id || '';
    const stat = teamStats.get(teamId) || {
      wins: 0,
      losses: 0,
      points: 0,
      pointDiff: 0,
      gamesPlayed: 0,
    };
    return {
      participantId: p.$id,
      rank: 0,
      wins: stat.wins,
      losses: stat.losses,
      points: stat.points,
      pointDifferential: stat.pointDiff,
      gamesPlayed: stat.gamesPlayed,
      byeCount: teamByeCounts.get(teamId) || 0,
    };
  });

  standings.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.pointDifferential !== a.pointDifferential)
      return b.pointDifferential - a.pointDifferential;
    return b.points - a.points;
  });

  let currentRank = 1;
  for (let i = 0; i < standings.length; i++) {
    if (
      i > 0 &&
      (standings[i].wins !== standings[i - 1].wins ||
        standings[i].pointDifferential !== standings[i - 1].pointDifferential ||
        standings[i].points !== standings[i - 1].points)
    ) {
      currentRank = i + 1;
    }
    standings[i].rank = currentRank;
  }
  return standings;
}

// ---------------------------------------------------------------------------
// blind_draw_ranked — reads cumulative Entry fields directly, not games
// ---------------------------------------------------------------------------

function calculateBlindDrawRankedStandings(participants) {
  const teams = new Map();
  for (const entry of participants) {
    if (!entry.team_id) continue;
    if (!teams.has(entry.team_id)) teams.set(entry.team_id, []);
    teams.get(entry.team_id).push(entry);
  }

  const standings = [];
  for (const team of teams.values()) {
    if (team.length !== 2) continue;

    // Partners share a fixed team for the whole tournament, so wins/games_played/
    // points_for/points_against are computed from the same shared game-level team
    // score for both entries — summing both would double every stat. Use one
    // representative partner's numbers instead.
    const displayEntry = team[0];
    const totalWins = displayEntry.wins || 0;
    const totalGamesPlayed = displayEntry.games_played || 0;
    const totalPointsFor = displayEntry.points_for || 0;
    const totalPointsAgainst = displayEntry.points_against || 0;

    standings.push({
      participantId: displayEntry.$id,
      rank: 0,
      wins: totalWins,
      losses: totalGamesPlayed - totalWins,
      gamesPlayed: totalGamesPlayed,
      points: totalPointsFor,
      pointDifferential: totalPointsFor - totalPointsAgainst,
    });
  }

  standings.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.pointDifferential !== a.pointDifferential)
      return b.pointDifferential - a.pointDifferential;
    return b.points - a.points;
  });
  standings.forEach((s, i) => (s.rank = i + 1));
  return standings;
}

/**
 * Recalculate and persist standings (the `seed` field) for a rounders-phase
 * tournament. Mirrors each format manager's updateStandings() exactly.
 */
export async function updateRoundersStandings(
  tablesDB,
  DATABASE_ID,
  ENTRIES_COLLECTION_ID,
  roundersType,
  participants,
  games,
  log
) {
  let standings;
  if (roundersType === 'switch') {
    standings = calculateSwitchRoundersStandings(participants, games);
  } else if (roundersType === 'blind_draw') {
    standings = calculateBlindDrawStandings(participants, games);
  } else if (roundersType === 'blind_draw_ranked') {
    standings = calculateBlindDrawRankedStandings(participants);
  } else {
    // random_rounders, ranked_rounders
    standings = calculateStandardRoundersStandings(participants, games);
  }

  for (const standing of standings) {
    try {
      await tablesDB.updateRow({
        databaseId: DATABASE_ID,
        tableId: ENTRIES_COLLECTION_ID,
        rowId: standing.participantId,
        data: { seed: standing.rank },
      });
    } catch (err) {
      log(
        `[game-complete] failed to update standing for ${standing.participantId}: ${err.message}`
      );
    }
  }
}
