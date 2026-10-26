// social-comment §7.8: the one-time, non-blocking notice after the engine's first platform font / emoji download: what
// was fetched, from where, and the licence caveat. Shown once per engine (the engine keeps the acknowledgement), from
// whichever editor window sees it first; headless, MCP and CLI downloads raise it in the next editor that connects.
import type { RemoteAssetsStatus } from '@jasper/api';
import { toast } from '@jasper/ui';
import { useEffect } from 'react';
import { useEngineOrNull } from '../state/engine.tsx';

/** One notice per page, even with several Program monitors open. */
let shown = false;

/** `Chirp 700 (fonts.example), 😀 (Apple) (em.example)` — names and hosts, untranslated. */
function fetchedList(status: RemoteAssetsStatus): string {
	const items = status.notice.items;
	const list = items
		.slice(0, 6)
		.map((i) => `${i.label} (${i.host})`)
		.join(', ');
	return items.length > 6 ? `${list}, … (${items.length})` : list;
}

export function RemoteAssetsNoticeHost() {
	const engine = useEngineOrNull();
	const client = engine?.status === 'connected' ? engine.client : null;
	const subscribe = engine?.subscribe;
	useEffect(() => {
		if (!client) return;
		let cancelled = false;
		const check = async () => {
			if (shown) return;
			let status: RemoteAssetsStatus;
			try {
				status = await client.call('remoteAssetsStatus');
			} catch {
				return; // engine without the service, or unreachable: nothing to tell
			}
			if (cancelled || shown || !status.notice.pending || status.notice.items.length === 0) return;
			shown = true;
			toast({
				kind: 'info',
				title: 'Downloaded platform fonts and emoji for social templates',
				detail: `Fetched: ${fetchedList(status)}. These platform fonts and emoji belong to their owners: they were downloaded for your own use and are not redistributed by JasperEditor. Turn this off in Preferences ▸ Privacy & Network.`,
				dedupeKey: 'remote-assets-notice',
				durationMs: 15_000,
				source: 'engine',
			});
			await client.call('remoteAssetsNoticeAck').catch(() => undefined);
		};
		void check();
		const off = subscribe?.((e) => {
			if (e?.type === 'remoteAssets.changed' && e.payload.notice) void check();
		});
		return () => {
			cancelled = true;
			off?.();
		};
	}, [client, subscribe]);
	return null;
}
