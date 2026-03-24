import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config
vi.mock('./config.js', () => ({
  CREDENTIAL_PROXY_PORT: 3001,
  OLLAMA_HOST: 'http://localhost:11434',
  OLLAMA_MODEL: 'llama3.2',
  WEBHOOK_LLM_PROVIDER: 'claude',
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  PROXY_BIND_HOST: '127.0.0.1',
}));

// Mock credential-proxy
vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
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

// Mock the Agent SDK query function
const mockQueryMessages = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => mockQueryMessages()),
}));

// Mock http/https for Ollama
vi.mock('http', async () => {
  const actual = await vi.importActual<typeof import('http')>('http');
  return { ...actual };
});

import { callLlm } from './llm-provider.js';

describe('llm-provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('callLlm with claude provider', () => {
    it('calls Claude SDK and returns text result', async () => {
      // Mock async iterator that yields a result message
      mockQueryMessages.mockReturnValue(
        (async function* () {
          yield {
            type: 'result',
            result: 'Hello from Claude',
          };
        })(),
      );

      const result = await callLlm(
        {
          messages: [{ role: 'user', content: 'Hello' }],
        },
        'claude',
      );

      expect(result.provider).toBe('claude');
      expect(result.text).toBe('Hello from Claude');
    });

    it('extracts text from assistant message blocks', async () => {
      mockQueryMessages.mockReturnValue(
        (async function* () {
          yield {
            type: 'assistant',
            message: {
              content: [
                { type: 'text', text: 'Part 1' },
                { type: 'text', text: ' Part 2' },
              ],
            },
          };
        })(),
      );

      const result = await callLlm(
        {
          messages: [{ role: 'user', content: 'Hello' }],
        },
        'claude',
      );

      expect(result.text).toBe('Part 1 Part 2');
    });

    it('uses result message over assistant message', async () => {
      mockQueryMessages.mockReturnValue(
        (async function* () {
          yield {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: 'Assistant text' }],
            },
          };
          yield {
            type: 'result',
            result: 'Final result',
          };
        })(),
      );

      const result = await callLlm(
        {
          messages: [{ role: 'user', content: 'Hello' }],
        },
        'claude',
      );

      expect(result.text).toBe('Final result');
    });

    it('passes system prompt correctly', async () => {
      const { query } = vi.mocked(
        await import('@anthropic-ai/claude-agent-sdk'),
      );
      mockQueryMessages.mockReturnValue(
        (async function* () {
          yield { type: 'result', result: 'ok' };
        })(),
      );

      await callLlm(
        {
          system: 'You are a classifier',
          messages: [{ role: 'user', content: 'Classify this' }],
        },
        'claude',
      );

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            systemPrompt: 'You are a classifier',
          }),
        }),
      );
    });

    it('defaults to claude-haiku-4-5 model', async () => {
      const { query } = vi.mocked(
        await import('@anthropic-ai/claude-agent-sdk'),
      );
      mockQueryMessages.mockReturnValue(
        (async function* () {
          yield { type: 'result', result: 'ok' };
        })(),
      );

      const result = await callLlm(
        {
          messages: [{ role: 'user', content: 'Hello' }],
        },
        'claude',
      );

      expect(result.model).toBe('claude-haiku-4-5');
      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            model: 'claude-haiku-4-5',
          }),
        }),
      );
    });
  });

  describe('callLlm provider routing', () => {
    it('defaults to configured provider', async () => {
      mockQueryMessages.mockReturnValue(
        (async function* () {
          yield { type: 'result', result: 'ok' };
        })(),
      );

      // WEBHOOK_LLM_PROVIDER is 'claude' in mock
      const result = await callLlm({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(result.provider).toBe('claude');
    });

    it('allows provider override', async () => {
      mockQueryMessages.mockReturnValue(
        (async function* () {
          yield { type: 'result', result: 'ok' };
        })(),
      );

      const result = await callLlm(
        {
          messages: [{ role: 'user', content: 'Hello' }],
        },
        'claude',
      );

      expect(result.provider).toBe('claude');
    });
  });
});
