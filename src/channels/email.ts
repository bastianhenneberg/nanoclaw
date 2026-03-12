/**
 * Email channel for NanoClaw
 *
 * Provides IMAP polling (inbound) + SMTP send (outbound), matching the same
 * Channel interface as the Telegram channel.
 *
 * Inspired by OpenClaw / NanoBot's email channel implementation.
 *
 * Configuration via environment variables (see config.ts EMAIL_* keys):
 *   EMAIL_ENABLED=true
 *   EMAIL_IMAP_HOST=imap.gmail.com
 *   EMAIL_IMAP_PORT=993
 *   EMAIL_SMTP_HOST=smtp.gmail.com
 *   EMAIL_SMTP_PORT=587
 *   EMAIL_ADDRESS=you@example.com
 *   EMAIL_PASSWORD=app-password
 *   EMAIL_POLL_INTERVAL=30          (seconds, default 30)
 *   EMAIL_ALLOWED_SENDERS=*         (* = anyone, or comma-separated list)
 *   EMAIL_AUTO_REPLY=true           (default true)
 *   EMAIL_MARK_SEEN=true            (default true)
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

import {
  EMAIL_ADDRESS,
  EMAIL_ALLOWED_SENDERS,
  EMAIL_AUTO_REPLY,
  EMAIL_ENABLED,
  EMAIL_IMAP_HOST,
  EMAIL_IMAP_MAILBOX,
  EMAIL_IMAP_PORT,
  EMAIL_IMAP_USE_SSL,
  EMAIL_MARK_SEEN,
  EMAIL_MAX_BODY_CHARS,
  EMAIL_PASSWORD,
  EMAIL_POLL_INTERVAL,
  EMAIL_SMTP_HOST,
  EMAIL_SMTP_PORT,
  EMAIL_SMTP_USE_SSL,
  EMAIL_SMTP_USE_TLS,
  EMAIL_FROM_ADDRESS,
  EMAIL_SUBJECT_PREFIX,
} from '../config.js';
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

/** Check if a sender is allowed per the EMAIL_ALLOWED_SENDERS config. */
function isSenderAllowed(senderEmail: string): boolean {
  if (EMAIL_ALLOWED_SENDERS.includes('*')) return true;
  if (EMAIL_ALLOWED_SENDERS.length === 0) return false;
  return EMAIL_ALLOWED_SENDERS.includes(senderEmail.toLowerCase().trim());
}

class EmailChannel implements Channel {
  readonly name = 'email';

  private running = false;
  private connected = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private seenUids = new Set<string>();

  // Reply-threading state: sender address → last subject / message-id seen
  private lastSubjectBySender = new Map<string, string>();
  private lastMessageIdBySender = new Map<string, string>();

  constructor(
    private readonly onMessage: OnInboundMessage,
    private readonly onChatMetadata: OnChatMetadata,
  ) {}

  async connect(): Promise<void> {
    if (!EMAIL_ENABLED) {
      logger.info('Email channel disabled (EMAIL_ENABLED != true)');
      return;
    }
    if (!EMAIL_IMAP_HOST || !EMAIL_ADDRESS || !EMAIL_PASSWORD) {
      logger.warn(
        'Email channel: missing required config (EMAIL_IMAP_HOST, EMAIL_ADDRESS, EMAIL_PASSWORD)',
      );
      return;
    }

    this.running = true;
    this.connected = true;
    logger.info(
      { host: EMAIL_IMAP_HOST, port: EMAIL_IMAP_PORT, address: EMAIL_ADDRESS },
      'Email channel started (IMAP polling)',
    );
    this.schedulePoll(0);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(EMAIL_JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.running = false;
    this.connected = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('Email channel stopped');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!EMAIL_AUTO_REPLY) {
      logger.debug({ jid }, 'Email auto-reply disabled, skipping outbound');
      return;
    }
    if (!EMAIL_SMTP_HOST) {
      logger.warn('Email channel: SMTP not configured, cannot send reply');
      return;
    }

    const to = jidToEmail(jid);
    const lastSubject =
      this.lastSubjectBySender.get(to) ?? 'Message from assistant';
    const inReplyTo = this.lastMessageIdBySender.get(to);

    const subject = lastSubject.toLowerCase().startsWith('re:')
      ? lastSubject
      : `${EMAIL_SUBJECT_PREFIX}${lastSubject}`;

    const from = EMAIL_FROM_ADDRESS || EMAIL_ADDRESS;

    try {
      const transport = createTransport(this.smtpConfig());
      await transport.sendMail({
        from,
        to,
        subject,
        text,
        ...(inReplyTo && {
          inReplyTo,
          references: inReplyTo,
        }),
      });
      logger.info({ to, subject }, 'Email reply sent');
    } catch (err) {
      logger.error({ to, err }, 'Failed to send email reply');
    }
  }

  // ─── private ──────────────────────────────────────────────────────────────

  private schedulePoll(delayMs: number): void {
    this.pollTimer = setTimeout(() => {
      if (!this.running) return;
      void this.poll().finally(() => {
        if (this.running) {
          this.schedulePoll(EMAIL_POLL_INTERVAL * 1000);
        }
      });
    }, delayMs);
  }

  private async poll(): Promise<void> {
    let client: ImapFlow | null = null;
    try {
      client = new ImapFlow({
        host: EMAIL_IMAP_HOST,
        port: EMAIL_IMAP_PORT,
        secure: EMAIL_IMAP_USE_SSL,
        auth: { user: EMAIL_ADDRESS, pass: EMAIL_PASSWORD },
        logger: false, // suppress imapflow's own verbose logging
      });

      await client.connect();

      const lock = await client.getMailboxLock(EMAIL_IMAP_MAILBOX);
      try {
        const messages = await this.fetchUnseen(client);
        logger.info(
          { mailbox: EMAIL_IMAP_MAILBOX, newMessages: messages.length },
          'Email poll complete',
        );
        for (const msg of messages) {
          await this.handleIncomingEmail(msg);
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      logger.warn({ err }, 'Email poll error');
    } finally {
      try {
        await client?.logout();
      } catch {
        // ignore logout errors
      }
    }
  }

  private async fetchUnseen(client: ImapFlow): Promise<ParsedEmail[]> {
    const results: ParsedEmail[] = [];

    // Phase 1: Collect metadata from FETCH — no other IMAP commands allowed
    // during iteration (ImapFlow deadlocks on nested commands).
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

      if (!isSenderAllowed(senderAddress)) {
        this.seenUids.add(uid);
        disallowedUids.push(uid);
        continue;
      }

      const textParts: string[] = [];
      const attachmentParts: MimePart[] = [];
      walkBodyStructure(msg.bodyStructure, textParts, attachmentParts);

      pending.push({ uid, senderAddress, envelope, bodyStructure: msg.bodyStructure, textParts, attachmentParts });
    }

    // Phase 2: Mark disallowed messages as seen (after fetch loop)
    if (EMAIL_MARK_SEEN && disallowedUids.length > 0) {
      for (const uid of disallowedUids) {
        try {
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        } catch {
          // ignore
        }
      }
    }

    // Phase 3: Download bodies and attachments for allowed messages
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
          logger.debug({ uid: msg.uid, partNum, err }, 'Failed to download text part');
        }
      }
      body = body.slice(0, EMAIL_MAX_BODY_CHARS).trim();

      // Download attachments
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
            const dl = await client.download(msg.uid, part.partNum, { uid: true });
            if (dl?.content) {
              await pipeline(dl.content, createWriteStream(filePath));
              const sizeBytes = fs.statSync(filePath).size;
              attachments.push({
                filename: safeName,
                mimeType: part.mimeType,
                tempPath: filePath,
                sizeBytes,
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

      const subject = msg.envelope.subject ?? '(no subject)';
      const messageId = msg.envelope.messageId ?? '';
      const dateStr = msg.envelope.date?.toISOString() ?? new Date().toISOString();

      results.push({
        uid: msg.uid,
        senderAddress: msg.senderAddress,
        subject,
        messageId,
        dateStr,
        body,
        attachments,
      });

      this.seenUids.add(msg.uid);
      if (EMAIL_MARK_SEEN) {
        await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
      }
    }

    // Trim seen set to avoid unbounded growth
    if (this.seenUids.size > 10_000) {
      const entries = [...this.seenUids];
      this.seenUids = new Set(entries.slice(-5_000));
    }

    logger.info(
      { newMessages: results.length },
      'Email poll complete',
    );

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
    const chatJid = emailToJid(senderAddress);

    // Track reply-threading state
    if (subject) this.lastSubjectBySender.set(senderAddress, subject);
    if (messageId) this.lastMessageIdBySender.set(senderAddress, messageId);

    // Notify channel registry about this chat
    this.onChatMetadata(chatJid, dateStr, senderAddress, 'email', false);

    // Format content — structured plaintext blob (same as NanoBot)
    const lines = [
      'Email received.',
      `From: ${senderAddress}`,
      `Subject: ${subject}`,
      `Date: ${dateStr}`,
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
        // Container path will be rewritten by index.ts after routing.
        // Use a placeholder that index.ts replaces with the actual container path.
        lines.push(
          `[ATTACHMENT name="${att.filename}" type="${att.mimeType}" size="${att.sizeBytes}" tempPath="${att.tempPath}"]`,
        );
      }
    }

    const content = lines.join('\n');

    const message: NewMessage = {
      id: `email-${uid}-${crypto.randomUUID()}`,
      chat_jid: chatJid,
      sender: senderAddress,
      sender_name: senderAddress,
      content,
      timestamp: dateStr,
      is_from_me: false,
      is_bot_message: false,
      emailAttachments: attachments.length > 0 ? attachments : undefined,
    };

    logger.info(
      {
        from: senderAddress,
        subject,
        uid,
        attachmentCount: attachments.length,
      },
      'Incoming email received',
    );

    this.onMessage(chatJid, message);
  }

  private smtpConfig() {
    if (EMAIL_SMTP_USE_SSL) {
      return {
        host: EMAIL_SMTP_HOST,
        port: EMAIL_SMTP_PORT,
        secure: true,
        auth: { user: EMAIL_ADDRESS, pass: EMAIL_PASSWORD },
      };
    }
    return {
      host: EMAIL_SMTP_HOST,
      port: EMAIL_SMTP_PORT,
      secure: false,
      auth: { user: EMAIL_ADDRESS, pass: EMAIL_PASSWORD },
      tls: { rejectUnauthorized: EMAIL_SMTP_USE_TLS },
    };
  }
}

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

/**
 * Recursively walk an imapflow bodyStructure tree.
 * Fills textParts (part numbers for text/plain) and attachmentParts.
 */
function walkBodyStructure(
  node: any,
  textParts: string[],
  attachmentParts: MimePart[],
): void {
  if (!node) return;

  // Multipart: recurse into children
  if (node.childNodes && Array.isArray(node.childNodes)) {
    for (const child of node.childNodes) {
      walkBodyStructure(child, textParts, attachmentParts);
    }
    return;
  }

  const type = (node.type || '').toLowerCase();
  const subtype = (node.subtype || '').toLowerCase();
  const disposition = (node.disposition || '').toLowerCase();
  const partNum = node.part || '1';
  const mimeType = `${type}/${subtype}`;

  // Collect plain-text body (not attachment disposition)
  if (type === 'text' && subtype === 'plain' && disposition !== 'attachment') {
    textParts.push(partNum);
    return;
  }

  // Collect attachments — explicit disposition or non-text content types
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

/** Strip dangerous characters from filenames. */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 200);
}

// ─── Channel registration ──────────────────────────────────────────────────

registerChannel('email', (opts: ChannelOpts): Channel | null => {
  if (!EMAIL_ENABLED) return null;
  return new EmailChannel(opts.onMessage, opts.onChatMetadata);
});
