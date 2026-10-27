// Extensions are consulted in registration order. Each extension owns its prepared state; the registry
// treats that state as opaque so adding a renderer does not couple the planner to its implementation.
import type {
	EffectSpec,
	Rational,
	RenderSnapshot,
	RenderTransition,
	RenderVisualClip,
	ResolvedEffect,
} from '@jasper/project';
import type { PlannedExport } from './planner.ts';

/** First drawn / one-past-last frame of a clip in an export range, including transition handles. */
export function layerSpan(c: RenderVisualClip, range: { start: number; end: number }): [number, number] {
	return [
		Math.max(c.start - (c.headHandle ?? 0), range.start),
		Math.min(c.start + c.duration + (c.tailHandle ?? 0), range.end),
	];
}

/**
 * A pre-rendered picture that replaces part of a layer's pipeline in the native composite.
 * - `layer`: replaces the decoded source only. Frames are `intrinsicBox`-sized (scaled if not); the builder
 *   still applies effects, Motion, opacity and fades. (Composition clips: the Remotion master.)
 * - `sequence`: the fully placed layer, sequence-sized, with Motion, effects and opacity baked in (straight
 *   alpha). The builder only places it in time, applies the transition fades (unless `includesFades`) and
 *   overlays it at (0, 0). (Warp stage for corner pins / animated Motion; hybrid Remotion layers.)
 */
export type LayerOverride = {
	path: string;
	space: 'layer' | 'sequence';
	/** Sequence frame shown by the intermediate's frame 0. */
	startFrame: number;
	includesFades?: boolean;
	/** ffmpeg decoder for the input (e.g. `libvpx-vp9` for VP9 alpha); default: automatic. */
	decoder?: string;
	/**
	 * `path` is one still image (PNG, straight alpha) looped for the layer's
	 * frames like a still clip (`sequence` space; `startFrame` is then informational). edit-structure: also in
	 * `layer` space (a generator's constant picture, e.g. Bars and Tone).
	 */
	still?: boolean;
	/**
	 * edit-structure (`layer` space): the intermediate holds the clip's content from content time `contentOrigin`
	 * (flicks) at the sequence rate, played like media (sourceIn, speed, frame hold); `startFrame` is ignored.
	 */
	contentOrigin?: number;
	/**
	 * The intermediate covers only this region of the frame (sequence pixels, `w × h` frames) and
	 * is overlaid at `x, y` (`sequence` space).
	 */
	rect?: { x: number; y: number; w: number; h: number };
	/**
	 * The intermediate was rendered without the clip's colour runs; the builder applies them to
	 * the override stream (`sequence` space) with the filters of the extensions that realise colour effects.
	 */
	colorRuns?: boolean;
	/**
	 * In `layer` space, the intermediate already follows the clip's time mapping (reverse, time
	 * remap, frame hold, interpolation): frame k shows sequence frame `startFrame + k`, played linearly.
	 */
	retimed?: boolean;
	/**
	 * spec 13 AS-070 (`layer` space, `still`): `path` is a still of the layer's region `lowered` (layer px; the
	 * layer box grown by its content bleed, 1 px per layer px) drawn WITHOUT Motion, Opacity and the lowered effects
	 * (Transform, S_Shake): the builder draws them per frame with the multi-tap kernel (`stream/lowered.ts`). The
	 * clip's other effects are in the still.
	 */
	lowered?: { x: number; y: number; w: number; h: number };
	/**
	 * spec 13 AS-076 (pipelined stills): `path` is being rendered; this settles when it is written. `ok: false` = the
	 * picture is not the planned one (clipped, re-cropped): the export restarts without the pipeline. `picture` = the
	 * layer region of a trimmed layer still (replaces `lowered`). Kernel streams await it per member; anything that
	 * opens `path` as an ffmpeg input awaits it before the composite starts.
	 */
	ready?: Promise<OverrideReady>;
	/**
	 * spec 13 AS-073: this `sequence` override is a master of several layers of the clip's track (`id`), covering
	 * sequence frames `[f0, f1)`: the builder draws it once for all of them (one input), not once per clip.
	 */
	run?: { id: string; f0: number; f1: number };
};

export type OverrideReady =
	| { ok: true; picture?: { x: number; y: number; w: number; h: number } }
	| { ok: false; reason: string };

type NativeEffectSupport = false | 'static' | 'animated';

/** What an extension sees when the builder asks it for an effect's filter text. */
export type EffectFilterContext = {
	clip: RenderVisualClip;
	/** The clip's effects evaluated at the layer's first drawn frame (stack order). */
	effects: readonly ResolvedEffect[];
	/** Index of the effect being asked about in `effects`. */
	index: number;
	/** Intrinsic layer size (the frames are this size, RGBA, when effects run). */
	box: { width: number; height: number };
	fps: Rational;
	/** First drawn and one-past-last sequence frame of this layer in this export. */
	f0: number;
	f1: number;
	/** Whatever this extension's `prepare` returned for this export. */
	prepared: unknown;
};

export type NativePrepareContext = {
	/** Aborted on cancel. */
	signal: AbortSignal;
	/** Job progress text (the bar stays where the export is; stages are shown in the Jobs panel). */
	stage(text: string): void;
	/** Per-job scratch directory (removed when the job ends). */
	scratchDir(): Promise<string>;
	log(text: string): void;
	/** The export/still job id (child jobs use it as `parentId`). */
	jobId: string;
	projectId?: string;
	/**
	 * Filled by `prepareExtensions`: the extensions of this export and what the ones before this one prepared
	 * (the warp stage uses them to source a layer from another extension's `layer` override, e.g. an MG master).
	 */
	extensions?: readonly NativeExtension[];
	preparedSoFar?: ReadonlyMap<string, unknown>;
	/**
	 * M2 (wp-m2-layer-bake, additive): what the preparation is for — the native composite (default) or a Remotion
	 * render (`prepareForRemotion` extensions) — and the Remotion concurrency of the export (S11:LBK-022: bakes
	 * follow it).
	 */
	purpose?: 'native' | 'remotion';
	concurrency?: number;
	/**
	 * M3 (wp-m3-cachegc, additive): holds a cache file (or a file inside a cache entry) for this export/still until the
	 * job ends — the cache GC never removes it meanwhile, and the export records it as used by its project — and tells
	 * whether it exists (waiting for a removal in progress, which then counts as missing). Call it BEFORE checking or
	 * writing a cached file; absent (unit tests) = plain existence check.
	 */
	pin?(path: string): Promise<boolean>;
	/**
	 * spec 13 AS-076: work an extension continues after `prepare` returned (pipelined still bakes): the export awaits it
	 * before it finishes (its errors fail the export). Absent = everything is done in `prepare`.
	 */
	background?(work: Promise<void>): void;
	/** false = no pipelined work (a restart after a pipelined still changed). */
	pipeline?: boolean;
	/** Aborts the background work (the job ended, or the export failed and nothing waits for it). */
	backgroundSignal?: AbortSignal;
};

export type NativeExtension = {
	id: string;
	/**
	 * Effects this extension realizes on the native path (`effectFilter`): `static` = only without keyframes,
	 * `animated` = keyframes too. The planner stops blocking them.
	 */
	effectSupport?(effectId: string, spec: EffectSpec | undefined): NativeEffectSupport;
	/**
	 * This extension renders the clip's frames by media time (reverse, time remaps, Frame Blending /
	 * Optical Flow, VFR media) through a `layer` override: the planner stops blocking reversed / retimed video clips.
	 */
	retimes?(clip: RenderVisualClip): boolean;
	/** Clip kinds whose picture this extension provides through `override` (planner: native-capable kinds). */
	kinds?: ReadonlySet<string>;
	/**
	 * The extension renders this whole layer (`override` with space `sequence`): the planner skips the generic
	 * Motion / opacity / effect blockers for it (the extension reports its own through `blockers`).
	 */
	claimsLayer?(clip: RenderVisualClip): boolean;
	/**
	 * This extension pre-renders the claimed layer with a graphics engine (S04:RP-003
	 * graphics group): the plan lists it in `graphicsGroups` with that engine and the path becomes `hybrid`.
	 */
	bakes?(clip: RenderVisualClip): 'remotion' | null;
	/** Reasons this extension cannot render a clip it claims / provides (capability missing…). */
	blockers?(clip: RenderVisualClip): string[];
	/**
	 * Plan warnings for a clip this extension claims / provides (e.g. MG_FPS_MISMATCH
	 * for a composition at another frame rate). Added to the RenderPlan with the clip as item.
	 */
	warnings?(clip: RenderVisualClip, ctx: { fps: Rational }): { code: string; message: string }[];
	/** Runs before the ffmpeg composite of an export or still: renders/bakes what `override`/`effectFilter` need. */
	prepare?(planned: PlannedExport, ctx: NativePrepareContext): Promise<unknown>;
	/** The layer's pre-rendered picture, or null. First extension returning non-null wins. */
	override?(clip: RenderVisualClip, prepared: unknown): LayerOverride | null;
	/**
	 * wave1c (GPU spans): this extension pre-renders the span of a GPU transition of track `trackId` (its sides A + B
	 * and the transition stage, straight alpha): the planner stops blocking it and lists it as a graphics group.
	 */
	bakesTransition?(t: RenderTransition, trackId: string): 'remotion' | null;
	/**
	 * The pre-rendered span of a transition: a `sequence` override shown over `[t.start, t.start + t.duration)` in the
	 * track's place of the stack; the builder draws its side clips only outside the span.
	 */
	transitionOverride?(t: RenderTransition, prepared: unknown): LayerOverride | null;
	/**
	 * Filter text for one enabled effect: `undefined` = not mine (ask the next extension), `''` = nothing to add
	 * (e.g. already fused into the filter of the first effect of a colour run), otherwise ffmpeg filter text
	 * (comma-joined chain allowed; RGBA in, RGBA out, frame size unchanged).
	 */
	effectFilter?(fx: ResolvedEffect, ctx: EffectFilterContext): string | undefined;
	/**
	 * Remotion path (exports and stills that plan `remotion`): when true, `prepare` also runs before the Remotion
	 * render, and `adaptRemotionDoc` may rewrite the snapshot handed to the composition (e.g. put the signed URL of
	 * a composition clip's pre-rendered master into its source). Must return a new object, never mutate.
	 */
	prepareForRemotion?: boolean;
	adaptRemotionDoc?(
		doc: RenderSnapshot,
		prepared: unknown,
		ctx: { signUrl(path: string): string },
	): RenderSnapshot;
};

/** Built-in effects of the M1 builder (static params only). */
export const BUILTIN_NATIVE_EFFECTS: ReadonlySet<string> = new Set([
	'jasper.crop',
	'jasper.flip-horizontal',
	'jasper.flip-vertical',
]);

export class NativeExtensionRegistry {
	private readonly list: NativeExtension[] = [];

	register(ext: NativeExtension): () => void {
		const i = this.list.findIndex((e) => e.id === ext.id);
		if (i >= 0) this.list.splice(i, 1, ext);
		else this.list.push(ext);
		return () => {
			const j = this.list.indexOf(ext);
			if (j >= 0) this.list.splice(j, 1);
		};
	}

	all(): readonly NativeExtension[] {
		return this.list;
	}
}

/** Prepared state per extension id for one export. */
export type PreparedExtensions = ReadonlyMap<string, unknown>;

/** Runs every extension's `prepare` in registration order. */
export async function prepareExtensions(
	exts: readonly NativeExtension[],
	planned: PlannedExport,
	ctx: NativePrepareContext,
): Promise<Map<string, unknown>> {
	const out = new Map<string, unknown>();
	for (const ext of exts) {
		if (ctx.signal.aborted) break;
		out.set(
			ext.id,
			ext.prepare ? await ext.prepare(planned, { ...ctx, extensions: exts, preparedSoFar: out }) : undefined,
		);
	}
	return out;
}

/** First non-null override for a clip. */
export function layerOverride(
	exts: readonly NativeExtension[],
	prepared: PreparedExtensions,
	clip: RenderVisualClip,
): LayerOverride | null {
	for (const ext of exts) {
		const o = ext.override?.(clip, prepared.get(ext.id));
		if (o) return o;
	}
	return null;
}

/**
 * Runs of identical values over frames `[f0, f1)`: the building block for per-frame animated parameters on the
 * native path (e.g. a keyframed grade becomes one `lut3d` per run, enabled with `enable='between(n,a,b)'`).
 * `key` must map equal values to equal strings.
 */
export function sampleRuns<T>(
	f0: number,
	f1: number,
	valueAt: (frame: number) => T,
	key: (v: T) => string,
): { start: number; end: number; value: T }[] {
	const out: { start: number; end: number; value: T; k: string }[] = [];
	for (let f = f0; f < f1; f++) {
		const v = valueAt(f);
		const k = key(v);
		const last = out[out.length - 1];
		if (last && last.k === k) last.end = f + 1;
		else out.push({ start: f, end: f + 1, value: v, k });
	}
	return out.map(({ start, end, value }) => ({ start, end, value }));
}

/**
 * edit-structure: runs every extension's `prepare` for each nested sequence drawn in the export (recursively), with
 * the nested snapshot as `planned.snapshot` and its range as `planned.range` (media is shared). Keys are nest paths
 * (`clipId>clipId…`, see `nestPath` in native.ts).
 */
export async function prepareNestedExtensions(
	exts: readonly NativeExtension[],
	planned: PlannedExport,
	ctx: NativePrepareContext,
	parent = '',
	out: Map<string, PreparedExtensions> = new Map(),
): Promise<Map<string, PreparedExtensions>> {
	for (const t of planned.snapshot.videoTracks)
		for (const c of t.clips) {
			if (!('nest' in c.source) || ctx.signal.aborted) continue;
			const sub = c.source.nest.snapshot;
			const path = parent ? `${parent}>${c.clipId}` : c.clipId;
			const nested: PlannedExport = { ...planned, snapshot: sub, range: sub.range };
			out.set(path, await prepareExtensions(exts, nested, ctx));
			await prepareNestedExtensions(exts, nested, ctx, path, out);
		}
	return out;
}
