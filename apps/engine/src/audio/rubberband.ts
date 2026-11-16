// The Pitch Shifter's Rubber Band engine in the engine (every export path, loudness analysis): loads the separate
// GPL module `rubberband.wasm` (scripts/rubberband-wasm/build.sh; AGENTS.md §2 exception) once per thread and hands
// it to @jasper/audio-fx. Without it, `rubberband-r3` shifters run Signalsmith and plans carry PITCH_ENGINE_FALLBACK.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rubberBandStatus, setRubberBandModule } from '@jasper/audio-fx';
import type { RenderSnapshot } from '@jasper/project';

/**
 * Where rubberband.wasm is: `JASPER_RUBBERBAND_WASM` → next to the running bundle (`dist/rubberband.wasm`, copied by
 * scripts/build.mjs) → the @jasper/audio-fx package (dev checkouts, tests). Null when none exists.
 */
export function resolveRubberBandWasm(env: NodeJS.ProcessEnv = process.env): string | null {
	const candidates: string[] = [];
	if (env.JASPER_RUBBERBAND_WASM) candidates.push(env.JASPER_RUBBERBAND_WASM);
	try {
		const here = fileURLToPath(new URL('./rubberband.wasm', import.meta.url));
		candidates.push(
			here,
			join(dirname(here), '..', '..', '..', 'packages', 'audio-fx', 'wasm', 'rubberband.wasm'),
		);
	} catch {
		// not a file: URL (bundled elsewhere)
	}
	try {
		candidates.push(createRequire(import.meta.url).resolve('@jasper/audio-fx/rubberband.wasm'));
	} catch {
		// package export not resolvable from here
	}
	for (const c of candidates) if (c && existsSync(c)) return c;
	return null;
}

let installed = false;

/** Loads rubberband.wasm for this thread's Pitch Shifters (idempotent; failures are reported, never thrown). */
export function installRubberBand(env: NodeJS.ProcessEnv = process.env): {
	available: boolean;
	error: string | null;
} {
	if (installed) return rubberBandStatus();
	installed = true;
	const path = resolveRubberBandWasm(env);
	if (!path)
		setRubberBandModule(null, 'rubberband.wasm not found (build it with scripts/rubberband-wasm/build.sh)');
	else
		try {
			setRubberBandModule(new WebAssembly.Module(readFileSync(path)));
		} catch (e) {
			setRubberBandModule(
				null,
				`rubberband.wasm could not be loaded: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	return rubberBandStatus();
}

type FxLike = {
	id?: string;
	effectId: string;
	enabled: boolean;
	params: Record<string, { value: unknown } | undefined>;
};

/** Plan warning when enabled Rubber Band Pitch Shifters of the render will run Signalsmith instead. */
export function pitchEngineWarnings(
	snapshot: Pick<RenderSnapshot, 'audioClips' | 'audioMix'>,
): { code: string; message: string; itemIds?: string[] }[] {
	const st = installRubberBand();
	if (st.available) return [];
	const items: string[] = [];
	const wants = (e: FxLike) =>
		e.enabled && e.effectId === 'jasper.audio.pitch-shifter' && e.params.engine?.value === 'rubberband-r3';
	for (const c of snapshot.audioClips ?? []) if ((c.effects as FxLike[]).some(wants)) items.push(c.clipId);
	for (const s of snapshot.audioMix?.strips ?? []) if ((s.inserts as FxLike[]).some(wants)) items.push(s.id);
	if (items.length === 0) return [];
	return [
		{
			code: 'PITCH_ENGINE_FALLBACK',
			message: `${items.length} Pitch Shifter${items.length === 1 ? ' uses' : 's use'} Rubber Band R3, which is not available here (${st.error}): ${items.length === 1 ? 'it renders' : 'they render'} with Signalsmith Stretch instead`,
			itemIds: items,
		},
	];
}
