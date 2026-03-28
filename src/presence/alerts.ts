/**
 * Presence Tracker Alerts
 *
 * Sends alerts via Telegram using NanoClaw's existing channel infrastructure.
 */

import { logger } from '../logger.js';

export type AlertSender = (chatId: string, message: string) => Promise<void>;

let alertSender: AlertSender | null = null;
let alertChatId: string | null = null;

export function configureAlerts(
  sender: AlertSender,
  chatId: string,
): void {
  alertSender = sender;
  alertChatId = chatId;
  logger.info({ chatId }, 'Presence alerts configured');
}

export async function sendPresenceAlert(message: string): Promise<void> {
  if (!alertSender || !alertChatId) {
    logger.debug({ message }, 'Presence alert skipped (not configured)');
    return;
  }

  try {
    await alertSender(alertChatId, message);
  } catch (err) {
    logger.error({ err, message }, 'Failed to send presence alert');
  }
}

export function isAlertsConfigured(): boolean {
  return alertSender !== null && alertChatId !== null;
}
