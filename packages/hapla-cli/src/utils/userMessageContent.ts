import type { UserMessage } from '@/api/types';
import type { InputItem } from '@/codex/codexAppServerTypes';

export interface ServerAuth {
  serverUrl: string;
  token: string;
}

type UserImagePart = {
  mediaType: string;
  data?: string;
  url?: string;
};

type RawMultimodalPart = {
  type?: unknown;
  text?: unknown;
  source?: {
    type?: unknown;
    media_type?: unknown;
    data?: unknown;
    url?: unknown;
  };
};

function getMultimodalParts(message: UserMessage): RawMultimodalPart[] {
  if (message.content.type !== 'multimodal') {
    return [];
  }

  return message.content.parts as RawMultimodalPart[];
}

function decodeDataUrl(url: string): { mediaType: string; base64: string } | null {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) {
    return null;
  }
  return {
    mediaType: match[1],
    base64: match[2],
  };
}

async function fetchImageAsDataUrl(url: string, auth?: ServerAuth): Promise<string> {
  const dataUrl = decodeDataUrl(url);
  if (dataUrl) {
    return url;
  }

  // Browser-uploaded chat images are served publicly under /files/..., but the
  // Codex host may not be able to reach that PUBLIC_URL. Use the authenticated
  // server endpoint the CLI already trusts when we recognize our own upload URL.
  const filesMatch = url.match(/\/files\/(public\/users\/[^?#]+)/);
  const fetchUrl = filesMatch && auth
    ? `${auth.serverUrl.replace(/\/+$/, '')}/v1/uploads/files/${filesMatch[1]}`
    : url;
  const fetchHeaders = filesMatch && auth
    ? { Authorization: `Bearer ${auth.token}` }
    : undefined;

  const response = await fetch(fetchUrl, fetchHeaders ? { headers: fetchHeaders } : undefined);
  if (!response.ok) {
    throw new Error(`Failed to fetch uploaded image: ${response.status}`);
  }

  const mediaType = response.headers.get('content-type') || 'image/jpeg';
  const arrayBuffer = await response.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  return `data:${mediaType};base64,${base64}`;
}

export function getUserMessageText(message: UserMessage): string {
  if (message.content.type === 'text') {
    return message.content.text;
  }

  return getMultimodalParts(message)
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

export function getUserMessageImages(message: UserMessage): UserImagePart[] {
  return getMultimodalParts(message)
    .filter((part): part is {
      type: 'image';
      source:
        | { type: 'base64'; media_type: string; data: string }
        | { type: 'url'; media_type: string; url: string };
    } => (
      part.type === 'image'
      && !!part.source
      && typeof part.source.media_type === 'string'
      && (
        (part.source?.type === 'base64' && typeof part.source.data === 'string')
        || (part.source?.type === 'url' && typeof part.source.url === 'string')
      )
    ))
    .map((part) => ({
      mediaType: part.source.media_type,
      ...(part.source.type === 'base64'
        ? { data: part.source.data }
        : { url: part.source.url }),
    }));
}

export function getCodexInputItems(message: UserMessage): InputItem[] {
  if (message.content.type === 'text') {
    return [{ type: 'text', text: message.content.text }];
  }

  return getMultimodalParts(message).flatMap<InputItem>((part) => {
    if (part.type === 'text' && typeof part.text === 'string') {
      return [{ type: 'text', text: part.text }];
    }

    if (
      part.type === 'image'
      && part.source?.type === 'base64'
      && typeof part.source.media_type === 'string'
      && typeof part.source.data === 'string'
    ) {
      return [{
        type: 'image',
        url: `data:${part.source.media_type};base64,${part.source.data}`,
      }];
    }

    if (
      part.type === 'image'
      && part.source?.type === 'url'
      && typeof part.source.url === 'string'
    ) {
      return [{
        type: 'image',
        url: part.source.url,
      }];
    }

    return [];
  });
}

export async function getCodexInputItemsAsync(message: UserMessage, auth?: ServerAuth): Promise<InputItem[]> {
  if (message.content.type === 'text') {
    return [{ type: 'text', text: message.content.text }];
  }

  const input: InputItem[] = [];
  for (const part of getMultimodalParts(message)) {
    if (part.type === 'text' && typeof part.text === 'string') {
      input.push({ type: 'text', text: part.text });
      continue;
    }

    if (
      part.type === 'image'
      && part.source?.type === 'base64'
      && typeof part.source.media_type === 'string'
      && typeof part.source.data === 'string'
    ) {
      input.push({
        type: 'image',
        url: `data:${part.source.media_type};base64,${part.source.data}`,
      });
      continue;
    }

    if (
      part.type === 'image'
      && part.source?.type === 'url'
      && typeof part.source.url === 'string'
    ) {
      input.push({
        type: 'image',
        url: await fetchImageAsDataUrl(part.source.url, auth),
      });
    }
  }

  return input;
}
