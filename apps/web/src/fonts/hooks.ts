// wp fonts: keeps the font store connected to this window's engine and current with `fonts.changed`.
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
			}),
		[subscribe],
	);
	return useStoreSelector(fontsStore(), (s) => s);
}
