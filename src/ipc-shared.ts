import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { RegisteredGroup } from './types.js';

/**
 * Write an IPC response file for request/response style IPC calls.
 * Creates the responses directory if needed.
 */
/** Validate requestId to prevent path traversal. */
const SAFE_REQUEST_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export function writeIpcResponse(
  sourceGroup: string,
  requestId: string,
  data: { result?: unknown; error?: string },
): string {
  // Sanitize requestId: strip path components and validate
  const safeId = path.basename(requestId).replace(/\.json$/, '');
  if (!SAFE_REQUEST_ID.test(safeId)) {
    throw new Error(`Invalid IPC requestId: ${requestId}`);
  }
  // Truncate error messages to prevent disk exhaustion
  if (data.error && data.error.length > 4096) {
    data = { ...data, error: data.error.slice(0, 4096) + '... [truncated]' };
  }
  const responseDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
  fs.mkdirSync(responseDir, { recursive: true });
  const responseFile = path.join(responseDir, `${safeId}.json`);
  fs.writeFileSync(responseFile, JSON.stringify(data));
  return responseFile;
}

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendPhoto: (jid: string, filePath: string, caption?: string) => Promise<void>;
  sendVideo: (jid: string, filePath: string, caption?: string) => Promise<void>;
  sendDocument: (
    jid: string,
    filePath: string,
    caption?: string,
  ) => Promise<void>;
  sendAudio: (jid: string, filePath: string, caption?: string) => Promise<void>;
  sendVoice: (jid: string, filePath: string, caption?: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
}
