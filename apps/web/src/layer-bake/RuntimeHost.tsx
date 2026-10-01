// Attaches the graded-preview runtime of DOM layers (runtime.ts) to the open editor session. Mounted invisibly
// through the Program monitor overlay registry (it renders nothing), like the composition runtime.
import type { EditorSession } from '@jasper/session';
import { useEffect } from 'react';
import type { ProgramOverlayHostProps } from '../extensions/index.ts';
import { useEngineOrNull } from '../state/engine.tsx';
import { ensureLayerBakeRuntime } from './runtime.ts';

/** Attaches the runtime of `session` (once connected to an engine). */
export function useLayerBakeRuntimeAttach(session: EditorSession | null): void {
	const engine = useEngineOrNull();
	useEffect(() => {
		if (!session || !engine || engine.status !== 'connected') return;
		ensureLayerBakeRuntime(session, { client: engine.client, subscribe: engine.subscribe });
	}, [session, engine]);
}

/** Program overlay that only attaches the runtime (renders nothing). */
export function LayerBakeRuntimeHost(props: ProgramOverlayHostProps) {
	useLayerBakeRuntimeAttach(props.session);
	return null;
}
