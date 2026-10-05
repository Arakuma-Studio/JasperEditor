// Attaches the graded-preview runtime of DOM layers (runtime.ts) to the open editor session. Mounted invisibly
// through the Program monitor overlay registry (it renders nothing), like the composition runtime.
import { useEffect } from 'react';
import type { ProgramOverlayHostProps } from '../extensions/index.ts';
import { useEngineOrNull } from '../state/engine.tsx';
import { ensureLayerBakeRuntime } from './runtime.ts';

export function LayerBakeRuntimeHost({ session }: ProgramOverlayHostProps) {
	const engine = useEngineOrNull();
	useEffect(() => {
		if (!session || !engine || engine.status !== 'connected') return;
		ensureLayerBakeRuntime(session, { client: engine.client, subscribe: engine.subscribe });
	}, [session, engine]);
	return null;
}
