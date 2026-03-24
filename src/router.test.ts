import { describe, it, expect, vi } from 'vitest';

// Mock timezone module
vi.mock('./timezone.js', () => ({
  formatLocalTime: vi.fn(
    (ts: string, _tz: string) => new Date(ts).toISOString(),
  ),
}));

import {
  escapeXml,
  formatMessages,
  stripInternalTags,
  formatOutbound,
  findChannel,
  routeOutbound,
} from './router.js';
import { Channel, NewMessage } from './types.js';

describe('router', () => {
  describe('escapeXml', () => {
    it('escapes & < > "', () => {
      expect(escapeXml('a & b')).toBe('a &amp; b');
      expect(escapeXml('<tag>')).toBe('&lt;tag&gt;');
      expect(escapeXml('say "hi"')).toBe('say &quot;hi&quot;');
    });

    it('handles empty string', () => {
      expect(escapeXml('')).toBe('');
    });

    it('returns empty for falsy input', () => {
      expect(escapeXml(undefined as unknown as string)).toBe('');
    });
  });

  describe('formatMessages', () => {
    it('formats messages as XML with context header', () => {
      const messages: NewMessage[] = [
        {
          id: '1',
          chat_jid: 'jid',
          sender: 's1',
          sender_name: 'Alice',
          content: 'Hello',
          timestamp: '2026-03-24T10:00:00Z',
        },
      ];
      const result = formatMessages(messages, 'Europe/Berlin');
      expect(result).toContain('<context timezone="Europe/Berlin"');
      expect(result).toContain('<messages>');
      expect(result).toContain('sender="Alice"');
      expect(result).toContain('Hello');
      expect(result).toContain('</messages>');
    });

    it('escapes special characters in content', () => {
      const messages: NewMessage[] = [
        {
          id: '1',
          chat_jid: 'jid',
          sender: 's1',
          sender_name: 'Bob',
          content: 'a < b & c > d',
          timestamp: '2026-03-24T10:00:00Z',
        },
      ];
      const result = formatMessages(messages, 'UTC');
      expect(result).toContain('a &lt; b &amp; c &gt; d');
    });
  });

  describe('stripInternalTags', () => {
    it('removes <internal>...</internal> blocks', () => {
      const input = 'Hello <internal>secret stuff</internal> World';
      expect(stripInternalTags(input)).toBe('Hello  World');
    });

    it('handles multiline internal blocks', () => {
      const input = 'Before\n<internal>\nline1\nline2\n</internal>\nAfter';
      expect(stripInternalTags(input)).toBe('Before\n\nAfter');
    });

    it('removes multiple internal blocks', () => {
      const input = '<internal>a</internal>mid<internal>b</internal>';
      expect(stripInternalTags(input)).toBe('mid');
    });

    it('returns trimmed text when no internal tags', () => {
      expect(stripInternalTags('  hello  ')).toBe('hello');
    });
  });

  describe('formatOutbound', () => {
    it('strips internal tags and returns text', () => {
      const result = formatOutbound(
        'Hello <internal>debug</internal> World',
      );
      expect(result).toBe('Hello  World');
    });

    it('returns empty string for internal-only content', () => {
      expect(formatOutbound('<internal>all hidden</internal>')).toBe('');
    });
  });

  describe('findChannel', () => {
    it('finds channel that owns the JID', () => {
      const ch1: Channel = {
        name: 'telegram',
        connect: async () => {},
        sendMessage: async () => {},
        isConnected: () => true,
        ownsJid: (jid) => jid.startsWith('tg:'),
        disconnect: async () => {},
      };
      const ch2: Channel = {
        name: 'email',
        connect: async () => {},
        sendMessage: async () => {},
        isConnected: () => true,
        ownsJid: (jid) => jid.startsWith('email:'),
        disconnect: async () => {},
      };

      expect(findChannel([ch1, ch2], 'tg:-12345')).toBe(ch1);
      expect(findChannel([ch1, ch2], 'email:user@test.com')).toBe(ch2);
    });

    it('returns undefined when no channel matches', () => {
      const ch: Channel = {
        name: 'telegram',
        connect: async () => {},
        sendMessage: async () => {},
        isConnected: () => true,
        ownsJid: (jid) => jid.startsWith('tg:'),
        disconnect: async () => {},
      };
      expect(findChannel([ch], 'unknown:jid')).toBeUndefined();
    });
  });

  describe('routeOutbound', () => {
    it('sends to the correct channel', async () => {
      const sendMessage = vi.fn(async () => {});
      const ch: Channel = {
        name: 'telegram',
        connect: async () => {},
        sendMessage,
        isConnected: () => true,
        ownsJid: (jid) => jid.startsWith('tg:'),
        disconnect: async () => {},
      };

      await routeOutbound([ch], 'tg:-12345', 'Hello');
      expect(sendMessage).toHaveBeenCalledWith('tg:-12345', 'Hello');
    });

    it('throws when no channel matches', () => {
      expect(() => routeOutbound([], 'tg:-12345', 'Hello')).toThrow(
        'No channel for JID',
      );
    });
  });
});
