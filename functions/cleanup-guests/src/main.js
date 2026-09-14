/**
 * Appwrite Function: Cleanup Guests
 * 
 * This function cleans up guest players from completed tournaments.
 * It only processes guests where:
 * 1. The tournament status is 'completed'
 * 2. The tournament was created more than 24 hours ago
 * 
 * When cleaning up:
 * - Game records are reassigned from guest to "Visitor" system user
 * - Participant entries are deleted
 * - Guest user records are deleted
 * 
 * Schedule this function to run daily via CRON: 0 6 * * * (6am UTC daily)
 * 
 * Required Environment Variables (set in Appwrite Console):
 * - APPWRITE_FUNCTION_PROJECT_ID: Your project ID
 * - APPWRITE_FUNCTION_API_KEY: API key with database read/write permissions
 * - DATABASE_ID: Your database ID
 * - USERS_COLLECTION_ID: Users collection ID
 * - PARTICIPANTS_COLLECTION_ID: Participants collection ID
 * - GAMES_COLLECTION_ID: Games collection ID
 * - TOURNAMENTS_COLLECTION_ID: Tournaments collection ID
 */

import { Client, Databases, Query } from 'node-appwrite';

// System Visitor user - holds all historic guest game records
const VISITOR_USER_ID = 'visitor_system_user';
const VISITOR_USERNAME = 'Visitor';

export default async function handler({ req, res, log, error }) {
  log('Starting guest cleanup job...');

  // Initialize Appwrite client
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT || 'https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || '')
    .setKey(process.env.APPWRITE_FUNCTION_API_KEY || '');

  const databases = new Databases(client);

  // Get collection IDs from environment
  const databaseId = process.env.DATABASE_ID || '';
  const usersCollection = process.env.USERS_COLLECTION_ID || '';
  const participantsCollection = process.env.PARTICIPANTS_COLLECTION_ID || '';
  const gamesCollection = process.env.GAMES_COLLECTION_ID || '';
  const tournamentsCollection = process.env.TOURNAMENTS_COLLECTION_ID || '';

  if (!databaseId || !usersCollection || !participantsCollection || !gamesCollection || !tournamentsCollection) {
    error('Missing required environment variables');
    return res.json({ 
      success: false, 
      error: 'Missing required environment variables' 
    }, 500);
  }

  const stats = {
    tournamentsChecked: 0,
    tournamentsEligible: 0,
    guestsProcessed: 0,
    gamesReassigned: 0,
    entriesDeleted: 0,
    errors: []
  };

  try {
    // Get all guest users
    const guestsResponse = await databases.listDocuments(
      databaseId,
      usersCollection,
      [
        Query.equal('is_guest', true),
        Query.limit(500)
      ]
    );

    const guests = guestsResponse.documents || [];
    log(`Found ${guests.length} guest users to check`);

    if (guests.length === 0) {
      log('No guests to cleanup');
      return res.json({
        success: true,
        message: 'No guests to cleanup',
        stats
      });
    }

    // Group guests by tournament
    const guestsByTournament = new Map();
    for (const guest of guests) {
      const tournamentId = guest.guest_tournament_id;
      if (!tournamentId) continue;
      
      if (!guestsByTournament.has(tournamentId)) {
        guestsByTournament.set(tournamentId, []);
      }
      guestsByTournament.get(tournamentId).push(guest);
    }

    log(`Guests belong to ${guestsByTournament.size} tournaments`);

    // Calculate cutoff date (24 hours ago)
    const cutoffDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    log(`Cutoff date: ${cutoffDate.toISOString()}`);

    // Ensure Visitor user exists
    await ensureVisitorUser(databases, databaseId, usersCollection, log);

    // Process each tournament
    for (const [tournamentId, tournamentGuests] of guestsByTournament) {
      stats.tournamentsChecked++;

      try {
        // Get tournament details
        const tournament = await databases.getDocument(
          databaseId,
          tournamentsCollection,
          tournamentId
        );

        const tournamentCreatedAt = new Date(tournament.$createdAt);
        const isCompleted = tournament.tournament_state === 'completed';
        const isOldEnough = tournamentCreatedAt < cutoffDate;

        log(`Tournament ${tournamentId} (${tournament.name || 'unnamed'}): status=${tournament.tournament_state}, created=${tournament.$createdAt}, isCompleted=${isCompleted}, isOldEnough=${isOldEnough}`);

        // Only cleanup if tournament is completed AND older than 24 hours
        if (!isCompleted) {
          log(`  Skipping: tournament not completed`);
          continue;
        }

        if (!isOldEnough) {
          log(`  Skipping: tournament too recent (created ${tournamentCreatedAt.toISOString()})`);
          continue;
        }

        stats.tournamentsEligible++;
        log(`  Processing ${tournamentGuests.length} guests from this tournament...`);

        // Process each guest in this tournament
        for (const guest of tournamentGuests) {
          try {
            // 1. Reassign games to Visitor
            const gamesUpdated = await reassignGuestGames(
              databases, databaseId, gamesCollection, guest.$id, log
            );
            stats.gamesReassigned += gamesUpdated;

            // 2. Delete participant entries
            const entriesDeleted = await deleteGuestEntries(
              databases, databaseId, participantsCollection, tournamentId, guest.$id, log
            );
            stats.entriesDeleted += entriesDeleted;

            // 3. Delete guest user
            await databases.deleteDocument(databaseId, usersCollection, guest.$id);
            stats.guestsProcessed++;

            log(`  Cleaned up guest "${guest.username}" (${guest.$id}): ${gamesUpdated} games, ${entriesDeleted} entries`);
          } catch (guestError) {
            const errMsg = `Failed to cleanup guest ${guest.$id}: ${guestError}`;
            error(errMsg);
            stats.errors.push(errMsg);
          }
        }
      } catch (tournamentError) {
        const errMsg = `Failed to process tournament ${tournamentId}: ${tournamentError}`;
        error(errMsg);
        stats.errors.push(errMsg);
      }
    }

    log(`Cleanup complete! Processed ${stats.guestsProcessed} guests from ${stats.tournamentsEligible} eligible tournaments`);

    return res.json({
      success: true,
      message: `Cleaned up ${stats.guestsProcessed} guests from ${stats.tournamentsEligible} completed tournaments`,
      stats
    });

  } catch (err) {
    const errMsg = `Cleanup job failed: ${err}`;
    error(errMsg);
    return res.json({
      success: false,
      error: errMsg,
      stats
    }, 500);
  }
}

/**
 * Ensure the Visitor system user exists
 */
async function ensureVisitorUser(databases, databaseId, usersCollection, log) {
  try {
    await databases.getDocument(databaseId, usersCollection, VISITOR_USER_ID);
    log('Visitor user exists');
  } catch {
    // Create the Visitor user
    log('Creating Visitor system user...');
    await databases.createDocument(
      databaseId,
      usersCollection,
      VISITOR_USER_ID,
      {
        auth_id: 'system_visitor_auth',
        username: VISITOR_USERNAME,
        is_guest: false,
        is_system_user: true
      }
    );
    log('Visitor system user created');
  }
}

/**
 * Reassign all games involving a guest to the Visitor user
 */
async function reassignGuestGames(databases, databaseId, gamesCollection, guestUserId, log) {
  let updatedGames = 0;

  // Query games where this guest participated
  // Check various player fields
  const queries = [
    Query.equal('player1', guestUserId),
    Query.equal('player2', guestUserId),
    Query.equal('team1_player1', guestUserId),
    Query.equal('team1_player2', guestUserId),
    Query.equal('team2_player1', guestUserId),
    Query.equal('team2_player2', guestUserId),
  ];

  for (const query of queries) {
    try {
      const response = await databases.listDocuments(
        databaseId,
        gamesCollection,
        [query, Query.limit(500)]
      );

      for (const game of response.documents) {
        const updates = {};

        // Update all fields that match the guest
        if (game.player1 === guestUserId) {
          updates.player1 = VISITOR_USER_ID;
        }
        if (game.player2 === guestUserId) {
          updates.player2 = VISITOR_USER_ID;
        }
        if (game.team1_player1 === guestUserId) {
          updates.team1_player1 = VISITOR_USER_ID;
        }
        if (game.team1_player2 === guestUserId) {
          updates.team1_player2 = VISITOR_USER_ID;
        }
        if (game.team2_player1 === guestUserId) {
          updates.team2_player1 = VISITOR_USER_ID;
        }
        if (game.team2_player2 === guestUserId) {
          updates.team2_player2 = VISITOR_USER_ID;
        }

        if (Object.keys(updates).length > 0) {
          await databases.updateDocument(
            databaseId,
            gamesCollection,
            game.$id,
            updates
          );
          updatedGames++;
        }
      }
    } catch {
      // Query might fail if field doesn't exist, that's OK
    }
  }

  return updatedGames;
}

/**
 * Delete participant entries for a guest in a tournament
 */
async function deleteGuestEntries(databases, databaseId, participantsCollection, tournamentId, guestUserId, log) {
  let deletedEntries = 0;

  const response = await databases.listDocuments(
    databaseId,
    participantsCollection,
    [
      Query.equal('tournament', tournamentId),
      Query.equal('user', guestUserId),
      Query.limit(10)
    ]
  );

  for (const entry of response.documents) {
    await databases.deleteDocument(databaseId, participantsCollection, entry.$id);
    deletedEntries++;
  }

  return deletedEntries;
}
