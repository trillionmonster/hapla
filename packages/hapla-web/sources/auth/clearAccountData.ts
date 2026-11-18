import { apiSocket } from '@/sync/apiSocket';
import { clearPersistence } from '@/sync/persistence';
import { projectManager } from '@/sync/projectManager';
import { sessionResources } from '@/sync/sessionResources';
import { storage } from '@/sync/storage';
import { settingsDefaults } from '@/sync/settings';
import { localSettingsDefaults } from '@/sync/localSettings';
import { profileDefaults } from '@/sync/profile';
import { clearWorkspacePreviewPersistence } from '@/utils/workspacePreviewStore';
import { clearWorkspaceVideoPersistence, releaseWorkspaceVideoMemory } from '@/utils/workspaceVideoCache';
import { clearVideoPreviewCache } from '@/components/media/videoPreview';
import { sync } from '@/sync/sync';
import { clearManagedDownloads } from '@/utils/downloadManager';

/** Quiesce the old account before a full reload disposes its sync engine. */
export function releaseAccountMemory(): void {
    clearManagedDownloads();
    apiSocket.disconnect();
    sync.stopQuestionBackfill();
    releaseWorkspaceVideoMemory();
    clearVideoPreviewCache();
    sessionResources.releaseAll();
    projectManager.clear();
    storage.setState({
        ...storage.getInitialState(),
        settings: { ...settingsDefaults },
        settingsVersion: null,
        localSettings: { ...localSettingsDefaults },
        profile: { ...profileDefaults },
    }, true);
}

export async function clearAccountData(): Promise<void> {
    releaseAccountMemory();
    await clearWorkspacePreviewPersistence();
    await clearWorkspaceVideoPersistence();
    clearPersistence();
    if (typeof localStorage !== 'undefined') {
        for (const key of Object.keys(localStorage)) {
            if (key.startsWith('hapla:workspace-mode:') || key.startsWith('hapla:closed-workspace-preview:')) {
                localStorage.removeItem(key);
            }
        }
    }
}
