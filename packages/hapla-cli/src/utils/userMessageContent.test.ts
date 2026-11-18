import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserMessage } from '@/api/types';
import { getCodexInputItems, getCodexInputItemsAsync, getUserMessageImages, getUserMessageText } from './userMessageContent';

describe('userMessageContent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it('extracts text and images from multimodal user messages', () => {
    const message: UserMessage = {
      role: 'user',
      content: {
        type: 'multimodal',
        parts: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'abc123',
            },
          },
          {
            type: 'text',
            text: 'describe this image',
          },
        ],
      },
    };

    expect(getUserMessageText(message)).toBe('describe this image');
    expect(getUserMessageImages(message)).toEqual([
      { mediaType: 'image/png', data: 'abc123' },
    ]);
    expect(getCodexInputItems(message)).toEqual([
      { type: 'image', url: 'data:image/png;base64,abc123' },
      { type: 'text', text: 'describe this image' },
    ]);
  });

  it('returns plain text input items for text-only messages', () => {
    const message: UserMessage = {
      role: 'user',
      content: {
        type: 'text',
        text: 'hello',
      },
    };

    expect(getUserMessageText(message)).toBe('hello');
    expect(getUserMessageImages(message)).toEqual([]);
    expect(getCodexInputItems(message)).toEqual([
      { type: 'text', text: 'hello' },
    ]);
  });

  it('preserves uploaded image urls in multimodal user messages', () => {
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
              url: 'http://127.0.0.1:3005/files/chat/test-image.jpg',
            },
          },
          {
            type: 'text',
            text: 'what is in this photo',
          },
        ],
      },
    };

    expect(getUserMessageText(message)).toBe('what is in this photo');
    expect(getUserMessageImages(message)).toEqual([
      { mediaType: 'image/jpeg', url: 'http://127.0.0.1:3005/files/chat/test-image.jpg' },
    ]);
    expect(getCodexInputItems(message)).toEqual([
      { type: 'image', url: 'http://127.0.0.1:3005/files/chat/test-image.jpg' },
      { type: 'text', text: 'what is in this photo' },
    ]);
  });


  it('rewrites Hapla upload URLs through the authenticated server endpoint for Codex', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const message: UserMessage = {
      role: 'user',
      content: {
        type: 'multimodal',
        parts: [
          {
            type: 'image',
            source: {
              type: 'url',
              media_type: 'image/png',
              url: 'https://public.example/files/public/users/user-1/chat-images/image.png',
            },
          },
          { type: 'text', text: 'describe it' },
        ],
      },
    };

    await expect(getCodexInputItemsAsync(message, {
      serverUrl: 'http://127.0.0.1:3001/',
      token: 'token-1',
    })).resolves.toEqual([
      { type: 'image', url: 'data:image/png;base64,AQID' },
      { type: 'text', text: 'describe it' },
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/v1/uploads/files/public/users/user-1/chat-images/image.png',
      { headers: { Authorization: 'Bearer token-1' } },
    );
  });
});
