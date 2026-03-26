import { isValidGroupFolder } from '../group-folder.js';
import { IpcDeps } from '../ipc-shared.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';

export async function handleRefreshGroups(
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  if (isMain) {
    logger.info(
      { sourceGroup },
      'Group metadata refresh requested via IPC',
    );
    await deps.syncGroups(true);
    const registeredGroups = deps.registeredGroups();
    const availableGroups = deps.getAvailableGroups();
    deps.writeGroupsSnapshot(
      sourceGroup,
      true,
      availableGroups,
      new Set(Object.keys(registeredGroups)),
    );
  } else {
    logger.warn(
      { sourceGroup },
      'Unauthorized refresh_groups attempt blocked',
    );
  }
}

export async function handleRegisterGroup(
  data: {
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  if (!isMain) {
    logger.warn(
      { sourceGroup },
      'Unauthorized register_group attempt blocked',
    );
    return;
  }
  if (data.jid && data.name && data.folder && data.trigger) {
    if (!isValidGroupFolder(data.folder)) {
      logger.warn(
        { sourceGroup, folder: data.folder },
        'Invalid register_group request - unsafe folder name',
      );
      return;
    }
    // Defense in depth: agent cannot set isMain via IPC
    deps.registerGroup(data.jid, {
      name: data.name,
      folder: data.folder,
      trigger: data.trigger,
      added_at: new Date().toISOString(),
      containerConfig: data.containerConfig,
      requiresTrigger: data.requiresTrigger,
    });
  } else {
    logger.warn(
      { data },
      'Invalid register_group request - missing required fields',
    );
  }
}
