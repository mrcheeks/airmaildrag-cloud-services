/**
 * Appwrite Function: Recalculate Rolling Stats
 *
 * Recalculates rolling window statistics for solo_game_stats and rival_game_stats.
 * Updates 30-day, 90-day, 3-month, and 6-month rolling windows.
 *
 * For each user with a stats document, it:
 * 1. Queries their completed games within each time window
 * 2. Recalculates aggregates (avg score, PPR, DPR, bag percentages, etc.)
 * 3. Updates the rolling fields on their stats document
 *
 * Schedule: 0 4 * * * (4am UTC daily)
 *
 * Required Environment Variables:
 * - APPWRITE_FUNCTION_PROJECT_ID: Your project ID
 * - APPWRITE_FUNCTION_API_KEY: API key with database read/write permissions
 * - DATABASE_ID: Your database ID
 * - SOLO_GAMES_COLLECTION_ID: solo_games collection ID
 * - SOLO_GAME_STATS_COLLECTION_ID: solo_game_stats collection ID
 * - RIVAL_GAMES_COLLECTION_ID: rival_games collection ID
 * - RIVAL_GAME_STATS_COLLECTION_ID: rival_game_stats collection ID
 */

import { Client, Databases, Query } from 'node-appwrite';

interface RollingResult {
	totalGames: number;
	totalScore: number;
	bestScore: number;
	totalRoundsPlayed: number;
	totalRoundPoints: number;
	totalBagsIn: number;
	totalBagsOn: number;
	totalBagsOff: number;
	totalFourBaggers: number;
	// Rival-only
	totalWins: number;
	totalDifferentialPoints: number;
}

function emptyResult(): RollingResult {
	return {
		totalGames: 0,
		totalScore: 0,
		bestScore: 0,
		totalRoundsPlayed: 0,
		totalRoundPoints: 0,
		totalBagsIn: 0,
		totalBagsOn: 0,
		totalBagsOff: 0,
		totalFourBaggers: 0,
		totalWins: 0,
		totalDifferentialPoints: 0
	};
}

function getDateCutoffs(): { d30: string; d90: string; m3: string; m6: string } {
	const now = new Date();

	const d30 = new Date(now);
	d30.setDate(d30.getDate() - 30);

	const d90 = new Date(now);
	d90.setDate(d90.getDate() - 90);

	const m3 = new Date(now);
	m3.setMonth(m3.getMonth() - 3);

	const m6 = new Date(now);
	m6.setMonth(m6.getMonth() - 6);

	return {
		d30: d30.toISOString(),
		d90: d90.toISOString(),
		m3: m3.toISOString(),
		m6: m6.toISOString()
	};
}

async function fetchAllDocuments(
	databases: Databases,
	databaseId: string,
	collectionId: string,
	queries: string[]
): Promise<any[]> {
	const docs: any[] = [];
	let offset = 0;
	const limit = 100;

	while (true) {
		const response = await databases.listDocuments(databaseId, collectionId, [
			...queries,
			Query.limit(limit),
			Query.offset(offset)
		]);
		docs.push(...response.documents);
		if (response.documents.length < limit) break;
		offset += limit;
	}
	return docs;
}

export default async function handler({
	req,
	res,
	log,
	error
}: {
	req: { body: string; headers: Record<string, string> };
	res: { json: (data: unknown, status?: number) => void };
	log: (message: string) => void;
	error: (message: string) => void;
}) {
	log('Starting rolling stats recalculation...');

	const client = new Client()
		.setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT || 'https://cloud.appwrite.io/v1')
		.setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || '')
		.setKey(process.env.APPWRITE_FUNCTION_API_KEY || '');

	const databases = new Databases(client);

	const databaseId = process.env.DATABASE_ID || '';
	const soloGamesCol = process.env.SOLO_GAMES_COLLECTION_ID || '';
	const soloStatsCol = process.env.SOLO_GAME_STATS_COLLECTION_ID || '';
	const rivalGamesCol = process.env.RIVAL_GAMES_COLLECTION_ID || '';
	const rivalStatsCol = process.env.RIVAL_GAME_STATS_COLLECTION_ID || '';

	if (!databaseId || !soloGamesCol || !soloStatsCol || !rivalGamesCol || !rivalStatsCol) {
		error('Missing required environment variables');
		return res.json({ success: false, error: 'Missing required environment variables' }, 500);
	}

	const cutoffs = getDateCutoffs();
	let soloUsersUpdated = 0;
	let rivalUsersUpdated = 0;
	const errors: string[] = [];

	// ========================
	// SOLO GAME STATS
	// ========================
	try {
		log('Processing solo game stats...');

		// Get all solo_game_stats documents
		const allSoloStats = await fetchAllDocuments(databases, databaseId, soloStatsCol, []);
		log(`Found ${allSoloStats.length} solo game stats documents`);

		for (const stats of allSoloStats) {
			try {
				const userId = stats.user_id;

				// Fetch games for each window - we fetch from the longest window and filter in memory
				const gamesIn6mo = await fetchAllDocuments(databases, databaseId, soloGamesCol, [
					Query.equal('player', userId),
					Query.equal('status', 'complete'),
					Query.greaterThan('$createdAt', cutoffs.m6)
				]);

				// Compute rolling stats for each window
				const windows = {
					d30: emptyResult(),
					d90: emptyResult(),
					m3: emptyResult(),
					m6: emptyResult()
				};

				for (const game of gamesIn6mo) {
					const createdAt = game.$createdAt;
					const rounds = game.round_scores ? JSON.parse(game.round_scores) : [];
					const roundCount = rounds.length;
					const roundPoints = rounds.reduce((s: number, r: any) => s + (r.round_score || 0), 0);
					const fourBaggers = rounds.filter((r: any) => r.bags_in === 4).length;
					const bagsOff = roundCount * 4 - (game.bags_in || 0) - (game.bags_on || 0);

					const addToWindow = (w: RollingResult) => {
						w.totalGames++;
						w.totalScore += game.score || 0;
						w.bestScore = Math.max(w.bestScore, game.score || 0);
						w.totalRoundsPlayed += roundCount;
						w.totalRoundPoints += roundPoints;
						w.totalBagsIn += game.bags_in || 0;
						w.totalBagsOn += game.bags_on || 0;
						w.totalBagsOff += bagsOff;
						w.totalFourBaggers += fourBaggers;
					};

					// Add to all applicable windows
					addToWindow(windows.m6);
					if (createdAt >= cutoffs.m3) addToWindow(windows.m3);
					if (createdAt >= cutoffs.d90) addToWindow(windows.d90);
					if (createdAt >= cutoffs.d30) addToWindow(windows.d30);
				}

				// Build update payload
				const calcSoloRolling = (w: RollingResult, prefix: string) => {
					const totalBags = w.totalBagsIn + w.totalBagsOn + w.totalBagsOff;
					return {
						[`total_games_${prefix}`]: w.totalGames,
						[`average_score_${prefix}`]: w.totalGames > 0 ? w.totalScore / w.totalGames : 0,
						[`best_score_${prefix}`]: w.bestScore,
						[`ppr_${prefix}`]:
							w.totalRoundsPlayed > 0 ? w.totalRoundPoints / w.totalRoundsPlayed : 0,
						[`in_percentage_${prefix}`]: totalBags > 0 ? (w.totalBagsIn / totalBags) * 100 : 0,
						[`on_percentage_${prefix}`]: totalBags > 0 ? (w.totalBagsOn / totalBags) * 100 : 0
					};
				};

				const updateData = {
					...calcSoloRolling(windows.d30, 'rolling_30'),
					...calcSoloRolling(windows.d90, 'rolling_90'),
					...calcSoloRolling(windows.m3, '3mo'),
					...calcSoloRolling(windows.m6, '6mo')
				};

				await databases.updateDocument(databaseId, soloStatsCol, stats.$id, updateData);
				soloUsersUpdated++;
			} catch (err: any) {
				const msg = `Solo stats error for ${stats.user_id}: ${err.message}`;
				error(msg);
				errors.push(msg);
			}
		}
	} catch (err: any) {
		const msg = `Fatal solo stats error: ${err.message}`;
		error(msg);
		errors.push(msg);
	}

	// ========================
	// RIVAL GAME STATS
	// ========================
	try {
		log('Processing rival game stats...');

		const allRivalStats = await fetchAllDocuments(databases, databaseId, rivalStatsCol, []);
		log(`Found ${allRivalStats.length} rival game stats documents`);

		for (const stats of allRivalStats) {
			try {
				const userId = stats.user_id;

				// Fetch rival games where this user is player_1 or player_2
				const gamesAsP1 = await fetchAllDocuments(databases, databaseId, rivalGamesCol, [
					Query.equal('player_1', userId),
					Query.equal('gameState', 'complete'),
					Query.greaterThan('$createdAt', cutoffs.m6)
				]);

				const gamesAsP2 = await fetchAllDocuments(databases, databaseId, rivalGamesCol, [
					Query.equal('player_2', userId),
					Query.equal('gameState', 'complete'),
					Query.greaterThan('$createdAt', cutoffs.m6)
				]);

				const windows = {
					d30: emptyResult(),
					d90: emptyResult(),
					m3: emptyResult(),
					m6: emptyResult()
				};

				const processGame = (game: any, isPlayer1: boolean) => {
					const createdAt = game.$createdAt;
					const myScore = isPlayer1 ? game.player_1_score || 0 : game.player_2_score || 0;
					const oppScore = isPlayer1 ? game.player_2_score || 0 : game.player_1_score || 0;
					const myBagsIn = isPlayer1 ? game.player_1_bags_in || 0 : game.player_2_bags_in || 0;
					const myBagsOn = isPlayer1 ? game.player_1_bags_on || 0 : game.player_2_bags_on || 0;
					const myBagsOff = isPlayer1 ? game.player_1_bags_off || 0 : game.player_2_bags_off || 0;
					const my4In = isPlayer1 ? game.player_1_4in || 0 : game.player_2_4in || 0;
					const won = myScore > oppScore;

					// Parse round_scores to get per-round data for PPR/DPR
					let roundCount = 0;
					let roundPoints = 0;
					let differentialPoints = 0;

					if (game.round_scores) {
						try {
							const rounds = JSON.parse(game.round_scores);
							roundCount = rounds.length;
							for (const r of rounds) {
								const myRoundScore = isPlayer1 ? r.team1RoundScore || 0 : r.team2RoundScore || 0;
								const oppRoundScore = isPlayer1 ? r.team2RoundScore || 0 : r.team1RoundScore || 0;
								roundPoints += myRoundScore;
								differentialPoints += myRoundScore - oppRoundScore;
							}
						} catch {
							/* ignore parse errors */
						}
					}

					const addToWindow = (w: RollingResult) => {
						w.totalGames++;
						w.totalScore += myScore;
						w.bestScore = Math.max(w.bestScore, myScore);
						w.totalWins += won ? 1 : 0;
						w.totalRoundsPlayed += roundCount;
						w.totalRoundPoints += roundPoints;
						w.totalDifferentialPoints += differentialPoints;
						w.totalBagsIn += myBagsIn;
						w.totalBagsOn += myBagsOn;
						w.totalBagsOff += myBagsOff;
						w.totalFourBaggers += my4In;
					};

					addToWindow(windows.m6);
					if (createdAt >= cutoffs.m3) addToWindow(windows.m3);
					if (createdAt >= cutoffs.d90) addToWindow(windows.d90);
					if (createdAt >= cutoffs.d30) addToWindow(windows.d30);
				};

				for (const game of gamesAsP1) processGame(game, true);
				for (const game of gamesAsP2) processGame(game, false);

				const calcRivalRolling = (w: RollingResult, prefix: string) => {
					const totalBags = w.totalBagsIn + w.totalBagsOn + w.totalBagsOff;
					return {
						[`total_games_${prefix}`]: w.totalGames,
						[`total_wins_${prefix}`]: w.totalWins,
						[`win_percentage_${prefix}`]: w.totalGames > 0 ? (w.totalWins / w.totalGames) * 100 : 0,
						[`average_score_${prefix}`]: w.totalGames > 0 ? w.totalScore / w.totalGames : 0,
						[`ppr_${prefix}`]:
							w.totalRoundsPlayed > 0 ? w.totalRoundPoints / w.totalRoundsPlayed : 0,
						[`dpr_${prefix}`]:
							w.totalRoundsPlayed > 0 ? w.totalDifferentialPoints / w.totalRoundsPlayed : 0,
						[`in_percentage_${prefix}`]: totalBags > 0 ? (w.totalBagsIn / totalBags) * 100 : 0,
						[`on_percentage_${prefix}`]: totalBags > 0 ? (w.totalBagsOn / totalBags) * 100 : 0
					};
				};

				const updateData = {
					...calcRivalRolling(windows.d30, 'rolling_30'),
					...calcRivalRolling(windows.d90, 'rolling_90'),
					...calcRivalRolling(windows.m3, '3mo'),
					...calcRivalRolling(windows.m6, '6mo')
				};

				await databases.updateDocument(databaseId, rivalStatsCol, stats.$id, updateData);
				rivalUsersUpdated++;
			} catch (err: any) {
				const msg = `Rival stats error for ${stats.user_id}: ${err.message}`;
				error(msg);
				errors.push(msg);
			}
		}
	} catch (err: any) {
		const msg = `Fatal rival stats error: ${err.message}`;
		error(msg);
		errors.push(msg);
	}

	const summary = {
		success: errors.length === 0,
		soloUsersUpdated,
		rivalUsersUpdated,
		errors
	};

	log(`Rolling stats recalculation complete: ${JSON.stringify(summary)}`);
	return res.json(summary, errors.length > 0 ? 207 : 200);
}
