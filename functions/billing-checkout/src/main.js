import Stripe from 'stripe';
import { Client, Databases, Query } from 'node-appwrite';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const DB_ID = process.env.DB_ID;
const COL_USERS = process.env.COL_USERS;

function getAdminClient() {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT)
    .setProject(process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);
  return { client, databases: new Databases(client) };
}

/**
 * Billing checkout function
 * 
 * Actions:
 *   checkout  — Create a Stripe Checkout Session for a new subscription
 *   portal    — Create a Stripe Customer Portal session for managing billing
 * 
 * Body: { action, plan?, userId, userEmail }
 */
export default async ({ req, res, log, error }) => {
  // CORS headers for browser requests
  const headers = {
    'Access-Control-Allow-Origin': process.env.APP_URL || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    return res.empty(204, headers);
  }

  if (req.method !== 'POST') {
    return res.json({ error: 'Method not allowed' }, 405, headers);
  }

  try {
    const body = JSON.parse(req.body || '{}');
    const { action, plan, userId, userEmail } = body;

    if (!userId || !userEmail) {
      return res.json({ error: 'Missing userId or userEmail' }, 400, headers);
    }

    const { databases } = getAdminClient();

    // Look up existing user record (may have stripe_customer_id)
    let userDoc = null;
    try {
      const existing = await databases.listDocuments(DB_ID, COL_USERS, [
        Query.equal('auth_id', userId),
      ]);
      if (existing.documents.length > 0) {
        userDoc = existing.documents[0];
      }
    } catch (e) {
      log('No existing user record found');
    }

    if (action === 'checkout') {
      if (!plan) {
        return res.json({ error: 'Missing plan' }, 400, headers);
      }

      // Map plan + interval to Stripe price ID
      // plan format: "player_monthly", "player_yearly", "director_monthly", "director_yearly"
      const priceMap = {
        player_monthly: process.env.STRIPE_PRICE_ID_PLAYER_MONTHLY,
        player_yearly: process.env.STRIPE_PRICE_ID_PLAYER_YEARLY,
        director_monthly: process.env.STRIPE_PRICE_ID_DIRECTOR_MONTHLY,
        director_yearly: process.env.STRIPE_PRICE_ID_DIRECTOR_YEARLY,
      };

      const priceId = priceMap[plan];
      if (!priceId) {
        return res.json({ error: `Invalid plan: ${plan}` }, 400, headers);
      }

      // Extract base plan name (player/director) for metadata
      const basePlan = plan.startsWith('director') ? 'director' : 'player';

      // Reuse existing Stripe customer or create new one
      let customerId = userDoc?.stripe_customer_id;

      if (!customerId) {
        const customer = await stripe.customers.create({
          email: userEmail,
          metadata: { userId },
        });
        customerId = customer.id;
      }

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${process.env.APP_URL}/subscriptions?billing=success`,
        cancel_url: `${process.env.APP_URL}/subscriptions?billing=cancelled`,
        metadata: { userId, plan: basePlan },
        subscription_data: {
          metadata: { userId, plan: basePlan },
        },
      });

      log(`Checkout session created for user ${userId}, plan ${plan}`);
      return res.json({ url: session.url }, 200, headers);

    } else if (action === 'portal') {
      if (!userDoc?.stripe_customer_id) {
        return res.json({ error: 'No billing account found. Subscribe first.' }, 400, headers);
      }

      const portalSession = await stripe.billingPortal.sessions.create({
        customer: userDoc.stripe_customer_id,
        return_url: `${process.env.APP_URL}/subscriptions`,
      });

      log(`Portal session created for user ${userId}`);
      return res.json({ url: portalSession.url }, 200, headers);

    } else {
      return res.json({ error: `Unknown action: ${action}` }, 400, headers);
    }
  } catch (e) {
    error(`Billing checkout error: ${e.message}`);
    return res.json({ error: 'Internal server error' }, 500, headers);
  }
};
