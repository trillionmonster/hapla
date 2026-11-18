import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    extractGeneratedImagePaths,
    extractGeneratedMediaPaths,
    generatedMediaMarkdown,
    generatedImagesMarkdown,
    uploadGeneratedMediaMentionedInText,
    uploadGeneratedMediaFiles,
    uploadGeneratedMedia,
    prepareGeneratedMediaArtifact,
    uploadGeneratedImagesMentionedInText,
} from './generatedImageUploads';
import { mediaFileVersion } from '@/modules/common/turnMediaArtifacts';
import * as videoPreview from '@/modules/common/workspaceVideoPreview';

const generatedImagesDir = join(homedir(), '.codex', 'generated_images');

vi.mock('node:fs/promises', async importOriginal => {
    const original = await importOriginal<typeof import('node:fs/promises')>();
    return { ...original, readFile: vi.fn(original.readFile) };
});

describe('generatedImageUploads', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
        vi.restoreAllMocks();
    });

    it('references workspace video and audio originals without uploading their bytes', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapla-workspace-originals-'));
        const paths = [join(root, 'video.mp4'), join(root, 'audio.wav')];
        await Promise.all(paths.map(path => writeFile(path, 'original bytes')));
        vi.spyOn(videoPreview, 'runVideoPreviewProcess').mockResolvedValue(Buffer.from(JSON.stringify({ streams: [{ width: 320, height: 180 }], format: { duration: '2' } })));
        const fetchMock = vi.fn();vi.stubGlobal('fetch', fetchMock);
        try {
            for (const [index, path] of paths.entries()) {
                const info = await stat(path);
                const candidate = { path, size: info.size, version: mediaFileVersion(info), mimeType: index === 0 ? 'video/mp4' : 'audio/wav' };
                expect(await prepareGeneratedMediaArtifact(candidate, { serverUrl: 'https://server.test', token: 'fixture' }, [root], null))
                    .toMatchObject({ ref: path, size: info.size, mimeType: candidate.mimeType });
            }
            expect(fetchMock).not.toHaveBeenCalled();
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('keeps generated images uploaded with their preview metadata', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapla-provider-image-'));const path = join(root, 'image.png');await writeFile(path, 'image');
        const info = await stat(path);const fetchMock = vi.fn(async () => new Response(JSON.stringify({ images: [{ url: '/files/image.png', width: 320, height: 180, thumbhash: 'thumb' }] }), { status: 200 }));vi.stubGlobal('fetch', fetchMock);
        try {
            const result = await prepareGeneratedMediaArtifact({ path, size: info.size, version: mediaFileVersion(info), mimeType: 'image/png' }, { serverUrl: 'https://server.test', token: 'fixture' }, [root], root);
            expect(result).toMatchObject({ ref: '/files/image.png', image: { width: 320, height: 180, thumbhash: 'thumb' } });expect(fetchMock).toHaveBeenCalledOnce();
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('delivers a successful upload immediately and continues after another file fails', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapla-upload-partial-'));
        const paths = ['first.png', 'failed.png', 'last.png'].map(name => join(root, name));
        await Promise.all(paths.map(path => writeFile(path, 'image')));
        const delivered: string[] = [];
        let call = 0;
        const fetchMock = vi.fn(async (_url: unknown, request: { signal: AbortSignal }) => {
            expect(request.signal).toBeInstanceOf(AbortSignal);
            call++;
            if (call === 2) { expect(delivered).toEqual([paths[0]]);return new Response('', { status: 503 }); }
            return new Response(JSON.stringify({ images: [{ url: `/files/${call}.png` }] }), { status: 200 });
        });
        vi.stubGlobal('fetch', fetchMock);const onError = vi.fn();
        try {
            const result = await uploadGeneratedMediaFiles(paths, { serverUrl: 'https://server.test', token: 'fixture' }, [root], {
                onUploaded: item => { delivered.push(item.path); }, onError,
            });
            expect(delivered).toEqual([paths[0], paths[2]]);expect(result).toHaveLength(2);expect(onError).toHaveBeenCalledOnce();
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('does not upload bytes when a file changes during the actual read', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapla-upload-changing-'));const path = join(root, 'image.png');await writeFile(path, 'before');
        const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        vi.mocked(readFile).mockImplementationOnce((async (file: string, options: any) => {
            const data = await original.readFile(file, options);await original.writeFile(file, 'changed while reading');return data;
        }) as any);
        const fetchMock = vi.fn();vi.stubGlobal('fetch', fetchMock);
        try {
            expect(await uploadGeneratedMedia(path, { serverUrl: 'https://server.test', token: 'fixture' }, [root])).toBeNull();
            expect(fetchMock).not.toHaveBeenCalled();
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('cancels a pending upload preparation without making a network request', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapla-upload-cancel-'));const path = join(root, 'image.png');await writeFile(path, 'image');
        const controller = new AbortController();const fetchMock = vi.fn();vi.stubGlobal('fetch', fetchMock);
        try {
            const pending = uploadGeneratedMedia(path, { serverUrl: 'https://server.test', token: 'fixture' }, [root], controller.signal);controller.abort();
            await expect(pending).rejects.toThrow();expect(fetchMock).not.toHaveBeenCalled();
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('extracts only image paths under the Codex generated images directory', () => {
        const imagePath = join(generatedImagesDir, 'session-1', 'cat.png');
        const text = [
            `图片在这里: ${imagePath}`,
            'ignored: /tmp/cat.png',
            'ignored: /home/user/.codex/not-generated/cat.png',
            `duplicate: ${imagePath}`,
        ].join('\n');

        expect(extractGeneratedImagePaths(text)).toEqual([imagePath]);
    });

    it('extracts generated videos and formats them for the Web media renderer', () => {
        const videoPath = join(generatedImagesDir, 'demo.webm');
        expect(extractGeneratedMediaPaths(`Video: ${videoPath}`)).toEqual([videoPath]);
        expect(generatedMediaMarkdown([{ path: videoPath, url: '/files/demo.webm', mediaType: 'video/webm' }]))
            .toBe('![demo.webm](/files/demo.webm)');
    });

    it('extracts generated audio files for the same media pipeline', () => {
        const audioPath = join(generatedImagesDir, 'voice.opus');
        expect(extractGeneratedMediaPaths(`Audio: ${audioPath}`)).toEqual([audioPath]);
        expect(generatedMediaMarkdown([{ path: audioPath, url: '/files/voice.opus', mediaType: 'audio/opus' }]))
            .toBe('![voice.opus](/files/voice.opus)');
    });

    it('uploads generated images and formats markdown image blocks', async () => {
        const imagePath = join(generatedImagesDir, `hapla-test-${Date.now()}.png`);
        await mkdir(generatedImagesDir, { recursive: true });
        await writeFile(imagePath, Buffer.from([1, 2, 3]));

        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            images: [{
                url: 'https://server.test/files/public/users/u/chat-images/generated.png',
                mediaType: 'image/png',
                width: 1122,
                height: 1402,
                thumbhash: 'thumb',
            }],
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));
        vi.stubGlobal('fetch', fetchMock);

        try {
            const uploaded = await uploadGeneratedImagesMentionedInText(`Generated: ${imagePath}`, {
                serverUrl: 'https://server.test/',
                token: 'token-1',
            });

            expect(uploaded).toEqual([expect.objectContaining({
                path: imagePath,
                url: 'https://server.test/files/public/users/u/chat-images/generated.png',
                mediaType: 'image/png',
                size: 3,
                digest: expect.stringMatching(/^[a-f0-9]{64}$/),
                image: { width: 1122, height: 1402, thumbhash: 'thumb' },
            })]);
            expect(fetchMock).toHaveBeenCalledTimes(1);

            const [url, request] = fetchMock.mock.calls[0] as unknown as [string, {
                headers: Record<string, string>;
                body: string;
            }];
            expect(url).toBe('https://server.test/v1/uploads/images');
            expect(request.headers).toEqual({
                Authorization: 'Bearer token-1',
                'Content-Type': 'application/json',
            });
            expect(JSON.parse(request.body)).toEqual({
                images: [{ mediaType: 'image/png', data: 'AQID' }],
            });

            expect(generatedImagesMarkdown(uploaded)).toBe(
                '![hapla-test-' + imagePath.match(/hapla-test-(\d+)\.png$/)![1] + '.png](https://server.test/files/public/users/u/chat-images/generated.png)',
            );
        } finally {
            await rm(imagePath, { force: true });
        }
    });

    it('uploads generated videos through the authenticated media endpoint', async () => {
        const videoPath = join(generatedImagesDir, `hapla-video-${Date.now()}.webm`);
        await mkdir(generatedImagesDir, { recursive: true });
        await writeFile(videoPath, Buffer.from([4, 5, 6]));
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            media: [{ url: 'https://server.test/files/generated.webm', mediaType: 'video/webm' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
        vi.stubGlobal('fetch', fetchMock);

        try {
            const uploaded = await uploadGeneratedMediaMentionedInText(`Generated: ${videoPath}`, {
                serverUrl: 'https://server.test/',
                token: 'token-2',
            });
            expect(uploaded).toEqual([expect.objectContaining({
                path: videoPath,
                url: 'https://server.test/files/generated.webm',
                mediaType: 'video/webm',
                size: 3,
                digest: expect.stringMatching(/^[a-f0-9]{64}$/),
            })]);
            const [url, request] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
            expect(url).toBe('https://server.test/v1/uploads/media');
            expect(JSON.parse(request.body)).toEqual({
                media: [{ mediaType: 'video/webm', data: 'BAUG' }],
            });
        } finally {
            await rm(videoPath, { force: true });
        }
    });

    it('uploads newly discovered workspace media but rejects files outside the allowed root', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'hapla-upload-workspace-'));
        const outside = await mkdtemp(join(tmpdir(), 'hapla-upload-outside-'));
        const insidePath = join(workspace, 'result.wav');
        const outsidePath = join(outside, 'other.wav');
        await Promise.all([
            writeFile(insidePath, Buffer.from([1, 2, 3, 4])),
            writeFile(outsidePath, Buffer.from([5, 6, 7, 8])),
        ]);
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            media: [{ url: '/files/public/users/u/chat-media/result.wav', mediaType: 'audio/wav' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
        vi.stubGlobal('fetch', fetchMock);

        try {
            const uploaded = await uploadGeneratedMediaFiles(
                [insidePath, outsidePath],
                { serverUrl: 'https://server.test', token: 'token-3' },
                [workspace],
            );
            expect(uploaded).toHaveLength(1);
            expect(uploaded[0]).toMatchObject({ path: insidePath, size: 4, mediaType: 'audio/wav' });
            expect(fetchMock).toHaveBeenCalledTimes(1);
        } finally {
            await Promise.all([
                rm(workspace, { recursive: true, force: true }),
                rm(outside, { recursive: true, force: true }),
            ]);
        }
    });

});
