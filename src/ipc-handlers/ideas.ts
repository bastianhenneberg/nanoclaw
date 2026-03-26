import { writeIpcResponse } from '../ipc-shared.js';
import { logger } from '../logger.js';

export async function handleListIdeas(
  data: {
    scope?: string;
    requestId?: string;
  },
  sourceGroup: string,
): Promise<void> {
  if (!data.requestId) return;
  try {
    const { readIdeas } = await import('../memory.js');
    const result = await readIdeas(
      sourceGroup,
      (data.scope as 'group' | 'agent' | 'global' | 'all') || 'all',
    );
    writeIpcResponse(sourceGroup, data.requestId, { result });
    logger.info({ sourceGroup }, 'Ideas listed via IPC');
  } catch (err) {
    writeIpcResponse(sourceGroup, data.requestId, {
      error: String(err),
    });
    logger.error({ sourceGroup, err }, 'Error listing ideas via IPC');
  }
}

export async function handleSaveIdea(
  data: {
    content?: string;
    scope?: string;
  },
  sourceGroup: string,
): Promise<void> {
  if (!data.content) {
    logger.warn({ data }, 'Invalid save_idea request - missing content');
    return;
  }
  try {
    const { saveIdea } = await import('../memory.js');
    await saveIdea(
      sourceGroup,
      data.content as string,
      (data.scope as 'group' | 'agent' | 'global') || 'group',
    );
    logger.info({ sourceGroup }, 'Idea saved via IPC');
  } catch (err) {
    logger.error({ sourceGroup, err }, 'Error saving idea via IPC');
  }
}
