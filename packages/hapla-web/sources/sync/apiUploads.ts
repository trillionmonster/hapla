import { apiSocket } from '@/sync/apiSocket';

export type UploadedChatImage = {
    url: string;
    path: string;
    mediaType: string;
    width: number;
    height: number;
    thumbhash: string;
};

export async function uploadChatImages(images: Array<{ mediaType: string; data: string }>): Promise<UploadedChatImage[]> {
    const response = await apiSocket.request('/v1/uploads/images', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ images }),
    });

    if (!response.ok) {
        throw new Error(`Failed to upload images: ${response.status}`);
    }

    const data = await response.json() as { images: UploadedChatImage[] };
    return data.images;
}