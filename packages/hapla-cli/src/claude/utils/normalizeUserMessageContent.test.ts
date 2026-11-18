import { describe, expect, it, vi, afterEach } from 'vitest';
import type { UserMessage } from '@/api/types';
import { normalizeClaudeUserContent } from './normalizeUserMessageContent';

describe('normalizeClaudeUserContent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps plain text messages unchanged', async () => {
    const message: UserMessage = {
      role: 'user',
      content: {
        type: 'text',
        text: 'hello claude',
      },
    };

    await expect(normalizeClaudeUserContent(message)).resolves.toBe('hello claude');
  });

  it('converts uploaded image urls into Claude file image blocks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('image-bytes'), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg' },
    })) as typeof fetch);

    const message: UserMessage = {
      role: 'user',
      content: {
        type: 'multimodal',
        parts: [
          {
            type: 'image',
            source: {
              type: 'url',
              media_type: 'image/jpeg',
              url: 'http://127.0.0.1:3005/files/chat/test.jpg',
            },
          },
          {
            type: 'text',
            text: 'describe this photo',
          },
        ],
      },
    };

    await expect(normalizeClaudeUserContent(message)).resolves.toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: Buffer.from('image-bytes').toString('base64'),
        },
      },
      {
        type: 'text',
        text: 'describe this photo',
      },
    ]);
  });
});