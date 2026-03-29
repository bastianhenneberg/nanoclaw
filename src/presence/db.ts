/**
 * Presence Tracker Database Layer
 *
 * Uses a separate SQLite database to keep presence data isolated
 * from the main NanoClaw message database.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { PresenceEvent, TrackedNumber } from './types.js';

let db: Database.Database | null = null;

function createSchema(database: Database.Database): void {
  database.exec(`
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

export function initPresenceDb(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  createSchema(db);
}

export function closePresenceDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function requireDb(): Database.Database {
  if (!db) throw new Error('Presence database not initialized');
  return db;
}

// --- Tracked Numbers ---

export function getTrackedNumbers(): TrackedNumber[] {
  return requireDb()
    .prepare('SELECT jid, label, added_at as addedAt FROM tracked_numbers')
    .all() as TrackedNumber[];
}

export function getTrackedJids(): string[] {
  const rows = requireDb().prepare('SELECT jid FROM tracked_numbers').all() as {
    jid: string;
  }[];
  return rows.map((r) => r.jid);
}

export function addTrackedNumber(jid: string, label: string | null): void {
  requireDb()
    .prepare(
      'INSERT OR REPLACE INTO tracked_numbers (jid, label, added_at) VALUES (?, ?, ?)',
    )
    .run(jid, label, Date.now());
}

export function removeTrackedNumber(jid: string): void {
  requireDb().prepare('DELETE FROM tracked_numbers WHERE jid = ?').run(jid);
}

export function getNumberLabel(jid: string): string | null {
  const row = requireDb()
    .prepare('SELECT label FROM tracked_numbers WHERE jid = ?')
    .get(jid) as { label: string | null } | undefined;
  return row?.label ?? null;
}

// --- Presence Events ---

export function insertPresenceEvent(
  jid: string,
  status: string,
  timestamp: number,
): void {
  requireDb()
    .prepare(
      'INSERT INTO presence_events (jid, status, timestamp) VALUES (?, ?, ?)',
    )
    .run(jid, status, timestamp);
}

export function getRecentEvents(
  jid: string,
  limit: number = 50,
): PresenceEvent[] {
  return requireDb()
    .prepare(
      `SELECT jid, status, timestamp 
       FROM presence_events 
       WHERE jid = ?
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(jid, limit) as PresenceEvent[];
}

export function getEventsSince(
  jid: string,
  sinceTimestamp: number,
): PresenceEvent[] {
  return requireDb()
    .prepare(
      `SELECT jid, status, timestamp 
       FROM presence_events 
       WHERE jid = ? AND timestamp > ?
       ORDER BY timestamp ASC`,
    )
    .all(jid, sinceTimestamp) as PresenceEvent[];
}

export function getEventCount(jid: string): number {
  const row = requireDb()
    .prepare('SELECT COUNT(*) as count FROM presence_events WHERE jid = ?')
    .get(jid) as { count: number };
  return row.count;
}
