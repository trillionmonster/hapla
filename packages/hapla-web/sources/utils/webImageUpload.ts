export interface WebUploadImage {
    data: string;
    mediaType: string;
    previewData?: string;
    sourceFile?: File;
}

const DEFAULT_WEB_IMAGE_MAX_DIMENSION = 1600;
const DEFAULT_WEB_IMAGE_QUALITY = 0.78;
const MOBILE_WEB_IMAGE_MAX_DIMENSION = 1280;
const MOBILE_WEB_IMAGE_QUALITY = 0.6;
const WEB_IMAGE_PREVIEW_MAX_DIMENSION = 256;
const WEB_IMAGE_PREVIEW_QUALITY = 0.45;
const DEFAULT_WEB_IMAGE_MAX_BASE64_LENGTH = 2_400_000;
const MOBILE_WEB_IMAGE_MAX_BASE64_LENGTH = 1_200_000;
const DEFAULT_WEB_IMAGE_MIN_DIMENSION = 960;
const MOBILE_WEB_IMAGE_MIN_DIMENSION = 720;
const DEFAULT_WEB_IMAGE_MIN_QUALITY = 0.45;
const MOBILE_WEB_IMAGE_MIN_QUALITY = 0.4;
const WEB_IMAGE_REENCODE_ATTEMPTS = 8;

const LOSSLESS_INPUT_MIME_TYPES = new Set([
    'image/png',
]);

const CONVERTIBLE_INPUT_MIME_TYPES = new Set([
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/heic',
    'image/heif',
    'image/heic-sequence',
    'image/heif-sequence',
]);

const HEIC_FAMILY_MIME_TYPES = new Set([
    'image/heic',
    'image/heif',
    'image/heic-sequence',
    'image/heif-sequence',
]);

export const WEB_IMAGE_INPUT_ACCEPT = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
].join(',');

function extractMediaType(dataUrl: string, fallback: string): string {
    const match = dataUrl.match(/^data:([^;,]+)[;,]/i);
    return match?.[1] || fallback;
}

function extractBase64(dataUrl: string): string {
    return dataUrl.split(',')[1] ?? '';
}

async function readBlobAsDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob as data URL'));
        reader.readAsDataURL(blob);
    });
}

async function blobToBase64(blob: Blob): Promise<string> {
    return extractBase64(await readBlobAsDataUrl(blob));
}

async function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob> {
    if (typeof canvas.toBlob === 'function') {
        const blob = await new Promise<Blob | null>((resolve) => {
            canvas.toBlob(resolve, mimeType, quality);
        });
        if (blob) {
            return blob;
        }
    }

    const fallbackDataUrl = canvas.toDataURL(mimeType, quality);
    const response = await fetch(fallbackDataUrl);
    return response.blob();
}

async function loadImageElement(image: WebUploadImage): Promise<HTMLImageElement> {
    const objectUrl = image.sourceFile ? URL.createObjectURL(image.sourceFile) : null;
    const src = objectUrl ?? `data:${image.mediaType};base64,${image.data}`;

    try {
        return await new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new window.Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(`Failed to load image for optimization: ${image.mediaType}`));
            img.src = src;
        });
    } finally {
        if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
        }
    }
}

async function createPreviewBase64(canvas: HTMLCanvasElement, mimeType: string): Promise<string> {
    const previewScale = Math.min(1, WEB_IMAGE_PREVIEW_MAX_DIMENSION / Math.max(canvas.width, canvas.height));
    if (previewScale === 1) {
        return blobToBase64(await canvasToBlob(canvas, mimeType, WEB_IMAGE_PREVIEW_QUALITY));
    }

    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = Math.max(1, Math.round(canvas.width * previewScale));
    previewCanvas.height = Math.max(1, Math.round(canvas.height * previewScale));

    const previewContext = previewCanvas.getContext('2d');
    if (!previewContext) {
        throw new Error('Failed to create preview canvas context');
    }

    previewContext.drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);
    return blobToBase64(await canvasToBlob(previewCanvas, mimeType, WEB_IMAGE_PREVIEW_QUALITY));
}

function getUploadProfile() {
    const isMobileLikeWeb = typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(pointer: coarse)').matches;

    if (isMobileLikeWeb) {
        return {
            maxDimension: MOBILE_WEB_IMAGE_MAX_DIMENSION,
            quality: MOBILE_WEB_IMAGE_QUALITY,
            minDimension: MOBILE_WEB_IMAGE_MIN_DIMENSION,
            minQuality: MOBILE_WEB_IMAGE_MIN_QUALITY,
            maxBase64Length: MOBILE_WEB_IMAGE_MAX_BASE64_LENGTH,
        };
    }

    return {
        maxDimension: DEFAULT_WEB_IMAGE_MAX_DIMENSION,
        quality: DEFAULT_WEB_IMAGE_QUALITY,
        minDimension: DEFAULT_WEB_IMAGE_MIN_DIMENSION,
        minQuality: DEFAULT_WEB_IMAGE_MIN_QUALITY,
        maxBase64Length: DEFAULT_WEB_IMAGE_MAX_BASE64_LENGTH,
    };
}

export function getWebImageFailureMessage(rejectedImages: WebUploadImage[]): string {
    const hasLargeFiles = rejectedImages.some((image) => (image.sourceFile?.size ?? 0) > 2 * 1024 * 1024);
    const hasHeicFamily = rejectedImages.some((image) => HEIC_FAMILY_MIME_TYPES.has(image.mediaType.toLowerCase()));
    if (hasHeicFamily) {
        return 'Some selected photos use HEIC/HEIF, which your mobile browser could not convert for upload. Choose JPEG/Most Compatible photos and try again.';
    }
    if (hasLargeFiles) {
        return 'Some selected images were still too large for this mobile browser to upload reliably after compression. Choose a smaller photo or crop it and try again.';
    }
    return 'Some selected images could not be prepared for upload in this mobile browser. Try another image or use a JPEG/PNG version.';
}

export async function optimizeWebImageForUpload(image: WebUploadImage): Promise<WebUploadImage> {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return image;
    }

    const normalizedMimeType = image.mediaType.toLowerCase();
    if (!CONVERTIBLE_INPUT_MIME_TYPES.has(normalizedMimeType)) {
        throw new Error(`Unsupported image type: ${image.mediaType}`);
    }
    if (!image.data && !image.sourceFile) {
        throw new Error(`Image payload unavailable: ${image.mediaType}`);
    }

    const uploadProfile = getUploadProfile();
    const loaded = await loadImageElement(image);

    const width = loaded.naturalWidth || loaded.width;
    const height = loaded.naturalHeight || loaded.height;
    if (!width || !height) {
        throw new Error(`Image dimensions unavailable: ${image.mediaType}`);
    }

    const outputMimeType = LOSSLESS_INPUT_MIME_TYPES.has(normalizedMimeType) ? 'image/png' : 'image/jpeg';
    let currentDimension = uploadProfile.maxDimension;
    let currentQuality = uploadProfile.quality;
    let fallbackResult: WebUploadImage | null = null;

    for (let attempt = 0; attempt < WEB_IMAGE_REENCODE_ATTEMPTS; attempt += 1) {
        const scale = Math.min(1, currentDimension / Math.max(width, height));
        const targetWidth = Math.max(1, Math.round(width * scale));
        const targetHeight = Math.max(1, Math.round(height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;

        const context = canvas.getContext('2d');
        if (!context) {
            throw new Error('Failed to create canvas context');
        }

        context.drawImage(loaded, 0, 0, targetWidth, targetHeight);

        const optimizedBlob = await canvasToBlob(canvas, outputMimeType, currentQuality);
        const optimizedBase64 = await blobToBase64(optimizedBlob);
        if (!optimizedBase64) {
            throw new Error(`Failed to encode optimized image: ${image.mediaType}`);
        }

        const result: WebUploadImage = {
            data: optimizedBase64,
            mediaType: outputMimeType,
            previewData: await createPreviewBase64(canvas, outputMimeType),
        };
        fallbackResult = result;

        if (
            image.data
            && image.data.length <= uploadProfile.maxBase64Length
            && optimizedBase64.length >= image.data.length
            && scale === 1
            && outputMimeType === normalizedMimeType
        ) {
            return {
                ...image,
                previewData: image.previewData ?? result.previewData,
            };
        }

        if (optimizedBase64.length <= uploadProfile.maxBase64Length) {
            return result;
        }

        if (currentQuality > uploadProfile.minQuality) {
            currentQuality = Math.max(uploadProfile.minQuality, currentQuality - 0.08);
            continue;
        }

        if (currentDimension > uploadProfile.minDimension) {
            currentDimension = Math.max(uploadProfile.minDimension, Math.round(currentDimension * 0.8));
            currentQuality = uploadProfile.quality;
            continue;
        }

        break;
    }

    if (fallbackResult) {
        throw new Error(`Optimized image still exceeds safe transport budget: ${fallbackResult.data.length}`);
    }

    throw new Error(`Failed to optimize image for upload: ${image.mediaType}`);
}

export async function readWebImageFiles(files: File[]): Promise<WebUploadImage[]> {
    return files.map((file) => ({
        data: '',
        mediaType: file.type || 'image/jpeg',
        sourceFile: file,
    }));
}

export async function prepareWebImagesForUpload(images: WebUploadImage[]): Promise<{
    acceptedImages: WebUploadImage[];
    rejectedImages: WebUploadImage[];
}> {
    const prepared = await Promise.allSettled(images.map((image) => optimizeWebImageForUpload(image)));
    const acceptedImages: WebUploadImage[] = [];
    const rejectedImages: WebUploadImage[] = [];

    prepared.forEach((result, index) => {
        if (result.status === 'fulfilled') {
            acceptedImages.push(result.value);
        } else {
            rejectedImages.push(images[index]);
        }
    });

    return { acceptedImages, rejectedImages };
}
