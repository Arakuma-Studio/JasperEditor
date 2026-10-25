// wp fonts: keeps the font store connected to this window's engine and current with `fonts.changed` (and
// `remoteAssets.changed`, social-comment §7.8).
import { useStoreSelector } from '@jasper/session/react';
import { useEffect } from 'react';
import { useEngineOrNull } from '../state/engine.tsx';
import { connectFonts, type FontsState, fontsStore, refreshFonts } from './store.ts';

export function useFonts(): FontsState {
	const engine = useEngineOrNull();
	const hosted = engine !== null;
	const client = engine?.status === 'connected' ? engine.client : null;
	// Outside an EngineProvider (standalone mounts, tests) the store keeps whatever it was connected to.
	useEffect(() => {
		if (hosted) connectFonts(client);
	}, [hosted, client]);
	const subscribe = engine?.subscribe;
	useEffect(
		() =>
			subscribe?.((e) => {
				if (e?.type === 'fonts.changed') void refreshFonts();
				// social-comment §7.8: the remote-asset manifest / settings change the catalogue's remote families,
				// emoji packs and images (downloads alone do not)
				else if (e?.type === 'remoteAssets.changed' && e.payload.reason !== 'fetched') void refreshFonts();
			}),
		[subscribe],
	);
	return useStoreSelector(fontsStore(), (s) => s);
}
