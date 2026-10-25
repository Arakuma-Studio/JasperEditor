// Edit ▸ Preferences ▸ Privacy & Network (spec 04 OF-002): the network uses the app may make, each one named and
// switchable. social-comment §7.8 adds "Platform fonts & emoji for social templates" (on by default): the engine
// downloads the platform fonts and emoji images social-comment templates need, from the sources of its remote-asset
// manifest, into this computer's cache. The setting lives in the engine (`/api/settings/network`) so headless, MCP and
// CLI renders follow it too.
import type { NetworkSettings, RemoteAssetsStatus } from '@jasper/api';
import { Button, Checkbox, toast } from '@jasper/ui';
import { useCallback, useEffect, useState } from 'react';
import { errorText } from '../processing/engine-jobs.ts';
import { PrefGroup } from '../shell/preferences/GeneralPage.tsx';
import { useEngineOrNull } from '../state/engine.tsx';

export function PrivacyNetworkPage() {
	const engine = useEngineOrNull();
	const client = engine?.status === 'connected' ? engine.client : null;
	const subscribe = engine?.subscribe;
	const [status, setStatus] = useState<RemoteAssetsStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const load = useCallback(async () => {
		if (!client) return;
		try {
			setStatus(await client.call('remoteAssetsStatus'));
			setError(null);
		} catch (e) {
			setError(errorText(e));
		}
	}, [client]);
	useEffect(() => {
		void load();
	}, [load]);
	// A download, another window or an agent changed something: refresh.
	useEffect(() => subscribe?.((e) => e?.type === 'remoteAssets.changed' && void load()), [subscribe, load]);

	const save = async (next: NetworkSettings) => {
		if (!client) return;
		setSaving(true);
		try {
			await client.call('networkSettingsPut', { body: next });
			await load();
		} catch (e) {
			toast({ kind: 'error', title: 'The network setting was not saved', detail: errorText(e) });
		} finally {
			setSaving(false);
		}
	};

	const cachedFonts = status?.fonts.filter((f) => f.cached).length ?? 0;
	const cachedEmoji = status?.emojiPacks.reduce((n, p) => n + p.cached, 0) ?? 0;
	const cachedImages = status?.images.filter((i) => i.cached).length ?? 0;
	const hosts = [
		...new Set([
			...(status?.fonts ?? []).map((f) => f.host),
			...(status?.emojiPacks ?? []).map((p) => p.host),
			...(status?.images ?? []).map((i) => i.host),
		]),
	]
		.filter(Boolean)
		.sort();

	return (
		<div className="flex flex-col gap-2" data-testid="prefs-privacy-network">
			<PrefGroup title="Network use">
				<p className="text-pr-small text-pr-muted">
					JasperEditor works offline. These are the only things it downloads, and only when they are switched
					on.
				</p>
				{!client ? (
					<p className="text-pr-small text-pr-warning" role="alert">
						The engine is not connected: the network settings cannot be read.
					</p>
				) : null}
				{error ? (
					<p className="text-pr-small text-pr-danger" role="alert">
						{error}
					</p>
				) : null}
			</PrefGroup>
			<PrefGroup title="Platform fonts & emoji for social templates" testId="prefs-platform-assets">
				<Checkbox
					checked={status?.settings.platformAssets ?? false}
					disabled={!status || saving}
					onCheckedChange={(platformAssets) => void save({ platformAssets })}
					label="Download platform fonts and emoji when a social template needs them"
				/>
				<p className="pl-6 text-pr-small text-pr-muted">
					Social-comment templates draw with each platform's own fonts (such as Chirp or SF Pro) and emoji
					images (Apple, Twemoji, Noto) so they look like the real apps. Files that cannot be shipped with
					JasperEditor are downloaded once, checked and kept on this computer; previews and exports use the
					same files. When this is off nothing is downloaded: files already downloaded are still used, and an
					export that needs a missing one is stopped with its name.
				</p>
				<p className="pl-6 text-pr-small text-pr-muted">
					Licence: these fonts and emoji belong to their platforms. They are downloaded for your own use and
					are not redistributed by JasperEditor; whether you may publish videos that show them is up to you.
				</p>
				{status ? (
					<dl
						className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pl-6 text-pr-small"
						data-testid="prefs-platform-assets-status"
					>
						<dt className="text-pr-muted">Downloaded</dt>
						<dd>{`${cachedFonts} of ${status.fonts.length} fonts, ${cachedEmoji} emoji images, ${cachedImages} of ${status.images.length} images`}</dd>
						<dt className="text-pr-muted">Sources</dt>
						<dd>{hosts.length ? hosts.join(', ') : 'None listed'}</dd>
						<dt className="text-pr-muted">Manifest override</dt>
						<dd>
							{status.manifest.override.status === 'absent'
								? 'None'
								: status.manifest.override.status === 'loaded'
									? 'In use'
									: `Ignored: ${status.manifest.override.message ?? 'invalid'}`}
						</dd>
					</dl>
				) : null}
				{status?.notice.pending ? (
					<div className="flex items-center gap-2 pl-6">
						<Button
							variant="quiet"
							onClick={() => void client?.call('remoteAssetsNoticeAck').then(setStatus, () => undefined)}
						>
							Dismiss the download notice
						</Button>
					</div>
				) : null}
			</PrefGroup>
		</div>
	);
}
