// Native export extensions (M2, ARCHITECTURE §19.6): the one plug-in point through which the M2 work packages
// keep their features on the fast native (ffmpeg) path without editing the planner or the filtergraph builder.
//
//   colour   (wp-m2-color)  effectFilter: fused colour runs → `lut3d=file=<baked>.cube` (+ per-frame windows)
//   mg       (wp-m2-mg)     kinds 'composition' (+ 'text' hybrid): prepare = Remotion pre-render → override 'layer'/'sequence'
//   track    (wp-m2-track)  claimsLayer: corner pin / animated Motion → prepare = warp stage → override 'sequence'
//
// Extensions are registered at engine start by their route plugin (`core.registerNativeExtension(ext)`),
// like the M1 motion-graphic master provider. Order of registration = order of consultation.
import type { EffectSpec, Rational, RenderSnapshot, RenderVisualClip, ResolvedEffect } from '@jasper/project';
import type { PlannedExport } from './planner.ts';

/** What `prepare` receives: the planned export (document, snapshot with engine-local media, output spec). */
export type PlannedExportLike = PlannedExport;

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
};

export type NativeEffectSupport = false | 'static' | 'animated';

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
};

export type NativeExtension = {
	id: string;
	/**
	 * Effects this extension realizes on the native path (`effectFilter`): `static` = only without keyframes,
	 * `animated` = keyframes too. The planner stops blocking them.
	 */
	effectSupport?(effectId: string, spec: EffectSpec | undefined): NativeEffectSupport;
	/** Clip kinds whose picture this extension provides through `override` (planner: native-capable kinds). */
	kinds?: ReadonlySet<string>;
	/**
	 * The extension renders this whole layer (`override` with space `sequence`): the planner skips the generic
	 * Motion / opacity / effect blockers for it (the extension reports its own through `blockers`).
	 */
	claimsLayer?(clip: RenderVisualClip): boolean;
	/** Reasons this extension cannot render a clip it claims / provides (capability missing…). */
	blockers?(clip: RenderVisualClip): string[];
	/**
	 * M2 (wp-m2-mg, additive): plan warnings for a clip this extension claims / provides (e.g. MG_FPS_MISMATCH
	 * for a composition at another frame rate). Added to the RenderPlan with the clip as item.
	 */
	warnings?(clip: RenderVisualClip, ctx: { fps: Rational }): { code: string; message: string }[];
	/** Runs before the ffmpeg composite of an export or still: renders/bakes what `override`/`effectFilter` need. */
	prepare?(planned: PlannedExportLike, ctx: NativePrepareContext): Promise<unknown>;
	/** The layer's pre-rendered picture, or null. First extension returning non-null wins. */
	override?(clip: RenderVisualClip, prepared: unknown): LayerOverride | null;
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
	planned: PlannedExportLike,
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
