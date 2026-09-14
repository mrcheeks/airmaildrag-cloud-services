/**
 * Appwrite Function: Send Push Notification
 * 
 * This function sends push notifications to specified users when their court is ready.
 * Deploy this as an Appwrite Function.
 * 
 * Required Environment Variables (set in Appwrite Console):
 * - APPWRITE_FUNCTION_PROJECT_ID: Your project ID
 * - APPWRITE_FUNCTION_API_KEY: API key with messaging.messages.create scope
 * 
 * Request Payload:
 * {
 *   userIds: string[],     // Array of user IDs to notify
 *   title: string,         // Notification title
 *   body: string,          // Notification body
 *   data?: object,         // Optional custom data
 *   url?: string           // Optional URL to open on click
 * }
 */

import { Client, ID, Messaging, Users } from 'node-appwrite';

interface RequestPayload {
  userIds: string[];
  title: string;
  body: string;
  data?: Record<string, string>;
  url?: string;
}

export default async function handler({ req, res, log, error }: {
  req: { body: string; headers: Record<string, string> };
  res: { json: (data: unknown, status?: number) => void; send: (data: string, status?: number) => void };
  log: (message: string) => void;
  error: (message: string) => void;
}) {
  // Initialize Appwrite client
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT || 'https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || '')
    .setKey(process.env.APPWRITE_FUNCTION_API_KEY || '');

  const messaging = new Messaging(client);
  const users = new Users(client);

  try {
    // Parse request payload
    const payload: RequestPayload = JSON.parse(req.body || '{}');
    
    if (!payload.userIds || payload.userIds.length === 0) {
      return res.json({ success: false, error: 'No user IDs provided' }, 400);
    }

    if (!payload.title || !payload.body) {
      return res.json({ success: false, error: 'Title and body are required' }, 400);
    }

    log(`Sending push notification to ${payload.userIds.length} users: "${payload.title}"`);

    // Get push targets for each user
    const targetIds: string[] = [];
    
    for (const userId of payload.userIds) {
      try {
        // Get user's targets (registered devices)
        const userTargets = await users.listTargets(userId);
        
        for (const target of userTargets.targets) {
          // Only include push notification targets
          if (target.providerType === 'push') {
            targetIds.push(target.$id);
          }
        }
      } catch (e) {
        log(`Could not get targets for user ${userId}: ${e}`);
      }
    }

    if (targetIds.length === 0) {
      log('No push targets found for specified users');
      return res.json({ 
        success: false, 
        error: 'No registered devices found for these users',
        usersChecked: payload.userIds.length 
      }, 200);
    }

    log(`Found ${targetIds.length} push targets`);

    // Create and send the push notification
    // createPush(messageId, title, body, topics, users, targets, data, action, image, icon, sound, color, tag, badge, draft, scheduledAt)
    const message = await messaging.createPush(
      ID.unique(), // messageId
      payload.title, // title
      payload.body, // body
      [], // topics (not using)
      [], // users (not using user IDs directly)
      targetIds, // targets - the actual target IDs
      payload.data || {}, // data payload
      payload.url || undefined, // action - URL to open
      undefined, // image
      '/images/AIRMAILDRAGLOGO.svg', // icon
      undefined, // sound
      undefined, // color
      undefined, // tag
      undefined, // badge
      false, // draft
      undefined // scheduledAt
    );

    log(`Push notification sent: ${message.$id}`);

    return res.json({
      success: true,
      messageId: message.$id,
      targetCount: targetIds.length
    });

  } catch (e) {
    error(`Failed to send push notification: ${e}`);
    return res.json({ 
      success: false, 
      error: e instanceof Error ? e.message : 'Unknown error' 
    }, 500);
  }
}
