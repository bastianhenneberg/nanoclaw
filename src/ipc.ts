import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR, IPC_POLL_INTERVAL } from './config.js';

/** Maximum IPC file size (1 MB). Files larger than this are rejected. */
const MAX_IPC_FILE_SIZE = 1024 * 1024;
/** Maximum IPC files to process per group per poll cycle. */
const MAX_IPC_FILES_PER_CYCLE = 100;

/**
 * Safely read an IPC JSON file. Rejects symlinks, oversized files,
 * and invalid JSON. Returns null if the file should be skipped.
 */
function safeReadIpcJson(filePath: string): unknown | null {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    logger.warn({ filePath }, 'Rejecting symlinked IPC file');
    return null;
  }
  if (stat.size > MAX_IPC_FILE_SIZE) {
    logger.warn(
      { filePath, size: stat.size },
      'Rejecting oversized IPC file',
    );
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}
import {
  sendPoolMessage,
  sendPoolPhoto,
  sendPoolVideo,
  sendPoolDocument,
  sendPoolAudio,
  sendPoolVoice,
} from './channels/telegram.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// Re-export IpcDeps so existing consumers (index.ts, tests) keep working
export { IpcDeps } from './ipc-shared.js';
import { IpcDeps } from './ipc-shared.js';

// Handler imports
import {
  handleScheduleTask,
  handlePauseTask,
  handleResumeTask,
  handleCancelTask,
  handleUpdateTask,
} from './ipc-handlers/tasks.js';
import {
  handleRefreshGroups,
  handleRegisterGroup,
} from './ipc-handlers/groups.js';
import {
  handleSendEmail,
  handleListEmails,
  handleReadEmail,
  handleForwardEmail,
  handleEmailAction,
  handleListMailboxes,
  handleSearchEmails,
  handleMoveEmail,
  handleReplyEmail,
  handleFlagEmail,
  handleCopyEmail,
  handleCreateFolder,
} from './ipc-handlers/email.js';
import { handleListIdeas, handleSaveIdea } from './ipc-handlers/ideas.js';

/**
 * Translate a container filesystem path to the corresponding host path.
 * Container mounts:
 *   /workspace/group/    → groups/{groupFolder}/
 *   /workspace/extra/*   → additionalMounts from containerConfig
 *   /workspace/project/  → project root (cwd)
 */
/**
 * Check that a resolved path stays within the expected base directory.
 * Prevents path traversal via ../ in container-supplied paths.
 */
function isPathContained(resolved: string, base: string): boolean {
  const rel = path.relative(base, resolved);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveHostPath(
  containerPath: string,
  sourceGroup: string,
  registeredGroups: Record<string, RegisteredGroup>,
): string | null {
  // Reject paths with .. to prevent traversal
  if (containerPath.includes('..')) {
    logger.warn(
      { containerPath, sourceGroup },
      'Rejecting container path with ".." (path traversal attempt)',
    );
    return null;
  }

  if (containerPath.startsWith('/workspace/group/')) {
    const base = path.join(GROUPS_DIR, sourceGroup);
    const resolved = path.join(
      base,
      containerPath.slice('/workspace/group/'.length),
    );
    if (!isPathContained(resolved, base)) return null;
    return resolved;
  }
  if (containerPath === '/workspace/group') {
    return path.join(GROUPS_DIR, sourceGroup);
  }
  if (containerPath.startsWith('/workspace/extra/')) {
    // Find the group's additionalMounts config to resolve the mapping
    for (const group of Object.values(registeredGroups)) {
      if (group.folder !== sourceGroup) continue;
      const mounts = group.containerConfig?.additionalMounts;
      if (!mounts) break;
      // /workspace/extra/{containerPath} → match against mount containerPath
      const relativePath = containerPath.slice('/workspace/extra/'.length);
      for (const mount of mounts) {
        const mountName = mount.containerPath || path.basename(mount.hostPath);
        if (
          relativePath === mountName ||
          relativePath.startsWith(mountName + '/')
        ) {
          const subPath = relativePath
            .slice(mountName.length)
            .replace(/^\//, '');
          const resolved = subPath
            ? path.join(mount.hostPath, subPath)
            : mount.hostPath;
          if (!isPathContained(resolved, mount.hostPath)) return null;
          return resolved;
        }
      }
      break;
    }
    logger.warn(
      { containerPath, sourceGroup },
      'Cannot resolve /workspace/extra/ path — no matching mount',
    );
    return null;
  }
  if (containerPath.startsWith('/workspace/project/')) {
    const base = process.cwd();
    const resolved = path.join(
      base,
      containerPath.slice('/workspace/project/'.length),
    );
    if (!isPathContained(resolved, base)) return null;
    return resolved;
  }
  // Not a known container path — return as-is (might be absolute host path already)
  return containerPath;
}

/**
 * Send a media file (photo/video/document) via IPC.
 * Resolves container path → host path, checks existence, routes to pool or deps sender.
 */
async function sendMediaFile(
  type: 'photo' | 'video' | 'document' | 'audio' | 'voice',
  data: {
    chatJid: string;
    filePath: string;
    caption?: string;
    sender?: string;
  },
  sourceGroup: string,
  registeredGroups: Record<string, RegisteredGroup>,
  deps: IpcDeps,
): Promise<void> {
  const hostFilePath = resolveHostPath(
    data.filePath,
    sourceGroup,
    registeredGroups,
  );
  if (!hostFilePath || !fs.existsSync(hostFilePath)) {
    logger.error(
      { containerPath: data.filePath, hostFilePath, sourceGroup, type },
      `${type} file not found on host`,
    );
    return;
  }

  const poolSenders: Record<
    string,
    (
      jid: string,
      fp: string,
      cap: string | undefined,
      sender: string,
      sg: string,
    ) => Promise<void>
  > = {
    photo: sendPoolPhoto,
    video: sendPoolVideo,
    document: sendPoolDocument,
    audio: sendPoolAudio,
    voice: sendPoolVoice,
  };
  const depsSenders: Record<
    string,
    (jid: string, fp: string, cap?: string) => Promise<void>
  > = {
    photo: deps.sendPhoto,
    video: deps.sendVideo,
    document: deps.sendDocument,
    audio: deps.sendAudio,
    voice: deps.sendVoice,
  };

  if (data.sender) {
    await poolSenders[type](
      data.chatJid,
      hostFilePath,
      data.caption,
      data.sender,
      sourceGroup,
    );
  } else {
    await depsSenders[type](data.chatJid, hostFilePath, data.caption);
  }

  logger.info(
    {
      chatJid: data.chatJid,
      sourceGroup,
      sender: data.sender,
      containerPath: data.filePath,
      hostPath: hostFilePath,
    },
    `IPC ${type} sent`,
  );
}

/**
 * Dispatch a single IPC message (text, photo, video, or document).
 */
async function dispatchIpcMessage(
  data: {
    type: string;
    chatJid: string;
    text?: string;
    filePath?: string;
    caption?: string;
    sender?: string;
  },
  sourceGroup: string,
  registeredGroups: Record<string, RegisteredGroup>,
  deps: IpcDeps,
): Promise<void> {
  if (data.type === 'message' && data.text) {
    if (data.sender && data.chatJid.startsWith('tg:')) {
      await sendPoolMessage(data.chatJid, data.text, data.sender, sourceGroup);
    } else {
      await deps.sendMessage(data.chatJid, data.text);
    }
    logger.info(
      { chatJid: data.chatJid, sourceGroup, sender: data.sender },
      'IPC message sent',
    );
  } else if (
    (data.type === 'photo' ||
      data.type === 'video' ||
      data.type === 'document' ||
      data.type === 'audio' ||
      data.type === 'voice') &&
    data.filePath &&
    data.chatJid.startsWith('tg:')
  ) {
    // Auto-detect audio files sent as documents
    let effectiveType = data.type as
      | 'photo'
      | 'video'
      | 'document'
      | 'audio'
      | 'voice';
    if (data.type === 'document' && data.filePath) {
      const ext = path.extname(data.filePath).toLowerCase();
      if (['.mp3', '.wav', '.m4a', '.aac', '.flac'].includes(ext)) {
        effectiveType = 'audio';
        logger.info(
          { filePath: data.filePath, ext },
          'Auto-detected audio file',
        );
      } else if (['.ogg', '.oga', '.opus'].includes(ext)) {
        effectiveType = 'voice';
        logger.info(
          { filePath: data.filePath, ext },
          'Auto-detected voice file',
        );
      }
    }
    await sendMediaFile(
      effectiveType,
      data as {
        chatJid: string;
        filePath: string;
        caption?: string;
        sender?: string;
      },
      sourceGroup,
      registeredGroups,
      deps,
    );
  }
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'))
            .slice(0, MAX_IPC_FILES_PER_CYCLE);
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = safeReadIpcJson(filePath);
              if (data === null) {
                fs.unlinkSync(filePath);
                continue;
              }
              if (
                data.chatJid &&
                (data.type === 'message' ||
                  data.type === 'photo' ||
                  data.type === 'video' ||
                  data.type === 'document')
              ) {
                // Authorization: verify this group can send to this chatJid.
                // Non-main groups can only send to their own registered JID.
                // Unregistered JIDs (email, unknown) are blocked for non-main.
                const targetGroup = registeredGroups[data.chatJid];
                const isAuthorized =
                  isMain ||
                  (targetGroup != null && targetGroup.folder === sourceGroup);
                if (isAuthorized) {
                  await dispatchIpcMessage(
                    data,
                    sourceGroup,
                    registeredGroups,
                    deps,
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'))
            .slice(0, MAX_IPC_FILES_PER_CYCLE);
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = safeReadIpcJson(filePath);
              if (data === null) {
                fs.unlinkSync(filePath);
                continue;
              }
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For send_email
    to?: string | string[];
    subject?: string;
    body?: string;
    from?: string;
    html?: string;
    replyTo?: string;
    // For email_action
    action?: string;
    messageId?: string;
    account?: string;
    archiveFolder?: string;
    // For list_emails (folder already defined above)
    limit?: number;
    unreadOnly?: boolean;
    requestId?: string;
    // For read_email / forward_email
    uid?: number;
    comment?: string;
    // For search_emails
    query?: string;
    folders?: string[];
    includeDeleted?: boolean;
    // For move_email / copy_email
    fromFolder?: string;
    toFolder?: string;
    // For flag_email
    flag?: string;
    // For create_folder
    folderPath?: string;
    // For save_idea
    content?: string;
    scope?: string;
  },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  switch (data.type) {
    case 'schedule_task':
      await handleScheduleTask(data, sourceGroup, isMain, deps);
      break;
    case 'pause_task':
      await handlePauseTask(data, sourceGroup, isMain, deps);
      break;
    case 'resume_task':
      await handleResumeTask(data, sourceGroup, isMain, deps);
      break;
    case 'cancel_task':
      await handleCancelTask(data, sourceGroup, isMain, deps);
      break;
    case 'update_task':
      await handleUpdateTask(data, sourceGroup, isMain, deps);
      break;
    case 'refresh_groups':
      await handleRefreshGroups(sourceGroup, isMain, deps);
      break;
    case 'register_group':
      await handleRegisterGroup(data, sourceGroup, isMain, deps);
      break;
    case 'send_email':
      await handleSendEmail(data, sourceGroup);
      break;
    case 'list_emails':
      await handleListEmails(data, sourceGroup);
      break;
    case 'read_email':
      await handleReadEmail(data, sourceGroup);
      break;
    case 'forward_email':
      await handleForwardEmail(data, sourceGroup);
      break;
    case 'email_action':
      await handleEmailAction(data, sourceGroup);
      break;
    case 'list_mailboxes':
      await handleListMailboxes(data, sourceGroup);
      break;
    case 'search_emails':
      await handleSearchEmails(data, sourceGroup);
      break;
    case 'move_email':
      await handleMoveEmail(data, sourceGroup);
      break;
    case 'reply_email':
      await handleReplyEmail(data, sourceGroup);
      break;
    case 'flag_email':
      await handleFlagEmail(data, sourceGroup);
      break;
    case 'copy_email':
      await handleCopyEmail(data, sourceGroup);
      break;
    case 'create_folder':
      await handleCreateFolder(data, sourceGroup);
      break;
    case 'list_ideas':
      await handleListIdeas(data, sourceGroup);
      break;
    case 'save_idea':
      await handleSaveIdea(data, sourceGroup);
      break;
    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
