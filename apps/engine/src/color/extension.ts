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
export const MAX_LUTS_PER_LAYER = 240;
/** Added to every baked table value so `lut3d`'s truncating 8-bit store rounds to nearest (see above). */
export const EXPORT_ROUNDING_BIAS = 0.5 / 255;
/** Largest lattice used for export bakes when a run references a bigger imported LUT (S06:CG-012). */
export const MAX_EXPORT_LUT_SIZE = 65;
/** Filters the shipped LGPL FFmpeg does not contain (ARCHITECTURE D-13 M2 note); never in generated text. */
export const GPL_FILTERS = [
	'eq',
	'hqdn3d',
	'perspective',
	'boxblur',
	'smartblur',
	'delogo',
	'frei0r',
	'spp',
	'pp7',
	'uspp',
	'fspp',
	'mpdecimate',
	'pullup',
] as const;

/** GPL filter names used in a filtergraph text (tests: CG-054). */
export function gplFiltersIn(filter: string): string[] {
	const used = new Set<string>();
	for (const m of filter.matchAll(/(?:^|[,;\]\s])([a-z0-9_]+)(?==|,|;|\[|$)/gim))
		used.add(m[1]!.toLowerCase());
	return GPL_FILTERS.filter((f) => used.has(f));
}

export type LutWindow = {
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
	/** Distinct baked LUTs (tests / logs). */
	baked: number;
};

export type ColorExtensionOptions = {
	/** `<appdir>/cache/luts` */
	lutCacheDir: string;
	effects?: EffectRegistry;
	log?(msg: string): void;
};

type RunState = { effects: ColorRunEffect[]; key: string };

const hasKeyframes = (fx: RenderVisualClip['effects'][number]) =>
	Object.values(fx.params).some((a) => a.keyframes.length > 0);

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

	/** Writes a baked LUT once (content-addressed by the run key + the 8-bit rounding variant). */
	const writeLut = (key: string, lut: Lut): Promise<string> => {
		const name = `${createHash('sha256').update(`u8r:${key}`).digest('hex')}.cube`;
		const file = join(opts.lutCacheDir, name);
		let p = writes.get(file);
		if (!p) {
			p = (async () => {
				if (await exists(file)) return file;
				await mkdir(opts.lutCacheDir, { recursive: true });
				const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.partial`;
				const data = lut.data.map((v) => v + EXPORT_ROUNDING_BIAS);
				await writeFile(
					tmp,
					serializeCube({ ...lut, data, title: 'JasperEditor colour run (8-bit rounding)' }),
				);
				await rename(tmp, file);
				return file;
			})().finally(() => writes.delete(file));
			writes.set(file, p);
		}
		return p;
	};

	return {
		id: 'color',
		effectSupport: (_effectId, spec) => (spec?.color ? 'animated' : false),

		async prepare(planned: PlannedExport, ctx): Promise<ColorPrepared> {
			const snap = planned.snapshot;
			const fps = snap.settings.fps;
			const R0 = snap.range.start;
			const R1 = snap.range.end;
			const out: ColorPrepared = { layers: new Map(), offlineLuts: [], baked: 0 };

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
							const lut = bakeColorRun(s.value.effects, registry, colorCtx, size);
							p = lut ? writeLut(s.value.key, lut) : Promise.resolve(null);
							bakes.set(s.value.key, p);
						}
						windows.push({ start: s.start, end: s.end, file: await p });
					}
					perRun.set(first, windows);
				}
				out.layers.set(c.clipId, perRun);
			}
			out.baked = bakes.size;
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
