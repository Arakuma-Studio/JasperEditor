// social-comment §7.8: Edit ▸ Preferences ▸ Privacy & Network and the first-download notice (extension points,
// ARCHITECTURE §19.10). Imported for its side effect by `commands/index.ts`.
import { programOverlays } from '../extensions/index.ts';
import { registerPreferencesDialog, registerPreferencesPage } from '../shell/preferences/index.ts';
import { PRIVACY_NETWORK_PAGE } from './ids.ts';
import { RemoteAssetsNoticeHost } from './notice.tsx';
import { PrivacyNetworkPage } from './PrivacyNetworkPage.tsx';

let registered = false;
export function registerRemoteAssetsUi(): void {
	if (registered) return;
	registered = true;
	registerPreferencesDialog();
	registerPreferencesPage({
		id: PRIVACY_NETWORK_PAGE,
		title: 'Privacy & Network',
		order: 58,
		component: PrivacyNetworkPage,
	});
	programOverlays.register({
		id: 'remote-assets.notice',
		active: () => true,
		component: RemoteAssetsNoticeHost,
		order: 0,
	});
}

registerRemoteAssetsUi();
