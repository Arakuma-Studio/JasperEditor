// The `warp` native extension (S09:TRK-032…034, ARCHITECTURE D-28, §19.5, §19.6): corner-pinned layers and
// layers with keyframed Motion or animated opacity stay on the native path. `prepare` renders each claimed layer
// into a sequence-space, straight-alpha ProRes 4444 intermediate (cached under `<appdir>/cache/warp/<key>.mov`);
// `override` hands it to the builder as a `sequence` override (the builder applies transition fades and overlays
// it at 0,0). FFmpeg's `perspective` filter is GPL-only (D-13), so the warp runs in our worker threads.
import { createHash } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import {
	CORNER_PIN_EFFECT_ID,
	clipContentTime,
	defaultEffectRegistry,
	type EffectRegistry,
	invertMat3,
	isAnimated,
	layerMapOf,
	type Mat3,
	multiplyMat3,
	type RenderVisualClip,
	resolveLayerProps,
} from '@jasper/project';
import { JobError } from '../../jobs/types.ts';
import type { Ffmpeg } from '../../tools/ffmpeg.ts';
import { layerSourceChain, SWS_FLAGS } from '../native.ts';
import {
	BUILTIN_NATIVE_EFFECTS,
	type LayerOverride,
	layerOverride,
	type NativeExtension,
	type NativePrepareContext,
} from '../native-ext.ts';
import type { PlannedExport } from '../planner.ts';
import { destRect } from './kernel.ts';
import { decoderArgs, renderWarpLayer, type WarpFrameSpec, WarpRenderError } from './render.ts';

export const WARP_EXTENSION_ID = 'warp';
/** Bumped whenever the intermediate's pixels would change for the same inputs (kernel, encoder settings). */
export const WARP_VERSION = 1;

/** Kinds whose picture the source chain can produce (composition: from an earlier extension's `layer` override). */
const WARP_KINDS: ReadonlySet<string> = new Set(['video', 'still', 'animated-image', 'solid', 'composition']);

type WarpPrepared = ReadonlyMap<string, { path: string; startFrame: number }>;

export type WarpDeps = {
	ffmpeg: Ffmpeg;
	/** `<appdir>/cache/warp`. */
	cacheDir: string;
	/** All registered extensions (the effect support of the others, the `layer` overrides before this one). */
	getExtensions(): readonly NativeExtension[];
	effects?: EffectRegistry;
	/** Worker threads (default: the machine's parallelism). */
	threads?: number;
	log?(msg: string): void;
};

function motionAnimated(c: RenderVisualClip): boolean {
	const t = c.transform;
	return (
		!!t &&
		(isAnimated(t.position) ||
			isAnimated(t.anchor) ||
			isAnimated(t.scale) ||
			isAnimated(t.scaleWidth) ||
			isAnimated(t.rotation))
	);
}

/** Layers the warp stage renders: an enabled corner pin, keyframed Motion or animated opacity. */
function warpClaims(c: RenderVisualClip): boolean {
	if (!WARP_KINDS.has(c.kind) || !c.transform) return false;
	return (
		c.effects.some((fx) => fx.enabled && fx.effectId === CORNER_PIN_EFFECT_ID) ||
		motionAnimated(c) ||
		isAnimated(c.opacity)
	);
}

/** First drawn / one-past-last frame of a clip in an export range (with transition handles, like the builder). */
function layerSpan(c: RenderVisualClip, range: { start: number; end: number }): [number, number] {
	return [
		Math.max(c.start - (c.headHandle ?? 0), range.start),
		Math.min(c.start + c.duration + (c.tailHandle ?? 0), range.end),
	];
}

const r9 = (x: number) => {
	const v = Math.round(x * 1e9) / 1e9;
	return Object.is(v, -0) ? 0 : v;
};

/** Per-frame layer maps (source frame px → sequence px) and opacities of a clip over `[f0, f1)`. */
function warpFrames(
	c: RenderVisualClip,
	f0: number,
	f1: number,
	fps: { num: number; den: number },
	size: { sw: number; sh: number; width: number; height: number },
): { maps: (Mat3 | null)[]; specs: WarpFrameSpec[] } {
	// The chain delivers the rounded intrinsic box; the layer map is in intrinsic (layer) pixels.
	const toLayer: Mat3 = [
		c.intrinsicBox.width / size.sw,
		0,
		0,
		0,
		c.intrinsicBox.height / size.sh,
		0,
		0,
		0,
		1,
	];
	const maps: (Mat3 | null)[] = [];
	const specs: WarpFrameSpec[] = [];
	for (let f = f0; f < f1; f++) {
		const props = resolveLayerProps(c, clipContentTime(c, f, fps));
		const opacity = props.opacity / 100;
		const fwd = multiplyMat3(layerMapOf(props), toLayer).map(r9) as Mat3;
		const inv = invertMat3(fwd);
		const rect = inv && opacity > 0 ? destRect(fwd, size.sw, size.sh, size.width, size.height) : null;
		maps.push(inv ? fwd : null);
		specs.push(rect && inv ? { inv, rect, opacity } : { inv: null, rect: null, opacity: 0 });
	}
	return { maps, specs };
}

/**
 * The chain's swscale conversions with slice threads (identical pixels, the single-threaded scaler is the decode
 * bottleneck at 1080p). Only for the warp's own decode; the cache key uses the builder's text.
 */
function threadedScalers(filter: string, threads: number): string {
	return threads > 1 ? filter.replaceAll(`:${SWS_FLAGS}`, `:${SWS_FLAGS}:threads=${threads}`) : filter;
}

async function fileFingerprint(path: string): Promise<string> {
	try {
		const s = await stat(path);
		return `${path}|${s.size}|${Math.round(s.mtimeMs)}`;
	} catch {
		return `${path}|missing`;
	}
}

export function createWarpExtension(deps: WarpDeps): NativeExtension {
	const effects = deps.effects ?? defaultEffectRegistry;
	const threads = Math.max(1, deps.threads ?? availableParallelism());
	const others = () => deps.getExtensions().filter((e) => e.id !== WARP_EXTENSION_ID);

	function blockers(c: RenderVisualClip): string[] {
		const out: string[] = [];
		const label = `${c.kind} clip "${c.name}"`;
		const exts = others();
		for (const fx of c.effects) {
			if (!fx.enabled || fx.effectId === CORNER_PIN_EFFECT_ID) continue;
			const animated = Object.values(fx.params).some((p) => isAnimated(p));
			if (BUILTIN_NATIVE_EFFECTS.has(fx.effectId)) {
				if (animated) out.push(`${label} has an animated ${fx.effectId}`);
				continue;
			}
			const spec = effects.get(fx.effectId, fx.effectVersion);
			let support: false | 'static' | 'animated' = false;
			for (const ext of exts) {
				const s = ext.effectSupport?.(fx.effectId, spec) ?? false;
				if (s === 'animated' || (s === 'static' && support === false)) support = s;
			}
			if (support === false)
				out.push(`${label} uses effect ${fx.effectId}, which the native path cannot render`);
			else if (support === 'static' && animated) out.push(`${label} has an animated ${fx.effectId}`);
		}
		if (c.kind === 'composition' && !exts.some((e) => e.kinds?.has('composition')))
			out.push(`${label} needs a pre-rendered composition master, which is unavailable`);
		if (c.kind === 'animated-image' && c.loop)
			out.push(`${label} loops its animation (not on the native path)`);
		return out;
	}

	async function prepareClip(
		c: RenderVisualClip,
		planned: PlannedExport,
		ctx: NativePrepareContext,
		before: readonly NativeExtension[],
		index: number,
		count: number,
	): Promise<{ path: string; startFrame: number } | null> {
		const snap = planned.snapshot;
		const fps = snap.settings.fps;
		const W = snap.settings.width;
		const H = snap.settings.height;
		const [f0, f1] = layerSpan(c, planned.range);
		const n = f1 - f0;
		const preparedSoFar = ctx.preparedSoFar ?? new Map<string, unknown>();
		// An earlier extension's `layer` override is the source (composition clips: the MG master, §19.6); a
		// `sequence` override means that extension renders the whole placed layer: nothing to warp.
		const override = layerOverride(before, preparedSoFar, c);
		if (override && override.space !== 'layer') return null;
		if (!override && c.kind === 'composition')
			throw new JobError(
				'WARP_SOURCE_UNAVAILABLE',
				`The warp stage needs the pre-rendered master of composition clip "${c.name}", which no extension provided`,
				false,
			);

		// The layer's source chain (the builder's code), as a standalone ffmpeg decode.
		const inputs: string[][] = [];
		const chain = layerSourceChain({
			clip: c,
			f0,
			f1,
			fps,
			sources: { media: (id) => planned.media[id] ?? null, mgMaster: () => null },
			override,
			extensions: { list: before, prepared: preparedSoFar },
			addInput: (args) => {
				inputs.push(args);
				return inputs.length - 1;
			},
		});
		const filter = `${chain.input}${chain.filters.join(',')}`;
		const size = { sw: chain.width, sh: chain.height, width: W, height: H };
		const { maps, specs } = warpFrames(c, f0, f1, fps, size);

		// Content key: source identity instead of paths, chain text, per-frame maps and opacities, sizes, span.
		const fingerprints = new Map<string, string>();
		for (const m of Object.values(planned.media))
			fingerprints.set(m.path, `${m.record.fingerprint}|${m.record.sizeBytes}|${m.record.mtimeMs}`);
		const inputKey: string[][] = [];
		for (const args of inputs) {
			const i = args.indexOf('-i');
			const path = args[i + 1]!;
			const id = fingerprints.get(path) ?? (await fileFingerprint(path));
			inputKey.push(args.map((a, k) => (k === i + 1 ? id : a)));
		}
		const key = createHash('sha256')
			.update(
				JSON.stringify({
					v: WARP_VERSION,
					inputs: inputKey,
					filter,
					size,
					fps,
					frames: n,
					maps,
					opacities: specs.map((s) => s.opacity),
				}),
			)
			.digest('hex')
			.slice(0, 40);
		const path = join(deps.cacheDir, `${key}.mov`);
		try {
			if ((await stat(path)).size > 0) {
				ctx.log(`warp: ${c.clipId} reused ${path}`);
				return { path, startFrame: f0 };
			}
		} catch {
			// not cached
		}
		await mkdir(deps.cacheDir, { recursive: true });
		const stage = `Warping layer ${index}/${count}`;
		ctx.stage(stage);
		const started = Date.now();
		let lastPct = -1;
		try {
			const args = decoderArgs(inputs, threadedScalers(filter, Math.max(2, Math.round(threads / 3))), n);
			ctx.log(`warp: ffmpeg ${args.join(' ')}`);
			await renderWarpLayer(deps.ffmpeg, {
				decodeArgs: args,
				...size,
				fps,
				frames: specs,
				output: path,
				workers: threads,
				threads,
				signal: ctx.signal,
				onProgress: (done, total) => {
					const pct = Math.floor((done / total) * 100);
					if (pct >= lastPct + 5) {
						lastPct = pct;
						ctx.stage(`${stage} · ${pct}%`);
					}
				},
			});
		} catch (e) {
			if (e instanceof WarpRenderError)
				throw new JobError(e.code, e.message, e.code !== 'JOB_CANCELLED' ? true : undefined);
			throw e;
		}
		const ms = Date.now() - started;
		const fpsOut = n / Math.max(1e-3, ms / 1000);
		const msg = `warp: ${c.clipId} ${n} frames in ${ms} ms (${fpsOut.toFixed(1)} fps) → ${path}`;
		ctx.log(msg);
		deps.log?.(msg);
		return { path, startFrame: f0 };
	}

	return {
		id: WARP_EXTENSION_ID,
		claimsLayer: warpClaims,
		blockers,
		async prepare(planned, ctx): Promise<WarpPrepared> {
			const out = new Map<string, { path: string; startFrame: number }>();
			const all = ctx.extensions ?? deps.getExtensions();
			const self = all.findIndex((e) => e.id === WARP_EXTENSION_ID);
			const before = self >= 0 ? all.slice(0, self) : all.filter((e) => e.id !== WARP_EXTENSION_ID);
			const clips = planned.snapshot.videoTracks
				.flatMap((t) => t.clips)
				.filter((c) => {
					if (!warpClaims(c)) return false;
					const [f0, f1] = layerSpan(c, planned.range);
					return f1 > f0;
				});
			for (const [i, c] of clips.entries()) {
				if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
				const r = await prepareClip(c, planned, ctx, before, i + 1, clips.length);
				if (r) out.set(c.clipId, r);
			}
			return out;
		},
		override(clip, prepared): LayerOverride | null {
			const p = (prepared as WarpPrepared | undefined)?.get(clip.clipId);
			return p ? { path: p.path, space: 'sequence', startFrame: p.startFrame } : null;
		},
	};
}
