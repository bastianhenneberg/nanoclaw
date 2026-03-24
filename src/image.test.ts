import { describe, it, expect } from 'vitest';

import { parseImageReferences } from './image.js';

describe('image', () => {
  describe('parseImageReferences', () => {
    it('extracts image references from messages', () => {
      const messages = [
        { content: 'Look at this [Image: attachments/img-123-abc.jpg]' },
      ];
      const refs = parseImageReferences(messages);
      expect(refs).toHaveLength(1);
      expect(refs[0].relativePath).toBe('attachments/img-123-abc.jpg');
      expect(refs[0].mediaType).toBe('image/jpeg');
    });

    it('extracts multiple references from one message', () => {
      const messages = [
        {
          content:
            '[Image: attachments/a.jpg] and [Image: attachments/b.jpg]',
        },
      ];
      const refs = parseImageReferences(messages);
      expect(refs).toHaveLength(2);
      expect(refs[0].relativePath).toBe('attachments/a.jpg');
      expect(refs[1].relativePath).toBe('attachments/b.jpg');
    });

    it('extracts references across multiple messages', () => {
      const messages = [
        { content: '[Image: attachments/first.jpg]' },
        { content: 'No image here' },
        { content: '[Image: attachments/second.jpg]' },
      ];
      const refs = parseImageReferences(messages);
      expect(refs).toHaveLength(2);
    });

    it('returns empty array for messages without images', () => {
      const messages = [
        { content: 'Just text' },
        { content: 'More text' },
      ];
      const refs = parseImageReferences(messages);
      expect(refs).toHaveLength(0);
    });

    it('returns empty array for empty messages', () => {
      const refs = parseImageReferences([]);
      expect(refs).toHaveLength(0);
    });

    it('handles nested bracket content correctly', () => {
      const messages = [
        { content: 'Check [this] and [Image: attachments/img.jpg]' },
      ];
      const refs = parseImageReferences(messages);
      expect(refs).toHaveLength(1);
      expect(refs[0].relativePath).toBe('attachments/img.jpg');
    });
  });
});
