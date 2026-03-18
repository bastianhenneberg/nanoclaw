/**
 * Persistent Memory System for NanoClaw
 *
 * Two-tier storage:
 *   1. Local files (primary, always available):
 *      groups/{folder}/MEMORY.md          — curated long-term facts
 *      groups/{folder}/memory/YYYY-MM-DD.md — daily session summaries
 *
 *   2. AI Brain API (centralized, cross-agent):
 *      POST /api/v1/agent-memories — store distilled facts
 *      GET  /api/v1/agent-memories — read memories with scope isolation
 *
 * Phase 1 (Dual-Write): writes to both, reads from local (fallback-safe).
 * If AI Brain is unreachable, local files are always used.
 */
import fs from 'fs';
import path from 'path';

import {
  AI_BRAIN_API_KEY,
  AI_BRAIN_API_URL,
  GROUPS_DIR,
  MEMORY_ENABLED,
  TIMEZONE,
} from './config.js';
import { callLlm } from './llm-provider.js';
import { logger } from './logger.js';

const AGENT_NAME = 'nanoclaw';

/**
 * Maximum characters of memory injected into each prompt.
 * Older / lower-priority content is truncated from the front.
 */
const MAX_CONTEXT_CHARS = 3000;

/** Number of daily memory files included in context (most recent N days). */
const MAX_DAILY_FILES = 7;

/** Minimum response length before attempting a memory flush. */
const MIN_RESPONSE_LENGTH = 50;

/** System prompt used when extracting memorable facts from a session. */
const FLUSH_SYSTEM_PROMPT = `You are a memory distillation assistant. Your job is to extract durable, reusable facts from a conversation that are worth remembering long-term.

Only extract:
- User preferences and working styles
- Explicit decisions or choices the user made
- Important names, contacts, project details
- Things the user explicitly asked to remember
- Technical context that will be relevant in future sessions

Do NOT extract:
- Ephemeral status (e.g. "server is running")
- One-off questions with no lasting relevance
- Trivial small talk

Format output as a concise Markdown bullet list (•). If nothing is worth remembering, reply with exactly: NOTHING`;

/** Check if AI Brain API is configured. */
function isAiBrainEnabled(): boolean {
  return !!(AI_BRAIN_API_URL && AI_BRAIN_API_KEY);
}

/**
 * Write a memory to the AI Brain API (fire-and-forget).
 * Never throws — failures are logged and silently ignored.
 */
async function writeToAiBrain(
  groupFolder: string,
  content: string,
  type: 'short-term' | 'long-term' = 'short-term',
): Promise<void> {
  if (!isAiBrainEnabled()) return;

  try {
    const response = await fetch(`${AI_BRAIN_API_URL}/api/v1/agent-memories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': AI_BRAIN_API_KEY,
      },
      body: JSON.stringify({
        agent: AGENT_NAME,
        group: groupFolder,
        scope: 'group',
        type,
        content,
      }),
    });

    if (!response.ok) {
      logger.warn(
        { groupFolder, status: response.status },
        'AI Brain API write failed',
      );
    } else {
      logger.debug({ groupFolder }, 'Memory synced to AI Brain');
    }
  } catch (err) {
    logger.warn({ groupFolder, err }, 'AI Brain API unreachable');
  }
}

/**
 * Read memories from AI Brain API for a group.
 * Returns formatted string or null if unavailable.
 */
async function readFromAiBrain(
  groupFolder: string,
  days: number = MAX_DAILY_FILES,
): Promise<string | null> {
  if (!isAiBrainEnabled()) return null;

  try {
    const params = new URLSearchParams({
      agent: AGENT_NAME,
      group: groupFolder,
      days: String(days),
      limit: '50',
    });

    const response = await fetch(
      `${AI_BRAIN_API_URL}/api/v1/agent-memories?${params}`,
      {
        headers: { 'X-API-Key': AI_BRAIN_API_KEY },
      },
    );

    if (!response.ok) return null;

    const data = (await response.json()) as {
      data: Array<{
        content: string;
        type: string;
        scope: string;
        created_at: string;
      }>;
    };

    if (!data.data || data.data.length === 0) return null;

    // Separate long-term and short-term
    const longTerm = data.data
      .filter((m) => m.type === 'long-term')
      .map((m) => m.content);
    const shortTerm = data.data
      .filter((m) => m.type === 'short-term')
      .map((m) => m.content);

    const parts: string[] = [];
    if (longTerm.length > 0) {
      parts.push(`## Long-term Memory\n${longTerm.join('\n')}`);
    }
    if (shortTerm.length > 0) {
      parts.push(shortTerm.join('\n\n'));
    }

    return parts.length > 0 ? parts.join('\n\n') : null;
  } catch (err) {
    logger.warn({ groupFolder, err }, 'AI Brain API read failed, using local');
    return null;
  }
}

export function ensureMemoryDir(groupFolder: string): string {
  const memDir = path.join(GROUPS_DIR, groupFolder, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  return memDir;
}

/**
 * Read the full memory context for a group from local files.
 */
function readLocalMemoryContext(groupFolder: string): string {
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  const memDir = path.join(groupDir, 'memory');
  const parts: string[] = [];

  // 1. Long-term curated memory
  const mainFile = path.join(groupDir, 'MEMORY.md');
  if (fs.existsSync(mainFile)) {
    const content = fs.readFileSync(mainFile, 'utf-8').trim();
    if (content) {
      parts.push(`## Long-term Memory\n${content}`);
    }
  }

  // 2. Recent daily session notes (newest last = most prominent)
  if (fs.existsSync(memDir)) {
    const dailyFiles = fs
      .readdirSync(memDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f))
      .sort()
      .slice(-MAX_DAILY_FILES);

    for (const file of dailyFiles) {
      const content = fs.readFileSync(path.join(memDir, file), 'utf-8').trim();
      if (content) {
        parts.push(content);
      }
    }
  }

  if (parts.length === 0) return '';

  let combined = parts.join('\n\n');

  if (combined.length > MAX_CONTEXT_CHARS) {
    combined = combined.slice(-MAX_CONTEXT_CHARS);
  }

  return combined;
}

/**
 * Read memory context — tries AI Brain first, falls back to local files.
 */
export async function readMemoryContext(groupFolder: string): Promise<string> {
  if (!MEMORY_ENABLED) return '';

  // Try AI Brain first
  const brainContext = await readFromAiBrain(groupFolder);
  if (brainContext) {
    let combined = brainContext;
    if (combined.length > MAX_CONTEXT_CHARS) {
      combined = combined.slice(-MAX_CONTEXT_CHARS);
    }
    return combined;
  }

  // Fallback to local files
  return readLocalMemoryContext(groupFolder);
}

/**
 * Inject the memory context as a preamble into the agent prompt.
 * If no memory exists the original prompt is returned unchanged.
 */
export async function injectMemoryIntoPrompt(
  prompt: string,
  groupFolder: string,
): Promise<string> {
  const context = await readMemoryContext(groupFolder);
  if (!context) return prompt;

  const preamble = [
    '<memory>',
    'The following is your persistent memory from previous sessions.',
    'Use this context to provide continuity. Do not repeat it back unless asked.',
    '',
    context,
    '</memory>',
    '',
  ].join('\n');

  return preamble + prompt;
}

/**
 * After a successful session, call the LLM to distill key facts
 * and store them both locally and in AI Brain.
 *
 * This runs fire-and-forget (non-blocking). Failures are logged but
 * never propagate to the caller.
 */
export function scheduleMemoryFlush(
  groupFolder: string,
  userMessage: string,
  agentResponse: string,
): void {
  if (!MEMORY_ENABLED) return;
  if (agentResponse.length < MIN_RESPONSE_LENGTH) return;

  // Fire and forget
  void flushSessionMemory(groupFolder, userMessage, agentResponse).catch(
    (err) => {
      logger.warn({ groupFolder, err }, 'Memory flush failed');
    },
  );
}

async function flushSessionMemory(
  groupFolder: string,
  userMessage: string,
  agentResponse: string,
): Promise<void> {
  // Truncate to keep LLM call cheap
  const truncMsg = userMessage.slice(0, 2000);
  const truncResp = agentResponse.slice(0, 3000);

  let facts: string;
  try {
    const result = await callLlm({
      system: FLUSH_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Extract memorable facts from this exchange:\n\nUSER: ${truncMsg}\n\nASSISTANT: ${truncResp}`,
        },
      ],
      maxTokens: 400,
    });
    facts = result.text.trim();
  } catch (err) {
    logger.warn({ groupFolder, err }, 'Memory flush LLM call failed');
    return;
  }

  if (!facts || facts.toUpperCase() === 'NOTHING') {
    logger.debug({ groupFolder }, 'Memory flush: nothing to store');
    return;
  }

  // Today's date in the user's local timezone (YYYY-MM-DD)
  const today = new Date().toLocaleDateString('en-CA', {
    timeZone: TIMEZONE,
  });
  const timeStr = new Date().toLocaleTimeString('de-DE', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
  });

  const entry = `### ${timeStr}\n${facts}`;

  // 1. Write locally (always — primary storage)
  const memDir = ensureMemoryDir(groupFolder);
  const dailyFile = path.join(memDir, `${today}.md`);
  const isNewFile = !fs.existsSync(dailyFile);
  const header = isNewFile ? `# Memory — ${today}\n` : '';
  fs.appendFileSync(dailyFile, `${header}\n${entry}\n`, 'utf-8');

  logger.info(
    { groupFolder, file: `memory/${today}.md`, chars: facts.length },
    'Memory flushed (local)',
  );

  // 2. Write to AI Brain (fire-and-forget, never blocks)
  void writeToAiBrain(groupFolder, entry);
}

/**
 * Return a status summary for a group's memory store.
 * Used for diagnostics and the /memory command.
 */
export function getMemoryStatus(groupFolder: string): {
  enabled: boolean;
  aiBrainEnabled: boolean;
  hasMainMemory: boolean;
  dailyFileCount: number;
  totalSizeBytes: number;
} {
  if (!MEMORY_ENABLED) {
    return {
      enabled: false,
      aiBrainEnabled: false,
      hasMainMemory: false,
      dailyFileCount: 0,
      totalSizeBytes: 0,
    };
  }

  const groupDir = path.join(GROUPS_DIR, groupFolder);
  const memDir = path.join(groupDir, 'memory');
  const mainFile = path.join(groupDir, 'MEMORY.md');

  const hasMainMemory = fs.existsSync(mainFile);
  let dailyFileCount = 0;
  let totalSizeBytes = 0;

  if (hasMainMemory) {
    totalSizeBytes += fs.statSync(mainFile).size;
  }

  if (fs.existsSync(memDir)) {
    for (const f of fs.readdirSync(memDir)) {
      if (/^\d{4}-\d{2}-\d{2}.*\.md$/.test(f)) {
        dailyFileCount++;
        totalSizeBytes += fs.statSync(path.join(memDir, f)).size;
      }
    }
  }

  return {
    enabled: true,
    aiBrainEnabled: isAiBrainEnabled(),
    hasMainMemory,
    dailyFileCount,
    totalSizeBytes,
  };
}
