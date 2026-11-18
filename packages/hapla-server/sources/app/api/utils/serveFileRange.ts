import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';

export type ByteRange = { start: number; end: number };

export function parseByteRange(header: string | undefined, size: number): ByteRange | null | 'unsatisfiable' {
    if (!header) return null;
    if (size <= 0 || !header.startsWith('bytes=') || header.includes(',')) return 'unsatisfiable';
    const match = header.slice(6).trim().match(/^(\d*)-(\d*)$/);
    if (!match || (!match[1] && !match[2])) return 'unsatisfiable';
    if (!match[1]) {
        const suffixLength = Number.parseInt(match[2], 10);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'unsatisfiable';
        return { start: Math.max(0, size - suffixLength), end: size - 1 };
    }
    const start = Number.parseInt(match[1], 10);
    const requestedEnd = match[2] ? Number.parseInt(match[2], 10) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) {
        return 'unsatisfiable';
    }
    return { start, end: Math.min(requestedEnd, size - 1) };
}

export async function serveFileRange(options: {
    request: FastifyRequest;
    reply: FastifyReply;
    fullPath: string;
    contentType: string;
    cacheControl: string;
    maxOpenEndedRangeBytes?: number;
}) {
    const file = await stat(options.fullPath).catch(() => null);
    if (!file?.isFile()) return options.reply.code(404).send('Not found');
    const range = parseByteRange(options.request.headers.range, file.size);
    options.reply.header('Accept-Ranges', 'bytes');
    options.reply.header('Content-Type', options.contentType);
    options.reply.header('Cache-Control', options.cacheControl);
    if (range === 'unsatisfiable') {
        options.reply.header('Content-Range', `bytes */${file.size}`);
        return options.reply.code(416).send();
    }
    if (range) {
        const isOpenEnded = /^bytes=\d+-$/i.test(options.request.headers.range?.trim() ?? '');
        const effectiveRange = isOpenEnded && options.maxOpenEndedRangeBytes
            ? { start: range.start, end: Math.min(range.end, range.start + options.maxOpenEndedRangeBytes - 1) }
            : range;
        options.reply.header('Content-Range', `bytes ${effectiveRange.start}-${effectiveRange.end}/${file.size}`);
        options.reply.header('Content-Length', String(effectiveRange.end - effectiveRange.start + 1));
        return options.reply.code(206).send(createReadStream(options.fullPath, effectiveRange));
    }
    options.reply.header('Content-Length', String(file.size));
    return options.reply.send(createReadStream(options.fullPath));
}
