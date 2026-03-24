/**
 * Multi-account email configuration parser.
 *
 * Supports two modes:
 *
 *   Legacy (single account) — all existing EMAIL_* env vars, unchanged.
 *     Activated when EMAIL_ACCOUNTS is not set.
 *
 *   Multi-account — numbered env vars EMAIL_1_*, EMAIL_2_*, ...
 *     Activated by setting EMAIL_ACCOUNTS=<count>.
 *     The legacy EMAIL_* vars are ignored in this mode.
 *
 * Example .env for 3 accounts:
 *
 *   EMAIL_ACCOUNTS=3
 *
 *   EMAIL_1_ENABLED=true
 *   EMAIL_1_ADDRESS=info@crewtex.de
 *   EMAIL_1_AUTH_TYPE=password
 *   EMAIL_1_PASSWORD=secret
 *   EMAIL_1_IMAP_HOST=imap.crewtex.de
 *   EMAIL_1_IMAP_PORT=993
 *   EMAIL_1_SMTP_HOST=smtp.crewtex.de
 *   EMAIL_1_SMTP_PORT=587
 *   EMAIL_1_GROUP_JID=tg:-5174112754
 *
 *   EMAIL_2_ENABLED=true
 *   EMAIL_2_ADDRESS=user@company.com
 *   EMAIL_2_AUTH_TYPE=oauth2
 *   EMAIL_2_OAUTH2_TENANT_ID=xxxx
 *   EMAIL_2_OAUTH2_CLIENT_ID=xxxx
 *   EMAIL_2_OAUTH2_CLIENT_SECRET=xxxx
 *   EMAIL_2_OAUTH2_GRANT_TYPE=client_credentials
 *   EMAIL_2_GROUP_JID=tg:-9876543210
 *
 *   EMAIL_3_ENABLED=true
 *   EMAIL_3_ADDRESS=noreply@other.de
 *   EMAIL_3_AUTH_TYPE=password
 *   EMAIL_3_PASSWORD=secret
 *   EMAIL_3_IMAP_HOST=mail.other.de
 *   EMAIL_3_GROUP_JID=tg:-1111111111
 */
import fs from 'fs';
import path from 'path';

// ── Load EMAIL_* vars from .env (NanoClaw doesn't set process.env) ────────────
const envCache: Record<string, string> = {};
try {
  const envPath = path.join(process.cwd(), '.env');
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!key.startsWith('EMAIL')) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    envCache[key] = value;
  }
} catch {
  // .env not found, fall back to process.env
}

export interface EmailAccountConfig {
  /** Human-readable index (1-based) for log messages */
  index: number;
  enabled: boolean;
  address: string;
  authType: 'password' | 'oauth2';

  // Password auth
  password: string;

  // IMAP
  imapHost: string;
  imapPort: number;
  imapUseSSL: boolean;
  imapMailbox: string;

  // SMTP
  smtpHost: string;
  smtpPort: number;
  smtpUseSSL: boolean;
  smtpUseTLS: boolean;
  fromAddress: string;
  subjectPrefix: string;

  // OAuth2
  oauth2ClientId: string;
  oauth2ClientSecret: string;
  oauth2TenantId: string;
  oauth2GrantType: 'client_credentials' | 'refresh_token';
  oauth2RefreshToken: string;

  // Routing & behaviour
  /** Telegram group JID to route all emails for this account to */
  groupJid: string;
  allowedSenders: string[];
  autoReply: boolean;
  markSeen: boolean;
  pollInterval: number;
  maxBodyChars: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function env(key: string, fallback = ''): string {
  return envCache[key] ?? process.env[key] ?? fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const val = envCache[key] ?? process.env[key];
  if (val === undefined) return fallback;
  return val !== 'false' && val !== '0';
}

function envInt(key: string, fallback: number): number {
  const val = envCache[key] ?? process.env[key];
  if (!val) return fallback;
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
}

function envList(key: string, fallback: string[]): string[] {
  const val = envCache[key] ?? process.env[key];
  if (!val) return fallback;
  return val
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// ── Per-account parser ────────────────────────────────────────────────────────

function parseAccount(prefix: string, index: number): EmailAccountConfig {
  const p = (k: string, fb = '') => env(`${prefix}${k}`, fb);
  const pb = (k: string, fb: boolean) => envBool(`${prefix}${k}`, fb);
  const pi = (k: string, fb: number) => envInt(`${prefix}${k}`, fb);
  const pl = (k: string, fb: string[]) => envList(`${prefix}${k}`, fb);

  return {
    index,
    enabled: pb('ENABLED', true),
    address: p('ADDRESS'),
    authType: p('AUTH_TYPE', 'password') as 'password' | 'oauth2',
    password: p('PASSWORD'),

    imapHost: p('IMAP_HOST', 'localhost'),
    imapPort: pi('IMAP_PORT', 993),
    imapUseSSL: pb('IMAP_USE_SSL', true),
    imapMailbox: p('IMAP_MAILBOX', 'INBOX'),

    smtpHost: p('SMTP_HOST'),
    smtpPort: pi('SMTP_PORT', 587),
    smtpUseSSL: pb('SMTP_USE_SSL', false),
    smtpUseTLS: pb('SMTP_USE_TLS', true),
    fromAddress: p('FROM_ADDRESS'),
    subjectPrefix: p('SUBJECT_PREFIX', 'Re: '),

    oauth2ClientId: p('OAUTH2_CLIENT_ID'),
    oauth2ClientSecret: p('OAUTH2_CLIENT_SECRET'),
    oauth2TenantId: p('OAUTH2_TENANT_ID'),
    oauth2GrantType: p('OAUTH2_GRANT_TYPE', 'client_credentials') as
      | 'client_credentials'
      | 'refresh_token',
    oauth2RefreshToken: p('OAUTH2_REFRESH_TOKEN'),

    groupJid: p('GROUP_JID'),
    allowedSenders: pl('ALLOWED_SENDERS', ['*']),
    autoReply: pb('AUTO_REPLY', true),
    markSeen: pb('MARK_SEEN', true),
    pollInterval: pi('POLL_INTERVAL', 30),
    maxBodyChars: pi('MAX_BODY_CHARS', 8000),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse all email account configs from environment variables.
 * Returns only enabled accounts with a valid address.
 */
export function parseEmailAccounts(): EmailAccountConfig[] {
  const countStr = env('EMAIL_ACCOUNTS');

  // Multi-account mode
  if (countStr) {
    const count = parseInt(countStr, 10);
    if (isNaN(count) || count < 1) return [];

    const accounts: EmailAccountConfig[] = [];
    for (let i = 1; i <= count; i++) {
      const acc = parseAccount(`EMAIL_${i}_`, i);
      if (!acc.address) continue;
      if (!acc.enabled) continue;
      accounts.push(acc);
    }
    return accounts;
  }

  // Legacy single-account mode — map global EMAIL_* vars to the same interface
  const enabled = envBool('EMAIL_ENABLED', false);
  if (!enabled) return [];

  const legacy = parseAccount('EMAIL_', 1);
  if (!legacy.address) return [];

  return [legacy];
}
