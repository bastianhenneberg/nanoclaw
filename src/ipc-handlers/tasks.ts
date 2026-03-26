import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../config.js';
import { createTask, deleteTask, getTaskById, updateTask } from '../db.js';
import { IpcDeps } from '../ipc-shared.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';

export async function handleScheduleTask(
  data: {
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    targetJid?: string;
  },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  if (
    !data.prompt ||
    !data.schedule_type ||
    !data.schedule_value ||
    !data.targetJid
  )
    return;

  const registeredGroups = deps.registeredGroups();
  const targetJid = data.targetJid as string;
  const targetGroupEntry = registeredGroups[targetJid];

  if (!targetGroupEntry) {
    logger.warn(
      { targetJid },
      'Cannot schedule task: target group not registered',
    );
    return;
  }

  const targetFolder = targetGroupEntry.folder;

  // Authorization: non-main groups can only schedule for themselves
  if (!isMain && targetFolder !== sourceGroup) {
    logger.warn(
      { sourceGroup, targetFolder },
      'Unauthorized schedule_task attempt blocked',
    );
    return;
  }

  const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

  let nextRun: string | null = null;
  if (scheduleType === 'cron') {
    try {
      const interval = CronExpressionParser.parse(data.schedule_value, {
        tz: TIMEZONE,
      });
      nextRun = interval.next().toISOString();
    } catch {
      logger.warn(
        { scheduleValue: data.schedule_value },
        'Invalid cron expression',
      );
      return;
    }
  } else if (scheduleType === 'interval') {
    const ms = parseInt(data.schedule_value, 10);
    if (isNaN(ms) || ms <= 0) {
      logger.warn(
        { scheduleValue: data.schedule_value },
        'Invalid interval',
      );
      return;
    }
    nextRun = new Date(Date.now() + ms).toISOString();
  } else if (scheduleType === 'once') {
    const date = new Date(data.schedule_value);
    if (isNaN(date.getTime())) {
      logger.warn(
        { scheduleValue: data.schedule_value },
        'Invalid timestamp',
      );
      return;
    }
    nextRun = date.toISOString();
  }

  const taskId =
    data.taskId ||
    `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const contextMode =
    data.context_mode === 'group' || data.context_mode === 'isolated'
      ? data.context_mode
      : 'isolated';
  createTask({
    id: taskId,
    group_folder: targetFolder,
    chat_jid: targetJid,
    prompt: data.prompt,
    schedule_type: scheduleType,
    schedule_value: data.schedule_value,
    context_mode: contextMode,
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
  });
  logger.info(
    { taskId, sourceGroup, targetFolder, contextMode },
    'Task created via IPC',
  );
  deps.onTasksChanged();
}

export async function handlePauseTask(
  data: { taskId?: string },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  if (!data.taskId) return;
  const task = getTaskById(data.taskId);
  if (task && (isMain || task.group_folder === sourceGroup)) {
    updateTask(data.taskId, { status: 'paused' });
    logger.info(
      { taskId: data.taskId, sourceGroup },
      'Task paused via IPC',
    );
    deps.onTasksChanged();
  } else {
    logger.warn(
      { taskId: data.taskId, sourceGroup },
      'Unauthorized task pause attempt',
    );
  }
}

export async function handleResumeTask(
  data: { taskId?: string },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  if (!data.taskId) return;
  const task = getTaskById(data.taskId);
  if (task && (isMain || task.group_folder === sourceGroup)) {
    updateTask(data.taskId, { status: 'active' });
    logger.info(
      { taskId: data.taskId, sourceGroup },
      'Task resumed via IPC',
    );
    deps.onTasksChanged();
  } else {
    logger.warn(
      { taskId: data.taskId, sourceGroup },
      'Unauthorized task resume attempt',
    );
  }
}

export async function handleCancelTask(
  data: { taskId?: string },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  if (!data.taskId) return;
  const task = getTaskById(data.taskId);
  if (task && (isMain || task.group_folder === sourceGroup)) {
    deleteTask(data.taskId);
    logger.info(
      { taskId: data.taskId, sourceGroup },
      'Task cancelled via IPC',
    );
    deps.onTasksChanged();
  } else {
    logger.warn(
      { taskId: data.taskId, sourceGroup },
      'Unauthorized task cancel attempt',
    );
  }
}

export async function handleUpdateTask(
  data: {
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
  },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  if (!data.taskId) return;
  const task = getTaskById(data.taskId);
  if (!task) {
    logger.warn(
      { taskId: data.taskId, sourceGroup },
      'Task not found for update',
    );
    return;
  }
  if (!isMain && task.group_folder !== sourceGroup) {
    logger.warn(
      { taskId: data.taskId, sourceGroup },
      'Unauthorized task update attempt',
    );
    return;
  }

  const updates: Parameters<typeof updateTask>[1] = {};
  if (data.prompt !== undefined) updates.prompt = data.prompt;
  if (data.schedule_type !== undefined)
    updates.schedule_type = data.schedule_type as
      | 'cron'
      | 'interval'
      | 'once';
  if (data.schedule_value !== undefined)
    updates.schedule_value = data.schedule_value;

  // Recompute next_run if schedule changed
  if (data.schedule_type || data.schedule_value) {
    const updatedTask = {
      ...task,
      ...updates,
    };
    if (updatedTask.schedule_type === 'cron') {
      try {
        const interval = CronExpressionParser.parse(
          updatedTask.schedule_value,
          { tz: TIMEZONE },
        );
        updates.next_run = interval.next().toISOString();
      } catch {
        logger.warn(
          { taskId: data.taskId, value: updatedTask.schedule_value },
          'Invalid cron in task update',
        );
        return;
      }
    } else if (updatedTask.schedule_type === 'interval') {
      const ms = parseInt(updatedTask.schedule_value, 10);
      if (!isNaN(ms) && ms > 0) {
        updates.next_run = new Date(Date.now() + ms).toISOString();
      }
    }
  }

  updateTask(data.taskId, updates);
  logger.info(
    { taskId: data.taskId, sourceGroup, updates },
    'Task updated via IPC',
  );
  deps.onTasksChanged();
}
