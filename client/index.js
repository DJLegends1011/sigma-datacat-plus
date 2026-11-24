// DataCat Plus client entry: registers the DataCat Plus provider, overlays, and Settings > Online section.
import datacatProvider, { setDatacatProviderSettings } from './datacat-provider.js';
import {
    setDatacatBrowseSettings,
    setDatacatAccountLoggedIn,
    closePreviewModal,
    isPreviewOpen,
    clearCreatorFilter,
    isCreatorBannerOpen,
} from './datacat-browse.js';
import { settingsMarkup, bindSettings } from './settings-panel.js';
import {
    closeRestoreModal,
    isRestoreModalOpen,
    disposeRestoreModal,
} from './datacat-avatar-restore.js';
import { PROVIDER_ID } from './datacat-id.js';

let _settingsAbort = null;

export default {
    async init(ctx) {
        const { settings, CoreAPI } = ctx;

        setDatacatProviderSettings(settings);
        setDatacatBrowseSettings(settings);

        await ctx.providers.register(datacatProvider, {
            name: 'DataCat Plus',
            extNamespace: PROVIDER_ID,
            searchPrefixes: ['dcplus', 'dcp'],
            excludeTagKey: PROVIDER_ID,
            excludeInputPrefix: PROVIDER_ID,
            hosts: ['datacat.run'],
            icon: 'fa-solid fa-cat',
            iconUrl: 'https://datacat.run/catgif.gif',
            beta: true,
            avatarTap: { imgId: 'datacatCharAvatar' },
        });

        // Register preview, creator banner, and avatar-restore overlays via the Sigma overlay ledger
        ctx.ui.addOverlay({ id: 'preview', close: closePreviewModal, visible: isPreviewOpen });
        ctx.ui.addOverlay({ id: 'creator-banner', close: clearCreatorFilter, visible: isCreatorBannerOpen });
        ctx.ui.addOverlay({ id: 'avatar-restore', close: closeRestoreModal, visible: isRestoreModalOpen });

        // Settings > Online > DataCat Plus: CL's DataCat section, ported in settings-panel.js.
        // The host reuses `el` across renders, so each render gets a fresh root and a fresh signal.
        ctx.ui.addProviderSettingsSection(PROVIDER_ID, (el) => {
            if (_settingsAbort) _settingsAbort.abort();
            _settingsAbort = new AbortController();
            const root = document.createElement('div');
            root.innerHTML = settingsMarkup();
            el.innerHTML = '';
            el.appendChild(root);
            bindSettings(root, { settings, CoreAPI, signal: _settingsAbort.signal });
        }, { excludeTagsHint: 'Tags entered here are always left out of DataCat Plus results.' });
    },

    dispose() {
        if (_settingsAbort) {
            _settingsAbort.abort();
            _settingsAbort = null;
        }
        closePreviewModal();
        clearCreatorFilter();
        disposeRestoreModal();
        setDatacatProviderSettings(null);
        setDatacatBrowseSettings(null);
        setDatacatAccountLoggedIn(false);
    },
};
