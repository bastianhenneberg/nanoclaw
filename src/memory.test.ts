import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// Mock config
vi.mock('./config.js', () => ({
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  MEMORY_ENABLED: true,
  TIMEZONE: 'Europe/Berlin',
  AI_BRAIN_API_URL: '',
  AI_BRAIN_API_KEY: '',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock llm-provider
vi.mock('./llm-provider.js', () => ({
  callLlm: vi.fn(async () => ({ text: '• User prefers dark mode\n• Project uses TypeScript' })),
}));

import {
  ensureMemoryDir,
  injectMemoryIntoPrompt,
  readMemoryContext,
  getMemoryStatus,
  scheduleMemoryFlush,
} from './memory.js';

describe('memory', () => {
  const testGroupDir = '/tmp/nanoclaw-test-groups/test-group';
  const testMemDir = path.join(testGroupDir, 'memory');

  beforeEach(() => {
    // Create test directories
    fs.mkdirSync(testMemDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up
    fs.rmSync('/tmp/nanoclaw-test-groups', { recursive: true, force: true });
  });

  describe('ensureMemoryDir', () => {
    it('creates memory directory if it does not exist', () => {
      fs.rmSync(testMemDir, { recursive: true, force: true });
      const result = ensureMemoryDir('test-group');
      expect(result).toBe(testMemDir);
      expect(fs.existsSync(testMemDir)).toBe(true);
    });

    it('returns path when directory already exists', () => {
      const result = ensureMemoryDir('test-group');
      expect(result).toBe(testMemDir);
    });
  });

  describe('readMemoryContext', () => {
    it('returns empty string when no memory files exist', async () => {
      const result = await readMemoryContext('test-group');
      expect(result).toBe('');
    });

    it('reads MEMORY.md as long-term memory', async () => {
      fs.writeFileSync(
        path.join(testGroupDir, 'MEMORY.md'),
        'User prefers TypeScript',
      );
      const result = await readMemoryContext('test-group');
      expect(result).toContain('Long-term Memory');
      expect(result).toContain('User prefers TypeScript');
    });

    it('reads daily session files sorted chronologically', async () => {
      fs.writeFileSync(path.join(testMemDir, '2026-03-20.md'), 'Day 1 notes');
      fs.writeFileSync(path.join(testMemDir, '2026-03-22.md'), 'Day 3 notes');
      fs.writeFileSync(path.join(testMemDir, '2026-03-21.md'), 'Day 2 notes');

      const result = await readMemoryContext('test-group');
      // Day 1 should appear before Day 3
      const day1Pos = result.indexOf('Day 1');
      const day3Pos = result.indexOf('Day 3');
      expect(day1Pos).toBeLessThan(day3Pos);
    });

    it('limits to 7 most recent daily files', async () => {
      for (let i = 1; i <= 10; i++) {
        const day = String(i).padStart(2, '0');
        fs.writeFileSync(
          path.join(testMemDir, `2026-03-${day}.md`),
          `Day ${i} notes`,
        );
      }

      const result = await readMemoryContext('test-group');
      // Day 1, 2, 3 should be truncated (only 7 most recent kept)
      expect(result).not.toContain('Day 1 notes');
      expect(result).not.toContain('Day 2 notes');
      expect(result).not.toContain('Day 3 notes');
      expect(result).toContain('Day 10 notes');
    });

    it('truncates to MAX_CONTEXT_CHARS', async () => {
      // Write a very large memory file
      const bigContent = 'x'.repeat(5000);
      fs.writeFileSync(path.join(testMemDir, '2026-03-20.md'), bigContent);

      const result = await readMemoryContext('test-group');
      expect(result.length).toBeLessThanOrEqual(3000);
    });

    it('ignores non-date files in memory directory', async () => {
      fs.writeFileSync(path.join(testMemDir, 'notes.md'), 'Random notes');
      fs.writeFileSync(path.join(testMemDir, 'README.md'), 'Readme');
      fs.writeFileSync(path.join(testMemDir, '2026-03-20.md'), 'Valid notes');

      const result = await readMemoryContext('test-group');
      expect(result).toContain('Valid notes');
      expect(result).not.toContain('Random notes');
      expect(result).not.toContain('Readme');
    });
  });

  describe('injectMemoryIntoPrompt', () => {
    it('returns original prompt when no memory exists', async () => {
      const result = await injectMemoryIntoPrompt('Hello agent', 'test-group');
      expect(result).toBe('Hello agent');
    });

    it('prepends memory context with tags', async () => {
      fs.writeFileSync(
        path.join(testGroupDir, 'MEMORY.md'),
        'User is a developer',
      );

      const result = await injectMemoryIntoPrompt('Hello agent', 'test-group');
      expect(result).toContain('<memory>');
      expect(result).toContain('</memory>');
      expect(result).toContain('User is a developer');
      expect(result).toContain('Hello agent');
      // Memory should come before the prompt
      expect(result.indexOf('<memory>')).toBeLessThan(
        result.indexOf('Hello agent'),
      );
    });
  });

  describe('getMemoryStatus', () => {
    it('returns status for group with no memory', () => {
      const status = getMemoryStatus('test-group');
      expect(status.enabled).toBe(true);
      expect(status.hasMainMemory).toBe(false);
      expect(status.dailyFileCount).toBe(0);
      expect(status.totalSizeBytes).toBe(0);
    });

    it('counts daily files and total size', () => {
      fs.writeFileSync(
        path.join(testGroupDir, 'MEMORY.md'),
        'Long term facts',
      );
      fs.writeFileSync(path.join(testMemDir, '2026-03-20.md'), 'Day 1');
      fs.writeFileSync(path.join(testMemDir, '2026-03-21.md'), 'Day 2');

      const status = getMemoryStatus('test-group');
      expect(status.hasMainMemory).toBe(true);
      expect(status.dailyFileCount).toBe(2);
      expect(status.totalSizeBytes).toBeGreaterThan(0);
    });
  });

  describe('scheduleMemoryFlush', () => {
    it('does nothing for short responses', async () => {
      const { callLlm } = vi.mocked(await import('./llm-provider.js'));
      callLlm.mockClear();

      scheduleMemoryFlush('test-group', 'hello', 'hi');
      // callLlm should not be called for short responses
      expect(callLlm).not.toHaveBeenCalled();
    });
  });
});
