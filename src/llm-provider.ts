/**
 * LLM Provider Abstraction
 *
 * Supports two backends for direct (non-agent) LLM calls:
 *   - 'claude'  → Claude Agent SDK via the local credential proxy
 *   - 'ollama'  → Ollama server (OpenAI-compatible /api/chat endpoint)
 *
 * Use this for lightweight, synchronous inference from the webhook server
 * where spinning up a full agent container is not necessary.
 */

import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';

import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  CREDENTIAL_PROXY_PORT,
  OLLAMA_HOST,
  OLLAMA_MODEL,
  WEBHOOK_LLM_PROVIDER,
} from './config.js';
import { PROXY_BIND_HOST } from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { logger } from './logger.js';

export type LlmProvider = 'claude' | 'ollama';

// Set proxy env vars once at module load — avoids race conditions when
// multiple callClaude() invocations run concurrently.
let claudeEnvInitialized = false;
function ensureClaudeEnv(): void {
  if (claudeEnvInitialized) return;
  const proxyHost = PROXY_BIND_HOST || 'localhost';
  process.env.ANTHROPIC_BASE_URL = `http://${proxyHost}:${CREDENTIAL_PROXY_PORT}`;
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    process.env.ANTHROPIC_API_KEY =
      process.env.ANTHROPIC_API_KEY || 'placeholder';
  } else {
    process.env.CLAUDE_CODE_OAUTH_TOKEN =
      process.env.CLAUDE_CODE_OAUTH_TOKEN || 'placeholder';
  }
  claudeEnvInitialized = true;
}

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
// Claude (via Agent SDK through credential proxy — supports OAuth)
// ---------------------------------------------------------------------------

async function callClaude(req: LlmRequest): Promise<LlmResponse> {
  const model = req.model || 'claude-haiku-4-5';

  // Build the prompt: system + user messages combined
  const parts: string[] = [];
  if (req.system) {
    parts.push(req.system);
  }
  for (const msg of req.messages) {
    if (msg.role !== 'system') {
      parts.push(msg.content);
    }
  }
  const prompt = parts.join('\n\n');

  // Ensure proxy env vars are set (once, thread-safe)
  ensureClaudeEnv();

  logger.debug(
    { model, authMode: detectAuthMode() },
    'Calling Claude via Agent SDK',
  );

  let resultText = '';

  // Use the Agent SDK's query function — it handles OAuth internally
  const messages = query({
    prompt,
    options: {
      maxTurns: 1,
      model,
      systemPrompt: req.system || '',
      allowedTools: [],
    },
  });

  for await (const message of messages) {
    if (message.type === 'assistant' && 'message' in message) {
      const content = (
        message as {
          message: { content: Array<{ type: string; text?: string }> };
        }
      ).message.content;
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          resultText += block.text;
        }
      }
    }
    if (message.type === 'result') {
      const text = (message as { result?: string }).result;
      if (text) {
        resultText = text;
      }
    }
  }

  return { text: resultText, provider: 'claude', model };
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
