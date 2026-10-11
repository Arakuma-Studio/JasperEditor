// Video layers whose frames are chosen by
// media time — reverse, Time Remapping, Frame Blending / Optical Flow (speed changes, remaps, frame-rate conform) and
// variable-frame-rate media (timestamp-exact) — stay on the native path. `prepare` renders each one into a
// layer-sized lossless intermediate (FFV1, cached under `<appdir>/cache/retime/<key>.mkv`) with exactly the frames
// the preview shows (same frame choice, same optical flow algorithm), and `override` hands it to the builder as the
// clip's `layer` source: effects, Motion, opacity, masks and transitions then apply as for any video layer.
import { createHash } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { pixelVariantKey, type RenderVisualClip } from '@jasper/project';
import { decoderArgs, sourceFilters } from '../../imports/decode.ts';
import { JobError } from '../../jobs/types.ts';
import { alphaDecoder } from '../../media/alpha.ts';
import type { Ffmpeg } from '../../tools/ffmpeg.ts';
import { inColor, SWS_FLAGS } from '../native.ts';
import type { LayerOverride, NativeExtension, NativePrepareContext } from '../native-ext.ts';
import type { PlannedExport } from '../planner.ts';
import { ChunkedFrames, cachedFrameTimes } from './frames.ts';
import { planRetime } from './plan.ts';
import { FlowPool } from './pool.ts';
import { RetimeRenderError, renderRetimeLayer } from './render.ts';

const RETIME_EXTENSION_ID = 'retime';
/** Bumped whenever the intermediate's pixels would change for the same inputs (algorithm, encoder). */
const RETIME_VERSION = 1;

type RetimePrepared = ReadonlyMap<string, { path: string; startFrame: number }>;

export type RetimeDeps = {
	ffmpeg: Ffmpeg;
	/** `<appdir>/cache/retime`. */
	cacheDir: string;
	/** All registered extensions (a layer another extension bakes whole is not retimed here). */
	getExtensions(): readonly NativeExtension[];
	threads?: number;
	log?(msg: string): void;
};

/** Video layers this extension renders (the snapshot marks them `retime`). */
function retimeClaims(c: RenderVisualClip): boolean {
	return c.kind === 'video' && !!c.retime && 'mediaId' in c.source;
}

function layerSpan(c: RenderVisualClip, range: { start: number; end: number }): [number, number] {
	return [
		Math.max(c.start - (c.headHandle ?? 0), range.start),
		Math.min(c.start + c.duration + (c.tailHandle ?? 0), range.end),
	];
}

export function createRetimeExtension(deps: RetimeDeps): NativeExtension {
	const threads = Math.max(1, deps.threads ?? availableParallelism());
	const bakedElsewhere = (c: RenderVisualClip) =>
		deps.getExtensions().some((e) => e.id !== RETIME_EXTENSION_ID && (e.bakes?.(c) ?? null) !== null);

	async function prepareClip(
		c: RenderVisualClip,
		planned: PlannedExport,
		ctx: NativePrepareContext,
		pool: () => FlowPool,
		index: number,
		count: number,
	): Promise<{ path: string; startFrame: number } | null> {
		if (!('mediaId' in c.source)) return null;
		const local = planned.media[c.source.mediaId];
		if (!local) return null; // offline: the builder draws the offline card
		const fps = planned.snapshot.settings.fps;
		const [f0, f1] = layerSpan(c, planned.range);
		if (f1 <= f0) return null;
		const fp = `${local.record.fingerprint}|${local.record.sizeBytes}|${local.record.mtimeMs}`;
		const times = await cachedFrameTimes(
			deps.ffmpeg,
			local.path,
			deps.cacheDir,
			createHash('sha256').update(fp).digest('hex').slice(0, 32),
			{ signal: ctx.signal },
		);
		const plan = planRetime(c, f0, f1, fps, times);
		const width = Math.max(1, Math.round(c.intrinsicBox.width));
		const height = Math.max(1, Math.round(c.intrinsicBox.height));
		const scaleOptions = `${inColor(local)}:${SWS_FLAGS}`;
		const decoder = alphaDecoder(local.record.probe);
		const key = createHash('sha256')
			.update(
				JSON.stringify({
					v: RETIME_VERSION,
					media: fp,
					size: [width, height],
					scaleOptions,
					pixel: pixelVariantKey(local.pixel ?? null),
					fps,
					mode: plan.interpolation,
					frames: plan.frames.map((f) => [f.a, f.b, Math.round(f.w * 1e6)]),
				}),
			)
			.digest('hex')
			.slice(0, 40);
		const path = join(deps.cacheDir, `${key}.mkv`);
		const present = ctx.pin ? await ctx.pin(path) : true;
		try {
			if (present && (await stat(path)).size > 0) {
				ctx.log(`retime: ${c.clipId} reused ${path}`);
				return { path, startFrame: f0 };
			}
		} catch {
			// not cached
		}
		await mkdir(deps.cacheDir, { recursive: true });
		const stage = `Retiming layer ${index}/${count}${plan.interpolation === 'optical-flow' ? ' (optical flow)' : ''}`;
		ctx.stage(stage);
		const started = Date.now();
		const frames = new ChunkedFrames(
			deps.ffmpeg,
			{
				file: local.path,
				times: times.kind === 'list' ? Array.from(times.times) : [],
				width,
				height,
				scaleOptions,
				decoder,
				// imports (Interpret Footage): the same source chain as the builder.
				pre: decoderArgs(local.record),
				filters: sourceFilters(local.record, local.pixel),
			},
			ctx.signal,
		);
		let lastPct = -1;
		try {
			await renderRetimeLayer(deps.ffmpeg, {
				plan,
				frames,
				width,
				height,
				fps,
				output: path,
				pool: plan.interpolation === 'optical-flow' ? pool() : null,
				signal: ctx.signal,
				threads: Math.max(1, Math.min(8, threads)),
				onProgress: (done, total) => {
					const pct = Math.floor((done / total) * 100);
					if (pct >= lastPct + 5) {
						lastPct = pct;
						ctx.stage(`${stage} · ${pct}%`);
					}
				},
			});
		} catch (e) {
			if (e instanceof RetimeRenderError)
				throw new JobError(e.code, e.message, e.code !== 'JOB_CANCELLED' ? true : undefined);
			throw e;
		} finally {
			frames.dispose();
		}
		const ms = Date.now() - started;
		const msg = `retime: ${c.clipId} ${plan.frames.length} frames (${plan.interpolation}, ${frames.decodedFrames} decoded) in ${ms} ms → ${path}`;
		ctx.log(msg);
		deps.log?.(msg);
		return { path, startFrame: f0 };
	}

	return {
		id: RETIME_EXTENSION_ID,
		retimes: retimeClaims,
		async prepare(planned, ctx): Promise<RetimePrepared> {
			const out = new Map<string, { path: string; startFrame: number }>();
			// Nested sequences are prepared separately by prepareNestedExtensions.
			const clips = planned.snapshot.videoTracks
				.flatMap((t) => t.clips)
				.filter((c) => retimeClaims(c) && !bakedElsewhere(c));
			let flow: FlowPool | null = null;
			const pool = () => {
				flow ??= new FlowPool(Math.max(1, Math.min(8, threads - 1)));
				return flow;
			};
			try {
				for (const [i, c] of clips.entries()) {
					if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
					const r = await prepareClip(c, planned, ctx, pool, i + 1, clips.length);
					if (r) out.set(c.clipId, r);
				}
			} finally {
				await (flow as FlowPool | null)?.close();
			}
			return out;
		},
		override(clip, prepared): LayerOverride | null {
			const p = (prepared as RetimePrepared | undefined)?.get(clip.clipId);
			return p ? { path: p.path, space: 'layer', startFrame: p.startFrame, retimed: true } : null;
		},
	};
}
