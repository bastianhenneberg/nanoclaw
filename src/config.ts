import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
// Email credentials (ADDRESS, PASSWORD, OAUTH2_*) are NOT loaded here —
// they are parsed per-account by integrations/email-accounts.ts directly from .env.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'TELEGRAM_BOT_POOL',
  'WEBHOOK_SECRET',
  'OLLAMA_HOST',
  'OLLAMA_MODEL',
  'WEBHOOK_LLM_PROVIDER',
  'MEMORY_ENABLED',
  'AI_BRAIN_API_URL',
  'AI_BRAIN_API_KEY',
  'EMAIL_GROUP_JID',
  'PRESENCE_TRACKER_ENABLED',
  'PRESENCE_ALERT_CHAT_ID',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Webhook server configuration
// Set WEBHOOK_PORT > 0 to enable the HTTP webhook endpoint.
// External services POST to /webhook/:groupFolder to inject messages.
export const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || '0', 10); // 0 = disabled
export const WEBHOOK_BIND_HOST = process.env.WEBHOOK_BIND_HOST || '127.0.0.1';
export const WEBHOOK_SECRET =
  process.env.WEBHOOK_SECRET || envConfig.WEBHOOK_SECRET || '';

// LLM provider for direct (non-agent) webhook processing.
// 'claude' uses the local credential proxy; 'ollama' calls an Ollama server.
export const WEBHOOK_LLM_PROVIDER =
  process.env.WEBHOOK_LLM_PROVIDER ||
  envConfig.WEBHOOK_LLM_PROVIDER ||
  'claude';
export const OLLAMA_HOST =
  process.env.OLLAMA_HOST || envConfig.OLLAMA_HOST || 'http://localhost:11434';
export const OLLAMA_MODEL =
  process.env.OLLAMA_MODEL || envConfig.OLLAMA_MODEL || 'llama3.2';

// Persistent memory system
// When enabled, key facts from each session are distilled and stored as
// Markdown files under groups/{folder}/memory/. Context is injected into
// subsequent sessions so the agent remembers past conversations.
export const MEMORY_ENABLED =
  (process.env.MEMORY_ENABLED ?? envConfig.MEMORY_ENABLED ?? 'true') !==
  'false';

// AI Brain API for centralized agent memory
export const AI_BRAIN_API_URL =
  process.env.AI_BRAIN_API_URL || envConfig.AI_BRAIN_API_URL || '';
export const AI_BRAIN_API_KEY =
  process.env.AI_BRAIN_API_KEY || envConfig.AI_BRAIN_API_KEY || '';

// ─── Email channel configuration ──────────────────────────────────────────
// Per-account email settings (credentials, IMAP/SMTP hosts, polling) are
// configured entirely in integrations/email-accounts.ts, which parses
// EMAIL_1_*, EMAIL_2_*, ... directly from .env.  Only the wildcard routing
// JID is needed here (used by the message processor for email→group routing).

// Wildcard email routing: chat_jid of the registered group that should receive
// all incoming emails that have no dedicated per-sender group registered.
// Example: EMAIL_GROUP_JID=tg:-1234567890  (your Telegram group JID)
export const EMAIL_GROUP_JID =
  process.env.EMAIL_GROUP_JID || envConfig.EMAIL_GROUP_JID || '';

export const TELEGRAM_BOT_POOL = (
  process.env.TELEGRAM_BOT_POOL ||
  envConfig.TELEGRAM_BOT_POOL ||
  ''
)
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

// ─── Presence Tracker configuration ───────────────────────────────────────
// Optional WhatsApp presence tracking (online/offline monitoring).
// Requires separate WhatsApp authentication (stored in store/presence-auth/).

export const PRESENCE_TRACKER_ENABLED =
  (process.env.PRESENCE_TRACKER_ENABLED ||
    envConfig.PRESENCE_TRACKER_ENABLED) === 'true';

// Chat ID for presence alerts (e.g., "tg:-5284494721" for a Telegram group)
export const PRESENCE_ALERT_CHAT_ID =
  process.env.PRESENCE_ALERT_CHAT_ID || envConfig.PRESENCE_ALERT_CHAT_ID || '';

// Paths for presence tracker data (stored under STORE_DIR)
export const PRESENCE_AUTH_DIR = path.join(STORE_DIR, 'presence-auth');
export const PRESENCE_DB_PATH = path.join(STORE_DIR, 'presence-tracker.db');
