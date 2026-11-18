import type { VideoPreview } from './videoPreview';

/** A short-lived decoder, never mounted or played. Only its small JPEG survives. */
export async function loadExternalVideoPreview(uri: string, signal: AbortSignal, publish: (value: VideoPreview) => void): Promise<VideoPreview> {
    const url = new URL(uri, window.location.href);
    if (!['http:', 'https:', 'blob:'].includes(url.protocol) || signal.aborted) return { status: 'unavailable' };
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    const deadline = setTimeout(cancel, 5_000);
    let value: VideoPreview = { status: 'unavailable' };
    const update = (next: Partial<VideoPreview>) => {
        if (controller.signal.aborted) return;
        value = { ...value, ...next };
        publish(value);
    };
    // HEAD changes the signed method for presigned GET URLs. A one-byte GET
    // preserves the signature; cancel the body even if a host ignores Range.
    try {
        if (url.protocol !== 'blob:') {
            let stopWaiting: (() => void) | undefined;
            const cancelled = new Promise<false>(resolve => {
                const abort = () => resolve(false);
                if (controller.signal.aborted) abort();
                else controller.signal.addEventListener('abort', abort, { once: true });
                stopWaiting = () => controller.signal.removeEventListener('abort', abort);
            });
            const supportsRanges = await Promise.race([fetch(uri, {
                headers: { Range: 'bytes=0-0' }, credentials: 'omit', cache: 'no-store', signal: controller.signal,
            }).then(response => {
                const range = response.headers.get('Content-Range')?.match(/^bytes\s+0-0\/(\d+)$/i);
                const raw = response.status === 206 ? range?.[1] : response.status === 200 ? response.headers.get('Content-Length') : undefined;
                const bytes = raw ? Number(raw) : NaN;
                void response.body?.cancel().catch(() => undefined);
                if (Number.isSafeInteger(bytes) && bytes >= 0) update({ sizeBytes: bytes });
                return response.status === 206;
            }).catch(() => false), cancelled]);
            stopWaiting?.();
            // A native metadata hint may read an entire unseekable movie when
            // its index lives at the end. Do not probe Range-ignoring hosts.
            // Opening the original URL remains available independently.
            if (!supportsRanges || controller.signal.aborted) return value;
        }
        if (controller.signal.aborted) return value;
        const video = document.createElement('video');
        await new Promise<void>(resolve => {
            let finished = false;
            const finish = () => {
                if (finished) return;
                finished = true;
                controller.signal.removeEventListener('abort', finish);
                video.onloadedmetadata = video.onloadeddata = video.onseeked = video.onerror = null;
                video.pause(); video.removeAttribute('src'); video.load();
                resolve();
            };
            const frame = () => {
                if (finished || !video.videoWidth || !video.videoHeight || video.readyState < 2) return;
                try {
                    const canvas = document.createElement('canvas');
                    const scale = Math.min(1, 320 / video.videoWidth, 180 / video.videoHeight);
                    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
                    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
                    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
                    const poster = canvas.toDataURL('image/jpeg', 0.65);
                    if (poster.length <= 190_000) update({ posterDataUrl: poster });
                } catch { /* A host may allow playback but deny frame extraction. */ }
                finish();
            };
            controller.signal.addEventListener('abort', finish, { once: true });
            video.muted = true;
            video.playsInline = true;
            video.preload = 'metadata';
            video.crossOrigin = 'anonymous';
            video.onloadedmetadata = () => {
                update({ status: 'ready', width: video.videoWidth || undefined, height: video.videoHeight || undefined,
                    durationSeconds: Number.isFinite(video.duration) ? video.duration : undefined });
                // Request only the opening frame, never play or scan the movie.
                if (video.readyState >= 2) frame();
                else if (video.duration > 0) video.currentTime = Math.min(0.05, video.duration / 2);
            };
            video.onloadeddata = video.onseeked = frame;
            video.onerror = finish;
            video.src = uri;
            video.load();
        });
        return value;
    } finally {
        clearTimeout(deadline);
        controller.abort();
        signal.removeEventListener('abort', cancel);
    }
}
