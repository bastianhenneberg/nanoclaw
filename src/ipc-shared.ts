import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { RegisteredGroup } from './types.js';

/**
 * Write an IPC response file for request/response style IPC calls.
 * Creates the responses directory if needed.
 */
export function writeIpcResponse(
  sourceGroup: string,
  requestId: string,
  data: { result?: unknown; error?: string },
): string {
  const responseDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
  fs.mkdirSync(responseDir, { recursive: true });
  const responseFile = path.join(responseDir, `${requestId}.json`);
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
