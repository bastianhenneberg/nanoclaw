/**
 * Persistent Memory System for NanoClaw
 *
 * Inspired by OpenClaw's memory architecture. Stores conversation facts as
 * Markdown files per group:
 *   groups/{folder}/MEMORY.md          — curated long-term facts
 *   groups/{folder}/memory/YYYY-MM-DD.md — daily session summaries (append-only)
 *
 * Memory is injected into the prompt context at session start, and flushed
 * (distilled) by a lightweight LLM call after each successful session.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, MEMORY_ENABLED, TIMEZONE } from './config.js';
import { callLlm } from './llm-provider.js';
import { logger } from './logger.js';

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

export function ensureMemoryDir(groupFolder: string): string {
  const memDir = path.join(GROUPS_DIR, groupFolder, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  return memDir;
}

/**
 * Read the full memory context for a group.
 * Returns a formatted string to be prepended to the agent prompt,
 * or an empty string if no memory exists yet.
 */
export function readMemoryContext(groupFolder: string): string {
  if (!MEMORY_ENABLED) return '';

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
      .sort() // lexicographic = chronological for YYYY-MM-DD prefix
      .slice(-MAX_DAILY_FILES);

    for (const file of dailyFiles) {
      const content = fs
        .readFileSync(path.join(memDir, file), 'utf-8')
        .trim();
      if (content) {
        parts.push(content);
      }
    }
  }

  if (parts.length === 0) return '';

  let combined = parts.join('\n\n');

  // Trim from the front to stay within token budget (keep most recent content)
  if (combined.length > MAX_CONTEXT_CHARS) {
    combined = combined.slice(-MAX_CONTEXT_CHARS);
  }

  return combined;
}

/**
 * Inject the memory context as a preamble into the agent prompt.
 * If no memory exists the original prompt is returned unchanged.
 */
export function injectMemoryIntoPrompt(
  prompt: string,
  groupFolder: string,
): string {
  const context = readMemoryContext(groupFolder);
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
 * and append them to today's daily memory file.
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

  const memDir = ensureMemoryDir(groupFolder);

  // Today's date in the user's local timezone (YYYY-MM-DD)
  const today = new Date().toLocaleDateString('en-CA', {
    timeZone: TIMEZONE,
  });
  const timeStr = new Date().toLocaleTimeString('de-DE', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
  });

  const dailyFile = path.join(memDir, `${today}.md`);

  // Create file header on first entry of the day
  const isNewFile = !fs.existsSync(dailyFile);
  const header = isNewFile ? `# Memory — ${today}\n` : '';
  const entry = `${header}\n### ${timeStr}\n${facts}\n`;

  fs.appendFileSync(dailyFile, entry, 'utf-8');

  logger.info(
    { groupFolder, file: `memory/${today}.md`, chars: facts.length },
    'Memory flushed',
  );
}

/**
 * Return a status summary for a group's memory store.
 * Used for diagnostics and the /memory command.
 */
export function getMemoryStatus(groupFolder: string): {
  enabled: boolean;
  hasMainMemory: boolean;
  dailyFileCount: number;
  totalSizeBytes: number;
} {
  if (!MEMORY_ENABLED) {
    return {
      enabled: false,
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

  return { enabled: true, hasMainMemory, dailyFileCount, totalSizeBytes };
}
