/** Large originals use HTTP delivery: R2 for public access, the local server on LAN. */
export const CLOUD_FILE_THRESHOLD_BYTES = 1024 * 1024;

export type CloudFileStage = 'hashing' | 'uploading-source' | 'waiting-capacity' | 'uploading-r2' | 'preparing' | 'ready';
export type CloudFileDelivery = {
    id: string;
    state: 'upload-required' | 'preparing' | 'ready' | 'failed';
    stage: CloudFileStage;
    progress: number;
    name: string;
    size: number;
    url?: string;
    downloadUrl?: string;
    headUrl?: string;
    expiresAt?: number;
    contentType?: string;
    error?: string;
};
export type CloudFileTask = {
    success: boolean;
    jobId?: string;
    state?: 'preparing' | 'ready' | 'failed';
    stage?: CloudFileStage;
    progress?: number;
    delivery?: CloudFileDelivery;
    error?: string;
};
