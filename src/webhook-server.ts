/**
 * NanoClaw Webhook Server
 *
 * Exposes an HTTP endpoint so external services (contact forms, invoice
 * mailers, n8n alternatives, etc.) can trigger NanoClaw agent groups
 * without going through Telegram.
 *
 * Two modes per request:
 *
 *   POST /webhook/:groupFolder
 *     Agent mode — the payload is formatted as a message and injected into
 *     the group's message queue.  The registered agent container picks it up
 *     with its full tool-set (MCP servers, file system, etc.).
 *     Returns 202 Accepted immediately; the agent responds asynchronously.
 *
 *   POST /webhook/:groupFolder/llm
 *     Direct LLM mode — the payload is sent straight to the configured LLM
 *     provider (Claude or Ollama) without spinning up an agent container.
 *     Returns 200 with { ok: true, response: "..." } synchronously.
 *     Useful for lightweight classification / extraction tasks.
 *
 * Authentication
 *   Every request must carry the shared secret in one of:
 *     Authorization: Bearer <WEBHOOK_SECRET>
 *     X-Webhook-Secret: <WEBHOOK_SECRET>
 *
 * Configuration (.env)
 *   WEBHOOK_PORT          Port to listen on (0 = disabled, default: 0)
 *   WEBHOOK_BIND_HOST     Bind address (default: 127.0.0.1)
 *   WEBHOOK_SECRET        Shared secret for authentication
 *   WEBHOOK_LLM_PROVIDER  'claude' | 'ollama' (default: 'claude')
 *   OLLAMA_HOST           Ollama base URL (default: http://localhost:11434)
 *   OLLAMA_MODEL          Model name for Ollama (default: llama3.2)
 */

import { createServer, IncomingMessage, Server, ServerResponse } from 'http';

import { WEBHOOK_SECRET } from './config.js';
import { callLlm, LlmProvider } from './llm-provider.js';
import { logger } from './logger.js';
import {
  handlePaperlessWebhook,
  isPaperlessLexofficeEnabled,
} from './paperless-lexoffice.js';
import { NewMessage, RegisteredGroup } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebhookDeps {
  /** Inject a message into the normal message-processing pipeline. */
  onMessage: (chatJid: string, msg: NewMessage) => void;
  /** Current map of JID → RegisteredGroup (called on each request). */
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** Send a text message directly to a chat (no agent processing). */
  sendNotification?: (jid: string, text: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function authenticate(req: IncomingMessage): boolean {
  if (!WEBHOOK_SECRET) {
    // No secret configured → open (warn once at startup, not per-request)
    return true;
  }

  const authHeader = req.headers['authorization'] ?? '';
  const secretHeader = req.headers['x-webhook-secret'] ?? '';

  const bearerToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length)
    : '';

  return bearerToken === WEBHOOK_SECRET || secretHeader === WEBHOOK_SECRET;
}

/**
 * Find a registered group by its folder name.
 * Returns [jid, group] or null if not found.
 */
function findGroupByFolder(
  groups: Record<string, RegisteredGroup>,
  folder: string,
): [string, RegisteredGroup] | null {
  for (const [jid, group] of Object.entries(groups)) {
    if (group.folder === folder) return [jid, group];
  }
  return null;
}

/**
 * Format an arbitrary JSON payload into a readable message for the agent.
 * Produces a YAML-like key: value block so the agent gets structured context.
 */
function formatPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload;

  if (typeof payload !== 'object' || payload === null) {
    return String(payload);
  }

  const lines: string[] = ['[Webhook payload]'];
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    const val =
      typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v ?? '');
    lines.push(`${k}: ${val}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

/**
 * Agent mode — inject payload as a message into the group queue.
 */
async function handleAgentWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  groupFolder: string,
  deps: WebhookDeps,
): Promise<void> {
  const groups = deps.registeredGroups();
  const match = findGroupByFolder(groups, groupFolder);

  if (!match) {
    sendJson(res, 404, {
      ok: false,
      error: `No registered group with folder '${groupFolder}'`,
    });
    return;
  }

  const [jid, group] = match;

  let payload: unknown = {};
  try {
    const body = await readBody(req);
    if (body.length > 0) {
      payload = JSON.parse(body.toString('utf-8'));
    }
  } catch {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON body' });
    return;
  }

  const content = formatPayload(payload);
  const now = new Date().toISOString();

  const msg: NewMessage = {
    id: `webhook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    chat_jid: jid,
    sender: 'webhook',
    sender_name: 'Webhook',
    content,
    timestamp: now,
    is_from_me: false,
    is_bot_message: false,
  };

  deps.onMessage(jid, msg);

  logger.info(
    { groupFolder, groupName: group.name, jid, payloadSize: content.length },
    'Webhook message injected into agent queue',
  );

  sendJson(res, 202, {
    ok: true,
    message: 'Queued for agent processing',
    group: group.name,
  });
}

/**
 * Direct LLM mode — call the LLM and return the response synchronously.
 *
 * Expected request body:
 * {
 *   "system":    "You are a helpful assistant",   // optional
 *   "prompt":    "Classify this email: ...",       // required (shorthand)
 *   "messages":  [{ "role": "user", "content": "..." }],  // or full history
 *   "provider":  "ollama",                         // optional override
 *   "model":     "llama3.2"                        // optional override
 * }
 */
async function handleLlmWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  groupFolder: string,
): Promise<void> {
  let body: Record<string, unknown> = {};
  try {
    const raw = await readBody(req);
    if (raw.length > 0) {
      body = JSON.parse(raw.toString('utf-8')) as Record<string, unknown>;
    }
  } catch {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON body' });
    return;
  }

  // Build messages array
  type RawMsg = { role: string; content: string };
  const rawMessages = (body['messages'] as RawMsg[] | undefined) ?? [];
  const messages = rawMessages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

  // Allow shorthand "prompt" field as a single user message
  if (messages.length === 0 && typeof body['prompt'] === 'string') {
    messages.push({ role: 'user', content: body['prompt'] });
  }

  if (messages.length === 0) {
    sendJson(res, 400, {
      ok: false,
      error: 'Provide "prompt" or "messages" array in request body',
    });
    return;
  }

  const providerOverride = body['provider'] as LlmProvider | undefined;
  const modelOverride = body['model'] as string | undefined;
  const system =
    typeof body['system'] === 'string' ? body['system'] : undefined;

  logger.info(
    {
      groupFolder,
      provider: providerOverride ?? 'default',
      model: modelOverride,
    },
    'Direct LLM webhook call',
  );

  try {
    const result = await callLlm(
      { system, messages, model: modelOverride },
      providerOverride,
    );

    sendJson(res, 200, {
      ok: true,
      response: result.text,
      provider: result.provider,
      model: result.model,
    });
  } catch (err) {
    logger.error({ err, groupFolder }, 'LLM webhook call failed');
    sendJson(res, 502, {
      ok: false,
      error: err instanceof Error ? err.message : 'LLM call failed',
    });
  }
}

/**
 * Paperless-ngx → Lexoffice bridge route.
 * Receives document_id, downloads PDF from Paperless, uploads to Lexoffice
 * based on tag.
 */
async function handlePaperlessRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookDeps,
): Promise<void> {
  if (!isPaperlessLexofficeEnabled()) {
    sendJson(res, 503, {
      ok: false,
      error: 'Paperless-Lexoffice bridge not configured',
    });
    return;
  }

  let payload: Record<string, unknown> = {};
  try {
    const body = await readBody(req);
    const bodyStr = body.toString('utf-8');
    logger.info(
      { contentType: req.headers['content-type'], bodyLength: body.length, bodyPreview: bodyStr.slice(0, 500) },
      'Paperless webhook: raw request',
    );
    if (body.length > 0) {
      payload = JSON.parse(bodyStr) as Record<string, unknown>;
    }
  } catch (parseErr) {
    logger.error({ parseErr }, 'Paperless webhook: failed to parse body');
    sendJson(res, 400, { ok: false, error: 'Invalid JSON body' });
    return;
  }

  try {
    const result = await handlePaperlessWebhook(payload);
    const status = result.ok ? 200 : 500;
    sendJson(res, status, result);

    // Send status message to lexware Telegram group
    if (deps.sendNotification) {
      const groups = deps.registeredGroups();
      const lexwareGroup = findGroupByFolder(groups, 'lexware');
      if (lexwareGroup) {
        const [jid] = lexwareGroup;
        let text: string;
        if (result.ok && !result.skipped) {
          text = `Lexoffice Upload: "${result.title}" -> ${result.account}`;
        } else if (result.skipped) {
          text = `Paperless Webhook: "${result.title}" übersprungen (kein Lexoffice-Tag)`;
        } else {
          text = `Lexoffice Upload fehlgeschlagen: ${result.error}`;
        }
        await deps.sendNotification(jid, text).catch((e) =>
          logger.error({ err: e }, 'Failed to send Paperless notification'),
        );
      }
    }
  } catch (err) {
    logger.error({ err }, 'Paperless-Lexoffice webhook failed');
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : 'Internal error',
    });

    // Send error to lexware group
    if (deps.sendNotification) {
      const groups = deps.registeredGroups();
      const lexwareGroup = findGroupByFolder(groups, 'lexware');
      if (lexwareGroup) {
        const [jid] = lexwareGroup;
        await deps.sendNotification(
          jid,
          `Lexoffice Upload Fehler: ${err instanceof Error ? err.message : 'Unbekannter Fehler'}`,
        ).catch((e) =>
          logger.error({ err: e }, 'Failed to send Paperless error notification'),
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Start the webhook HTTP server.
 *
 * @param port  Port to listen on. Pass 0 to pick a random port (useful in tests).
 * @param host  Bind address (default: 127.0.0.1 — localhost only).
 * @param deps  Callbacks into the main NanoClaw runtime.
 */
export function startWebhookServer(
  port: number,
  host: string,
  deps: WebhookDeps,
): Promise<Server> {
  if (!WEBHOOK_SECRET) {
    logger.warn(
      'WEBHOOK_SECRET is not set — webhook endpoint is unprotected! ' +
        'Set WEBHOOK_SECRET in .env to require authentication.',
    );
  }

  return new Promise((resolve, reject) => {
    const server = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        // Health check (no auth required)
        if (req.method === 'GET' && req.url === '/webhook/health') {
          sendJson(res, 200, { ok: true, service: 'nanoclaw-webhook' });
          return;
        }

        // Auth check for all other routes
        if (!authenticate(req)) {
          sendJson(res, 401, { ok: false, error: 'Unauthorized' });
          return;
        }

        // Only POST is supported for data endpoints
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'Method not allowed' });
          return;
        }

        const url = req.url ?? '';

        // POST /webhook/paperless — Paperless-ngx → Lexoffice bridge
        if (url.match(/^\/webhook\/paperless\/?$/)) {
          await handlePaperlessRoute(req, res, deps);
          return;
        }

        // POST /webhook/:groupFolder/llm — direct LLM mode
        const llmMatch = url.match(/^\/webhook\/([^/]+)\/llm\/?$/);
        if (llmMatch) {
          await handleLlmWebhook(req, res, llmMatch[1]);
          return;
        }

        // POST /webhook/:groupFolder — agent mode
        const agentMatch = url.match(/^\/webhook\/([^/]+)\/?$/);
        if (agentMatch) {
          await handleAgentWebhook(req, res, agentMatch[1], deps);
          return;
        }

        sendJson(res, 404, {
          ok: false,
          error: 'Not found. Use POST /webhook/:groupFolder',
        });
      },
    );

    server.on('error', (err) => {
      logger.error({ err, port, host }, 'Webhook server error');
      reject(err);
    });

    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      logger.info({ port: actualPort, host }, 'Webhook server started');
      resolve(server);
    });
  });
}
