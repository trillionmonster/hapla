import { cleanupPreviousPagePreviews } from './workspacePreviewStore';

if (typeof window !== 'undefined' && typeof indexedDB !== 'undefined') {
    void cleanupPreviousPagePreviews();
    window.addEventListener('pageshow', event => {
        if (event.persisted) void cleanupPreviousPagePreviews();
    });
}
