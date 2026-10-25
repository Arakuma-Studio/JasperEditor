// social-comment §7.8: the engine's font catalogue (`GET /api/fonts`) for the Players that draw templates — the
// Program monitor and the Motion Templates gallery (posters and hover previews). Read again when the remote-asset
// settings or manifest change (`epoch` counts those changes, so template assets are prefetched again too).
import type { FontCatalog } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { useEffect, useState } from 'react';
import { useEngineOrNull } from '../state/engine.tsx';

export function useFontCatalog(engine: EngineClient | null): { catalog: FontCatalog | null; epoch: number } {
	const [catalog, setCatalog] = useState<FontCatalog | null>(null);
	const [epoch, setEpoch] = useState(0);
	const subscribe = useEngineOrNull()?.subscribe;
	useEffect(
		() =>
			subscribe?.((e) => {
				if (e?.type === 'remoteAssets.changed' && e.payload.reason !== 'fetched') setEpoch((n) => n + 1);
			}),
		[subscribe],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `epoch` re-reads the catalogue
	useEffect(() => {
		if (!engine) return;
		let cancelled = false;
		// An engine (or test client) without the fonts route: text uses the fallback stack, templates show markers.
		Promise.resolve()
			.then(() => engine.listFonts())
			.then((c) => !cancelled && setCatalog(c))
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [engine, epoch]);
	return { catalog, epoch };
}
