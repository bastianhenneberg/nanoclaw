import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_TIMEOUT: 300_000, // 5min
  IDLE_TIMEOUT: 300_000, // 5min
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

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  stopContainer: vi.fn((name: string) => `docker stop -t 1 ${name}`),
}));

// Mock child_process.exec
const mockExec = vi.fn();
vi.mock('child_process', () => ({
  exec: (...args: unknown[]) => mockExec(...args),
}));

import { HealthMonitor } from './health-monitor.js';

describe('HealthMonitor', () => {
  let monitor: HealthMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    mockExec.mockReset();
    monitor = new HealthMonitor();
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  describe('registerContainer', () => {
    it('tracks a new container', () => {
      monitor.registerContainer('nanoclaw-test-123', 'jid@g.us', 'test', false);
      const stats = monitor.getStats();
      expect(stats.tracked).toBe(1);
      expect(stats.containers[0].name).toBe('nanoclaw-test-123');
      expect(stats.containers[0].group).toBe('test');
    });

    it('tracks multiple containers', () => {
      monitor.registerContainer('nanoclaw-a-1', 'jid1@g.us', 'a', false);
      monitor.registerContainer('nanoclaw-b-2', 'jid2@g.us', 'b', true);
      expect(monitor.getStats().tracked).toBe(2);
    });
  });

  describe('unregisterContainer', () => {
    it('removes a tracked container', () => {
      monitor.registerContainer('nanoclaw-test-123', 'jid@g.us', 'test', false);
      monitor.unregisterContainer('nanoclaw-test-123');
      expect(monitor.getStats().tracked).toBe(0);
    });

    it('is a no-op for unknown containers', () => {
      monitor.unregisterContainer('unknown');
      expect(monitor.getStats().tracked).toBe(0);
    });
  });

  describe('updateActivity', () => {
    it('resets the idle timer', () => {
      monitor.registerContainer('nanoclaw-test-123', 'jid@g.us', 'test', false);

      // Advance time a bit, then update activity
      vi.advanceTimersByTime(10_000);
      monitor.updateActivity('nanoclaw-test-123');

      const stats = monitor.getStats();
      // idleMs should be very small since we just updated
      expect(stats.containers[0].idleMs).toBeLessThan(1000);
    });

    it('ignores unknown containers', () => {
      // Should not throw
      monitor.updateActivity('nonexistent');
    });
  });

  describe('getStats', () => {
    it('returns empty stats with no containers', () => {
      const stats = monitor.getStats();
      expect(stats.tracked).toBe(0);
      expect(stats.containers).toEqual([]);
    });

    it('calculates running and idle times', () => {
      monitor.registerContainer('nanoclaw-test-123', 'jid@g.us', 'test', false);
      vi.advanceTimersByTime(5000);

      const stats = monitor.getStats();
      expect(stats.containers[0].runningMs).toBeGreaterThanOrEqual(5000);
      expect(stats.containers[0].idleMs).toBeGreaterThanOrEqual(5000);
    });
  });

  describe('start / stop', () => {
    it('starts and stops without error', () => {
      // Mock docker ps for health check
      mockExec.mockImplementation(
        (
          _cmd: string,
          _opts: unknown,
          cb?: (err: null, result: { stdout: string }) => void,
        ) => {
          if (cb) cb(null, { stdout: '' });
        },
      );

      monitor.start();
      // Starting again should be a no-op
      monitor.start();
      monitor.stop();
      // Stopping again should be safe
      monitor.stop();
    });
  });

  describe('callbacks', () => {
    it('sets heal callback without error', () => {
      const healCb = vi.fn();
      monitor.setHealCallback(healCb);
      // No assertion needed — just ensure it doesn't throw
    });

    it('sets alert callback without error', () => {
      const alertCb = vi.fn();
      monitor.setAlertCallback(alertCb);
    });
  });
});
