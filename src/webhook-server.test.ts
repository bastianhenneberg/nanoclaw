import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';

// Mock config
vi.mock('./config.js', () => ({
  WEBHOOK_SECRET: 'test-secret',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock db
vi.mock('./db.js', () => ({
  getAllTasks: vi.fn(() => []),
  getTaskById: vi.fn(() => undefined),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
}));

// Mock llm-provider
vi.mock('./llm-provider.js', () => ({
  callLlm: vi.fn(async () => ({
    text: 'LLM response',
    provider: 'claude',
    model: 'claude-haiku-4-5',
  })),
}));

// Mock paperless-lexoffice
vi.mock('./paperless-lexoffice.js', () => ({
  handlePaperlessWebhook: vi.fn(),
  isPaperlessLexofficeEnabled: vi.fn(() => false),
}));

import { startWebhookServer, WebhookDeps } from './webhook-server.js';

function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode!, body: { raw } });
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('webhook-server', () => {
  let server: http.Server;
  let port: number;
  let deps: WebhookDeps;

  beforeEach(async () => {
    deps = {
      onMessage: vi.fn(),
      registeredGroups: vi.fn(() => ({
        'tg:-12345': {
          name: 'Test Group',
          folder: 'test-group',
          trigger: '@Andy',
          added_at: '2026-01-01T00:00:00Z',
        },
      })),
      sendNotification: vi.fn(async () => {}),
    };

    server = await startWebhookServer(0, '127.0.0.1', deps);
    const addr = server.address() as { port: number };
    port = addr.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('authentication', () => {
    it('rejects requests without auth', async () => {
      const res = await makeRequest(port, 'GET', '/api/status');
      expect(res.status).toBe(401);
    });

    it('accepts Bearer token', async () => {
      const res = await makeRequest(port, 'GET', '/api/status', undefined, {
        Authorization: 'Bearer test-secret',
      });
      expect(res.status).toBe(200);
    });

    it('accepts X-Webhook-Secret header', async () => {
      const res = await makeRequest(port, 'GET', '/api/status', undefined, {
        'X-Webhook-Secret': 'test-secret',
      });
      expect(res.status).toBe(200);
    });

    it('rejects wrong secret', async () => {
      const res = await makeRequest(port, 'GET', '/api/status', undefined, {
        Authorization: 'Bearer wrong-secret',
      });
      expect(res.status).toBe(401);
    });
  });

  describe('health check', () => {
    it('responds without auth', async () => {
      const res = await makeRequest(port, 'GET', '/webhook/health');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.service).toBe('nanoclaw-webhook');
    });
  });

  describe('GET /api/status', () => {
    it('returns system status', async () => {
      const res = await makeRequest(port, 'GET', '/api/status', undefined, {
        Authorization: 'Bearer test-secret',
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.groupCount).toBe(1);
      expect(typeof res.body.uptime).toBe('number');
      expect(typeof res.body.version).toBe('string');
    });
  });

  describe('GET /api/groups', () => {
    it('returns registered groups', async () => {
      const res = await makeRequest(port, 'GET', '/api/groups', undefined, {
        Authorization: 'Bearer test-secret',
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      const groups = res.body.groups as Array<{
        jid: string;
        name: string;
        folder: string;
      }>;
      expect(groups).toHaveLength(1);
      expect(groups[0].folder).toBe('test-group');
    });
  });

  describe('POST /webhook/:groupFolder', () => {
    it('injects message for registered group', async () => {
      const res = await makeRequest(
        port,
        'POST',
        '/webhook/test-group',
        { text: 'Hello from webhook' },
        { Authorization: 'Bearer test-secret' },
      );
      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(deps.onMessage).toHaveBeenCalled();
    });

    it('returns 404 for unknown group', async () => {
      const res = await makeRequest(
        port,
        'POST',
        '/webhook/nonexistent',
        { text: 'Hello' },
        { Authorization: 'Bearer test-secret' },
      );
      expect(res.status).toBe(404);
    });

    it('returns 400 for invalid JSON', async () => {
      const res = await new Promise<{
        status: number;
        body: Record<string, unknown>;
      }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/webhook/test-group',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer test-secret',
            },
          },
          (httpRes) => {
            const chunks: Buffer[] = [];
            httpRes.on('data', (c: Buffer) => chunks.push(c));
            httpRes.on('end', () => {
              resolve({
                status: httpRes.statusCode!,
                body: JSON.parse(Buffer.concat(chunks).toString('utf-8')),
              });
            });
          },
        );
        req.on('error', reject);
        req.write('{invalid json');
        req.end();
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /webhook/:groupFolder/llm', () => {
    it('returns LLM response synchronously', async () => {
      const res = await makeRequest(
        port,
        'POST',
        '/webhook/test-group/llm',
        { prompt: 'Classify this' },
        { Authorization: 'Bearer test-secret' },
      );
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.response).toBe('LLM response');
    });

    it('returns 400 when no prompt or messages given', async () => {
      const res = await makeRequest(
        port,
        'POST',
        '/webhook/test-group/llm',
        {},
        { Authorization: 'Bearer test-secret' },
      );
      expect(res.status).toBe(400);
    });
  });

  describe('unknown routes', () => {
    it('returns 404 for unknown paths', async () => {
      const res = await makeRequest(
        port,
        'POST',
        '/unknown/path',
        {},
        { Authorization: 'Bearer test-secret' },
      );
      expect(res.status).toBe(404);
    });

    it('returns 405 for non-POST methods on webhook endpoints', async () => {
      const res = await makeRequest(
        port,
        'PUT',
        '/webhook/test-group',
        {},
        { Authorization: 'Bearer test-secret' },
      );
      expect(res.status).toBe(405);
    });
  });
});
