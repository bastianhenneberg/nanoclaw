/**
 * Health Monitor for NanoClaw
 * Tracks container health, detects stuck containers, and performs self-healing
 */
import { exec } from 'child_process';
import { promisify } from 'util';

import { CONTAINER_TIMEOUT, IDLE_TIMEOUT } from './config.js';
import { logger } from './logger.js';
import { stopContainer } from './container-runtime.js';

const execAsync = promisify(exec);

// Health check interval (30 seconds)
const HEALTH_CHECK_INTERVAL = 30_000;

// Grace period before considering a container stuck (use the larger of the two timeouts + buffer)
const STUCK_THRESHOLD = Math.max(CONTAINER_TIMEOUT, IDLE_TIMEOUT) + 60_000;

// Maximum time a container can run regardless of activity (2 hours hard limit)
const MAX_CONTAINER_LIFETIME = 2 * 60 * 60 * 1000;

export interface TrackedContainer {
  containerName: string;
  groupJid: string;
  groupFolder: string;
  startTime: number;
  lastActivity: number;
  isTaskContainer: boolean;
}

export type AlertCallback = (message: string, level: 'warn' | 'error') => void;

export class HealthMonitor {
  private containers = new Map<string, TrackedContainer>();
  private intervalId: NodeJS.Timeout | null = null;
  private alertCallback: AlertCallback | null = null;
  private healCallback: ((groupJid: string) => void) | null = null;

  /**
   * Set callback for alerts (e.g., send Telegram message)
   */
  setAlertCallback(cb: AlertCallback): void {
    this.alertCallback = cb;
  }

  /**
   * Set callback for self-healing (reset group queue state)
   */
  setHealCallback(cb: (groupJid: string) => void): void {
    this.healCallback = cb;
  }

  /**
   * Start the health monitoring loop
   */
  start(): void {
    if (this.intervalId) return;

    logger.info('Health monitor started');
    this.intervalId = setInterval(() => {
      this.checkHealth().catch((err) => {
        logger.error({ err }, 'Health check failed');
      });
    }, HEALTH_CHECK_INTERVAL);

    // Run initial check
    this.checkHealth().catch((err) => {
      logger.error({ err }, 'Initial health check failed');
    });
  }

  /**
   * Stop the health monitoring loop
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Health monitor stopped');
    }
  }

  /**
   * Register a new container for monitoring
   */
  registerContainer(
    containerName: string,
    groupJid: string,
    groupFolder: string,
    isTaskContainer: boolean = false,
  ): void {
    const now = Date.now();
    this.containers.set(containerName, {
      containerName,
      groupJid,
      groupFolder,
      startTime: now,
      lastActivity: now,
      isTaskContainer,
    });
    logger.debug(
      { containerName, groupJid },
      'Container registered for health monitoring',
    );
  }

  /**
   * Update last activity time for a container
   */
  updateActivity(containerName: string): void {
    const container = this.containers.get(containerName);
    if (container) {
      container.lastActivity = Date.now();
    }
  }

  /**
   * Unregister a container (called when container exits normally)
   */
  unregisterContainer(containerName: string): void {
    this.containers.delete(containerName);
    logger.debug(
      { containerName },
      'Container unregistered from health monitoring',
    );
  }

  /**
   * Get current container stats
   */
  getStats(): {
    tracked: number;
    containers: Array<{
      name: string;
      group: string;
      runningMs: number;
      idleMs: number;
    }>;
  } {
    const now = Date.now();
    const containers = Array.from(this.containers.values()).map((c) => ({
      name: c.containerName,
      group: c.groupFolder,
      runningMs: now - c.startTime,
      idleMs: now - c.lastActivity,
    }));
    return { tracked: containers.length, containers };
  }

  /**
   * Run health check on all tracked containers
   */
  private async checkHealth(): Promise<void> {
    const now = Date.now();
    const issues: string[] = [];

    // Get list of actually running containers from Docker
    const runningContainers = await this.getRunningContainers();

    for (const [containerName, container] of this.containers) {
      const runningTime = now - container.startTime;
      const idleTime = now - container.lastActivity;

      // Check 1: Container exceeded max lifetime
      if (runningTime > MAX_CONTAINER_LIFETIME) {
        const msg = `Container ${containerName} (${container.groupFolder}) exceeded max lifetime (${Math.round(runningTime / 60000)}min)`;
        logger.warn({ containerName, runningTime }, msg);
        issues.push(msg);
        await this.healContainer(container, 'max_lifetime');
        continue;
      }

      // Check 2: Container appears stuck (no activity for too long)
      if (idleTime > STUCK_THRESHOLD) {
        const msg = `Container ${containerName} (${container.groupFolder}) appears stuck (idle ${Math.round(idleTime / 60000)}min)`;
        logger.warn({ containerName, idleTime }, msg);
        issues.push(msg);
        await this.healContainer(container, 'stuck');
        continue;
      }

      // Check 3: Container is tracked but not running in Docker (zombie state)
      // Grace period: only flag as zombie if tracked for >30s (avoids false positives during rapid cycling)
      const trackedTime = now - container.startTime;
      if (!runningContainers.has(containerName) && trackedTime > 30_000) {
        const msg = `Container ${containerName} (${container.groupFolder}) is zombie (tracked but not running)`;
        logger.warn({ containerName }, msg);
        issues.push(msg);
        this.cleanupZombie(container);
        continue;
      }
    }

    // Check 4: Orphan containers (running in Docker but not tracked)
    for (const dockerContainer of runningContainers) {
      if (
        dockerContainer.startsWith('nanoclaw-') &&
        !this.containers.has(dockerContainer)
      ) {
        // Check if it's been running too long (orphaned before monitor started)
        const containerAge = await this.getContainerAge(dockerContainer);
        if (containerAge > STUCK_THRESHOLD) {
          const msg = `Orphan container ${dockerContainer} detected (running ${Math.round(containerAge / 60000)}min, not tracked)`;
          logger.warn(
            { containerName: dockerContainer, age: containerAge },
            msg,
          );
          issues.push(msg);
          await this.killOrphanContainer(dockerContainer);
        }
      }
    }

    // Send alert if issues found
    if (issues.length > 0 && this.alertCallback) {
      this.alertCallback(
        `🔧 Health Monitor:\n${issues.join('\n')}`,
        issues.some((i) => i.includes('stuck') || i.includes('zombie'))
          ? 'error'
          : 'warn',
      );
    }

    logger.debug(
      { tracked: this.containers.size, running: runningContainers.size },
      'Health check completed',
    );
  }

  /**
   * Get set of running nanoclaw containers from Docker
   */
  private async getRunningContainers(): Promise<Set<string>> {
    try {
      const { stdout } = await execAsync(
        'docker ps --filter "name=nanoclaw-" --format "{{.Names}}"',
        { timeout: 10000 },
      );
      return new Set(stdout.trim().split('\n').filter(Boolean));
    } catch (err) {
      logger.error({ err }, 'Failed to list running containers');
      return new Set();
    }
  }

  /**
   * Get container age in milliseconds
   */
  private async getContainerAge(containerName: string): Promise<number> {
    try {
      const { stdout } = await execAsync(
        `docker inspect --format '{{.State.StartedAt}}' ${containerName}`,
        { timeout: 5000 },
      );
      const startedAt = new Date(stdout.trim()).getTime();
      return Date.now() - startedAt;
    } catch {
      return 0;
    }
  }

  /**
   * Heal a stuck or expired container
   */
  private async healContainer(
    container: TrackedContainer,
    reason: 'stuck' | 'max_lifetime',
  ): Promise<void> {
    logger.info(
      { containerName: container.containerName, reason },
      'Healing container',
    );

    try {
      // Stop the container gracefully, then force kill if needed
      await execAsync(stopContainer(container.containerName), {
        timeout: 15000,
      });
    } catch (err) {
      logger.warn(
        { containerName: container.containerName, err },
        'Graceful stop failed, force killing',
      );
      try {
        await execAsync(`docker kill ${container.containerName}`, {
          timeout: 5000,
        });
      } catch {
        // Container might already be dead
      }
    }

    // Remove from tracking
    this.containers.delete(container.containerName);

    // Trigger group queue reset so pending messages can be processed
    if (this.healCallback) {
      this.healCallback(container.groupJid);
    }

    logger.info(
      { containerName: container.containerName, groupJid: container.groupJid },
      'Container healed successfully',
    );
  }

  /**
   * Cleanup a zombie container (tracked but not running)
   */
  private cleanupZombie(container: TrackedContainer): void {
    logger.info(
      { containerName: container.containerName },
      'Cleaning up zombie container',
    );

    // Remove from tracking
    this.containers.delete(container.containerName);

    // Reset group queue
    if (this.healCallback) {
      this.healCallback(container.groupJid);
    }
  }

  /**
   * Kill an orphan container (running but not tracked)
   */
  private async killOrphanContainer(containerName: string): Promise<void> {
    logger.info({ containerName }, 'Killing orphan container');

    try {
      await execAsync(stopContainer(containerName), { timeout: 15000 });
    } catch {
      try {
        await execAsync(`docker kill ${containerName}`, { timeout: 5000 });
      } catch {
        // Best effort
      }
    }
  }
}

// Singleton instance
export const healthMonitor = new HealthMonitor();
