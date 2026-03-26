import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  TELEGRAM_BOT_POOL,
  WEBHOOK_BIND_HOST,
  WEBHOOK_PORT,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import { writeGroupsSnapshot, writeTasksSnapshot } from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  storeChatMetadata,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { healthMonitor } from './health-monitor.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { initBotPool } from './channels/telegram.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatOutbound, routeOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { startWebhookServer } from './webhook-server.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import {
  handleIncomingMessage,
  MessageProcessorDeps,
  MessageState,
  processGroupMessages,
  recoverPendingMessages,
  startMessageLoop,
} from './message-processor.js';

// --- Shared mutable state ---

const messageState: MessageState = {
  lastTimestamp: '',
  lastAgentTimestamp: {},
  sessions: {},
  registeredGroups: {},
  messageLoopRunning: false,
};

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  messageState.lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    messageState.lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    messageState.lastAgentTimestamp = {};
  }
  messageState.sessions = getAllSessions();
  messageState.registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(messageState.registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', messageState.lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(messageState.lastAgentTimestamp),
  );
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  messageState.registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(messageState.registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  messageState.registeredGroups = groups;
}

// --- Message processor deps (bridges state to extracted functions) ---

const processorDeps: MessageProcessorDeps = {
  state: messageState,
  channels,
  queue,
  saveState,
  getAvailableGroups,
};

/**
 * Resolve a channel for a JID and call a method on it.
 * Throws if no channel owns the JID or the method is not supported.
 */
function requireChannelMethod(jid: string, method: string): any {
  const channel = findChannel(channels, jid);
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  if (!(method in channel))
    throw new Error(`Channel for ${jid} does not support ${method}`);
  return (channel as any)[method].bind(channel);
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Webhook server is started after channelOpts is defined below.
  let webhookServer: import('http').Server | null = null;

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    webhookServer?.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = messageState.registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err: unknown) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }
      handleIncomingMessage(chatJid, msg, messageState.registeredGroups);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => messageState.registeredGroups,
  };

  // Start optional webhook server now that channelOpts is defined.
  if (WEBHOOK_PORT > 0) {
    webhookServer = await startWebhookServer(WEBHOOK_PORT, WEBHOOK_BIND_HOST, {
      onMessage: (chatJid, msg) => channelOpts.onMessage(chatJid, msg),
      registeredGroups: () => messageState.registeredGroups,
      sendNotification: (jid, text) => routeOutbound(channels, jid, text),
    });
  }

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Initialize Telegram bot pool for agent swarms
  if (TELEGRAM_BOT_POOL.length > 0) {
    await initBotPool(TELEGRAM_BOT_POOL);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => messageState.registeredGroups,
    getSessions: () => messageState.sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => {
      queue.registerProcess(groupJid, proc, containerName, groupFolder);
      healthMonitor.registerContainer(
        containerName,
        groupJid,
        groupFolder,
        true,
      );
    },
    onProcessComplete: (containerName) => {
      healthMonitor.unregisterContainer(containerName);
    },
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) =>
      requireChannelMethod(jid, 'sendMessage')(jid, text),
    sendPhoto: (jid, fp, cap) =>
      requireChannelMethod(jid, 'sendPhoto')(jid, fp, cap),
    sendVideo: (jid, fp, cap) =>
      requireChannelMethod(jid, 'sendVideo')(jid, fp, cap),
    sendDocument: (jid, fp, cap) =>
      requireChannelMethod(jid, 'sendDocument')(jid, fp, cap),
    sendAudio: (jid, fp, cap) =>
      requireChannelMethod(jid, 'sendAudio')(jid, fp, cap),
    sendVoice: (jid, fp, cap) =>
      requireChannelMethod(jid, 'sendVoice')(jid, fp, cap),
    registeredGroups: () => messageState.registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(messageState.registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  queue.setProcessMessagesFn((chatJid) =>
    processGroupMessages(chatJid, processorDeps),
  );

  // Start health monitoring for self-healing
  healthMonitor.setHealCallback((groupJid) => {
    queue.resetGroup(groupJid);
  });
  healthMonitor.setAlertCallback((message, level) => {
    // Find main group and send alert there
    const mainEntry = Object.entries(messageState.registeredGroups).find(
      ([, g]) => g.isMain,
    );
    if (mainEntry) {
      const [mainJid] = mainEntry;
      const channel = findChannel(channels, mainJid);
      if (channel) {
        const prefix = level === 'error' ? '🚨' : '⚠️';
        channel.sendMessage(mainJid, `${prefix} ${message}`).catch((err) => {
          logger.error({ err }, 'Failed to send health alert');
        });
      }
    }
    if (level === 'error') {
      logger.error(message);
    } else {
      logger.warn(message);
    }
  });
  healthMonitor.start();
  logger.info('Health monitor started');

  recoverPendingMessages(messageState, queue);
  startMessageLoop(processorDeps).catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
