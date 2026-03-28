/**
 * IPC Handlers for Presence Tracker
 *
 * Commands:
 *   presence_track   - Add a number to tracking
 *   presence_untrack - Remove a number from tracking
 *   presence_list    - List all tracked numbers
 *   presence_stats   - Get usage statistics for a number
 *   presence_events  - Get recent presence events
 *   presence_status  - Check tracker connection status
 */

import { getPresenceTracker, isPresenceTrackerEnabled } from '../presence/index.js';
import { writeIpcResponse } from '../ipc-shared.js';
import { logger } from '../logger.js';

export async function handlePresenceTrack(
  data: {
    phone?: string;
    label?: string;
    requestId?: string;
  },
  sourceGroup: string,
): Promise<void> {
  if (!data.requestId) return;

  if (!isPresenceTrackerEnabled()) {
    writeIpcResponse(sourceGroup, data.requestId, {
      error: 'Presence tracker is not enabled. Set PRESENCE_TRACKER_ENABLED=true in .env',
    });
    return;
  }

  if (!data.phone) {
    writeIpcResponse(sourceGroup, data.requestId, {
      error: 'Missing required parameter: phone',
    });
    return;
  }

  const tracker = getPresenceTracker()!;
  const success = tracker.addNumber(data.phone, data.label);

  writeIpcResponse(sourceGroup, data.requestId, {
    result: success
      ? `✅ Now tracking ${data.label || data.phone}`
      : `❌ Failed to add ${data.phone}`,
  });

  logger.info(
    { sourceGroup, phone: data.phone, label: data.label, success },
    'Presence track request',
  );
}

export async function handlePresenceUntrack(
  data: {
    phone?: string;
    requestId?: string;
  },
  sourceGroup: string,
): Promise<void> {
  if (!data.requestId) return;

  if (!isPresenceTrackerEnabled()) {
    writeIpcResponse(sourceGroup, data.requestId, {
      error: 'Presence tracker is not enabled',
    });
    return;
  }

  if (!data.phone) {
    writeIpcResponse(sourceGroup, data.requestId, {
      error: 'Missing required parameter: phone',
    });
    return;
  }

  const tracker = getPresenceTracker()!;
  const success = tracker.removeNumber(data.phone);

  writeIpcResponse(sourceGroup, data.requestId, {
    result: success
      ? `✅ Stopped tracking ${data.phone}`
      : `❌ Failed to remove ${data.phone}`,
  });

  logger.info(
    { sourceGroup, phone: data.phone, success },
    'Presence untrack request',
  );
}

export async function handlePresenceList(
  data: {
    requestId?: string;
  },
  sourceGroup: string,
): Promise<void> {
  if (!data.requestId) return;

  if (!isPresenceTrackerEnabled()) {
    writeIpcResponse(sourceGroup, data.requestId, {
      error: 'Presence tracker is not enabled',
    });
    return;
  }

  const tracker = getPresenceTracker()!;
  const tracked = tracker.listTracked();

  if (tracked.length === 0) {
    writeIpcResponse(sourceGroup, data.requestId, {
      result: '📋 No numbers tracked yet.\n\nUse presence_track to add numbers.',
    });
    return;
  }

  const lines = ['📋 **Tracked Numbers:**', ''];
  for (const t of tracked) {
    const phone = t.jid.replace('@s.whatsapp.net', '');
    const label = t.label ? `**${t.label}**` : phone;
    const addedDate = new Date(t.addedAt).toLocaleDateString('de-DE');
    lines.push(`• ${label} (${phone}) - since ${addedDate}`);
  }

  writeIpcResponse(sourceGroup, data.requestId, {
    result: lines.join('\n'),
  });
}

export async function handlePresenceStats(
  data: {
    phone?: string;
    days?: number;
    requestId?: string;
  },
  sourceGroup: string,
): Promise<void> {
  if (!data.requestId) return;

  if (!isPresenceTrackerEnabled()) {
    writeIpcResponse(sourceGroup, data.requestId, {
      error: 'Presence tracker is not enabled',
    });
    return;
  }

  if (!data.phone) {
    writeIpcResponse(sourceGroup, data.requestId, {
      error: 'Missing required parameter: phone',
    });
    return;
  }

  const tracker = getPresenceTracker()!;
  const days = data.days || 7;
  const stats = tracker.getStats(data.phone, days);

  if (stats.length === 0) {
    writeIpcResponse(sourceGroup, data.requestId, {
      result: `📊 No data yet for ${data.phone} in the last ${days} days.`,
    });
    return;
  }

  const lines = [`📊 **Stats for ${data.phone}** (last ${days} days):`, ''];
  lines.push('```');
  lines.push('Date       | Sessions | Online  | First    | Last');
  lines.push('-'.repeat(55));

  let totalSessions = 0;
  let totalMinutes = 0;

  for (const s of stats) {
    totalSessions += s.sessions;
    totalMinutes += s.totalMinutes;
    lines.push(
      `${s.date} | ${String(s.sessions).padStart(8)} | ${String(s.totalMinutes).padStart(5)}m | ${s.firstSeen.padStart(8)} | ${s.lastSeen}`,
    );
  }

  lines.push('-'.repeat(55));
  lines.push(
    `Total      | ${String(totalSessions).padStart(8)} | ${String(totalMinutes).padStart(5)}m |`,
  );
  lines.push('```');

  writeIpcResponse(sourceGroup, data.requestId, {
    result: lines.join('\n'),
  });

  logger.info(
    { sourceGroup, phone: data.phone, days },
    'Presence stats request',
  );
}

export async function handlePresenceEvents(
  data: {
    phone?: string;
    limit?: number;
    requestId?: string;
  },
  sourceGroup: string,
): Promise<void> {
  if (!data.requestId) return;

  if (!isPresenceTrackerEnabled()) {
    writeIpcResponse(sourceGroup, data.requestId, {
      error: 'Presence tracker is not enabled',
    });
    return;
  }

  if (!data.phone) {
    writeIpcResponse(sourceGroup, data.requestId, {
      error: 'Missing required parameter: phone',
    });
    return;
  }

  const tracker = getPresenceTracker()!;
  const limit = data.limit || 20;
  const events = tracker.getRecentEvents(data.phone, limit);

  if (events.length === 0) {
    writeIpcResponse(sourceGroup, data.requestId, {
      result: `📜 No events yet for ${data.phone}.`,
    });
    return;
  }

  const lines = [`📜 **Recent Events for ${data.phone}:**`, ''];

  for (const e of events.slice(0, 20)) {
    const time = new Date(e.timestamp).toLocaleString('de-DE');
    const icon =
      e.status === 'available'
        ? '🟢'
        : e.status === 'unavailable'
          ? '🔴'
          : '✍️';
    lines.push(`${icon} ${time} - ${e.status}`);
  }

  if (events.length > 20) {
    lines.push(`\n... and ${events.length - 20} more events`);
  }

  writeIpcResponse(sourceGroup, data.requestId, {
    result: lines.join('\n'),
  });
}

export async function handlePresenceStatus(
  data: {
    requestId?: string;
  },
  sourceGroup: string,
): Promise<void> {
  if (!data.requestId) return;

  if (!isPresenceTrackerEnabled()) {
    writeIpcResponse(sourceGroup, data.requestId, {
      result: '❌ Presence tracker is disabled (PRESENCE_TRACKER_ENABLED != true)',
    });
    return;
  }

  const tracker = getPresenceTracker()!;
  const connected = tracker.isConnected();
  const tracked = tracker.listTracked();

  const lines = [
    '📡 **Presence Tracker Status:**',
    '',
    `• Connection: ${connected ? '🟢 Connected' : '🔴 Disconnected'}`,
    `• Tracking: ${tracked.length} number(s)`,
  ];

  writeIpcResponse(sourceGroup, data.requestId, {
    result: lines.join('\n'),
  });
}
