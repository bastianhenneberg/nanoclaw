import fs from 'fs';
import { Api, Bot, InputFile } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

/**
 * Initialize send-only Api instances for the bot pool.
 * Each pool bot can send messages but doesn't poll for updates.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 * On first assignment, renames the bot to match the sender's role.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  const api = await getPoolApi(sender, groupFolder);
  if (!api) return;

  try {
    const numericId = chatId.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await api.sendMessage(numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
      }
    }
    logger.info({ chatId, sender, length: text.length }, 'Pool message sent');
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

/**
 * Get or assign a pool bot for a sender, with optional rename.
 */
async function getPoolApi(
  sender: string,
  groupFolder: string,
): Promise<Api | null> {
  if (poolApis.length === 0) {
    logger.warn('No pool bots available');
    return null;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info(
        { sender, groupFolder, poolIndex: idx },
        'Assigned and renamed pool bot',
      );
    } catch (err) {
      logger.warn(
        { sender, err },
        'Failed to rename pool bot (sending anyway)',
      );
    }
  }
  return poolApis[idx];
}

/**
 * Send a photo via a pool bot assigned to the given sender name.
 */
export async function sendPoolPhoto(
  chatId: string,
  filePath: string,
  caption: string | undefined,
  sender: string,
  groupFolder: string,
): Promise<void> {
  const api = await getPoolApi(sender, groupFolder);
  if (!api) return;

  try {
    const numericId = chatId.replace(/^tg:/, '');
    await api.sendPhoto(
      numericId,
      new InputFile(fs.createReadStream(filePath)),
      {
        caption: caption || undefined,
      },
    );
    logger.info({ chatId, sender, filePath }, 'Pool photo sent');
  } catch (err) {
    logger.error(
      { chatId, sender, filePath, err },
      'Failed to send pool photo',
    );
  }
}

// Store main bot reference for sendPhoto access
let mainBotApi: Api | null = null;

// Maps chat_jid → Bot api instance that serves that group.
// When a bot receives a message from a group, it registers itself here.
// Used for sending replies via the correct bot.
const jidBotMap = new Map<string, Api>();

// Deduplication: when multiple bots share a group, each receives the same
// message via its own polling. We track recent message IDs to process each
// message only once. IDs expire after 60 seconds to avoid unbounded growth.
const seenMessages = new Map<string, number>();
const SEEN_TTL_MS = 60_000;

function dedup(msgId: string): boolean {
  const now = Date.now();
  // Prune old entries periodically (every 100 calls)
  if (seenMessages.size > 500) {
    for (const [id, ts] of seenMessages) {
      if (now - ts > SEEN_TTL_MS) seenMessages.delete(id);
    }
  }
  if (seenMessages.has(msgId)) return false;
  seenMessages.set(msgId, now);
  return true;
}

/**
 * Register handlers common to all bots (main + extra).
 * Each bot polls independently; messages route through the same callbacks.
 */
function setupBotHandlers(bot: Bot, opts: TelegramChannelOpts): void {
  bot.command('chatid', (ctx) => {
    const chatId = ctx.chat.id;
    const chatType = ctx.chat.type;
    const chatName =
      chatType === 'private'
        ? ctx.from?.first_name || 'Private'
        : (ctx.chat as any).title || 'Unknown';

    ctx.reply(
      `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('ping', (ctx) => {
    ctx.reply(`${ASSISTANT_NAME} is online.`);
  });

  bot.on('message:text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;
    if (!dedup(ctx.message.message_id.toString())) return;

    const chatJid = `tg:${ctx.chat.id}`;
    let content = ctx.message.text;
    const timestamp = new Date(ctx.message.date * 1000).toISOString();
    const senderName =
      ctx.from?.first_name ||
      ctx.from?.username ||
      ctx.from?.id.toString() ||
      'Unknown';
    const sender = ctx.from?.id.toString() || '';
    const msgId = ctx.message.message_id.toString();

    const chatName =
      ctx.chat.type === 'private'
        ? senderName
        : (ctx.chat as any).title || chatJid;

    // Translate @bot_username mentions into TRIGGER_PATTERN format
    const botUsername = ctx.me?.username?.toLowerCase();
    if (botUsername) {
      const entities = ctx.message.entities || [];
      const isBotMentioned = entities.some((entity) => {
        if (entity.type === 'mention') {
          const mentionText = content
            .substring(entity.offset, entity.offset + entity.length)
            .toLowerCase();
          return mentionText === `@${botUsername}`;
        }
        return false;
      });
      if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    opts.onChatMetadata(chatJid, timestamp, chatName, 'telegram', isGroup);

    const group = opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered Telegram chat',
      );
      return;
    }

    // Track which bot serves this group
    jidBotMap.set(chatJid, bot.api);

    opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatJid, chatName, sender: senderName },
      'Telegram message stored',
    );
  });

  const storeNonText = (ctx: any, placeholder: string) => {
    if (!dedup(ctx.message.message_id.toString())) return;
    const chatJid = `tg:${ctx.chat.id}`;
    const group = opts.registeredGroups()[chatJid];
    if (!group) return;

    const timestamp = new Date(ctx.message.date * 1000).toISOString();
    const senderName =
      ctx.from?.first_name ||
      ctx.from?.username ||
      ctx.from?.id?.toString() ||
      'Unknown';
    const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    opts.onChatMetadata(chatJid, timestamp, undefined, 'telegram', isGroup);

    // Track which bot serves this group
    jidBotMap.set(chatJid, ctx.api);

    opts.onMessage(chatJid, {
      id: ctx.message.message_id.toString(),
      chat_jid: chatJid,
      sender: ctx.from?.id?.toString() || '',
      sender_name: senderName,
      content: `${placeholder}${caption}`,
      timestamp,
      is_from_me: false,
    });
  };

  bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
  bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
  bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
  bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
  bot.on('message:document', (ctx) => {
    const name = ctx.message.document?.file_name || 'file';
    storeNonText(ctx, `[Document: ${name}]`);
  });
  bot.on('message:sticker', (ctx) => {
    const emoji = ctx.message.sticker?.emoji || '';
    storeNonText(ctx, `[Sticker ${emoji}]`);
  });
  bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
  bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

  bot.catch((err) => {
    logger.error({ err: err.message }, 'Telegram bot error');
  });
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bots: Bot[] = [];
  private opts: TelegramChannelOpts;
  private botTokens: string[];

  constructor(botTokens: string[], opts: TelegramChannelOpts) {
    this.botTokens = botTokens;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const startPromises = this.botTokens.map(async (token, index) => {
      const bot = new Bot(token);
      this.bots.push(bot);
      setupBotHandlers(bot, this.opts);

      // Clear any stale polling sessions from a previous (killed) process
      try {
        await bot.api.deleteWebhook({ drop_pending_updates: false });
      } catch (err) {
        logger.debug({ err }, 'deleteWebhook before polling (non-critical)');
      }

      return new Promise<void>((resolve) => {
        bot.start({
          onStart: (botInfo) => {
            // First bot is the main bot
            if (index === 0) {
              mainBotApi = bot.api;
            }
            logger.info(
              { username: botInfo.username, id: botInfo.id },
              'Telegram bot connected',
            );
            console.log(`  Telegram bot: @${botInfo.username}`);
            console.log(
              `  Send /chatid to the bot to get a chat's registration ID`,
            );
            resolve();
          },
        });
      });
    });

    console.log('');
    await Promise.all(startPromises);
    console.log('');
  }

  /**
   * Get the Api instance for a given jid.
   * Uses the bot that last received a message from this group,
   * falling back to the main (first) bot.
   */
  private getApiForJid(jid: string): Api | null {
    return (
      jidBotMap.get(jid) || (this.bots.length > 0 ? this.bots[0].api : null)
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const api = this.getApiForJid(jid);
    if (!api) {
      logger.warn('No Telegram bot available');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bots.length > 0;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    for (const bot of this.bots) {
      bot.stop();
    }
    this.bots = [];
    logger.info('All Telegram bots stopped');
  }

  async sendPhoto(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    const api = this.getApiForJid(jid);
    if (!api) {
      logger.warn('No Telegram bot available');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      await api.sendPhoto(
        numericId,
        new InputFile(fs.createReadStream(filePath)),
        {
          caption: caption || undefined,
        },
      );
      logger.info({ jid, filePath }, 'Telegram photo sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send Telegram photo');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    const api = this.getApiForJid(jid);
    if (!api) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_EXTRA_BOTS']);
  const mainToken =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!mainToken) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }

  const tokens = [mainToken];

  // Add extra bots (comma-separated tokens)
  const extraRaw =
    process.env.TELEGRAM_EXTRA_BOTS || envVars.TELEGRAM_EXTRA_BOTS || '';
  if (extraRaw) {
    const extras = extraRaw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    tokens.push(...extras);
  }

  if (tokens.length > 1) {
    logger.info({ count: tokens.length }, 'Telegram multi-bot mode');
  }

  return new TelegramChannel(tokens, opts);
});
