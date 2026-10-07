// The colour native extension (S06:CG-050…055, ARCHITECTURE §19.6 / D-21): every effect with a colour op is
// realized on the native path. Consecutive colour effects of a layer (a colour run) are baked with the SAME
// TypeScript maths as the preview into one 3D LUT, written content-addressed to `<appdir>/cache/luts/`, and
// applied with `lut3d=file=…:interp=tetrahedral` on the layer's RGBA frames, on the first effect of the run.
//
// Precision (deviation from the `format=rgba64le,…,format=rgba` text of S06:CG-051, measured on the chart
// fixture with FFmpeg 6.1 and 7.1): the layer is already 8-bit RGBA at this point, so 16-bit processing gains
// nothing, while swscale's packed 8↔16-bit conversions are not exact (`v<<8` in, `round(v/256)` out) and cost
// up to ±2 code values (25 % of pixels off by one). `lut3d` on 8-bit data maps inputs exactly (v/255) and
// stores `trunc(out·255)`; the baked table is therefore written with a +0.5/255 offset (`EXPORT_ROUNDING_BIAS`)
// so the store rounds to nearest. Result: 99.999 % of chart pixels equal the TypeScript reference
// (`applyLut` of the unbiased table, rounded), max 1.
// Keyframed grades: the evaluated run is sampled per output frame (`sampleRuns`), one LUT per distinct state,
// each `lut3d` enabled on its frame window (at most 240 per layer; above that the params are quantised).
//
// LUT files (M3, wp-m3-cachegc, S06:CG-056): named by the sha256 of their `.cube` text, so states that bake to the
// same table — a grade keyframed back to an earlier value, hold segments, params that clamp to the same result, the
// same look on several clips or exports — share one file; nothing is written when the file exists. A process-wide
// memo (state key → file) skips the bake itself for states seen before. The text is byte-identical to before (same
// lattice, same 6-decimal values), so the export output does not change. Files are pinned for the export
// (`ctx.pin`) before they are reused or written: the cache GC never removes a LUT an export is about to read.
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	bakeColorRun,
	type ColorRunEffect,
	clipContentTime,
	colorRunKey,
	defaultEffectRegistry,
	type EffectRegistry,
	EXPORT_LUT_SIZE,
	effectRuns,
	evaluate,
	isAnimated,
	type Lut,
	type ParamValue,
	type RenderVisualClip,
	type ResolvedEffect,
	serializeCube,
} from '@jasper/project';
import { type EffectFilterContext, type NativeExtension, sampleRuns } from '../export/native-ext.ts';
import type { PlannedExport } from '../export/planner.ts';
import { exists } from '../tools/fs.ts';
import { readCubeFile } from './prober.ts';

/** Most distinct LUTs one layer may use in an export (S06:CG-052). */
const MAX_LUTS_PER_LAYER = 240;
/** Added to every baked table value so `lut3d`'s truncating 8-bit store rounds to nearest (see above). */
const EXPORT_ROUNDING_BIAS = 0.5 / 255;
/** States remembered process-wide (state key → baked file); each costs ~200 bytes, a bake ~10–50 ms. */
const LUT_MEMO_SIZE = 4096;
/** Largest lattice used for export bakes when a run references a bigger imported LUT (S06:CG-012). */
const MAX_EXPORT_LUT_SIZE = 65;
type LutWindow = {
	/** Sequence frames `[start, end)`. */
	start: number;
	end: number;
	/** Baked `.cube` file, or null when the run is the identity in this window. */
	file: string | null;
};

export type ColorPrepared = {
	/** clipId → first effect id of the run → windows over the layer's frames. */
	layers: Map<string, Map<string, LutWindow[]>>;
	/** LUT assets the grade references that are offline (the grade skips them, S06:CG-004). */
	offlineLuts: string[];
	/** Distinct run states of this export (tests / logs). */
	baked: number;
	/** Distinct LUT files they use (states with identical tables share one, CG-056). */
	files: number;
	/** States served by the memo (no bake) / files that already existed (no write) / files written. */
	reused: number;
	existing: number;
	written: number;
};

export type ColorExtensionOptions = {
	/** `<appdir>/cache/luts` */
	lutCacheDir: string;
	effects?: EffectRegistry;
	log?(msg: string): void;
};

type RunState = { effects: ColorRunEffect[]; key: string };

const hasKeyframes = (fx: RenderVisualClip['effects'][number]) =>
	Object.values(fx.params).some((a) => isAnimated(a));

/** Quoted filter-option value (single quotes; `'` itself is closed, escaped and reopened). */
export function quoteFilterPath(path: string): string {
	return `'${path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
}

/** Referenced `{mediaId}` values of a clip's colour effects (static values and keyframes). */
function lutRefs(clip: RenderVisualClip): string[] {
	const out = new Set<string>();
	for (const fx of clip.effects) {
		if (!fx.enabled) continue;
		for (const a of Object.values(fx.params)) {
			for (const v of [a.value, ...a.keyframes.map((k) => k.value)]) {
				const id = (v as { mediaId?: unknown } | null)?.mediaId;
				if (typeof id === 'string' && id) out.add(id);
			}
		}
	}
	return [...out];
}

export function createColorExtension(opts: ColorExtensionOptions): NativeExtension {
	const registry = opts.effects ?? defaultEffectRegistry;
	const assetCache = new Map<string, Promise<Lut | null>>();
	const writes = new Map<string, Promise<string>>();

	const loadAsset = (path: string, fingerprint: string): Promise<Lut | null> => {
		const k = `${fingerprint}:${path}`;
		let p = assetCache.get(k);
		if (!p) {
			p = readCubeFile(path).catch((e) => {
				opts.log?.(`[color] cannot read LUT ${path}: ${(e as Error).message}`);
				return null;
			});
			assetCache.set(k, p);
			if (assetCache.size > 64) assetCache.delete(assetCache.keys().next().value!);
		}
		return p;
	};

	/** State key → LUT file (absolute) of states baked before, most recent last. */
	const memo = new Map<string, string>();
	const remember = (key: string, file: string) => {
		memo.delete(key);
		memo.set(key, file);
		if (memo.size > LUT_MEMO_SIZE) memo.delete(memo.keys().next().value!);
	};

	/** Writes `text` as `<sha256(text)>.cube` unless that file exists (content-addressed, CG-056). */
	const writeLut = async (
		text: string,
		pin: (path: string) => Promise<boolean>,
		stats: ColorPrepared,
	): Promise<string> => {
		const file = join(opts.lutCacheDir, `${createHash('sha256').update(text).digest('hex')}.cube`);
		// Pinned first: a GC pass cannot remove it between this check and the export reading it.
		if (await pin(file)) {
			stats.existing++;
			return file;
		}
		let p = writes.get(file);
		if (!p) {
			p = (async () => {
				await mkdir(opts.lutCacheDir, { recursive: true });
				const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.partial`;
				await writeFile(tmp, text);
				await rename(tmp, file);
				stats.written++;
				return file;
			})().finally(() => writes.delete(file));
			writes.set(file, p);
		}
		return p;
	};

	/** The `.cube` text of a baked run as written for `lut3d` (+0.5/255 so its 8-bit store rounds to nearest). */
	const cubeText = (lut: Lut) =>
		serializeCube({
			...lut,
			data: lut.data.map((v) => v + EXPORT_ROUNDING_BIAS),
			title: 'JasperEditor colour run (8-bit rounding)',
		});

	return {
		id: 'color',
		effectSupport: (_effectId, spec) => (spec?.color ? 'animated' : false),

		async prepare(planned: PlannedExport, ctx): Promise<ColorPrepared> {
			const snap = planned.snapshot;
			const fps = snap.settings.fps;
			const R0 = snap.range.start;
			const R1 = snap.range.end;
			const out: ColorPrepared = {
				layers: new Map(),
				offlineLuts: [],
				baked: 0,
				files: 0,
				reused: 0,
				existing: 0,
				written: 0,
			};
			const pin = ctx.pin ?? exists;

			// LUT assets referenced by any colour effect: load them once (the bake reads them synchronously).
			const luts = new Map<string, Lut | null>();
			const clips = snap.videoTracks.flatMap((t) => t.clips);
			for (const c of clips) {
				for (const id of lutRefs(c)) {
					if (luts.has(id)) continue;
					const local = planned.media[id];
					const asset = planned.document.media[id];
					const lut = local && asset ? await loadAsset(local.path, asset.fingerprint) : null;
					luts.set(id, lut);
					if (!lut) out.offlineLuts.push(id);
				}
			}
			if (out.offlineLuts.length)
				ctx.log(`LUT_OFFLINE: ${out.offlineLuts.length} LUT asset(s) offline; the grades skip them`);
			const lutKey = (id: string) => {
				const l = luts.get(id);
				return l ? (planned.document.media[id]?.fingerprint ?? id) : `offline:${id}`;
			};
			const colorCtx = { lut: (id: string) => luts.get(id) ?? null };
			const bakes = new Map<string, Promise<string | null>>();

			for (const c of clips) {
				if (!c.effects.some((fx) => fx.enabled && registry.get(fx.effectId, fx.effectVersion)?.color))
					continue;
				const f0 = Math.max(c.start - (c.headHandle ?? 0), R0);
				const f1 = Math.min(c.start + c.duration + (c.tailHandle ?? 0), R1);
				if (f1 <= f0) continue;
				const staticRuns = effectRuns(c.effects, registry);
				const perRun = new Map<string, LutWindow[]>();
				for (const run of staticRuns) {
					if (run.kind !== 'color') continue;
					const first = run.effects[0]!.id;
					// Lattice size: 33, or an imported LUT's size when it is larger (cap 65).
					let size = EXPORT_LUT_SIZE;
					for (const fx of run.effects)
						for (const a of Object.values(fx.params)) {
							const id = (a.value as { mediaId?: unknown } | null)?.mediaId;
							const l = typeof id === 'string' ? luts.get(id) : null;
							if (l?.dimensions === 3) size = Math.max(size, Math.min(MAX_EXPORT_LUT_SIZE, l.size));
						}
					const animated = run.effects.some(hasKeyframes);
					const stateAt = (f: number): RunState => {
						const t = clipContentTime(c, f, fps);
						const effects: ColorRunEffect[] = run.effects.map((fx) => ({
							id: fx.id,
							effectId: fx.effectId,
							effectVersion: fx.effectVersion,
							enabled: true,
							params: Object.fromEntries(
								Object.entries(fx.params).map(([k, a]) => [k, evaluate(a, t) as ParamValue]),
							),
						}));
						return { effects, key: colorRunKey(effects, lutKey, size) };
					};
					let states: { start: number; end: number; value: RunState }[];
					if (!animated) states = [{ start: f0, end: f1, value: stateAt(f0) }];
					else {
						let q = 1;
						for (;;) {
							const step = q;
							states = sampleRuns(
								f0,
								f1,
								(f) => stateAt(f0 + Math.floor((f - f0) / step) * step),
								(s) => s.key,
							);
							if (states.length <= MAX_LUTS_PER_LAYER) break;
							q *= 2;
						}
						if (q > 1)
							ctx.log(
								`[color] clip ${c.clipId}: grade quantised to every ${q} frames (${states.length} LUTs)`,
							);
					}
					const windows: LutWindow[] = [];
					for (const s of states) {
						let p = bakes.get(s.value.key);
						if (!p) {
							const state = s.value;
							p = (async () => {
								const known = memo.get(state.key);
								if (known && (await pin(known))) {
									out.reused++;
									return known;
								}
								const lut = bakeColorRun(state.effects, registry, colorCtx, size);
								if (!lut) return null;
								const file = await writeLut(cubeText(lut), pin, out);
								remember(state.key, file);
								return file;
							})();
							bakes.set(state.key, p);
						}
						windows.push({ start: s.start, end: s.end, file: await p });
					}
					perRun.set(first, windows);
				}
				out.layers.set(c.clipId, perRun);
			}
			out.baked = bakes.size;
			const files = new Set<string>();
			for (const p of bakes.values()) {
				const f = await p;
				if (f) files.add(f);
			}
			out.files = files.size;
			if (out.baked > 1)
				ctx.log(
					`[color] ${out.baked} grade states → ${out.files} LUT files (${out.written} written, ${out.existing} existing, ${out.reused} remembered)`,
				);
			return out;
		},

		effectFilter(fx: ResolvedEffect, ctx: EffectFilterContext): string | undefined {
			const spec = registry.get(fx.effectId, fx.effectVersion);
			if (!spec?.color) return undefined;
			const prepared = ctx.prepared as ColorPrepared | undefined;
			const run = effectRuns(ctx.effects, registry).find(
				(r) => r.kind === 'color' && r.effects.some((e) => e.id === fx.id),
			);
			if (run?.kind !== 'color' || run.effects[0]!.id !== fx.id) return '';
			const windows = prepared?.layers.get(ctx.clip.clipId)?.get(fx.id);
			if (!windows) {
				opts.log?.(`[color] no prepared LUT for ${ctx.clip.clipId}/${fx.id}; the grade is skipped`);
				return '';
			}
			const live = windows.filter((w) => w.file && w.end > ctx.f0 && w.start < ctx.f1);
			if (live.length === 0) return '';
			const lut3d = (file: string) => `lut3d=file=${quoteFilterPath(file)}:interp=tetrahedral`;
			if (live.length === 1 && live[0]!.start <= ctx.f0 && live[0]!.end >= ctx.f1)
				return lut3d(live[0]!.file!);
			// Frame numbers `n` count from the layer's first drawn frame (f0).
			const parts = live.map((w) => {
				const a = Math.max(w.start, ctx.f0) - ctx.f0;
				const b = Math.min(w.end, ctx.f1) - 1 - ctx.f0;
				return `${lut3d(w.file!)}:enable='between(n,${a},${b})'`;
			});
			return parts.join(',');
		},
	};
}
