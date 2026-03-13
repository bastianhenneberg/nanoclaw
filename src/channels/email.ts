/**
 * Email channel for NanoClaw — Multi-account edition
 *
 * Supports unlimited IMAP/SMTP accounts (password or OAuth2), each routed
 * to its own Telegram group. Fully backward-compatible with the legacy
 * single-account EMAIL_* env vars.
 *
 * ── Single account (legacy, unchanged) ────────────────────────────────────
 *   EMAIL_ENABLED=true
 *   EMAIL_ADDRESS=you@example.com
 *   EMAIL_PASSWORD=app-password
 *   EMAIL_IMAP_HOST=imap.example.com
 *   EMAIL_SMTP_HOST=smtp.example.com
 *   EMAIL_GROUP_JID=tg:-1234567890
 *
 * ── Multiple accounts ──────────────────────────────────────────────────────
 *   EMAIL_ACCOUNTS=3
 *   EMAIL_1_ADDRESS=info@company.de
 *   EMAIL_1_PASSWORD=secret
 *   EMAIL_1_IMAP_HOST=imap.company.de
 *   EMAIL_1_GROUP_JID=tg:-111111111
 *
 *   EMAIL_2_ADDRESS=user@office365.com
 *   EMAIL_2_AUTH_TYPE=oauth2
 *   EMAIL_2_OAUTH2_TENANT_ID=...
 *   EMAIL_2_OAUTH2_CLIENT_ID=...
 *   EMAIL_2_OAUTH2_CLIENT_SECRET=...
 *   EMAIL_2_GROUP_JID=tg:-222222222
 *
 *   EMAIL_3_ADDRESS=noreply@other.de
 *   EMAIL_3_PASSWORD=secret
 *   EMAIL_3_IMAP_HOST=mail.other.de
 *   EMAIL_3_GROUP_JID=tg:-333333333
 *
 * See src/email-accounts.ts for all available config keys.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import { createTransport } from 'nodemailer';
import { ImapFlow } from 'imapflow';

import { EmailAttachment } from '../types.js';
import { MicrosoftTokenManager } from '../oauth2.js';
import { EmailAccountConfig, parseEmailAccounts } from '../email-accounts.js';

import { logger } from '../logger.js';
import {
  Channel,
  NewMessage,
  OnInboundMessage,
  OnChatMetadata,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

// JID prefix used for email "chats" — each sender address is a unique chat
const EMAIL_JID_PREFIX = 'email:';

function emailToJid(address: string): string {
  return `${EMAIL_JID_PREFIX}${address.toLowerCase().trim()}`;
}

function jidToEmail(jid: string): string {
  return jid.replace(EMAIL_JID_PREFIX, '');
}

function isSenderAllowed(
  senderEmail: string,
  allowedSenders: string[],
): boolean {
  if (allowedSenders.includes('*')) return true;
  if (allowedSenders.length === 0) return false;
  return allowedSenders.includes(senderEmail.toLowerCase().trim());
}

// ── EmailChannel ─────────────────────────────────────────────────────────────

class EmailChannel implements Channel {
  readonly name: string;

  private running = false;
  private connected = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private seenUids = new Set<string>();

  // Reply-threading state: sender address → last subject / message-id seen
  private lastSubjectBySender = new Map<string, string>();
  private lastMessageIdBySender = new Map<string, string>();

  // OAuth2 token manager (only created when authType=oauth2)
  private tokenManager: MicrosoftTokenManager | null = null;

  constructor(
    private readonly cfg: EmailAccountConfig,
    private readonly onMessage: OnInboundMessage,
    private readonly onChatMetadata: OnChatMetadata,
  ) {
    this.name = `email:${cfg.address}`;

    if (cfg.authType === 'oauth2') {
      this.tokenManager = new MicrosoftTokenManager({
        clientId: cfg.oauth2ClientId,
        clientSecret: cfg.oauth2ClientSecret,
        tenantId: cfg.oauth2TenantId,
        grantType: cfg.oauth2GrantType,
        refreshToken: cfg.oauth2RefreshToken || undefined,
      });
    }
  }

  async connect(): Promise<void> {
    const { cfg } = this;

    if (cfg.authType === 'oauth2') {
      if (
        !cfg.oauth2ClientId ||
        !cfg.oauth2ClientSecret ||
        !cfg.oauth2TenantId
      ) {
        logger.warn(
          { account: cfg.address, index: cfg.index },
          'Email account (OAuth2): missing CLIENT_ID, CLIENT_SECRET or TENANT_ID — skipping',
        );
        return;
      }
    } else {
      if (!cfg.imapHost || !cfg.address || !cfg.password) {
        logger.warn(
          { account: cfg.address, index: cfg.index },
          'Email account: missing IMAP_HOST, ADDRESS or PASSWORD — skipping',
        );
        return;
      }
    }

    this.running = true;
    this.connected = true;
    logger.info(
      {
        index: cfg.index,
        address: cfg.address,
        imapHost: cfg.imapHost,
        authType: cfg.authType,
        groupJid: cfg.groupJid || '(per-sender routing)',
      },
      'Email account started',
    );
    this.schedulePoll(0);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    // Only owns email:<sender> JIDs — Telegram groups are owned by telegram channel
    return jid.startsWith(EMAIL_JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.running = false;
    this.connected = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info({ address: this.cfg.address }, 'Email account stopped');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const { cfg } = this;

    if (!cfg.autoReply) {
      logger.debug({ jid }, 'Email auto-reply disabled');
      return;
    }
    if (!cfg.smtpHost) {
      logger.warn(
        { account: cfg.address },
        'SMTP not configured, cannot send reply',
      );
      return;
    }

    // Determine recipient: if jid is groupJid, we can't reply without a sender
    // In that case look up the last known sender for this group
    let to = jid.startsWith(EMAIL_JID_PREFIX)
      ? jidToEmail(jid)
      : (this.lastSenderForGroup.get(jid) ?? '');

    if (!to) {
      logger.warn({ jid }, 'Cannot determine reply recipient');
      return;
    }

    const lastSubject =
      this.lastSubjectBySender.get(to) ?? 'Message from assistant';
    const inReplyTo = this.lastMessageIdBySender.get(to);
    const subject = lastSubject.toLowerCase().startsWith('re:')
      ? lastSubject
      : `${cfg.subjectPrefix}${lastSubject}`;
    const from = cfg.fromAddress || cfg.address;

    try {
      const smtpCfg = await this.buildSmtpConfig();
      const transport = createTransport(smtpCfg);
      await transport.sendMail({
        from,
        to,
        subject,
        text,
        ...(inReplyTo && { inReplyTo, references: inReplyTo }),
      });
      logger.info({ to, subject, account: cfg.address }, 'Email reply sent');
    } catch (err) {
      logger.error(
        { to, err, account: cfg.address },
        'Failed to send email reply',
      );
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /** groupJid → last sender email (for reply routing when jid is groupJid) */
  private lastSenderForGroup = new Map<string, string>();

  private schedulePoll(delayMs: number): void {
    this.pollTimer = setTimeout(() => {
      if (!this.running) return;
      void this.poll().finally(() => {
        if (this.running) this.schedulePoll(this.cfg.pollInterval * 1000);
      });
    }, delayMs);
  }

  private async poll(): Promise<void> {
    let client: ImapFlow | null = null;
    try {
      const auth = await this.buildImapAuth();
      client = new ImapFlow({
        host: this.cfg.imapHost,
        port: this.cfg.imapPort,
        secure: this.cfg.imapUseSSL,
        auth,
        logger: false,
      });

      await client.connect();
      const lock = await client.getMailboxLock(this.cfg.imapMailbox);
      try {
        const messages = await this.fetchUnseen(client);
        for (const msg of messages) await this.handleIncomingEmail(msg);
      } finally {
        lock.release();
      }
    } catch (err) {
      if (
        this.tokenManager &&
        err instanceof Error &&
        (err.message.includes('Authentication failed') ||
          err.message.includes('[AUTHENTICATIONFAILED]') ||
          err.message.includes('401'))
      ) {
        logger.warn(
          { account: this.cfg.address },
          'OAuth2: token rejected, invalidating cache',
        );
        this.tokenManager.invalidate();
      }
      logger.warn({ err, account: this.cfg.address }, 'Email poll error');
    } finally {
      try {
        await client?.logout();
      } catch {
        /* ignore */
      }
    }
  }

  private async buildImapAuth(): Promise<{
    user: string;
    pass?: string;
    accessToken?: string;
  }> {
    if (this.tokenManager) {
      return {
        user: this.cfg.address,
        accessToken: await this.tokenManager.getAccessToken(),
      };
    }
    return { user: this.cfg.address, pass: this.cfg.password };
  }

  private async buildSmtpConfig(): Promise<object> {
    const { cfg } = this;

    if (this.tokenManager) {
      return {
        host: cfg.smtpHost,
        port: cfg.smtpPort,
        secure: cfg.smtpUseSSL,
        auth: {
          type: 'OAuth2',
          user: cfg.address,
          accessToken: await this.tokenManager.getAccessToken(),
        },
      };
    }

    if (cfg.smtpUseSSL) {
      return {
        host: cfg.smtpHost,
        port: cfg.smtpPort,
        secure: true,
        auth: { user: cfg.address, pass: cfg.password },
      };
    }

    return {
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      secure: false,
      auth: { user: cfg.address, pass: cfg.password },
      tls: { rejectUnauthorized: cfg.smtpUseTLS },
    };
  }

  private async fetchUnseen(client: ImapFlow): Promise<ParsedEmail[]> {
    const results: ParsedEmail[] = [];

    interface PendingMessage {
      uid: string;
      senderAddress: string;
      envelope: any;
      bodyStructure: any;
      textParts: string[];
      attachmentParts: MimePart[];
    }

    const pending: PendingMessage[] = [];
    const disallowedUids: string[] = [];

    for await (const msg of client.fetch('1:*', {
      uid: true,
      envelope: true,
      bodyStructure: true,
      flags: true,
    })) {
      const uid = String(msg.uid);
      if (this.seenUids.has(uid)) continue;

      if (msg.flags?.has('\\Seen')) {
        this.seenUids.add(uid);
        continue;
      }

      const envelope = msg.envelope;
      if (!envelope) continue;

      const senderAddress = envelope.from?.[0]?.address?.toLowerCase() ?? '';
      if (!senderAddress) continue;

      if (!isSenderAllowed(senderAddress, this.cfg.allowedSenders)) {
        this.seenUids.add(uid);
        disallowedUids.push(uid);
        continue;
      }

      const textParts: string[] = [];
      const attachmentParts: MimePart[] = [];
      walkBodyStructure(msg.bodyStructure, textParts, attachmentParts);
      pending.push({
        uid,
        senderAddress,
        envelope,
        bodyStructure: msg.bodyStructure,
        textParts,
        attachmentParts,
      });
    }

    if (this.cfg.markSeen && disallowedUids.length > 0) {
      for (const uid of disallowedUids) {
        try {
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        } catch {
          /* ignore */
        }
      }
    }

    for (const msg of pending) {
      let body = '';
      for (const partNum of msg.textParts) {
        try {
          const dl = await client.download(msg.uid, partNum, { uid: true });
          if (dl?.content) {
            const chunks: Buffer[] = [];
            for await (const chunk of dl.content) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            body += Buffer.concat(chunks).toString('utf-8');
          }
        } catch (err) {
          logger.debug(
            { uid: msg.uid, partNum, err },
            'Failed to download text part',
          );
        }
      }
      body = body.slice(0, this.cfg.maxBodyChars).trim();

      const attachments: EmailAttachment[] = [];
      if (msg.attachmentParts.length > 0) {
        const tmpDir = path.join(
          os.tmpdir(),
          `nanoclaw-email-${msg.uid}-${Date.now()}`,
        );
        fs.mkdirSync(tmpDir, { recursive: true });

        for (const part of msg.attachmentParts) {
          const safeName = sanitizeFilename(
            part.filename || `attachment-${part.partNum}`,
          );
          const filePath = path.join(tmpDir, safeName);
          try {
            const dl = await client.download(msg.uid, part.partNum, {
              uid: true,
            });
            if (dl?.content) {
              await pipeline(dl.content, createWriteStream(filePath));
              attachments.push({
                filename: safeName,
                mimeType: part.mimeType,
                tempPath: filePath,
                sizeBytes: fs.statSync(filePath).size,
              });
            }
          } catch (err) {
            logger.warn(
              { uid: msg.uid, filename: safeName, err },
              'Failed to download attachment',
            );
          }
        }
      }

      results.push({
        uid: msg.uid,
        senderAddress: msg.senderAddress,
        subject: msg.envelope.subject ?? '(no subject)',
        messageId: msg.envelope.messageId ?? '',
        dateStr: msg.envelope.date?.toISOString() ?? new Date().toISOString(),
        body,
        attachments,
      });

      this.seenUids.add(msg.uid);
      if (this.cfg.markSeen) {
        await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
      }
    }

    // Trim seen set to avoid unbounded growth
    if (this.seenUids.size > 10_000) {
      const entries = [...this.seenUids];
      this.seenUids = new Set(entries.slice(-5_000));
    }

    return results;
  }

  private async handleIncomingEmail(email: ParsedEmail): Promise<void> {
    const {
      senderAddress,
      subject,
      messageId,
      dateStr,
      body,
      uid,
      attachments,
    } = email;
    const { cfg } = this;

    if (subject) this.lastSubjectBySender.set(senderAddress, subject);
    if (messageId) this.lastMessageIdBySender.set(senderAddress, messageId);

    // Determine the chat JID for routing:
    // - If this account has a groupJid, use that (all emails → one Telegram group)
    //   and remember the sender for reply routing.
    // - Otherwise fall back to per-sender email JID (legacy routing via EMAIL_GROUP_JID).
    let chatJid: string;
    if (cfg.groupJid) {
      chatJid = cfg.groupJid;
      this.lastSenderForGroup.set(cfg.groupJid, senderAddress);
    } else {
      chatJid = emailToJid(senderAddress);
    }

    this.onChatMetadata(chatJid, dateStr, senderAddress, 'email', false);

    const lines = [
      'Email received.',
      `Account: ${cfg.address}`,
      `From: ${senderAddress}`,
      `Subject: ${subject}`,
      `Date: ${dateStr}`,
      `Message-ID: ${messageId}`,
    ];

    if (attachments.length > 0) {
      lines.push(
        `Attachments (${attachments.length}): ${attachments.map((a) => a.filename).join(', ')}`,
      );
    }

    lines.push('', body || '(empty body)');

    if (attachments.length > 0) {
      lines.push('', '--- Attachments ---');
      for (const att of attachments) {
        lines.push(
          `[ATTACHMENT name="${att.filename}" type="${att.mimeType}" size="${att.sizeBytes}" tempPath="${att.tempPath}"]`,
        );
      }
    }

    const message: NewMessage = {
      id: `email-${uid}-${crypto.randomUUID()}`,
      chat_jid: chatJid,
      sender: senderAddress,
      sender_name: senderAddress,
      content: lines.join('\n'),
      timestamp: dateStr,
      is_from_me: false,
      is_bot_message: false,
      emailAttachments: attachments.length > 0 ? attachments : undefined,
    };

    logger.info(
      {
        account: cfg.address,
        from: senderAddress,
        subject,
        uid,
        chatJid,
        attachmentCount: attachments.length,
      },
      'Incoming email received',
    );

    this.onMessage(chatJid, message);
  }
}

// ── Interfaces ────────────────────────────────────────────────────────────────

interface ParsedEmail {
  uid: string;
  senderAddress: string;
  subject: string;
  messageId: string;
  dateStr: string;
  body: string;
  attachments: EmailAttachment[];
}

interface MimePart {
  partNum: string;
  mimeType: string;
  filename: string;
}

function walkBodyStructure(
  node: any,
  textParts: string[],
  attachmentParts: MimePart[],
): void {
  if (!node) return;
  if (node.childNodes && Array.isArray(node.childNodes)) {
    for (const child of node.childNodes)
      walkBodyStructure(child, textParts, attachmentParts);
    return;
  }

  const type = (node.type || '').toLowerCase();
  const subtype = (node.subtype || '').toLowerCase();
  const disposition = (node.disposition || '').toLowerCase();
  const partNum = node.part || '1';
  const mimeType = `${type}/${subtype}`;

  if (type === 'text' && subtype === 'plain' && disposition !== 'attachment') {
    textParts.push(partNum);
    return;
  }

  if (
    disposition === 'attachment' ||
    disposition === 'inline' ||
    type === 'application' ||
    (type === 'image' && disposition === 'attachment')
  ) {
    const filename =
      node.dispositionParameters?.filename ||
      node.parameters?.name ||
      `${partNum}.bin`;
    attachmentParts.push({ partNum, mimeType, filename });
  }
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 200);
}

// ── Email listing API (for IPC) ───────────────────────────────────────────────

export interface ListEmailsParams {
  account: string;
  folder?: string;
  limit?: number;
  unreadOnly?: boolean;
}

export async function listEmails(params: ListEmailsParams): Promise<string> {
  const accounts = parseEmailAccounts();
  const cfg = accounts.find(
    (a) => a.address.toLowerCase() === params.account.toLowerCase(),
  );

  if (!cfg) {
    throw new Error(`Account not found: ${params.account}`);
  }

  let client: ImapFlow | null = null;
  try {
    // Build IMAP config
    const imapConfig: any = {
      host: cfg.imapHost,
      port: cfg.imapPort,
      secure: cfg.imapUseSSL,
      logger: false,
    };

    if (cfg.authType === 'oauth2') {
      const tokenMgr = new MicrosoftTokenManager({
        tenantId: cfg.oauth2TenantId,
        clientId: cfg.oauth2ClientId,
        clientSecret: cfg.oauth2ClientSecret,
        grantType: cfg.oauth2GrantType,
        refreshToken: cfg.oauth2RefreshToken || undefined,
      });
      const token = await tokenMgr.getAccessToken();
      imapConfig.auth = {
        user: cfg.address,
        accessToken: token,
      };
    } else {
      imapConfig.auth = {
        user: cfg.address,
        pass: cfg.password,
      };
    }

    client = new ImapFlow(imapConfig);
    await client.connect();

    const folder = params.folder || 'INBOX';
    const limit = params.limit || 10;

    await client.mailboxOpen(folder);

    // Search for messages
    const searchCriteria = params.unreadOnly ? { seen: false } : { all: true };
    const uids = await client.search(searchCriteria, { uid: true });

    if (!uids || !Array.isArray(uids) || uids.length === 0) {
      await client.logout();
      return `No emails found in ${folder}`;
    }

    // Get the last N messages (most recent)
    const recentUids = uids.slice(-limit).reverse();

    const lines: string[] = [
      `📬 ${params.account} — ${folder} (${uids.length} total, showing ${recentUids.length})`,
      '',
    ];

    for (const uid of recentUids) {
      const msgResult = await client.fetchOne(
        uid,
        { envelope: true, flags: true },
        { uid: true },
      );
      if (!msgResult || typeof msgResult === 'boolean') continue;
      const env = msgResult.envelope;
      if (!env) continue;

      const from = env.from?.[0]?.address || 'unknown';
      const subject = env.subject || '(no subject)';
      const date = env.date ? new Date(env.date).toLocaleString('de-DE') : '';
      const isUnread = !msgResult.flags?.has('\\Seen');
      const marker = isUnread ? '🔵' : '⚪';

      lines.push(`${marker} **${subject}**`);
      lines.push(`   From: ${from} | ${date}`);
      lines.push(`   Message-ID: ${env.messageId || 'n/a'}`);
      lines.push('');
    }

    await client.logout();
    return lines.join('\n');
  } catch (err) {
    if (client) {
      try {
        await client.logout();
      } catch {}
    }
    throw err;
  }
}

// ── Email action API (for IPC) ────────────────────────────────────────────────

export interface EmailActionParams {
  action: 'delete' | 'archive' | 'mark_read' | 'mark_unread';
  messageId: string;
  account: string;
  archiveFolder?: string;
}

export async function performEmailAction(
  params: EmailActionParams,
): Promise<boolean> {
  const accounts = parseEmailAccounts();
  const cfg = accounts.find(
    (a) => a.address.toLowerCase() === params.account.toLowerCase(),
  );

  if (!cfg) {
    logger.warn(
      { account: params.account },
      'Email action failed: account not found',
    );
    return false;
  }

  let client: ImapFlow | null = null;
  try {
    // Build IMAP config
    const imapConfig: any = {
      host: cfg.imapHost,
      port: cfg.imapPort,
      secure: cfg.imapUseSSL,
      logger: false,
    };

    if (cfg.authType === 'oauth2') {
      const tokenMgr = new MicrosoftTokenManager({
        tenantId: cfg.oauth2TenantId,
        clientId: cfg.oauth2ClientId,
        clientSecret: cfg.oauth2ClientSecret,
        grantType: cfg.oauth2GrantType,
        refreshToken: cfg.oauth2RefreshToken || undefined,
      });
      const token = await tokenMgr.getAccessToken();
      imapConfig.auth = {
        user: cfg.address,
        accessToken: token,
      };
    } else {
      imapConfig.auth = {
        user: cfg.address,
        pass: cfg.password,
      };
    }

    client = new ImapFlow(imapConfig);
    await client.connect();

    // Find the email by Message-ID
    await client.mailboxOpen(cfg.imapMailbox);
    const searchResults = await client.search({
      header: { 'message-id': params.messageId },
    });

    if (
      !searchResults ||
      !Array.isArray(searchResults) ||
      searchResults.length === 0
    ) {
      logger.warn(
        { messageId: params.messageId, account: params.account },
        'Email not found',
      );
      await client.logout();
      return false;
    }

    const uid = (searchResults as number[])[0];

    switch (params.action) {
      case 'delete':
        await client.messageDelete(uid, { uid: true });
        logger.info(
          { messageId: params.messageId, account: params.account },
          'Email deleted',
        );
        break;

      case 'archive':
        const archiveFolder = params.archiveFolder || 'Archive';
        await client.messageMove(uid, archiveFolder, { uid: true });
        logger.info(
          {
            messageId: params.messageId,
            account: params.account,
            folder: archiveFolder,
          },
          'Email archived',
        );
        break;

      case 'mark_read':
        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        logger.info(
          { messageId: params.messageId, account: params.account },
          'Email marked as read',
        );
        break;

      case 'mark_unread':
        await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true });
        logger.info(
          { messageId: params.messageId, account: params.account },
          'Email marked as unread',
        );
        break;
    }

    await client.logout();
    return true;
  } catch (err) {
    logger.error(
      {
        err,
        action: params.action,
        messageId: params.messageId,
        account: params.account,
      },
      'Email action failed',
    );
    if (client) {
      try {
        await client.logout();
      } catch {}
    }
    return false;
  }
}

// ── Channel registration — one instance per configured account ────────────────

registerChannel('email', (opts: ChannelOpts): Channel | null => {
  const accounts = parseEmailAccounts();
  if (accounts.length === 0) return null;

  if (accounts.length === 1) {
    // Single account: return it directly (existing behaviour)
    return new EmailChannel(accounts[0], opts.onMessage, opts.onChatMetadata);
  }

  // Multiple accounts: register each as its own channel instance
  // Return the first; register the rest directly.
  const [first, ...rest] = accounts;
  for (const acc of rest) {
    const ch = new EmailChannel(acc, opts.onMessage, opts.onChatMetadata);
    // Connect immediately — the registry will only call connect() on the returned instance
    void ch.connect();
  }
  return new EmailChannel(first, opts.onMessage, opts.onChatMetadata);
});
