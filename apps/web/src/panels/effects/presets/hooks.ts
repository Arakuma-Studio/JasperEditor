// Keeps the preset library connected to the engine of this window and current with `effectPresets.changed`
// (another window or an agent saved, renamed or deleted a preset).
import { useStoreSelector } from '@jasper/session/react';
import { useEffect } from 'react';
import { useEngineOrNull } from '../../../state/engine.tsx';
import { connectPresetLibrary, type PresetLibraryState, presetLibrary, refreshPresets } from './store.ts';

export function usePresetLibrary(): PresetLibraryState {
	const engine = useEngineOrNull();
	const hosted = engine !== null;
	const client = engine?.status === 'connected' ? engine.client : null;
	// Outside an EngineProvider (standalone mounts, tests) the library keeps whatever it was connected to.
	useEffect(() => {
		if (hosted) connectPresetLibrary(client);
	}, [hosted, client]);
	const subscribe = engine?.subscribe;
	useEffect(
		() =>
			subscribe?.((e) => {
				if (e?.type === 'effectPresets.changed') void refreshPresets();
			}),
		[subscribe],
	);
	return useStoreSelector(presetLibrary(), (s) => s);
}
