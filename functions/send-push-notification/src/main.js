const { Client, Databases } = require('node-appwrite');
const webpush = require('web-push');

module.exports = async function({ req, res, log, error }) {
  // Initialize Appwrite client
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT || 'https://syd.cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || '')
    .setKey(process.env.APPWRITE_FUNCTION_API_KEY || '');

  const databases = new Databases(client);
  
  // Database IDs
  const DATABASE_ID = process.env.DATABASE_ID || '6868c5320038da5d0e63';
  const USERS_COLLECTION = process.env.USERS_COLLECTION || '6868c550003e370efd7b';

  // Configure web-push with VAPID keys
  const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
  const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:support@airmaildrag.com';

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    error('VAPID keys not configured');
    return res.json({ success: false, error: 'VAPID keys not configured' }, 500);
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  try {
    // Parse request payload
    const payload = JSON.parse(req.body || '{}');
    
    if (!payload.userIds || payload.userIds.length === 0) {
      return res.json({ success: false, error: 'No user IDs provided' }, 400);
    }

    if (!payload.title || !payload.body) {
      return res.json({ success: false, error: 'Title and body are required' }, 400);
    }

    log(`Sending push notification to ${payload.userIds.length} users: "${payload.title}"`);

    // Prepare notification payload
    const notificationPayload = JSON.stringify({
      title: payload.title,
      body: payload.body,
      icon: payload.icon || '/images/AIRMAILDRAGLOGO.svg',
      badge: payload.badge || '/images/AIRMAILDRAGLOGO.svg',
      data: payload.data || {},
      url: payload.url || '/'
    });

    // Get subscriptions for each user and send notifications
    const results = [];
    
    for (const userId of payload.userIds) {
      try {
        log(`Getting subscription for user ${userId}`);
        
        // Get user document with push_subscription
        const user = await databases.getDocument(DATABASE_ID, USERS_COLLECTION, userId);
        
        if (!user.push_subscription) {
          log(`No push subscription for user ${userId}`);
          results.push({ userId, success: false, error: 'No subscription' });
          continue;
        }

        const subscription = JSON.parse(user.push_subscription);
        log(`Found subscription for user ${userId}, endpoint: ${subscription.endpoint?.substring(0, 50)}...`);

        // Send push notification using web-push
        try {
          await webpush.sendNotification(subscription, notificationPayload);
          log(`Push sent successfully to user ${userId}`);
          results.push({ userId, success: true });
        } catch (pushError) {
          log(`Failed to send push to user ${userId}: ${pushError.message}`);
          
          // If subscription is expired/invalid, clear it
          if (pushError.statusCode === 410 || pushError.statusCode === 404) {
            log(`Subscription expired for user ${userId}, clearing...`);
            await databases.updateDocument(DATABASE_ID, USERS_COLLECTION, userId, {
              push_subscription: null
            });
          }
          
          results.push({ userId, success: false, error: pushError.message });
        }
      } catch (e) {
        log(`Error processing user ${userId}: ${e.message}`);
        results.push({ userId, success: false, error: e.message });
      }
    }

    const successCount = results.filter(r => r.success).length;
    log(`Push notifications sent: ${successCount}/${results.length} successful`);

    return res.json({
      success: successCount > 0,
      sent: successCount,
      total: results.length,
      results
    });
  } catch (err) {
    error(`Push notification error: ${err.message}`);
    return res.json({ 
      success: false, 
      error: err.message 
    }, 500);
  }
};