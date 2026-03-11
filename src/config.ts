import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'TELEGRAM_BOT_POOL',
  'WEBHOOK_SECRET',
  'OLLAMA_HOST',
  'OLLAMA_MODEL',
  'WEBHOOK_LLM_PROVIDER',
  'MEMORY_ENABLED',
  'EMAIL_ENABLED',
  'EMAIL_IMAP_HOST',
  'EMAIL_IMAP_PORT',
  'EMAIL_IMAP_MAILBOX',
  'EMAIL_IMAP_USE_SSL',
  'EMAIL_SMTP_HOST',
  'EMAIL_SMTP_PORT',
  'EMAIL_SMTP_USE_TLS',
  'EMAIL_SMTP_USE_SSL',
  'EMAIL_ADDRESS',
  'EMAIL_PASSWORD',
  'EMAIL_FROM_ADDRESS',
  'EMAIL_POLL_INTERVAL',
  'EMAIL_ALLOWED_SENDERS',
  'EMAIL_AUTO_REPLY',
  'EMAIL_MARK_SEEN',
  'EMAIL_MAX_BODY_CHARS',
  'EMAIL_SUBJECT_PREFIX',
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

// ─── Email channel configuration ──────────────────────────────────────────
// Set EMAIL_ENABLED=true and configure IMAP/SMTP to activate email support.
// Each sender email address becomes an isolated "chat" (JID: email:<address>).
// The group for incoming emails must be registered with folder "email_<address>"
// or the main group can handle all email by mapping email:* to its chat_jid.

export const EMAIL_ENABLED =
  (process.env.EMAIL_ENABLED ?? envConfig.EMAIL_ENABLED ?? 'false') === 'true';

export const EMAIL_IMAP_HOST =
  process.env.EMAIL_IMAP_HOST || envConfig.EMAIL_IMAP_HOST || '';
export const EMAIL_IMAP_PORT = parseInt(
  process.env.EMAIL_IMAP_PORT || envConfig.EMAIL_IMAP_PORT || '993',
  10,
);
export const EMAIL_IMAP_MAILBOX =
  process.env.EMAIL_IMAP_MAILBOX || envConfig.EMAIL_IMAP_MAILBOX || 'INBOX';
export const EMAIL_IMAP_USE_SSL =
  (process.env.EMAIL_IMAP_USE_SSL ?? envConfig.EMAIL_IMAP_USE_SSL ?? 'true') !== 'false';

export const EMAIL_SMTP_HOST =
  process.env.EMAIL_SMTP_HOST || envConfig.EMAIL_SMTP_HOST || '';
export const EMAIL_SMTP_PORT = parseInt(
  process.env.EMAIL_SMTP_PORT || envConfig.EMAIL_SMTP_PORT || '587',
  10,
);
export const EMAIL_SMTP_USE_TLS =
  (process.env.EMAIL_SMTP_USE_TLS ?? envConfig.EMAIL_SMTP_USE_TLS ?? 'true') !== 'false';
export const EMAIL_SMTP_USE_SSL =
  (process.env.EMAIL_SMTP_USE_SSL ?? envConfig.EMAIL_SMTP_USE_SSL ?? 'false') === 'true';

export const EMAIL_ADDRESS =
  process.env.EMAIL_ADDRESS || envConfig.EMAIL_ADDRESS || '';
export const EMAIL_PASSWORD =
  process.env.EMAIL_PASSWORD || envConfig.EMAIL_PASSWORD || '';
export const EMAIL_FROM_ADDRESS =
  process.env.EMAIL_FROM_ADDRESS || envConfig.EMAIL_FROM_ADDRESS || '';

export const EMAIL_POLL_INTERVAL = Math.max(
  5,
  parseInt(process.env.EMAIL_POLL_INTERVAL || envConfig.EMAIL_POLL_INTERVAL || '30', 10),
);
export const EMAIL_ALLOWED_SENDERS = (
  process.env.EMAIL_ALLOWED_SENDERS || envConfig.EMAIL_ALLOWED_SENDERS || '*'
)
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export const EMAIL_AUTO_REPLY =
  (process.env.EMAIL_AUTO_REPLY ?? envConfig.EMAIL_AUTO_REPLY ?? 'true') !== 'false';
export const EMAIL_MARK_SEEN =
  (process.env.EMAIL_MARK_SEEN ?? envConfig.EMAIL_MARK_SEEN ?? 'true') !== 'false';
export const EMAIL_MAX_BODY_CHARS = parseInt(
  process.env.EMAIL_MAX_BODY_CHARS || envConfig.EMAIL_MAX_BODY_CHARS || '12000',
  10,
);
export const EMAIL_SUBJECT_PREFIX =
  process.env.EMAIL_SUBJECT_PREFIX || envConfig.EMAIL_SUBJECT_PREFIX || 'Re: ';

export const TELEGRAM_BOT_POOL = (
  process.env.TELEGRAM_BOT_POOL ||
  envConfig.TELEGRAM_BOT_POOL ||
  ''
)
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
