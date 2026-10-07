// Wave expressions in the composition: the snapshot's expressions are bound with @jasper/expressions (QuickJS-wasm),
// in the Player and in the Remotion renderer (headless Chrome) alike. Loading the engine is asynchronous; renders
// hold the frame with `delayRender` until it is ready, so no frame is ever drawn with pre-expression values.
import {
	bindSnapshotExpressions,
	isExpressionEngineLoaded,
	loadExpressionEngine,
	textSelectorExpressionHost,
} from '@jasper/expressions';
import type { TextSelectorExpressionHost } from '@jasper/project';
import { useEffect, useMemo, useState } from 'react';
import { continueRender, delayRender } from 'remotion';
import type { TextExpressionHostFactory } from './layers/text/expression-context.ts';
import type { RenderDoc } from './types.ts';

export function useExpressionSnapshot(doc: RenderDoc): RenderDoc {
	const needs = !!doc.expressions;
	const [ready, setReady] = useState(isExpressionEngineLoaded());
	const [handle] = useState(() =>
		needs && !isExpressionEngineLoaded() ? delayRender('Loading the expression engine') : null,
	);
	useEffect(() => {
		if (!needs || ready) {
			if (handle !== null && ready) continueRender(handle);
			return;
		}
		let alive = true;
		loadExpressionEngine().then(
			() => {
				if (alive) setReady(true);
			},
			(e) => {
				// Renders fall back to keyframed values and report the error on the console.
				console.error('[expressions] the engine could not be loaded', e);
				if (alive) setReady(true);
			},
		);
		return () => {
			alive = false;
		};
	}, [needs, ready, handle]);
	return useMemo(() => (needs && ready ? bindSnapshotExpressions(doc) : doc), [doc, needs, ready]);
}

/**
 * text-animators: per-clip hosts of the text Expression Selector, evaluated in the snapshot's expression world.
 * Null without expressions or before the engine is loaded (selectors then use their static Amount).
 */
export function useTextExpressionHosts(doc: RenderDoc): TextExpressionHostFactory | null {
	const data = doc.expressions ?? null;
	const loaded = isExpressionEngineLoaded();
	return useMemo(() => {
		if (!data || !loaded) return null;
		const cache = new Map<string, TextSelectorExpressionHost | null>();
		return (clipId: string) => {
			if (!cache.has(clipId)) cache.set(clipId, textSelectorExpressionHost(data, clipId));
			return cache.get(clipId) ?? null;
		};
	}, [data, loaded]);
}
