/**
 * Presence Tracker Types
 */

export interface PresenceEvent {
  jid: string;
  status: string;
  timestamp: number;
}

export interface TrackedNumber {
  jid: string;
  label: string | null;
  addedAt: number;
}

export interface DailyStats {
  date: string;
  jid: string;
  sessions: number;
  totalMinutes: number;
  firstSeen: string;
  lastSeen: string;
}

export interface PresenceTrackerConfig {
  enabled: boolean;
  alertChatId: string;
  authDir: string;
  dbPath: string;
}
