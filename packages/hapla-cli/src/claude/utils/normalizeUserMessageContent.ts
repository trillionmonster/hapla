import type { UserMessage } from '@/api/types';

type ClaudeImageMimeType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

// Matches @anthropic-ai/sdk Base64ImageSource / URLImageSource shapes.
// The Claude Agent SDK (O9.readMessages) reads `block.source.type`, so the
// content block MUST use `source` rather than a custom `file` envelope.
type ClaudeUserContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source:
        | { type: 'base64'; media_type: ClaudeImageMimeType; data: string }
        | { type: 'url'; url: string };
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

const SUPPORTED_IMAGE_MIME_TYPES = new Set<ClaudeImageMimeType>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

function normalizeImageMimeType(mediaType: string): ClaudeImageMimeType {
  const normalized = mediaType.toLowerCase();
  if (normalized === 'image/jpg') {
    return 'image/jpeg';
  }
  if (SUPPORTED_IMAGE_MIME_TYPES.has(normalized as ClaudeImageMimeType)) {
    return normalized as ClaudeImageMimeType;
  }
  throw new Error(`Unsupported Claude image type: ${mediaType}`);
}

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

async function fetchImageAsBase64(url: string, auth?: ServerAuth): Promise<{ mediaType: string; base64: string; originalSize: number }> {
  const dataUrl = decodeDataUrl(url);
  if (dataUrl) {
    return {
      mediaType: dataUrl.mediaType,
      base64: dataUrl.base64,
      originalSize: Buffer.from(dataUrl.base64, 'base64').length,
    };
  }

  // Detect URLs that point at our own Hapla server's public file route:
  //   <PUBLIC_URL>/files/public/users/<accountId>/chat-images/<key>.<ext>
  // The CLI host may not be able to reach PUBLIC_URL. Rewrite to the authenticated
  // /v1/uploads/files/* endpoint on the server URL the CLI already trusts.
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

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return {
    mediaType: contentType,
    base64: buffer.toString('base64'),
    originalSize: buffer.length,
  };
}

export interface ServerAuth {
  serverUrl: string;
  token: string;
}

export async function normalizeClaudeUserContent(message: UserMessage, auth?: ServerAuth): Promise<string | ClaudeUserContentBlock[]> {
  if (message.content.type === 'text') {
    return message.content.text;
  }

  const content: ClaudeUserContentBlock[] = [];
  for (const part of getMultimodalParts(message)) {
    if (part.type === 'text' && typeof part.text === 'string') {
      content.push({ type: 'text', text: part.text });
      continue;
    }

    if (part.type !== 'image' || !part.source || typeof part.source.media_type !== 'string') {
      continue;
    }

    if (part.source.type === 'base64' && typeof part.source.data === 'string') {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: normalizeImageMimeType(part.source.media_type),
          data: part.source.data,
        },
      });
      continue;
    }

    if (part.source.type === 'url' && typeof part.source.url === 'string') {
      const image = await fetchImageAsBase64(part.source.url, auth);
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: normalizeImageMimeType(part.source.media_type || image.mediaType),
          data: image.base64,
        },
      });
    }
  }

  return content;
}
