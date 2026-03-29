/**
 * WhatsApp Presence Tracker
 *
 * Tracks when contacts go online/offline and calculates usage statistics.
 * Integrated with NanoClaw as an optional feature module.
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  WASocket,
  BaileysEventMap,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  ConnectionState,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import pino from 'pino';
import QRCode from 'qrcode';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - no types available
import qrcode from 'qrcode-terminal';
import path from 'path';

import { logger } from '../logger.js';
import { sendPresenceAlert } from './alerts.js';
import {
  addTrackedNumber,
  getEventsSince,
  getNumberLabel,
  getRecentEvents,
  getTrackedJids,
  getTrackedNumbers,
  insertPresenceEvent,
  removeTrackedNumber,
} from './db.js';
import { DailyStats, PresenceEvent, TrackedNumber } from './types.js';

export class PresenceTracker {
  private sock: WASocket | null = null;
  private trackedJids: Set<string> = new Set();
  private lidToJid: Map<string, string> = new Map(); // LID -> phone JID mapping
  private currentSessions: Map<string, number> = new Map(); // jid -> online start timestamp
  private authDir: string;
  private storeDir: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isShuttingDown = false;

  constructor(authDir: string, storeDir: string) {
    this.authDir = authDir;
    this.storeDir = storeDir;
  }

  async start(): Promise<void> {
    this.isShuttingDown = false;

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    const silentLogger = pino({ level: 'silent' });

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
      },
      browser: ['NanoClaw Presence', 'Chrome', '120.0.0'],
      logger: silentLogger,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      // Note: markOnlineOnConnect: false would hide online status but breaks presence subscriptions
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
      this.handleConnectionUpdate(update);
    });

    this.sock.ev.on('presence.update', (update) => {
      this.handlePresenceUpdate(update);
    });
  }

  private handleConnectionUpdate(update: Partial<ConnectionState>): void {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('Presence tracker: QR code generated, scan with WhatsApp');
      console.log('\n📱 Scan this QR code with WhatsApp:\n');
      qrcode.generate(qr, { small: true });
      console.log('\nWhatsApp > Settings > Linked Devices > Link a Device\n');

      // Save QR as image
      const qrPath = path.join(this.storeDir, 'presence-qr.png');
      QRCode.toFile(
        qrPath,
        qr,
        { width: 400 },
        (err: Error | null | undefined) => {
          if (!err) logger.info({ qrPath }, 'QR code saved');
        },
      );
    }

    if (connection === 'close') {
      const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect =
        reason !== DisconnectReason.loggedOut && !this.isShuttingDown;

      logger.info(
        { reason: DisconnectReason[reason] || reason },
        'Presence tracker disconnected',
      );

      if (shouldReconnect) {
        logger.info('Presence tracker reconnecting in 5s...');
        this.reconnectTimer = setTimeout(() => this.start(), 5000);
      } else if (reason === DisconnectReason.loggedOut) {
        logger.warn(
          'Presence tracker logged out. Delete store/presence-auth/ and restart to re-authenticate.',
        );
      }
    }

    if (connection === 'open') {
      logger.info('Presence tracker connected to WhatsApp');
      this.loadTrackedNumbers();
      this.subscribeToAll();
    }
  }

  private loadTrackedNumbers(): void {
    const jids = getTrackedJids();
    this.trackedJids = new Set(jids);

    // Load LID mappings for tracked numbers
    this.loadLidMappings();

    logger.info(
      { count: this.trackedJids.size, lidMappings: this.lidToJid.size },
      'Presence tracker loaded tracked numbers',
    );
  }

  private loadLidMappings(): void {
    this.lidToJid.clear();

    // Read LID mapping files from auth directory
    // Format: lid-mapping-{phoneNumber}.json contains the LID as a string
    try {
      const files = fs.readdirSync(this.authDir);
      for (const file of files) {
        const match = file.match(/^lid-mapping-(\d+)\.json$/);
        if (match) {
          const phone = match[1];
          const jid = `${phone}@s.whatsapp.net`;

          // Only load mappings for tracked numbers
          if (this.trackedJids.has(jid)) {
            try {
              const lidStr = fs.readFileSync(
                path.join(this.authDir, file),
                'utf-8',
              );
              const lid = JSON.parse(lidStr);
              const lidJid = `${lid}@lid`;
              this.lidToJid.set(lidJid, jid);
              logger.debug({ phone, lid, lidJid }, 'Loaded LID mapping');
            } catch (err) {
              logger.warn({ file, err }, 'Failed to read LID mapping file');
            }
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to read LID mappings from auth directory');
    }
  }

  private async subscribeToAll(): Promise<void> {
    for (const jid of Array.from(this.trackedJids)) {
      await this.subscribeToPresence(jid);
    }
  }

  private async subscribeToPresence(jid: string): Promise<void> {
    if (!this.sock) return;

    try {
      await this.sock.presenceSubscribe(jid);
      logger.debug({ jid }, 'Subscribed to presence');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to subscribe to presence');
    }
  }

  private handlePresenceUpdate(
    update: BaileysEventMap['presence.update'],
  ): void {
    const { presences } = update;

    for (let [jid, presence] of Object.entries(presences)) {
      // Convert LID to phone JID if we have a mapping
      const phoneJid = this.lidToJid.get(jid);
      if (phoneJid) {
        jid = phoneJid;
      }

      if (!this.trackedJids.has(jid)) continue;

      const status = presence.lastKnownPresence;
      const timestamp = Date.now();

      // Log the event
      insertPresenceEvent(jid, status, timestamp);

      // Track sessions and send alerts
      const name = this.formatJid(jid);
      const timeStr = new Date(timestamp).toLocaleTimeString('de-DE');

      if (status === 'available') {
        if (!this.currentSessions.has(jid)) {
          this.currentSessions.set(jid, timestamp);
          const msg = `🟢 <b>${name}</b> online @ ${timeStr}`;
          logger.info({ jid, name }, 'Contact online');
          sendPresenceAlert(msg);
        }
      } else if (status === 'unavailable') {
        const sessionStart = this.currentSessions.get(jid);
        if (sessionStart) {
          const duration = Math.round((timestamp - sessionStart) / 1000 / 60);
          const msg = `🔴 <b>${name}</b> offline @ ${timeStr} (${duration}min Session)`;
          logger.info({ jid, name, duration }, 'Contact offline');
          sendPresenceAlert(msg);
          this.currentSessions.delete(jid);
        }
      }
      // Note: 'composing' status is logged but not alerted (too spammy)
    }
  }

  private formatJid(jid: string): string {
    const label = getNumberLabel(jid);
    if (label) return label;
    return jid.replace('@s.whatsapp.net', '');
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {
        // Ignore errors during shutdown
      }
      this.sock = null;
    }

    logger.info('Presence tracker stopped');
  }

  // --- Public API ---

  addNumber(phone: string, label?: string): boolean {
    const jid = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';

    try {
      addTrackedNumber(jid, label || null);
      this.trackedJids.add(jid);

      if (this.sock) {
        this.subscribeToPresence(jid);
      }

      logger.info({ jid, label }, 'Added number to tracking');
      return true;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to add number');
      return false;
    }
  }

  removeNumber(phone: string): boolean {
    const jid = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';

    try {
      removeTrackedNumber(jid);
      this.trackedJids.delete(jid);
      this.currentSessions.delete(jid);
      logger.info({ jid }, 'Removed number from tracking');
      return true;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to remove number');
      return false;
    }
  }

  listTracked(): TrackedNumber[] {
    return getTrackedNumbers();
  }

  getStats(phone: string, days: number = 7): DailyStats[] {
    const jid = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    const events = getEventsSince(jid, since);

    // Group by day and calculate stats
    const dailyMap = new Map<
      string,
      { sessions: number; totalMs: number; firstSeen: number; lastSeen: number }
    >();

    let sessionStart: number | null = null;

    for (const event of events) {
      const date = new Date(event.timestamp).toISOString().split('T')[0];

      if (!dailyMap.has(date)) {
        dailyMap.set(date, {
          sessions: 0,
          totalMs: 0,
          firstSeen: event.timestamp,
          lastSeen: event.timestamp,
        });
      }

      const day = dailyMap.get(date)!;
      day.lastSeen = event.timestamp;

      if (event.status === 'available' && sessionStart === null) {
        sessionStart = event.timestamp;
        day.sessions++;
      } else if (event.status === 'unavailable' && sessionStart !== null) {
        day.totalMs += event.timestamp - sessionStart;
        sessionStart = null;
      }
    }

    return Array.from(dailyMap.entries()).map(([date, stats]) => ({
      date,
      jid,
      sessions: stats.sessions,
      totalMinutes: Math.round(stats.totalMs / 1000 / 60),
      firstSeen: new Date(stats.firstSeen).toLocaleTimeString(),
      lastSeen: new Date(stats.lastSeen).toLocaleTimeString(),
    }));
  }

  getRecentEvents(phone: string, limit: number = 50): PresenceEvent[] {
    const jid = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    return getRecentEvents(jid, limit);
  }

  isConnected(): boolean {
    return this.sock !== null;
  }
}
