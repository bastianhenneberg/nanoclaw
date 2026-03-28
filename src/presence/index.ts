/**
 * Presence Tracker Module
 *
 * WhatsApp presence tracking as an optional NanoClaw feature.
 *
 * Enable via .env:
 *   PRESENCE_TRACKER_ENABLED=true
 *   PRESENCE_ALERT_CHAT_ID=tg:-5284494721
 *
 * Usage:
 *   await initPresenceTracker(config, alertSender);
 *   await startPresenceTracker();
 *   await stopPresenceTracker();
 */

import path from 'path';

import { logger } from '../logger.js';
import { configureAlerts, AlertSender } from './alerts.js';
import { initPresenceDb, closePresenceDb } from './db.js';
import { PresenceTracker } from './tracker.js';
import { PresenceTrackerConfig } from './types.js';

export { PresenceTracker } from './tracker.js';
export type { DailyStats, PresenceEvent, TrackedNumber } from './types.js';

let tracker: PresenceTracker | null = null;
let config: PresenceTrackerConfig | null = null;

/**
 * Initialize the presence tracker module.
 * Call before startPresenceTracker().
 */
export function initPresenceTracker(
  cfg: PresenceTrackerConfig,
  alertSender?: AlertSender,
): void {
  if (!cfg.enabled) {
    logger.info('Presence tracker disabled (PRESENCE_TRACKER_ENABLED != true)');
    return;
  }

  config = cfg;
  initPresenceDb(cfg.dbPath);

  if (alertSender && cfg.alertChatId) {
    configureAlerts(alertSender, cfg.alertChatId);
  }

  tracker = new PresenceTracker(cfg.authDir, path.dirname(cfg.dbPath));
  logger.info('Presence tracker initialized');
}

/**
 * Start the presence tracker (connect to WhatsApp).
 */
export async function startPresenceTracker(): Promise<void> {
  if (!tracker) {
    logger.debug('Presence tracker not initialized, skipping start');
    return;
  }

  try {
    await tracker.start();
  } catch (err) {
    logger.error({ err }, 'Failed to start presence tracker');
  }
}

/**
 * Stop the presence tracker (disconnect from WhatsApp).
 */
export async function stopPresenceTracker(): Promise<void> {
  if (tracker) {
    await tracker.stop();
    tracker = null;
  }
  closePresenceDb();
  config = null;
}

/**
 * Get the tracker instance for API access.
 */
export function getPresenceTracker(): PresenceTracker | null {
  return tracker;
}

/**
 * Check if presence tracker is enabled and initialized.
 */
export function isPresenceTrackerEnabled(): boolean {
  return tracker !== null;
}
