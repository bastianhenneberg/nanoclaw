/**
 * LLM Provider Abstraction
 *
 * Supports two backends for direct (non-agent) LLM calls:
 *   - 'claude'  → Anthropic API via the local credential proxy
 *   - 'ollama'  → Ollama server (OpenAI-compatible /api/chat endpoint)
 *
 * Use this for lightweight, synchronous inference from the webhook server
 * where spinning up a full agent container is not necessary.
 */

import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';

import {
  CREDENTIAL_PROXY_PORT,
  OLLAMA_HOST,
  OLLAMA_MODEL,
  WEBHOOK_LLM_PROVIDER,
} from './config.js';
import { logger } from './logger.js';

export type LlmProvider = 'claude' | 'ollama';

export interface LlmMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LlmRequest {
  /** System prompt (optional) */
  system?: string;
  /** Conversation messages. At minimum one user message is required. */
  messages: LlmMessage[];
  /** Model override. Defaults to configured OLLAMA_MODEL / claude-3-5-haiku-latest */
  model?: string;
  /** Max tokens to generate (default: 1024) */
  maxTokens?: number;
}

export interface LlmResponse {
  text: string;
  provider: LlmProvider;
  model: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const makeRequest = isHttps ? httpsRequest : httpRequest;
    const bodyStr = JSON.stringify(body);

    const req = makeRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode && res.statusCode >= 400) {
            reject(
              new Error(
                `LLM request failed: HTTP ${res.statusCode} — ${raw.slice(0, 300)}`,
              ),
            );
          } else {
            resolve(raw);
          }
        });
      },
    );

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Claude (via credential proxy on localhost)
// ---------------------------------------------------------------------------

async function callClaude(req: LlmRequest): Promise<LlmResponse> {
  const model = req.model || 'claude-3-5-haiku-latest';
  const maxTokens = req.maxTokens ?? 1024;

  // Filter out system messages from the messages array for Anthropic API
  const userMessages = req.messages.filter((m) => m.role !== 'system');

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: userMessages,
  };

  if (req.system) {
    body['system'] = req.system;
  }

  const proxyUrl = `http://localhost:${CREDENTIAL_PROXY_PORT}/v1/messages`;

  logger.debug({ model, proxyUrl }, 'Calling Claude via credential proxy');

  const raw = await postJson(proxyUrl, body, {
    'anthropic-version': '2023-06-01',
    // x-api-key is injected by the credential proxy
    'x-api-key': 'placeholder',
  });

  const parsed = JSON.parse(raw) as {
    content?: Array<{ type: string; text: string }>;
    error?: { message: string };
  };

  if (parsed.error) {
    throw new Error(`Claude error: ${parsed.error.message}`);
  }

  const text =
    parsed.content
      ?.filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('') ?? '';

  return { text, provider: 'claude', model };
}

// ---------------------------------------------------------------------------
// Ollama (native /api/chat endpoint)
// ---------------------------------------------------------------------------

async function callOllama(req: LlmRequest): Promise<LlmResponse> {
  const model = req.model || OLLAMA_MODEL;

  // Build messages array, injecting system message if provided
  const messages: LlmMessage[] = [];
  if (req.system) {
    messages.push({ role: 'system', content: req.system });
  }
  messages.push(...req.messages.filter((m) => m.role !== 'system'));

  const body = {
    model,
    messages,
    stream: false,
    options: {
      num_predict: req.maxTokens ?? 1024,
    },
  };

  const ollamaUrl = `${OLLAMA_HOST.replace(/\/$/, '')}/api/chat`;

  logger.debug({ model, ollamaUrl }, 'Calling Ollama');

  const raw = await postJson(ollamaUrl, body);

  const parsed = JSON.parse(raw) as {
    message?: { content: string };
    error?: string;
  };

  if (parsed.error) {
    throw new Error(`Ollama error: ${parsed.error}`);
  }

  const text = parsed.message?.content ?? '';
  return { text, provider: 'ollama', model };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Call the configured LLM provider with the given request.
 * Provider is determined by WEBHOOK_LLM_PROVIDER env var ('claude' | 'ollama').
 * Can be overridden per-request via the `provider` option.
 */
export async function callLlm(
  req: LlmRequest,
  providerOverride?: LlmProvider,
): Promise<LlmResponse> {
  const provider = providerOverride ?? (WEBHOOK_LLM_PROVIDER as LlmProvider);

  switch (provider) {
    case 'ollama':
      return callOllama(req);
    case 'claude':
      return callClaude(req);
    default:
      logger.warn({ provider }, 'Unknown LLM provider, falling back to claude');
      return callClaude(req);
  }
}
