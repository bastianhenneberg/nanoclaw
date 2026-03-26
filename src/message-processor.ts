import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  EMAIL_GROUP_JID,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  setSession,
  storeMessage,
} from './db.js';
import { healthMonitor } from './health-monitor.js';
import { parseImageReferences } from './image.js';
import { injectMemoryIntoPrompt, scheduleMemoryFlush } from './memory.js';
import { findChannel, formatMessages } from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { GroupQueue } from './group-queue.js';

/**
 * Mutable shared state, owned by index.ts, passed by reference.
 */
export interface MessageState {
  lastTimestamp: string;
  lastAgentTimestamp: Record<string, string>;
  sessions: Record<string, string>;
  registeredGroups: Record<string, RegisteredGroup>;
  messageLoopRunning: boolean;
}

export interface MessageProcessorDeps {
  state: MessageState;
  channels: Channel[];
  queue: GroupQueue;
  saveState: () => void;
  getAvailableGroups: () => import('./container-runner.js').AvailableGroup[];
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
export async function processGroupMessages(
  chatJid: string,
  deps: MessageProcessorDeps,
): Promise<boolean> {
  const { state, channels, queue } = deps;
  const group = state.registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = state.lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);
  const imageAttachments = parseImageReferences(missedMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = state.lastAgentTimestamp[chatJid] || '';
  state.lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  deps.saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    imageAttachments,
    deps,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text) {
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    state.lastAgentTimestamp[chatJid] = previousCursor;
    deps.saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  imageAttachments: Array<{ relativePath: string; mediaType: string }>,
  deps: MessageProcessorDeps,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const { state, queue } = deps;
  const isMain = group.isMain === true;
  const sessionId = state.sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = deps.getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(state.registeredGroups)),
  );

  // Collect streamed results for memory flush (streaming mode returns result: null)
  const streamedResults: string[] = [];

  // Track container name for health monitor updates
  let currentContainerName: string | null = null;

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        // Update health monitor on activity
        if (currentContainerName) {
          healthMonitor.updateActivity(currentContainerName);
        }
        if (output.newSessionId) {
          state.sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        if (output.result) {
          streamedResults.push(output.result);
        }
        await onOutput(output);
      }
    : undefined;

  // Inject persistent memory context as a preamble to the prompt
  const promptWithMemory = await injectMemoryIntoPrompt(prompt, group.folder);

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: promptWithMemory,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        ...(imageAttachments.length > 0 && { imageAttachments }),
      },
      (proc, containerName) => {
        currentContainerName = containerName;
        queue.registerProcess(chatJid, proc, containerName, group.folder);
        healthMonitor.registerContainer(
          containerName,
          chatJid,
          group.folder,
          false,
        );
      },
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      state.sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    // Unregister container from health monitor
    if (currentContainerName) {
      healthMonitor.unregisterContainer(currentContainerName);
    }

    // After a session, distill memorable facts into memory storage.
    // Runs fire-and-forget so it never blocks the response.
    // Do this even for errors if we have streamed results — ensures memory
    // is flushed even when containers are killed by health monitor.
    const agentResult = output.result || streamedResults.join('\n\n');
    if (agentResult) {
      scheduleMemoryFlush(group.folder, prompt, agentResult);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

/**
 * Handle an incoming message from any channel.
 * Applies email wildcard routing, sender allowlist, and email attachment handling
 * before storing the message in the database.
 */
export function handleIncomingMessage(
  chatJid: string,
  msg: NewMessage,
  registeredGroups: Record<string, RegisteredGroup>,
): void {
  // Email wildcard routing: if an email arrives for a sender that has no
  // dedicated registered group, reroute to EMAIL_GROUP_JID so a single
  // group can process all incoming emails.
  if (
    chatJid.startsWith('email:') &&
    !registeredGroups[chatJid] &&
    EMAIL_GROUP_JID &&
    registeredGroups[EMAIL_GROUP_JID]
  ) {
    logger.debug(
      { from: chatJid, to: EMAIL_GROUP_JID },
      'Email wildcard routing: rerouting to default email group',
    );
    msg = { ...msg, chat_jid: EMAIL_GROUP_JID };
    chatJid = EMAIL_GROUP_JID;
  }

  // Sender allowlist drop mode: discard messages from denied senders before storing
  if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
    const cfg = loadSenderAllowlist();
    if (
      shouldDropMessage(chatJid, cfg) &&
      !isSenderAllowed(chatJid, msg.sender, cfg)
    ) {
      if (cfg.logDenied) {
        logger.debug(
          { chatJid, sender: msg.sender },
          'sender-allowlist: dropping message (drop mode)',
        );
      }
      return;
    }
  }

  // Email attachment handling: copy temp files into the target group folder
  // so the agent container can access them at /workspace/group/attachments/
  if (msg.emailAttachments && msg.emailAttachments.length > 0) {
    const groupFolder = registeredGroups[chatJid]?.folder;
    if (groupFolder) {
      const attDir = path.join(GROUPS_DIR, groupFolder, 'attachments');
      fs.mkdirSync(attDir, { recursive: true });

      let updatedContent = msg.content;
      for (const att of msg.emailAttachments) {
        const destFilename = `email-${Date.now()}-${att.filename}`;
        const destPath = path.join(attDir, destFilename);
        try {
          fs.copyFileSync(att.tempPath, destPath);
          updatedContent = updatedContent.replace(
            `tempPath="${att.tempPath}"`,
            `path="/workspace/group/attachments/${destFilename}"`,
          );
          logger.info(
            { groupFolder, filename: destFilename },
            'Email attachment copied to group folder',
          );
        } catch (err) {
          logger.warn(
            { err, src: att.tempPath },
            'Failed to copy email attachment',
          );
        }
      }
      msg = { ...msg, content: updatedContent };
    }
  }

  storeMessage(msg);
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
export function recoverPendingMessages(
  state: MessageState,
  queue: GroupQueue,
): void {
  for (const [chatJid, group] of Object.entries(state.registeredGroups)) {
    const sinceTimestamp = state.lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

/**
 * Poll for new messages and route to active containers or queue.
 */
export async function startMessageLoop(
  deps: MessageProcessorDeps,
): Promise<void> {
  const { state, channels, queue } = deps;

  if (state.messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  state.messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(state.registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        state.lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        state.lastTimestamp = newTimestamp;
        deps.saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = state.registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            state.lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            state.lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            deps.saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}
