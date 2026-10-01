// Attaches the composition runtime (runtime.ts) to the open editor session. Mounted invisibly through the
// Program monitor overlay registry (it renders nothing) and from the Composition section / Remotion tab, so
// previews, master states and bundle relinks work whenever those are on screen.
import type { EditorSession } from '@jasper/session';
import { useEffect, useState } from 'react';
import type { ProgramOverlayHostProps } from '../extensions/index.ts';
import { useEngineOrNull } from '../state/engine.tsx';
import { currentMgRuntime, ensureMgRuntime, type MgRuntime } from './runtime.ts';

/** The runtime of `session` (attached on first use); null without an engine connection. */
export function useMgRuntimeAttach(session: EditorSession | null): MgRuntime | null {
	const engine = useEngineOrNull();
	const [rt, setRt] = useState<MgRuntime | null>(() =>
		currentMgRuntime()?.session === session ? currentMgRuntime() : null,
	);
	useEffect(() => {
		if (!session || !engine || engine.status !== 'connected') return;
		setRt(ensureMgRuntime(session, { client: engine.client, subscribe: engine.subscribe }));
	}, [session, engine]);
	return rt;
}

/** Program overlay that only attaches the runtime (renders nothing). */
export function MgRuntimeHost(props: ProgramOverlayHostProps) {
	useMgRuntimeAttach(props.session);
	return null;
}
