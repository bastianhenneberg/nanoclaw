/**
 * WhatsApp Presence Tracker
 * Tracks when contacts go online/offline and calculates usage statistics.
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  WASocket,
  BaileysEventMap,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - no types available
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import pino from 'pino';

const STORE_DIR = path.join(process.cwd(), 'store');
const AUTH_DIR = path.join(STORE_DIR, 'presence-auth');
const DB_PATH = path.join(STORE_DIR, 'presence-tracker.db');

// Telegram notifications
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID || '-5284494721'; // InfraMonitor

interface PresenceEvent {
  jid: string;
  status: string;
  timestamp: number;
}

interface DailyStats {
  date: string;
  jid: string;
  sessions: number;
  totalMinutes: number;
  firstSeen: string;
  lastSeen: string;
}

async function sendTelegramAlert(message: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('[TG] No bot token configured, skipping alert');
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
      }),
    });

    if (!response.ok) {
      console.error('[TG] Failed to send alert:', await response.text());
    }
  } catch (err) {
    console.error('[TG] Error sending alert:', err);
  }
}

export class PresenceTracker {
  private sock: WASocket | null = null;
  private db: Database.Database;
  private trackedJids: Set<string> = new Set();
  private currentSessions: Map<string, number> = new Map(); // jid -> online start timestamp

  constructor() {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    this.db = new Database(DB_PATH);
    this.initDb();
  }

  private initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS presence_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jid TEXT NOT NULL,
        status TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      
      CREATE INDEX IF NOT EXISTS idx_presence_jid_ts ON presence_events(jid, timestamp);
      
      CREATE TABLE IF NOT EXISTS tracked_numbers (
        jid TEXT PRIMARY KEY,
        label TEXT,
        added_at INTEGER NOT NULL
      );
    `);
  }

  async start() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const logger = pino({ level: 'silent' });

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: ['Presence Tracker', 'Chrome', '120.0.0'],
      logger,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('\n📱 Scan this QR code with WhatsApp:\n');
        qrcode.generate(qr, { small: true });
        console.log('\nWhatsApp > Settings > Linked Devices > Link a Device\n');

        // Also save as image
        const qrPath = path.join(STORE_DIR, 'qr-code.png');
        QRCode.toFile(
          qrPath,
          qr,
          { width: 400 },
          (err: Error | null | undefined) => {
            if (!err) console.log(`QR saved to: ${qrPath}`);
          },
        );
      }

      if (connection === 'close') {
        const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;

        console.log(
          `Connection closed. Reason: ${DisconnectReason[reason] || reason}`,
        );

        if (shouldReconnect) {
          console.log('Reconnecting in 3s...');
          setTimeout(() => this.start(), 3000);
        } else {
          console.log(
            'Logged out. Delete store/presence-auth/ and restart to re-authenticate.',
          );
        }
      }

      if (connection === 'open') {
        console.log('✅ Connected to WhatsApp');
        this.loadTrackedNumbers();
        this.subscribeToAll();
      }
    });

    this.sock.ev.on('presence.update', (update) => {
      this.handlePresenceUpdate(update);
    });
  }

  private loadTrackedNumbers() {
    const rows = this.db.prepare('SELECT jid FROM tracked_numbers').all() as {
      jid: string;
    }[];
    this.trackedJids = new Set(rows.map((r) => r.jid));
    console.log(`📋 Loaded ${this.trackedJids.size} tracked numbers`);
  }

  private async subscribeToAll() {
    for (const jid of Array.from(this.trackedJids)) {
      await this.subscribeToPresence(jid);
    }
  }

  private async subscribeToPresence(jid: string) {
    if (!this.sock) return;

    try {
      await this.sock.presenceSubscribe(jid);
      console.log(`👁️ Subscribed to presence: ${jid}`);
    } catch (err) {
      console.error(`Failed to subscribe to ${jid}:`, err);
    }
  }

  private handlePresenceUpdate(update: BaileysEventMap['presence.update']) {
    const { id, presences } = update;

    for (const [jid, presence] of Object.entries(presences)) {
      if (!this.trackedJids.has(jid)) continue;

      const status = presence.lastKnownPresence;
      const timestamp = Date.now();

      // Log the event
      this.db
        .prepare(
          'INSERT INTO presence_events (jid, status, timestamp) VALUES (?, ?, ?)',
        )
        .run(jid, status, timestamp);

      // Track sessions
      const name = this.formatJid(jid);
      const timeStr = new Date(timestamp).toLocaleTimeString('de-DE');

      if (status === 'available') {
        if (!this.currentSessions.has(jid)) {
          this.currentSessions.set(jid, timestamp);
          const msg = `🟢 <b>${name}</b> online @ ${timeStr}`;
          console.log(msg.replace(/<[^>]+>/g, ''));
          sendTelegramAlert(msg);
        }
      } else if (status === 'unavailable') {
        const sessionStart = this.currentSessions.get(jid);
        if (sessionStart) {
          const duration = Math.round((timestamp - sessionStart) / 1000 / 60);
          const msg = `🔴 <b>${name}</b> offline @ ${timeStr} (${duration}min Session)`;
          console.log(msg.replace(/<[^>]+>/g, ''));
          sendTelegramAlert(msg);
          this.currentSessions.delete(jid);
        }
      } else if (status === 'composing') {
        console.log(`✍️ ${name} typing...`);
        // Don't send typing notifications to Telegram (too spammy)
      }
    }
  }

  private formatJid(jid: string): string {
    const row = this.db
      .prepare('SELECT label FROM tracked_numbers WHERE jid = ?')
      .get(jid) as { label?: string } | undefined;
    if (row?.label) return row.label;
    return jid.replace('@s.whatsapp.net', '');
  }

  // Public API

  addNumber(phone: string, label?: string): boolean {
    const jid = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';

    try {
      this.db
        .prepare(
          'INSERT OR REPLACE INTO tracked_numbers (jid, label, added_at) VALUES (?, ?, ?)',
        )
        .run(jid, label || null, Date.now());

      this.trackedJids.add(jid);

      if (this.sock) {
        this.subscribeToPresence(jid);
      }

      console.log(`➕ Added ${label || phone} (${jid}) to tracking`);
      return true;
    } catch (err) {
      console.error('Failed to add number:', err);
      return false;
    }
  }

  removeNumber(phone: string): boolean {
    const jid = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';

    try {
      this.db.prepare('DELETE FROM tracked_numbers WHERE jid = ?').run(jid);
      this.trackedJids.delete(jid);
      console.log(`➖ Removed ${jid} from tracking`);
      return true;
    } catch (err) {
      console.error('Failed to remove number:', err);
      return false;
    }
  }

  listTracked(): Array<{ jid: string; label: string | null; addedAt: number }> {
    return this.db
      .prepare('SELECT jid, label, added_at as addedAt FROM tracked_numbers')
      .all() as Array<{ jid: string; label: string | null; addedAt: number }>;
  }

  getStats(phone: string, days: number = 7): DailyStats[] {
    const jid = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    const events = this.db
      .prepare(
        `
      SELECT status, timestamp 
      FROM presence_events 
      WHERE jid = ? AND timestamp > ?
      ORDER BY timestamp ASC
    `,
      )
      .all(jid, since) as PresenceEvent[];

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

    return this.db
      .prepare(
        `
      SELECT jid, status, timestamp 
      FROM presence_events 
      WHERE jid = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `,
      )
      .all(jid, limit) as PresenceEvent[];
  }
}

// CLI Interface
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const tracker = new PresenceTracker();

  switch (command) {
    case 'start':
      await tracker.start();
      break;

    case 'add':
      if (!args[1]) {
        console.log('Usage: presence-tracker add <phone> [label]');
        process.exit(1);
      }
      tracker.addNumber(args[1], args[2]);
      break;

    case 'remove':
      if (!args[1]) {
        console.log('Usage: presence-tracker remove <phone>');
        process.exit(1);
      }
      tracker.removeNumber(args[1]);
      break;

    case 'list':
      const tracked = tracker.listTracked();
      if (tracked.length === 0) {
        console.log(
          'No numbers tracked yet. Use: presence-tracker add <phone> [label]',
        );
      } else {
        console.log('\nTracked numbers:');
        for (const t of tracked) {
          console.log(`  ${t.label || 'unnamed'}: ${t.jid}`);
        }
      }
      break;

    case 'stats':
      if (!args[1]) {
        console.log('Usage: presence-tracker stats <phone> [days=7]');
        process.exit(1);
      }
      const stats = tracker.getStats(args[1], parseInt(args[2]) || 7);
      if (stats.length === 0) {
        console.log('No data yet for this number.');
      } else {
        console.log('\nDaily statistics:');
        console.log(
          'Date       | Sessions | Online Time | First Seen | Last Seen',
        );
        console.log('-'.repeat(65));
        for (const s of stats) {
          console.log(
            `${s.date} | ${String(s.sessions).padStart(8)} | ${String(s.totalMinutes).padStart(7)}min | ${s.firstSeen.padStart(10)} | ${s.lastSeen}`,
          );
        }
      }
      break;

    case 'events':
      if (!args[1]) {
        console.log('Usage: presence-tracker events <phone> [limit=50]');
        process.exit(1);
      }
      const events = tracker.getRecentEvents(args[1], parseInt(args[2]) || 50);
      if (events.length === 0) {
        console.log('No events yet for this number.');
      } else {
        console.log('\nRecent events:');
        for (const e of events) {
          const time = new Date(e.timestamp).toLocaleString();
          const icon =
            e.status === 'available'
              ? '🟢'
              : e.status === 'unavailable'
                ? '🔴'
                : '✍️';
          console.log(`${icon} ${time} - ${e.status}`);
        }
      }
      break;

    default:
      console.log(`
WhatsApp Presence Tracker

Usage:
  npx tsx src/presence-tracker.ts <command> [args]

Commands:
  start                     Start the tracker (shows QR code on first run)
  add <phone> [label]       Add a phone number to track
  remove <phone>            Remove a phone number from tracking
  list                      List all tracked numbers
  stats <phone> [days=7]    Show daily statistics for a number
  events <phone> [limit=50] Show recent presence events

Examples:
  npx tsx src/presence-tracker.ts start
  npx tsx src/presence-tracker.ts add 491234567890 "Max"
  npx tsx src/presence-tracker.ts stats 491234567890 14
`);
  }
}

main().catch(console.error);
