import Stripe from 'stripe';
import { Client, Databases, Query, ID } from 'node-appwrite';

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
 * Map Stripe price ID → plan name
 */
function getPlanFromPriceId(priceId) {
  if (priceId === process.env.STRIPE_PRICE_ID_PLAYER_MONTHLY) return 'player';
  if (priceId === process.env.STRIPE_PRICE_ID_PLAYER_YEARLY) return 'player';
  if (priceId === process.env.STRIPE_PRICE_ID_DIRECTOR_MONTHLY) return 'director';
  if (priceId === process.env.STRIPE_PRICE_ID_DIRECTOR_YEARLY) return 'director';
  return 'free';
}

/**
 * Find user document by auth_id and update billing fields
 */
async function updateUserBilling(databases, authId, data) {
  const users = await databases.listDocuments(DB_ID, COL_USERS, [
    Query.equal('auth_id', authId),
  ]);

  if (users.documents.length === 0) {
    throw new Error(`User not found for auth_id: ${authId}`);
  }

  const updateData = { ...data };
  // Map 'plan' key to 'subscription' field name
  if (data.plan !== undefined) {
    updateData.subscription = data.plan;
    delete updateData.plan;
  }
  if (data.status !== undefined) {
    updateData.billing_status = data.status;
    delete updateData.status;
  }

  await databases.updateDocument(DB_ID, COL_USERS, users.documents[0].$id, updateData);
}

/**
 * Billing webhook handler
 * 
 * Handles Stripe webhook events:
 *   - checkout.session.completed
 *   - customer.subscription.updated
 *   - customer.subscription.deleted
 *   - invoice.payment_failed
 */
export default async ({ req, res, log, error }) => {
  const headers = {
    'Access-Control-Allow-Origin': process.env.APP_URL || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Stripe-Signature',
  };

  if (req.method === 'OPTIONS') {
    return res.empty(204, headers);
  }

  if (req.method !== 'POST') {
    return res.json({ error: 'Method not allowed' }, 405, headers);
  }

  try {
    // Verify Stripe signature
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      error(`Webhook signature verification failed: ${err.message}`);
      return res.json({ error: 'Invalid signature' }, 400, headers);
    }

    const { databases } = getAdminClient();

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        const plan = session.metadata?.plan || 'player';

        if (!userId) {
          error('checkout.session.completed: Missing userId in metadata');
          break;
        }

        // Fetch the subscription for billing period info
        let billingEnd = null;
        if (session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          billingEnd = new Date(sub.current_period_end * 1000).toISOString();
        }

        await updateUserBilling(databases, userId, {
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
          plan: plan,
          status: 'active',
          billing_period_end: billingEnd,
        });

        log(`checkout.session.completed: ${userId} → ${plan}`);
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const userId = subscription.metadata?.userId;

        if (!userId) {
          error('customer.subscription.updated: Missing userId in metadata');
          break;
        }

        const plan = getPlanFromPriceId(subscription.items.data[0]?.price?.id);
        const billingStatus = subscription.cancel_at_period_end ? 'cancelling' : 'active';
        const billingEnd = new Date(subscription.current_period_end * 1000).toISOString();

        await updateUserBilling(databases, userId, {
          plan: plan,
          status: billingStatus,
          billing_period_end: billingEnd,
        });

        log(`customer.subscription.updated: ${userId} → ${plan} (${billingStatus})`);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const userId = subscription.metadata?.userId;

        if (!userId) {
          error('customer.subscription.deleted: Missing userId in metadata');
          break;
        }

        await updateUserBilling(databases, userId, {
          plan: 'free',
          status: 'cancelled',
          stripe_subscription_id: null,
          billing_period_end: null,
        });

        log(`customer.subscription.deleted: ${userId} → free`);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;

        // Find user by stripe customer ID
        const users = await databases.listDocuments(DB_ID, COL_USERS, [
          Query.equal('stripe_customer_id', customerId),
        ]);

        if (users.documents.length > 0) {
          const doc = users.documents[0];
          await databases.updateDocument(DB_ID, COL_USERS, doc.$id, {
            billing_status: 'past_due',
          });
          log(`invoice.payment_failed: customer ${customerId} → past_due`);
        }
        break;
      }

      default:
        log(`Unhandled event type: ${event.type}`);
    }

    return res.json({ received: true }, 200, headers);
  } catch (e) {
    error(`Billing webhook error: ${e.message}`);
    return res.json({ error: 'Internal server error' }, 500, headers);
  }
};
