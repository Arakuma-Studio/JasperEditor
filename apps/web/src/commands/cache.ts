// M3 UI commands for the media cache (S04:CA-013/CA-014, wp-m3-cachegc): Edit ▸ Preferences ▸ Media Cache… opens the
// Preferences dialog on the Media Cache page (usage per kind, Clean Unused, Clean All (not in use)…, automatic
// cleaning). This module is imported at start-up (commands/index.ts), so it also registers the page.
import { MediaCachePreferencesPage } from '../cache/MediaCachePage.tsx';
import {
	PREFERENCES_DIALOG,
	registerPreferencesDialog,
	registerPreferencesPage,
} from '../shell/preferences/index.ts';
import type { UiCommand } from './types.ts';

export const MEDIA_CACHE_PAGE = 'media-cache';

registerPreferencesDialog();
registerPreferencesPage({
	id: MEDIA_CACHE_PAGE,
	title: 'Media Cache',
	order: 40,
	component: MediaCachePreferencesPage,
});

export const cacheCommands: UiCommand[] = [
	{
		id: 'cache.preferences',
		label: 'Media Cache…',
		description:
			'Edit ▸ Preferences ▸ Media Cache: disk used by waveforms, proxies, baked LUTs, renders…; Clean Unused, Clean All and the automatic limits.',
		scope: 'global',
		run: (ctx) => {
			registerPreferencesDialog();
			ctx.ui.openDialog(PREFERENCES_DIALOG, { page: MEDIA_CACHE_PAGE });
		},
	},
];
