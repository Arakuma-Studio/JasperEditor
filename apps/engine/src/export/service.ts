// Export and still jobs (ARCHITECTURE §9.5, S04 §10–§13): plan → native filtergraph (ffmpeg) or Remotion
// `renderMedia`; outputs in `<appdir>/renders/<jobId>/`; frame-count verification (FRAME_COUNT_MISMATCH);
// progress mapping (S04:RN-030); `export.finished` event. Motion-graphic masters come from a provider that
// WP-2G registers (`registerMgMasterProvider`).

import type { ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
	copyFile,
	type FileHandle,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
	type EngineJob,
	type ExportResult,
	type ExportSettings,
	type ExportStartRequest,
	STILL_FORMAT_EXTENSIONS,
	type StillRequest,
} from '@jasper/api';
import {
	buildRenderSnapshot,
	copyableRuns,
	type MediaHandle,
	mediaDecodeHints,
	type RenderVisualClip,
	rotoStorePath,
	writeCaptionFile,
} from '@jasper/project';
import { hasSoxr, resamplerArgs } from '../audio/decode.ts';
import { layoutOf, type MixdownResult, renderMixdown } from '../audio/mixdown.ts';
import type { UrlSigner } from '../auth/signed-url.ts';
import type { CacheService } from '../cache/service.ts';
import { writeHdrBoxes } from '../color/hdr-boxes.ts';
import {
	colorTagArgs,
	displayLutFilter,
	isPlainRec709Output,
	MASTERING_PRIMARIES,
	outputFilters,
	outputLutFilter,
	svtHdrParams,
} from '../color/output.ts';
import type { Broadcaster } from '../events/broadcaster.ts';
import type { FontCatalogService } from '../fonts/catalog.ts';
import type { JobQueue } from '../jobs/queue.ts';
import { type JobContext, JobError } from '../jobs/types.ts';
import type { MediaRegistry } from '../media/registry.ts';
import { appendEncoderArgs, planRemotionExport } from '../remotion/export-plan.ts';
import type { RemotionService } from '../remotion/service.ts';
import { audioEncodeArgs, type EncoderService, videoEncodeArgs } from '../tools/encoders.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { exists, randomId } from '../tools/fs.ts';
import { terminateTree } from '../tools/process.ts';
import { runBlendPipeline } from './blend/run.ts';
import {
	embedArgs,
	embeddedTracks,
	sidecarBytes,
	sidecarName,
	sidecarTracks,
	subtitleCodecFor,
} from './captions.ts';
import { BT709_FRAME_TAGS, buildNativeGraph, SWS_FLAGS } from './native.ts';
import {
	layerOverride,
	type NativeExtension,
	NativeExtensionRegistry,
	type PreparedExtensions,
	prepareExtensions,
	prepareNestedExtensions,
} from './native-ext.ts';
import {
	assertFrameSize,
	audioCodecOf,
	isAnimeTemplate,
	mediaKeyOf,
	type PlanCapabilities,
	PlanError,
	type PlannedExport,
	planExport,
} from './planner.ts';
import {
	probeSourceFrames,
	proresProfileMatches,
	SOURCE_CODECS,
	type SourceFrames,
	smartCodecOf,
	smartPieces,
} from './smart.ts';
import { convertStill, stillCurveFor } from './still-formats.ts';
import { streamLayer } from './stream/run.ts';
import { createSyntheticExtension } from './synthetic.ts';
import { concatFilter, type ExportRun, exportRuns, type PreviewPiece } from './use-previews.ts';

/**
 * A native extension's `prepare` failed (S11:LBK-023): an `auto` export or still falls back to the Remotion path
 * when that path is eligible; a forced `native` one fails with the cause.
 */
class NativePrepareError extends Error {
	constructor(readonly failure: unknown) {
		super((failure as Error)?.message ?? String(failure));
		this.name = 'NativePrepareError';
	}
}

/** edit-structure: what the Remotion-path extensions prepared for nested sequences, per top-level preparation. */
const NESTED_REMOTION = new WeakMap<ReadonlyMap<string, unknown>, Map<string, PreparedExtensions>>();

/** Remotion concurrency of an export with `slots` CPU slots (S04:RR-004; bakes follow it, S11:LBK-022). */
function remotionConcurrency(slots: number): number {
	return Math.max(1, Math.min(slots, Math.floor(availableParallelism() / 2)));
}

export type MgMasterRequest = {
	clip: RenderVisualClip;
	fps: { num: number; den: number };
	sequence: { width: number; height: number };
	projectId?: string;
	/** The export/still job that needs the master (its mg-render job is shown as a child). */
	parentId?: string;
	signal: AbortSignal;
};
/**
 * Returns the path of a cached (or freshly rendered) straight-alpha ProRes 4444 master whose frame 0 is the
 * clip's first frame and whose size is the clip canvas, or null when fframes cannot render it.
 */
export type MgMasterProvider = (req: MgMasterRequest) => Promise<string | null>;

/** previews: the render previews of a document's sequence (full size, current format), or why there are none. */
export type PreviewSource = (
	doc: PlannedExport['document'],
	sequenceId: string,
) => Promise<{ pieces: PreviewPiece[] } | { reason: string }>;

type StoredRequest =
	| { kind: 'export'; request: ExportStartRequest }
	| { kind: 'still'; request: StillRequest };

const JOB_ID_RE = /^job_[0-9a-f]{16}$/;

/** Same retention as the job journal (S04:JB-030: 7 days): older jobs cannot be retried anyway. */
const REQUEST_RETENTION_MS = 7 * 24 * 3600 * 1000;

type ExportServiceDeps = {
	rendersDir: string;
	ff: Ffmpeg;
	/** Encoder selection (D-13); absent = libx264 (legacy/tests). */
	encoders?: EncoderService;
	queue: JobQueue;
	registry: MediaRegistry;
	fonts: FontCatalogService;
	remotion: RemotionService;
	broadcaster: Broadcaster;
	signer: UrlSigner;
	/** Engine origin for signed absolute URLs, e.g. `http://127.0.0.1:47900`. */
	origin(): string;
	/** Local/dev mode: exports may be copied to a client-chosen path (S04:SC-002). */
	localMode: boolean;
	capabilities(): Promise<PlanCapabilities>;
};

export class ExportService {
	private mgProvider: MgMasterProvider | null = null;
	/** M2 native extensions (ARCHITECTURE §19.6). */
	readonly nativeExtensions = new NativeExtensionRegistry();
	/**
	 * M3 (wp-m3-cachegc): the cache registry. Exports and stills pin every cache file they read for the job's
	 * lifetime and record them as used by their project (`export:<projectId>:<sequenceId>`, CA-012/CA-016).
	 */
	cache: CacheService | null = null;

	/** parity (roto): matte-set lookup of the roto service (registered by its routes). */
	private rotoSet: ((key: string) => Promise<{ start: number; end: number } | null>) | null = null;
	registerRotoSets(fn: (key: string) => Promise<{ start: number; end: number } | null>): void {
		this.rotoSet = fn;
	}

	constructor(private readonly deps: ExportServiceDeps) {
		// edit-structure: Bars and Tone / counting leader pictures and tones (always available: ffmpeg only).
		this.nativeExtensions.register(createSyntheticExtension({ ffmpeg: deps.ff }));
	}

	/** M2 hook: colour (LUT), motion-graphics pre-renders, warp stage… keep features on the native path. */
	registerNativeExtension(ext: NativeExtension): () => void {
		return this.nativeExtensions.register(ext);
	}

	/** WP-2G hook: motion-graphic masters for the native path. */
	registerMgMasterProvider(fn: MgMasterProvider | null): void {
		this.mgProvider = fn;
	}

	get hasMgMasterProvider(): boolean {
		return this.mgProvider !== null;
	}

	registerRunners(): void {
		this.deps.queue.registerRunner('export', (ctx) =>
			this.withRequestCleanup(ctx, () => this.runExport(ctx)),
		);
		this.deps.queue.registerRunner('still', (ctx) => this.withRequestCleanup(ctx, () => this.runStill(ctx)));
	}

	/**
	 * Stored requests are removed when the job succeeds (runners) or fails for good (here). Retryable failures
	 * and cancellations keep theirs: `POST /api/jobs/:id/retry` re-runs the same input. `sweepRequests()`
	 * removes those once they are older than the job journal's retention.
	 */
	private async withRequestCleanup(ctx: JobContext, run: () => Promise<unknown>): Promise<unknown> {
		try {
			return await run();
		} catch (e) {
			const file = (ctx.input as { request?: unknown } | undefined)?.request;
			const final = e instanceof JobError && e.retryable === false && !ctx.signal.aborted;
			if (final && typeof file === 'string') await rm(file, { force: true }).catch(() => {});
			throw e;
		}
	}

	/** Removes stored render requests older than `maxAgeMs` (default: the 7-day job journal retention). */
	async sweepRequests(maxAgeMs = REQUEST_RETENTION_MS, now = Date.now()): Promise<number> {
		const dir = join(this.deps.rendersDir, '.requests');
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			return 0;
		}
		let removed = 0;
		for (const name of names) {
			if (!name.endsWith('.json')) continue;
			const file = join(dir, name);
			try {
				if (now - (await stat(file)).mtimeMs > maxAgeMs) {
					await rm(file, { force: true });
					removed++;
				}
			} catch {
				// raced with a runner removing it
			}
		}
		return removed;
	}

	async plan(req: {
		envelope: { revision: number; document: unknown };
		sequenceId: string;
		settings: ExportSettings;
	}): Promise<PlannedExport> {
		const caps = await this.deps.capabilities();
		const planned = await planExport(
			{
				envelope: req.envelope,
				sequenceId: req.sequenceId,
				settings: { ...req.settings, sequenceId: req.sequenceId },
			},
			this.planDeps(caps),
		);
		if (req.settings.usePreviews) await this.attachPreviews(planned, req.settings);
		if (!planned.previews) await this.attachSmart(planned, req.settings);
		return planned;
	}

	/**
	 * Smart rendering: with the `auto` engine and an H.264 / ProRes export matching its sources, the plan copies the
	 * whole closed GOPs of stretches that show a source untouched and renders the rest; otherwise `plan.smart.reasons`
	 * says why not.
	 */
	private async attachSmart(planned: PlannedExport, settings: ExportSettings): Promise<void> {
		const reasons: string[] = [];
		const o = planned.output;
		const seq = planned.snapshot.settings;
		const codec = smartCodecOf(settings);
		if (settings.smartRender === false) reasons.push('Smart rendering is off for this export');
		if (planned.draftProxies?.length) reasons.push('The export renders from proxies (Use Proxies)');
		if (settings.engine !== 'auto')
			reasons.push(`The ${settings.engine} engine was chosen (smart rendering runs with Auto)`);
		if (!codec)
			reasons.push(
				`${settings.video?.codec ?? 'This'} exports are always encoded (H.264 and ProRes exports can copy their sources)`,
			);
		else if (!o.encoder || o.encoder.codec !== codec)
			reasons.push(`No ${codec} encoder is available for the frames around the copied stretches`);
		if (settings.container === 'webm') reasons.push('WebM exports are always encoded');
		if (o.width !== seq.width || o.height !== seq.height)
			reasons.push('The export frame size differs from the sequence');
		if (o.fps.num * seq.fps.den !== seq.fps.num * o.fps.den)
			reasons.push('The export frame rate differs from the sequence');
		if (o.alpha) reasons.push('Alpha masters are always rendered');
		if (o.color?.converts || o.color?.hdr)
			reasons.push('The export converts colours (Colour Space / HDR): every frame is encoded');
		if (codec === 'h264' && o.color && o.color.bitDepth !== 8)
			reasons.push('H.264 smart rendering copies 8-bit streams');
		if (o.gop) reasons.push('A keyframe interval was requested: every frame is encoded');
		if (reasons.length) {
			planned.plan.smart = { used: false, copiedFrames: 0, reasons };
			return;
		}
		// H.264 copies keep the sources' own bitrate and profile next to the encoder's frames: the user opts in.
		const optIn = codec === 'h264' && settings.smartRender !== true;
		const runs = copyableRuns(planned.document, planned.sequenceId, planned.range);
		const frames = new Map<string, SourceFrames>();
		const usable: typeof runs = [];
		for (const r of runs) {
			const local = planned.media[r.mediaId];
			if (!local) continue;
			let src: SourceFrames;
			try {
				src = await probeSourceFrames(
					this.deps.ff,
					local.path,
					`${local.record.sizeBytes}:${local.record.mtimeMs}`,
				);
			} catch {
				reasons.push(`${local.record.originalName}: its packets could not be read`);
				continue;
			}
			const name = local.record.originalName;
			if (src.codec !== SOURCE_CODECS[codec!]) {
				reasons.push(`${name} is ${src.codec}, the export is ${codec}`);
				continue;
			}
			if (src.width !== seq.width || src.height !== seq.height) {
				reasons.push(`${name} is not at the sequence frame size`);
				continue;
			}
			if (codec === 'h264' && src.pixFmt !== 'yuv420p') {
				reasons.push(`${name} is ${src.pixFmt ?? 'an unknown pixel format'}; H.264 exports are 8-bit 4:2:0`);
				continue;
			}
			if (codec === 'prores' && !proresProfileMatches(o.proresProfile, src.profile)) {
				reasons.push(
					`${name} is ProRes ${src.profile ?? '?'}, the export ProRes ${o.proresProfile === '4444' ? '4444' : '422 HQ'}`,
				);
				continue;
			}
			frames.set(r.mediaId, src);
			usable.push(r);
		}
		if (runs.length === 0)
			reasons.push(
				'No stretch shows a source untouched at the sequence frame size and rate (effects, Motion, transitions, speed or other layers need encoding)',
			);
		const pieces = smartPieces(planned.range, usable, (id) => frames.get(id));
		const copied = pieces.filter((p) => p.kind === 'copy').reduce((n, p) => n + p.end - p.start, 0);
		if (copied === 0) {
			if (usable.length)
				reasons.push('No whole closed GOP of the sources lies inside the copyable stretches');
			planned.plan.smart = { used: false, copiedFrames: 0, reasons };
			return;
		}
		if (optIn) {
			planned.plan.smart = {
				used: false,
				copiedFrames: 0,
				reasons: [
					...reasons,
					`Smart rendering is opt-in for H.264 exports (Smart Render): it would copy ${copied} of ${planned.range.end - planned.range.start} frames`,
				],
			};
			return;
		}
		planned.smart = { codec: codec!, pieces };
		planned.plan.path = 'copy';
		const renderMode = planned.plan.segments[0]?.mode ?? 'native';
		planned.plan.segments = pieces.map((p) => ({
			startFrame: p.start,
			endFrame: p.end,
			mode: p.kind === 'copy' ? 'copy' : renderMode,
			graphicsGroups: p.kind === 'copy' ? [] : (planned.plan.segments[0]?.graphicsGroups ?? []),
		}));
		planned.plan.smart = { used: true, copiedFrames: copied, reasons };
		planned.plan.warnings.push({
			code: 'SMART_RENDER',
			message: `${copied} of ${planned.range.end - planned.range.start} frames are copied from the sources without re-encoding`,
		});
	}

	/** Smart rendering: copies the closed GOPs, renders the rest with the export's path, joins them seamlessly. */
	private async renderSmart(
		ctx: JobContext,
		req: ExportStartRequest,
		planned: PlannedExport,
		output: string,
		smart: NonNullable<PlannedExport['smart']>,
	): Promise<{
		planned: PlannedExport;
		frames: number;
		path: 'copy' | 'native' | 'hybrid' | 'remotion';
		remotionOutput: 'direct' | 'intermediate' | undefined;
		warnings: { code: string; message: string }[];
		audio: MixdownResult | null;
	}> {
		const o = planned.output;
		const audio = o.videoOnly ? null : await this.renderAudio(planned, ctx);
		const scratch = await ctx.scratchDir();
		const ext = smart.codec === 'prores' ? 'mov' : 'mp4';
		const total = Math.max(1, planned.range.end - planned.range.start);
		const files: string[] = [];
		const warnings: { code: string; message: string }[] = [];
		let done = 0;
		for (const [i, p] of smart.pieces.entries()) {
			const n = p.end - p.start;
			const file = join(scratch, `piece-${i}.${ext}`);
			if (p.kind === 'copy') {
				const local = planned.media[p.mediaId]!;
				const src = await probeSourceFrames(
					this.deps.ff,
					local.path,
					`${local.record.sizeBytes}:${local.record.mtimeMs}`,
				);
				// Input seeking with stream copy starts at the keyframe at or before the time: a quarter frame into the
				// GOP's first frame lands on its own keyframe; timestamps restart at 0 for the join.
				const t = (src.times[p.sourceFrame] ?? 0) + (0.25 * o.fps.den) / o.fps.num;
				const args = [
					'-y',
					'-ss',
					t.toFixed(6),
					'-i',
					local.path,
					'-map',
					'0:v:0',
					'-c:v',
					'copy',
					'-frames:v',
					String(n),
					'-an',
					'-sn',
					'-dn',
					'-avoid_negative_ts',
					'make_zero',
					'-f',
					ext === 'mov' ? 'mov' : 'mp4',
					file,
				];
				ctx.log(`ffmpeg ${args.join(' ')}`);
				ctx.progress((done / total) * 0.95, { stage: `Copying frames ${p.start}–${p.end}` });
				await this.deps.ff.run(args, { signal: ctx.signal, onSpawn: ctx.trackChild });
				const count = await this.deps.ff.countVideoFrames(file, { signal: ctx.signal });
				if (count !== n)
					throw new JobError(
						'SMART_COPY_MISMATCH',
						`Copied ${count} frames of ${local.record.originalName}, expected ${n}`,
						true,
					);
			} else {
				const sub: JobContext = {
					...ctx,
					progress: (v, extra) =>
						ctx.progress(((done + (v ?? 0) * n) / total) * 0.95, {
							...extra,
							stage: `Encoding frames ${p.start}–${p.end} · ${extra?.stage ?? ''}`,
						}),
				};
				const r = await this.renderToFile(
					sub,
					{
						...req,
						settings: {
							...req.settings,
							smartRender: false,
							usePreviews: false,
							videoOnly: true,
							container: ext,
							range: { type: 'custom', startFrame: p.start, endFrame: p.end },
						},
					},
					file,
					{ noBFrames: smart.codec === 'h264' },
				);
				warnings.push(...r.warnings.filter((w) => w.code !== 'SMART_RENDER'));
			}
			files.push(file);
			done += n;
		}
		ctx.progress(0.96, { stage: 'Joining copied and encoded frames' });
		const soxr = await hasSoxr(this.deps.ff);
		// Exports always carry a sound stream (silence when nothing is heard), as the native path does.
		const layout = o.audioChannels === 1 ? 'mono' : o.audioChannels === 6 ? '5.1' : 'stereo';
		const audioInput = o.videoOnly
			? []
			: audio?.path
				? ['-i', audio.path]
				: [
						'-f',
						'lavfi',
						'-t',
						o.durationSec.toFixed(6),
						'-i',
						`anullsrc=r=${o.audioSampleRate}:cl=${layout}`,
					];
		const audioArgs = (input: number): string[] =>
			!o.videoOnly
				? [
						'-map',
						`${input}:a:0`,
						...(audio?.path && audio.sampleRate !== o.audioSampleRate
							? ['-af', `aresample=${o.audioSampleRate}:${resamplerArgs(soxr)}`]
							: []),
						...audioEncodeArgs(audioCodecOf(o.encoder, o), o.audioBitrateKbps, o.audioChannels),
						'-ar',
						String(o.audioSampleRate),
						'-ac',
						String(o.audioChannels),
					]
				: ['-an'];
		const rate = `${o.fps.num}/${o.fps.den}`;
		let args: string[];
		if (smart.codec === 'prores') {
			const list = join(scratch, 'pieces.txt');
			await writeFile(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
			args = [
				'-y',
				'-f',
				'concat',
				'-safe',
				'0',
				'-i',
				list,
				...audioInput,
				'-map',
				'0:v:0',
				'-c:v',
				'copy',
				...audioArgs(1),
				'-frames:v',
				String(o.frames),
				'-f',
				'mov',
				output,
			];
		} else {
			// One Annex B stream: every IDR carries its own SPS/PPS (copied GOPs the source's, encoded ones the encoder's).
			const joined = join(scratch, 'joined.h264');
			const handle = await open(joined, 'w');
			try {
				for (const [i, f] of files.entries()) {
					const raw = join(scratch, `piece-${i}.h264`);
					await this.deps.ff.run(
						['-y', '-i', f, '-map', '0:v:0', '-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', raw],
						{
							signal: ctx.signal,
							onSpawn: ctx.trackChild,
						},
					);
					await handle.writeFile(await readFile(raw));
					await rm(raw, { force: true });
				}
			} finally {
				await handle.close();
			}
			// The raw stream has no timestamps: mux the picture first (CFR at the export rate), then the sound with it.
			const video = join(scratch, `joined.${o.encoder?.container === 'mov' ? 'mov' : 'mp4'}`);
			const vargs = [
				'-y',
				'-fflags',
				'+genpts',
				'-r',
				rate,
				'-f',
				'h264',
				'-i',
				joined,
				'-map',
				'0:v:0',
				'-c:v',
				'copy',
				'-tag:v',
				'avc3',
				'-frames:v',
				String(o.frames),
				video,
			];
			ctx.log(`ffmpeg ${vargs.join(' ')}`);
			await this.deps.ff.run(vargs, { signal: ctx.signal, onSpawn: ctx.trackChild });
			args = [
				'-y',
				'-i',
				video,
				...audioInput,
				'-map',
				'0:v:0',
				'-c:v',
				'copy',
				'-tag:v',
				'avc3',
				...audioArgs(1),
				...(o.color
					? colorTagArgs(o.color)
					: [
							'-colorspace',
							'bt709',
							'-color_primaries',
							'bt709',
							'-color_trc',
							'bt709',
							'-color_range',
							'tv',
						]),
				...(o.encoder?.container !== 'webm' ? ['-movflags', '+faststart'] : []),
				'-f',
				o.encoder?.container === 'mov' ? 'mov' : 'mp4',
				output,
			];
		}
		ctx.log(`ffmpeg ${args.join(' ')}`);
		await this.deps.ff.run(args, { signal: ctx.signal, onSpawn: ctx.trackChild });
		const count = await this.deps.ff.countVideoFrames(output, { signal: ctx.signal });
		if (count !== o.frames)
			throw new JobError(
				'FRAME_COUNT_MISMATCH',
				`Expected ${o.frames} frames, the output has ${count}`,
				true,
				{
					expected: o.frames,
					actual: count,
				},
			);
		return { planned, frames: count, path: 'copy', remotionOutput: undefined, warnings, audio };
	}

	private previewSource: PreviewSource | null = null;
	/** previews: where an export finds the render previews of a document (the preview service registers it). */
	registerPreviewSource(fn: PreviewSource | null): void {
		this.previewSource = fn;
	}

	/** Use Previews: which stretches of the range come from preview files (plan segments + a warning say so). */
	private async attachPreviews(planned: PlannedExport, settings: ExportSettings): Promise<void> {
		const warn = (message: string): void => {
			planned.plan.warnings.push({ code: 'PREVIEWS_UNUSED', message });
		};
		if (!this.previewSource) return warn('Render previews are not available on this engine');
		if (planned.output.alpha) return warn('Alpha masters are always rendered (previews have no alpha)');
		const burn = settings.captions?.burnIn;
		if (burn === false || Array.isArray(burn))
			return warn(
				'Previews burn in the visible caption tracks; this export burns in others, so they are not used',
			);
		const found = await this.previewSource(planned.document, planned.sequenceId);
		if ('reason' in found) return warn(found.reason);
		const runs = exportRuns(planned.range, found.pieces);
		const used = runs.filter((r) => r.kind === 'preview');
		if (used.length === 0) return warn('No segment of the export range has a render preview');
		const frames = used.reduce((n, r) => n + r.end - r.start, 0);
		planned.previews = runs;
		planned.plan.segments = runs.map((r) => ({
			startFrame: r.start,
			endFrame: r.end,
			mode: r.kind === 'preview' ? 'native' : (planned.plan.segments[0]?.mode ?? 'native'),
			graphicsGroups: r.kind === 'preview' ? [] : (planned.plan.segments[0]?.graphicsGroups ?? []),
		}));
		planned.plan.warnings.push({
			code: 'USING_PREVIEWS',
			message: `${frames} of ${planned.range.end - planned.range.start} frames come from render previews (${used.length} segment${used.length === 1 ? '' : 's'}); the rest is rendered`,
		});
	}

	/**
	 * Use Previews: renders the stretches without a preview to ProRes intermediates (the export's own path), then
	 * encodes previews + intermediates with the export's encoder and mix.
	 */
	private async renderWithPreviews(
		ctx: JobContext,
		req: ExportStartRequest,
		planned: PlannedExport,
		output: string,
		runs: ExportRun[],
	): Promise<{
		planned: PlannedExport;
		frames: number;
		path: 'copy' | 'native' | 'hybrid' | 'remotion';
		remotionOutput: 'direct' | 'intermediate' | undefined;
		warnings: { code: string; message: string }[];
		audio: MixdownResult | null;
	}> {
		const audio = planned.output.videoOnly ? null : await this.renderAudio(planned, ctx);
		const seq = planned.snapshot.settings;
		const files: string[] = [];
		const counts: number[] = [];
		const warnings: { code: string; message: string }[] = [];
		let path: 'native' | 'hybrid' | 'remotion' = 'native';
		const total = Math.max(1, planned.range.end - planned.range.start);
		let done = 0;
		// Preview files are cache entries: held for the job (and waited for when a cleaning pass is removing them).
		const present = this.pinFor(ctx) ?? exists;
		for (const [i, r] of runs.entries()) {
			const n = r.end - r.start;
			if (r.kind === 'preview') {
				if (!(await present(r.file)))
					throw new JobError('PREVIEW_MISSING', 'A render preview was deleted during the export', true);
				files.push(r.file);
			} else {
				const file = join(await ctx.scratchDir(), `run-${i}.mov`);
				const sub: JobContext = {
					...ctx,
					progress: (v, extra) =>
						ctx.progress(((done + (v ?? 0) * n) / total) * 0.9, {
							...extra,
							stage: `Rendering frames ${r.start}–${r.end} · ${extra?.stage ?? ''}`,
						}),
				};
				const res = await this.renderToFile(
					sub,
					{
						...req,
						settings: {
							...req.settings,
							usePreviews: false,
							videoOnly: true,
							container: 'mov',
							range: { type: 'custom', startFrame: r.start, endFrame: r.end },
							video: {
								codec: 'prores',
								proresProfile: 'hq',
								width: seq.width,
								height: seq.height,
								frameRate: { num: seq.fps.num, den: seq.fps.den },
								scaling: 'stretch',
								quality: { mode: 'crf', value: 10 },
								encoderSpeed: 'fast',
							},
						},
					},
					file,
				);
				if (res.renderPath === 'remotion') path = 'remotion';
				else if (res.renderPath === 'hybrid' && path === 'native') path = 'hybrid';
				warnings.push(...res.warnings);
				files.push(file);
			}
			counts.push(n);
			done += n;
		}
		const o = planned.output;
		const enc = videoEncodeArgs(o.encoder!, {
			crf: o.crf,
			speed: o.speed,
			width: o.width,
			height: o.height,
			fps: o.fps,
			...(o.bitrateKbps ? { bitrateKbps: o.bitrateKbps } : {}),
			...(o.proresProfile ? { proresProfile: o.proresProfile } : {}),
			...(o.gop ? { gop: o.gop } : {}),
			...(o.noBFrames ? { noBFrames: true } : {}),
		});
		const filter = concatFilter({
			frames: counts,
			size: { width: seq.width, height: seq.height },
			fps: seq.fps,
			output: o,
			encoderFilters: enc.filters,
		});
		const script = join(await ctx.scratchDir(), 'previews-graph.txt');
		await writeFile(script, filter);
		const soxr = await hasSoxr(this.deps.ff);
		const ai = files.length;
		const args = [
			...enc.pre,
			...files.flatMap((f) => ['-i', f]),
			...(audio?.path ? ['-i', audio.path] : []),
			'-filter_complex_script',
			script,
			'-map',
			'[vout]',
			...(audio?.path ? ['-map', `${ai}:a:0`] : []),
			...(audio?.path && audio.sampleRate !== o.audioSampleRate
				? ['-af', `aresample=${o.audioSampleRate}:${resamplerArgs(soxr)}`]
				: []),
			...enc.video,
			...['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'],
			'-r',
			`${o.fps.num}/${o.fps.den}`,
			'-frames:v',
			String(o.frames),
			...(audio?.path
				? [
						...audioEncodeArgs(audioCodecOf(o.encoder, o), o.audioBitrateKbps, o.audioChannels),
						'-ar',
						String(o.audioSampleRate),
						'-ac',
						String(o.audioChannels),
						'-shortest',
					]
				: ['-an']),
			'-threads',
			String(Math.max(1, ctx.slots)),
			...(o.encoder?.container !== 'webm' ? ['-movflags', '+faststart'] : []),
			'-f',
			o.encoder?.container ?? 'mp4',
			output,
		];
		ctx.log(`ffmpeg ${args.join(' ')}`);
		const durationSec = o.durationSec;
		await this.deps.ff.run(args, {
			signal: ctx.signal,
			onSpawn: ctx.trackChild,
			onProgress: (p) => {
				if (durationSec <= 0) return;
				const t = Math.min(durationSec, p.outTimeUs / 1e6);
				ctx.progress(0.9 + (t / durationSec) * 0.09, { stage: 'Encoding (previews + rendered frames)' });
			},
		});
		const count = await this.deps.ff.countVideoFrames(output, { signal: ctx.signal });
		if (count !== o.frames)
			throw new JobError(
				'FRAME_COUNT_MISMATCH',
				`Expected ${o.frames} frames, the output has ${count}`,
				true,
				{
					expected: o.frames,
					actual: count,
				},
			);
		return { planned, frames: count, path, remotionOutput: undefined, warnings, audio };
	}

	private async storeRequest(r: StoredRequest): Promise<string> {
		const dir = join(this.deps.rendersDir, '.requests');
		await mkdir(dir, { recursive: true });
		const file = join(dir, `${randomId('req', 8)}.json`);
		await writeFile(file, JSON.stringify(r));
		return file;
	}

	/** `POST /api/exports`: validates by planning first (PATH_NOT_ELIGIBLE surfaces synchronously). */
	async start(req: ExportStartRequest, origin: EngineJob['origin'] = { type: 'user' }): Promise<EngineJob> {
		const dest = req.settings.destination;
		if (dest?.type === 'path') {
			// Writing to an arbitrary path is a local/desktop feature, like path registration (S04:SC-002).
			if (!this.deps.localMode) {
				throw new PlanError('LOCAL_MODE_ONLY', 403, 'Export to a path is only available in local mode');
			}
			if (!isAbsolute(dest.path) || basename(dest.path) === '' || dest.path.endsWith(sep)) {
				throw new PlanError('VALIDATION_FAILED', 400, 'The export destination must be an absolute file path');
			}
		}
		const planned = await this.plan(req);
		const file = await this.storeRequest({ kind: 'export', request: req });
		const cores = this.deps.queue.totalSlots;
		const seqName = sequenceName(planned);
		return this.deps.queue.submit({
			kind: 'export',
			title: `Export – ${seqName}`,
			priority: 'user',
			cpuSlots: cores,
			minSlots: Math.ceil(cores / 2),
			origin,
			projectId: planned.document.projectId,
			stage:
				planned.plan.path === 'remotion'
					? 'Queued (Remotion)'
					: planned.plan.path === 'hybrid'
						? 'Queued (native + baked graphics)'
						: 'Queued (native)',
			input: { request: file },
		});
	}

	/** `POST /api/stills`. */
	async still(req: StillRequest, origin: EngineJob['origin'] = { type: 'user' }): Promise<EngineJob> {
		if (req.destination) {
			// gaps (Export Frame to a folder): a local/desktop feature like exports to a path (S04:SC-002).
			if (!this.deps.localMode)
				throw new PlanError(
					'LOCAL_MODE_ONLY',
					403,
					'Export Frame to a folder is only available in local mode',
				);
			if (!isAbsolute(req.destination.folder))
				throw new PlanError('VALIDATION_FAILED', 400, 'The Export Frame folder must be an absolute path');
		}
		const file = await this.storeRequest({ kind: 'still', request: req });
		const doc = req.envelope.document as { projectId?: string };
		return this.deps.queue.submit({
			kind: 'still',
			title: `Frame ${req.frame}`,
			priority: 'interactive',
			cpuSlots: 2,
			minSlots: 1,
			origin,
			...(typeof doc.projectId === 'string' ? { projectId: doc.projectId } : {}),
			input: { request: file },
		});
	}

	/**
	 * wp captions (S04:TR-061/062): embeds the selected caption tracks as subtitle streams (`mov_text` in MP4/MOV,
	 * WebVTT in WebM; stream copy for picture and sound) and writes the sidecar files into the job directory.
	 */
	private async writeCaptionOutputs(
		planned: PlannedExport,
		output: string,
		dir: string,
		ctx: JobContext,
	): Promise<NonNullable<ExportResult['captions']> | null> {
		const c = planned.captionSettings;
		if (!c?.embed && !c?.sidecar?.length) return null;
		const seq = planned.document.sequences[planned.sequenceId]!;
		const embedded: NonNullable<ExportResult['captions']>['embedded'] = [];
		const sidecars: NonNullable<ExportResult['captions']>['sidecars'] = [];
		const tracks = embeddedTracks(planned.document, seq, c, planned.range);
		if (tracks.length) {
			ctx.progress(0.99, { stage: 'Embedding captions' });
			const scratch = await ctx.scratchDir();
			const files = [];
			for (const [i, t] of tracks.entries()) {
				const path = join(scratch, `captions-${i}.vtt`);
				await writeFile(path, writeCaptionFile(t.doc, 'vtt'));
				files.push({ path, language: t.language, title: t.name });
			}
			const container = extname(output).slice(1);
			const tmp = join(dir, `captioned${extname(output)}`);
			const args = embedArgs(output, files, container, tmp);
			ctx.log(`ffmpeg ${args.join(' ')}`);
			await this.deps.ff.run(args, { signal: ctx.signal, onSpawn: ctx.trackChild });
			await rename(tmp, output);
			for (const t of tracks)
				embedded.push({
					trackId: t.track.id,
					name: t.name,
					language: t.language,
					codec: subtitleCodecFor(container),
					cues: t.doc.cues.length,
				});
		}
		const side = sidecarTracks(planned.document, seq, c, planned.range);
		// sidecars live in `captions/` so `output.*` stays the only output file of the job
		if (side.length) await mkdir(join(dir, 'captions'), { recursive: true });
		for (const format of c.sidecar ?? []) {
			for (const t of side) {
				const name = sidecarName('output', t, format, side.length === 1);
				await writeFile(join(dir, 'captions', name), sidecarBytes(t, format, seq, c.dropFrame));
				sidecars.push({
					trackId: t.track.id,
					format,
					name,
					url: `/renders/${ctx.job.id}/captions/${encodeURIComponent(name)}`,
					cues: t.doc.cues.length,
				});
			}
		}
		return { embedded, sidecars };
	}

	/** A sidecar caption file of a finished render job (`/renders/:jobId/captions/:name`). */
	async sidecarFile(jobId: string, name: string): Promise<string | null> {
		if (!JOB_ID_RE.test(jobId) || !/^output(\.[A-Za-z0-9_-]+)*\.(srt|vtt|scc|mcc|stl|ttml|dfxp)$/.test(name))
			return null;
		const job = this.deps.queue.get(jobId);
		if (job && job.state !== 'succeeded') return null;
		const file = join(this.deps.rendersDir, jobId, 'captions', name);
		return (await exists(file)) ? file : null;
	}

	/** Output file of a finished render job (`/renders/:jobId/output`). */
	async outputFile(jobId: string): Promise<string | null> {
		if (!JOB_ID_RE.test(jobId)) return null;
		// A running render writes output.* in place: never serve a partial file.
		const job = this.deps.queue.get(jobId);
		if (job && job.state !== 'succeeded') return null;
		const dir = join(this.deps.rendersDir, jobId);
		try {
			const f = (await readdir(dir)).find((n) => n.startsWith('output.'));
			return f ? join(dir, f) : null;
		} catch {
			return null;
		}
	}

	/** `NativePrepareContext.pin` of a job: holds the cache entry of `path` until the job ends. */
	private pinFor(ctx: JobContext): ((path: string) => Promise<boolean>) | undefined {
		const cache = this.cache;
		return cache ? (path) => cache.acquireForJob(ctx.job.id, path) : undefined;
	}

	/** Pins what the composite reads from the cache: every layer override and fframes master. */
	private async pinInputs(
		ctx: JobContext,
		planned: PlannedExport,
		exts: readonly NativeExtension[],
		prepared: ReadonlyMap<string, unknown>,
		masters: ReadonlyMap<string, string> = new Map(),
	): Promise<void> {
		if (!this.cache) return;
		const paths = new Set(masters.values());
		for (const clip of planned.snapshot.videoTracks.flatMap((t) => t.clips)) {
			const o = layerOverride(exts, prepared, clip);
			if (o) paths.add(o.path);
		}
		for (const p of paths) await this.cache.acquireForJob(ctx.job.id, p);
	}

	/** Records the cache entries this job used as its project's ref set for the sequence (survives restarts). */
	private commitRefs(ctx: JobContext, planned: PlannedExport, what: 'export' | 'still'): void {
		const pid = planned.document.projectId;
		if (!this.cache || !pid) return;
		this.cache.commitHolderRefs(`job:${ctx.job.id}`, `${what}:${pid}:${planned.sequenceId}`, pid);
	}

	private async loadRequest(ctx: JobContext): Promise<StoredRequest> {
		const file = (ctx.input as { request?: string })?.request;
		if (!file) throw new JobError('BAD_REQUEST', 'Missing render request', false);
		try {
			return JSON.parse(await readFile(file, 'utf8')) as StoredRequest;
		} catch {
			throw new JobError('BAD_REQUEST', 'The render request is no longer available', false);
		}
	}

	private async outDir(ctx: JobContext): Promise<string> {
		const dir = join(this.deps.rendersDir, ctx.job.id);
		await mkdir(dir, { recursive: true });
		return dir;
	}

	private async collectMgMasters(
		planned: PlannedExport,
		ctx: JobContext,
	): Promise<Map<string, string> | null> {
		const masters = new Map<string, string>();
		// Anime templates (S11:ATP-008) are Remotion graphics: baked by the layer-bake extension, not by fframes.
		// edit-structure: motion graphics inside nested sequences are drawn in the nested frame.
		const clips: { clip: RenderVisualClip; snap: PlannedExport['snapshot'] }[] = [];
		const collect = (snap: PlannedExport['snapshot']) => {
			for (const c of snap.videoTracks.flatMap((t) => t.clips)) {
				if (c.kind === 'motion-graphic' && !isAnimeTemplate(c)) clips.push({ clip: c, snap });
				if ('nest' in c.source) collect(c.source.nest.snapshot);
			}
		};
		collect(planned.snapshot);
		if (clips.length === 0) return masters;
		if (!this.mgProvider) return null;
		for (const { clip, snap } of clips) {
			if (masters.has(clip.clipId)) continue;
			ctx.progress(0, { stage: 'Rendering motion graphics' });
			const p = await this.mgProvider({
				clip,
				fps: snap.settings.fps,
				sequence: { width: snap.settings.width, height: snap.settings.height },
				projectId: planned.document.projectId,
				parentId: ctx.job.id,
				signal: ctx.signal,
			});
			if (!p || !(await exists(p))) return null;
			masters.set(clip.clipId, p);
		}
		return masters;
	}

	private async runNative(
		planned: PlannedExport,
		masters: Map<string, string>,
		output: string,
		ctx: JobContext,
		still = false,
		audio: MixdownResult | null = null,
	): Promise<number> {
		const exts = this.nativeExtensions.all();
		let prepared: Map<string, unknown>;
		let nested: Map<string, PreparedExtensions>;
		try {
			const pctx = {
				signal: ctx.signal,
				stage: (text: string) => ctx.progress(0, { stage: text }),
				scratchDir: () => ctx.scratchDir(),
				log: (text: string) => ctx.log(text),
				jobId: ctx.job.id,
				...(planned.document.projectId ? { projectId: planned.document.projectId } : {}),
				purpose: 'native' as const,
				concurrency: remotionConcurrency(ctx.slots),
				...(this.pinFor(ctx) ? { pin: this.pinFor(ctx) } : {}),
			};
			prepared = await prepareExtensions(exts, planned, pctx);
			// edit-structure: nested sequences are drawn in the same graph; their layers get their own preparations.
			nested = await prepareNestedExtensions(exts, planned, pctx);
		} catch (e) {
			if (ctx.signal.aborted) throw e;
			throw new NativePrepareError(e);
		}
		await this.pinInputs(ctx, planned, exts, prepared, masters);
		const pinNested = async (pl: PlannedExport, parent: string): Promise<void> => {
			for (const c of pl.snapshot.videoTracks.flatMap((t) => t.clips)) {
				if (!('nest' in c.source)) continue;
				const path = parent ? `${parent}>${c.clipId}` : c.clipId;
				const sub = { ...pl, snapshot: c.source.nest.snapshot, range: c.source.nest.snapshot.range };
				await this.pinInputs(ctx, sub, exts, nested.get(path) ?? new Map());
				await pinNested(sub, path);
			}
		};
		await pinNested(planned, '');
		// color-mgmt: the output conversion (exports) or the display rendition (stills), baked once per job.
		const colorLut = still
			? await displayLutFilter(planned.snapshot.settings.color, await ctx.scratchDir())
			: planned.output.color
				? await outputLutFilter(planned.output.color, await ctx.scratchDir())
				: null;
		const graph = buildNativeGraph({
			colorLut,
			snapshot: planned.snapshot,
			output: planned.output,
			outputFile: output,
			sources: {
				media: (id) => planned.media[id] ?? null,
				mgMaster: (id) => masters.get(id) ?? null,
			},
			threads: ctx.slots,
			still,
			extensions: { list: exts, prepared },
			...(audio?.path
				? { audio: { file: audio.path, sampleRate: audio.sampleRate, soxr: await hasSoxr(this.deps.ff) } }
				: {}),
			nested,
		});
		let args = graph.args;
		if (graph.filter.length > 60_000) {
			const script = join(await ctx.scratchDir(), 'graph.txt');
			await writeFile(script, graph.filter);
			const i = args.indexOf('-filter_complex');
			args = [...args.slice(0, i), '-filter_complex_script', script, ...args.slice(i + 2)];
		}
		for (const [i, seg] of (graph.blend?.segments ?? []).entries()) {
			if (seg.filter.length > 60_000) {
				const script = join(await ctx.scratchDir(), `blend-${i}.txt`);
				await writeFile(script, seg.filter);
				const k = seg.args.indexOf('-filter_complex');
				seg.args = [...seg.args.slice(0, k), '-filter_complex_script', script, ...seg.args.slice(k + 2)];
			}
			ctx.log(`ffmpeg (blend layer ${i + 1}) ${seg.args.join(' ')}`);
		}
		ctx.log(`ffmpeg ${args.join(' ')}`);
		const total = graph.durationSec;
		const started = Date.now();
		// Sub-pixel layers stream into the composite's pipes while it runs (stream/run.ts). A failed stream stops the
		// composite and is the reported error.
		const streamAbort = new AbortController();
		const onJobAbort = () => streamAbort.abort();
		ctx.signal.addEventListener('abort', onJobAbort, { once: true });
		const producers: Promise<void>[] = [];
		let streamError: Error | null = null;
		const blend = graph.blend;
		const allStreams =
			graph.streams.length + (blend?.segments.reduce((n, sg) => n + sg.streams.length, 0) ?? 0);
		const workers = Math.max(
			2,
			Math.floor(Math.max(1, ctx.slots) / Math.max(1, allStreams + (blend?.segments.length ?? 0))),
		);
		const runStreams = (child: ChildProcess, streams = graph.streams) => {
			for (const s of streams) {
				const sink = child.stdio[s.fd] as Writable;
				producers.push(
					streamLayer(this.deps.ff, s.plan, sink, {
						workers,
						signal: streamAbort.signal,
						onSpawn: ctx.trackChild,
					}).catch((e: Error) => {
						if (streamAbort.signal.aborted) return;
						streamError ??= e;
						void terminateTree(child, 500);
					}),
				);
			}
		};
		// keyframes-blend: the processes before the composite run while it runs; the last kernel feeds its pipe:3.
		const runBlend = (child: ChildProcess) => {
			if (!blend) return;
			producers.push(
				runBlendPipeline(
					this.deps.ff,
					blend.segments,
					{ width: blend.width, height: blend.height },
					child.stdio[blend.backdropFd] as Writable,
					{
						workers,
						signal: streamAbort.signal,
						onSpawn: ctx.trackChild,
						runStreams: (c, streams) => runStreams(c, streams),
					},
				).catch((e: Error) => {
					if (streamAbort.signal.aborted) return;
					streamError ??= e;
					void terminateTree(child, 500);
				}),
			);
		};
		const pipes = graph.streams.length + (blend ? 1 : 0);
		try {
			await this.deps.ff.run(args, {
				signal: ctx.signal,
				...(pipes > 0 ? { pipes } : {}),
				onSpawn: (child) => {
					ctx.trackChild(child);
					if (graph.streams.length > 0) runStreams(child);
					runBlend(child);
				},
				onProgress: (p) => {
					if (still || total <= 0) return;
					const done = Math.min(total, p.outTimeUs / 1e6);
					const elapsed = (Date.now() - started) / 1000;
					const speed = p.speed ?? (elapsed > 0 ? done / elapsed : undefined);
					ctx.progress((done / total) * 0.98, {
						stage: 'Encoding (native)',
						...(speed ? { speed, etaSec: (total - done) / speed } : {}),
					});
				},
			});
		} catch (e) {
			streamAbort.abort();
			await Promise.all(producers);
			throw streamError ?? e;
		} finally {
			ctx.signal.removeEventListener('abort', onJobAbort);
		}
		// The composite succeeded (and the frame count is checked below): a stream it stopped reading ends here.
		streamAbort.abort();
		await Promise.all(producers);
		if (still) return 1;
		const count = await this.deps.ff.countVideoFrames(output, { signal: ctx.signal });
		if (count !== graph.outputFrames) {
			throw new JobError(
				'FRAME_COUNT_MISMATCH',
				`Expected ${graph.outputFrames} frames, the output has ${count}`,
				true,
				{
					expected: graph.outputFrames,
					actual: count,
				},
			);
		}
		return count;
	}

	/**
	 * audio-mix: the deliverable's audio for every path — the offline mixer over the export range (clip levels, pan,
	 * buses, sends, automation, 5.1) with two-pass loudness normalisation when requested.
	 */
	private async renderAudio(planned: PlannedExport, ctx: JobContext): Promise<MixdownResult> {
		ctx.progress(0, { stage: 'Mixing audio' });
		const o = planned.output;
		const sr = planned.snapshot.audioMix?.sampleRate ?? 48000;
		return renderMixdown({
			ff: this.deps.ff,
			snapshot: planned.snapshot,
			media: (id) => {
				const m = planned.media[id];
				if (!m) return null;
				return {
					path: m.path,
					streams: m.record.probe.streams.filter((x) => x.type === 'audio') as never,
				};
			},
			range: planned.range,
			length: Math.round(o.durationSec * sr),
			outputLayout: layoutOf(o.audioChannels),
			normalize: o.normalize,
			scratchDir: await ctx.scratchDir(),
			signal: ctx.signal,
			onSpawn: ctx.trackChild,
			onProgress: (_f, stage) => ctx.progress(0, { stage }),
		});
	}

	/** Remotion's direct output (VP9/Opus or GPL H.264) with the mixdown as its audio (stream copy of the video). */
	private async muxAudio(
		planned: PlannedExport,
		video: string,
		audio: MixdownResult,
		output: string,
		ctx: JobContext,
	) {
		const o = planned.output;
		const codec = audioCodecOf(o.encoder, o);
		const soxr = await hasSoxr(this.deps.ff);
		const af =
			audio.sampleRate !== o.audioSampleRate
				? ['-af', `aresample=${o.audioSampleRate}:${resamplerArgs(soxr)}`]
				: [];
		const args = [
			'-i',
			video,
			'-i',
			audio.path!,
			'-map',
			'0:v:0',
			'-map',
			'1:a:0',
			'-c:v',
			'copy',
			...af,
			...audioEncodeArgs(codec, o.audioBitrateKbps, o.audioChannels),
			'-ar',
			String(o.audioSampleRate),
			'-ac',
			String(o.audioChannels),
			'-shortest',
			...(o.encoder?.container !== 'webm' ? ['-movflags', '+faststart'] : []),
			'-f',
			o.encoder?.container ?? 'mp4',
			output,
		];
		ctx.log(`ffmpeg ${args.join(' ')}`);
		await this.deps.ff.run(args, { signal: ctx.signal, onSpawn: ctx.trackChild });
	}

	/** color-mgmt: writes the mastering display / content light boxes of PQ and HLG exports into MP4 and MOV files. */
	/**
	 * gaps (Sequence Settings ▸ Pixel Aspect Ratio): a stream-copy remux that signals the pixel aspect ratio (H.264 /
	 * HEVC VUI through `*_metadata`, MP4 / MOV `pasp`, Matroska display size). Nothing is re-encoded.
	 */
	private async writeSequenceFormat(planned: PlannedExport, output: string, ctx: JobContext): Promise<void> {
		const o = planned.output;
		if (!o.pixelAspect) return;
		const codec = o.encoder?.codec;
		const par = o.pixelAspect;
		const bsf =
			par && codec === 'h264'
				? ['-bsf:v', `h264_metadata=sample_aspect_ratio=${par.num}/${par.den}`]
				: par && codec === 'hevc'
					? ['-bsf:v', `hevc_metadata=sample_aspect_ratio=${par.num}/${par.den}`]
					: [];
		const ext = extname(output);
		const tmp = join(dirname(output), `format${ext}`);
		await this.deps.ff.run(
			[
				'-i',
				output,
				'-map',
				'0',
				'-c',
				'copy',
				...bsf,
				...(par ? ['-aspect', `${o.width * par.num}:${o.height * par.den}`] : []),
				...(ext === '.mp4' || ext === '.mov' ? ['-movflags', '+faststart'] : []),
				tmp,
			],
			{ signal: ctx.signal, onSpawn: ctx.trackChild },
		);
		await rename(tmp, output);
		ctx.log(`[format] pixel aspect ${par!.num}:${par!.den}`);
	}

	private async writeHdrMetadata(planned: PlannedExport, output: string, ctx: JobContext): Promise<void> {
		const c = planned.output.color;
		const container = planned.output.encoder?.container;
		if (!c?.hdr || (container !== 'mp4' && container !== 'mov')) return;
		const md = c.hdr.masteringDisplay;
		const p = MASTERING_PRIMARIES[md.primaries];
		await writeHdrBoxes(
			output,
			{ r: p.r, g: p.g, b: p.b, white: [0.3127, 0.329], maxNits: md.maxNits, minNits: md.minNits },
			c.hdr.maxCll !== undefined || c.hdr.maxFall !== undefined
				? {
						...(c.hdr.maxCll !== undefined ? { maxCll: c.hdr.maxCll } : {}),
						...(c.hdr.maxFall !== undefined ? { maxFall: c.hdr.maxFall } : {}),
					}
				: null,
		);
		ctx.log(`[color] HDR metadata written: mastering ${md.primaries} ${md.maxNits}/${md.minNits} cd/m²`);
	}

	/** Encodes Remotion's ProRes/PCM intermediate with the selected encoder (D-13). */
	private async encodeIntermediate(
		planned: PlannedExport,
		input: string,
		output: string,
		frames: number,
		ctx: JobContext,
		from: number,
		stage: string,
		audio: MixdownResult | null = null,
	): Promise<void> {
		const o = planned.output;
		const choice = o.encoder!;
		const enc = videoEncodeArgs(choice, {
			crf: o.crf,
			speed: o.speed,
			width: o.width,
			height: o.height,
			fps: o.fps,
			...(o.bitrateKbps ? { bitrateKbps: o.bitrateKbps } : {}),
			...(o.proresProfile ? { proresProfile: o.proresProfile } : {}),
			...(o.gop ? { gop: o.gop } : {}),
			...(o.noBFrames ? { noBFrames: true } : {}),
			...(o.color
				? { bitDepth: o.color.bitDepth, colorCodes: o.color.codes, svtHdr: svtHdrParams(o.color) }
				: {}),
		});
		// color-mgmt: the intermediate holds the working signal (BT.709 matrix); convert to the output space.
		const lut = o.color ? await outputLutFilter(o.color, await ctx.scratchDir()) : null;
		const vf = [
			...(o.color
				? outputFilters(o.color, lut, SWS_FLAGS)
				: [`scale=out_color_matrix=bt709:out_range=tv:${SWS_FLAGS}`, 'setsar=1', BT709_FRAME_TAGS]),
			...enc.filters,
		];
		const soxr = await hasSoxr(this.deps.ff);
		const args = [
			...enc.pre,
			'-i',
			input,
			...(audio?.path ? ['-i', audio.path] : []),
			'-map',
			'0:v:0',
			...(o.videoOnly ? [] : ['-map', audio?.path ? '1:a:0' : '0:a:0?']),
			'-vf',
			vf.join(','),
			...(audio?.path && audio.sampleRate !== o.audioSampleRate
				? ['-af', `aresample=${o.audioSampleRate}:${resamplerArgs(soxr)}`]
				: []),
			...enc.video,
			...(o.color
				? colorTagArgs(o.color)
				: ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']),
			'-frames:v',
			String(frames),
			...(o.videoOnly
				? ['-an']
				: [
						...audioEncodeArgs(audioCodecOf(choice, o), o.audioBitrateKbps, o.audioChannels),
						'-ar',
						String(o.audioSampleRate),
						'-ac',
						String(o.audioChannels),
					]),
			'-threads',
			String(Math.max(1, ctx.slots)),
			...(choice.container !== 'webm' ? ['-movflags', '+faststart'] : []),
			'-f',
			choice.container,
			output,
		];
		ctx.log(`ffmpeg ${args.join(' ')}`);
		const total = o.durationSec;
		await this.deps.ff.run(args, {
			signal: ctx.signal,
			onSpawn: ctx.trackChild,
			onProgress: (p) => {
				if (total <= 0) return;
				const done = Math.min(total, p.outTimeUs / 1e6);
				ctx.progress(from + (done / total) * (0.98 - from), { stage: `${stage} · Encoding` });
			},
		});
	}

	/** M2 (§19.6): runs `prepare` of the extensions that serve the Remotion path too. */
	private async prepareForRemotion(planned: PlannedExport, ctx: JobContext): Promise<Map<string, unknown>> {
		const exts = this.nativeExtensions.all().filter((e) => e.prepareForRemotion);
		if (exts.length === 0) return new Map();
		const pctx = {
			signal: ctx.signal,
			stage: (text: string) => ctx.progress(0, { stage: text }),
			scratchDir: () => ctx.scratchDir(),
			log: (text: string) => ctx.log(text),
			jobId: ctx.job.id,
			...(planned.document.projectId ? { projectId: planned.document.projectId } : {}),
			purpose: 'remotion' as const,
			concurrency: remotionConcurrency(ctx.slots),
			...(this.pinFor(ctx) ? { pin: this.pinFor(ctx) } : {}),
		};
		const prepared = await prepareExtensions(exts, planned, pctx);
		await this.pinInputs(ctx, planned, exts, prepared);
		// edit-structure: nested sequences' layers (graded DOM layers inside nests…) are prepared too.
		NESTED_REMOTION.set(prepared, await prepareNestedExtensions(exts, planned, pctx));
		return prepared;
	}

	/**
	 * S11:LBK-023: after a native preparation step failed, re-plans an `auto` export/still on the Remotion path.
	 * Returns null when that is not allowed (forced `native`, cancelled, Remotion not eligible): the caller then
	 * fails with the original error.
	 */
	private async fallbackToRemotion(
		e: unknown,
		input: Parameters<typeof planExport>[0],
		ctx: JobContext,
		warnings: { code: string; message: string }[],
	): Promise<PlannedExport | null> {
		if (!(e instanceof NativePrepareError) || ctx.signal.aborted || input.settings.engine === 'native')
			return null;
		let planned: PlannedExport;
		try {
			planned = await planExport(
				{ ...input, settings: { ...input.settings, engine: 'remotion' } },
				this.planDeps(await this.deps.capabilities()),
			);
		} catch {
			return null;
		}
		const message = `The native path could not be prepared (${e.message.slice(0, 300)}); rendered with Remotion instead`;
		warnings.push({ code: 'NATIVE_FALLBACK', message });
		ctx.log(`warning NATIVE_FALLBACK: ${message}`);
		ctx.progress(0, { stage: 'Falling back to Remotion' });
		return planned;
	}

	private planDeps(caps: PlanCapabilities): Parameters<typeof planExport>[1] {
		return {
			registry: this.deps.registry,
			fonts: this.deps.fonts,
			capabilities: caps,
			extensions: this.nativeExtensions.all(),
			...(this.rotoSet ? { rotoSet: this.rotoSet } : {}),
			...(this.deps.encoders
				? {
						selectEncoder: (r) => this.deps.encoders!.select(r),
						lgplOnly: this.deps.encoders.inventory.lgplOnly,
					}
				: {}),
		};
	}

	/** The cause of a native preparation failure (what a forced native export fails with). */
	private unwrap(e: unknown): unknown {
		return e instanceof NativePrepareError ? e.failure : e;
	}

	/** Snapshot with signed absolute media and font URLs for the headless browser (S04:RR-003, MS-003). */
	private remotionProps(
		planned: PlannedExport,
		prepared: ReadonlyMap<string, unknown> = new Map(),
	): Record<string, unknown> {
		const origin = this.deps.origin();
		const sign = (path: string) => this.deps.signer.signUrl(origin, path);
		let doc = buildRenderSnapshot(planned.document, planned.sequenceId, {
			captions: planned.captions,
			range: planned.range,
			resolveMedia: (asset): MediaHandle | null => {
				const local = planned.media[asset.id];
				// gaps: a draft export with proxies serves the proxy file (its record) under its own key.
				const key = local?.record.mediaKey ?? mediaKeyOf(asset);
				if (!local || !key) return null;
				const r = local.record;
				return {
					url: sign(`/media/${encodeURIComponent(key)}`),
					proxyUrl: null,
					kind: asset.kind,
					width: r.display?.width ?? null,
					height: r.display?.height ?? null,
					durationFlicks: r.probe.durationFlicks,
					hasAudio: r.hasAudio,
					rotation: r.probe.rotationDegrees,
					...mediaDecodeHints(r.probe),
				};
			},
			resolveFont: (font, weight, italic) => {
				const f = this.deps.fonts.resolve(font.family, weight, italic);
				return f ? sign(f.url) : null;
			},
			// parity (roto): object-matte sets for the headless browser
			resolveRoto: (key) => sign(rotoStorePath(key)),
		});
		const nested = NESTED_REMOTION.get(prepared);
		const adapt = (d: typeof doc, prep: ReadonlyMap<string, unknown>, path: string): typeof doc => {
			for (const ext of this.nativeExtensions.all()) {
				if (ext.prepareForRemotion && ext.adaptRemotionDoc)
					d = ext.adaptRemotionDoc(d, prep.get(ext.id), { signUrl: sign });
			}
			if (!nested || nested.size === 0) return d;
			// edit-structure: adapt the nested snapshots of nest clips with what was prepared for them.
			return {
				...d,
				videoTracks: d.videoTracks.map((t) => ({
					...t,
					clips: t.clips.map((c) => {
						if (!('nest' in c.source)) return c;
						const p = path ? `${path}>${c.clipId}` : c.clipId;
						const sub = adapt(c.source.nest.snapshot, nested.get(p) ?? new Map(), p);
						return { ...c, source: { nest: { ...c.source.nest, snapshot: sub } } };
					}),
				})),
			};
		};
		doc = adapt(doc, prepared, '');
		return {
			doc,
			options: { isPreview: false, useProxies: false, transparentBackground: planned.output.alpha === true },
		};
	}

	/**
	 * previews: renders an export request (its range, picture settings) into `output` inside the calling job — the same
	 * planning, paths, fallbacks and frame-count check as an export job, without the job's output directory, captions
	 * or destination copy. `output` must carry the container's extension; the caller owns the file (partials).
	 */
	async renderToFile(
		ctx: JobContext,
		req: ExportStartRequest,
		output: string,
		opts: { noBFrames?: boolean } = {},
	): Promise<{
		frames: number;
		renderPath: 'copy' | 'native' | 'hybrid' | 'remotion';
		warnings: { code: string; message: string }[];
	}> {
		ctx.progress(0, { stage: 'Planning' });
		let planned: PlannedExport;
		try {
			planned = await this.plan(req);
		} catch (e) {
			if (e instanceof PlanError) throw new JobError(e.code, e.message, false, e.detail);
			throw e;
		}
		if (opts.noBFrames) planned.output.noBFrames = true;
		const r = await this.renderPlanned(ctx, req, planned, output);
		return { frames: r.frames, renderPath: r.path, warnings: r.warnings };
	}

	/**
	 * previews (Render Audio): the offline mix of an export request's range (`settings.audio`: channels, rate) as a
	 * 32-bit float WAV at `output`. The same mixer as every export's audio.
	 */
	async mixdownToFile(
		ctx: JobContext,
		req: ExportStartRequest,
		output: string,
	): Promise<{ samples: number }> {
		let planned: PlannedExport;
		try {
			planned = await this.plan(req);
		} catch (e) {
			if (e instanceof PlanError) throw new JobError(e.code, e.message, false, e.detail);
			throw e;
		}
		const audio = await this.renderAudio(planned, ctx);
		if (!audio.path) throw new JobError('MIXDOWN_FAILED', 'The mixer wrote no audio', true);
		await copyFile(audio.path, output);
		return { samples: audio.samples };
	}

	private async runExport(ctx: JobContext): Promise<unknown> {
		const stored = await this.loadRequest(ctx);
		if (stored.kind !== 'export') throw new JobError('BAD_REQUEST', 'Not an export request', false);
		const req = stored.request;
		ctx.progress(0, { stage: 'Planning' });
		let planned: PlannedExport;
		try {
			planned = await this.plan(req);
		} catch (e) {
			if (e instanceof PlanError) throw new JobError(e.code, e.message, false, e.detail);
			throw e;
		}
		const dir = await this.outDir(ctx);
		const encoder = planned.output.encoder;
		const output = join(dir, `output.${encoder?.container ?? 'mp4'}`);
		ctx.addPartial(dir);
		const rendered = planned.previews?.some((r) => r.kind === 'preview')
			? await this.renderWithPreviews(ctx, req, planned, output, planned.previews)
			: planned.smart
				? await this.renderSmart(ctx, req, planned, output, planned.smart)
				: await this.renderPlanned(ctx, req, planned, output);
		planned = rendered.planned;
		const { frames, path, remotionOutput, warnings, audio } = rendered;
		return this.finishExport(ctx, req, planned, output, dir, {
			frames,
			path,
			remotionOutput,
			warnings,
			audio,
		});
	}

	/** Renders a planned export into `output` (native / hybrid with the Remotion fallback, or Remotion). */
	private async renderPlanned(
		ctx: JobContext,
		req: ExportStartRequest,
		planned: PlannedExport,
		output: string,
	): Promise<{
		planned: PlannedExport;
		frames: number;
		path: 'copy' | 'native' | 'hybrid' | 'remotion';
		remotionOutput: 'direct' | 'intermediate' | undefined;
		warnings: { code: string; message: string }[];
		audio: MixdownResult | null;
	}> {
		const encoder = planned.output.encoder;
		let frames = 0;
		let remotionOutput: 'direct' | 'intermediate' | undefined;
		let path = planned.plan.path;
		let masters = new Map<string, string>();
		const warnings: { code: string; message: string }[] = [];
		// previews: picture-only renders skip the mixdown.
		const audio = planned.output.videoOnly ? null : await this.renderAudio(planned, ctx);
		if (path === 'native' || path === 'hybrid') {
			const m = await this.collectMgMasters(planned, ctx);
			if (m === null) {
				if (req.settings.engine === 'native') {
					throw new JobError('PATH_NOT_ELIGIBLE', 'Motion-graphic masters are unavailable (fframes)', false);
				}
				path = 'remotion';
			} else masters = m;
		}
		if (path === 'native' || path === 'hybrid') {
			try {
				frames = await this.runNative(planned, masters, output, ctx, false, audio);
			} catch (e) {
				// S11:LBK-023: a failed preparation (bake, warp, pre-render…) of an `auto` export → Remotion path.
				const replanned = await this.fallbackToRemotion(
					e,
					{
						envelope: req.envelope,
						sequenceId: req.sequenceId,
						settings: { ...req.settings, sequenceId: req.sequenceId },
					},
					ctx,
					warnings,
				);
				if (!replanned) throw this.unwrap(e);
				planned = replanned;
				path = 'remotion';
			}
		}
		if (path === 'remotion' && planned.output.alpha) {
			// wp interchange: a straight-alpha ProRes 4444 master of the range (no audio), as the layer bake renders it.
			const prepared = await this.prepareForRemotion(planned, ctx);
			ctx.progress(0, { stage: 'Rendering alpha master' });
			const res = await this.deps.remotion.renderAlphaMaster({
				inputProps: this.remotionProps(planned, prepared),
				output,
				scratchDir: await ctx.scratchDir(),
				signal: ctx.signal,
				ffmpeg: this.deps.ff,
				concurrency: remotionConcurrency(ctx.slots),
				log: ctx.log,
				onSpawn: ctx.trackChild,
				onProgress: (p) =>
					ctx.progress(p.progress, {
						stage: `Rendering ${p.renderedFrames}/${p.totalFrames} frames (alpha)`,
					}),
			});
			frames = res.frames;
			remotionOutput = 'direct';
		} else if (path === 'remotion') {
			const seqW = planned.snapshot.settings.width;
			// D-13 (wp-lgpl): Remotion renders a ProRes intermediate that our ffmpeg encodes with the selected
			// encoder, or encodes VP9/Opus itself; only a dev setup with GPL builds on both sides lets Remotion
			// encode H.264 (see remotion/export-plan.ts).
			const rp = planRemotionExport({
				encoder,
				remotion: this.deps.remotion.ffmpegInfo,
				lgplOnly: this.deps.encoders?.inventory.lgplOnly ?? false,
				crf: planned.output.crf,
				speed: planned.output.speed,
				fps: planned.output.fps,
				plainRec709: isPlainRec709Output(planned.output.color),
			});
			if (rp.mode === 'unavailable') throw new JobError(rp.code, rp.reason, false);
			ctx.log(`remotion export: ${rp.mode} (${rp.reason})`);
			remotionOutput = rp.mode;
			const render = rp.phases[0]!;
			// audio-mix: Remotion renders the picture only; the deliverable's audio is the mixdown.
			const target = join(
				await ctx.scratchDir(),
				rp.mode === 'direct' ? `remotion-video.${encoder?.container ?? 'mp4'}` : 'remotion-intermediate.mov',
			);
			const prepared = await this.prepareForRemotion(planned, ctx);
			ctx.progress(0, { stage: `${render.label} · Preparing bundle` });
			const res = await this.deps.remotion.renderMedia({
				inputProps: this.remotionProps(planned, prepared),
				output: target,
				signal: ctx.signal,
				concurrency: remotionConcurrency(ctx.slots),
				log: ctx.log,
				crf: rp.mode === 'direct' ? rp.crf : planned.output.crf,
				x264Preset: planned.output.x264Preset,
				audioBitrateKbps: planned.output.audioBitrateKbps,
				...(rp.mode === 'intermediate' ? { intermediate: true } : {}),
				...(rp.mode === 'direct' && rp.codec === 'vp9'
					? {
							vp9: {
								crf: rp.crf,
								colorSpace: rp.colorSpace,
								ffmpegOverride: appendEncoderArgs('libvpx-vp9', rp.extraVideoArgs),
							},
						}
					: {}),
				...(planned.output.width !== seqW ? { scale: planned.output.width / seqW } : {}),
				muted: true,
				onProgress: (p) =>
					ctx.progress(p.progress * render.weight, { stage: `${render.label} · ${p.stage}` }),
			});
			if (rp.mode === 'intermediate') {
				await this.encodeIntermediate(
					planned,
					target,
					output,
					res.frames,
					ctx,
					render.weight,
					rp.phases[1]!.label,
					audio,
				);
			} else if (audio) await this.muxAudio(planned, target, audio, output, ctx);
			else await rename(target, output);
			const count = await this.deps.ff.countVideoFrames(output, { signal: ctx.signal });
			if (count !== res.frames) {
				throw new JobError(
					'FRAME_COUNT_MISMATCH',
					`Expected ${res.frames} frames, the output has ${count}`,
					true,
				);
			}
			frames = count;
		}
		return {
			planned,
			frames,
			path: path as 'native' | 'hybrid' | 'remotion',
			remotionOutput,
			warnings,
			audio,
		};
	}

	private async finishExport(
		ctx: JobContext,
		req: ExportStartRequest,
		planned: PlannedExport,
		output: string,
		dir: string,
		r: {
			frames: number;
			path: 'copy' | 'native' | 'hybrid' | 'remotion';
			remotionOutput: 'direct' | 'intermediate' | undefined;
			warnings: { code: string; message: string }[];
			audio: MixdownResult | null;
		},
	): Promise<unknown> {
		const { frames, path, remotionOutput, warnings, audio } = r;
		const encoder = planned.output.encoder;
		// gaps: the sequence's pixel aspect ratio and field order signalled in the file.
		await this.writeSequenceFormat(planned, output, ctx);
		// color-mgmt: HDR static metadata boxes (`mdcv` / `clli`) in MP4 / MOV outputs.
		await this.writeHdrMetadata(planned, output, ctx);
		// wp captions: embedded caption streams (remux) and sidecar files.
		const captionResult = await this.writeCaptionOutputs(planned, output, dir, ctx);
		const byteSize = (await stat(output)).size;
		const downloadUrl = `/renders/${ctx.job.id}/output`;
		let finalPath: string | undefined;
		if (req.settings.destination?.type === 'path') {
			// The destination is a partial until the job succeeds: a cancel during (or right after) the copy deletes it.
			finalPath = await copyNoOverwrite(
				output,
				withExtension(req.settings.destination.path, extname(output)),
				{ signal: ctx.signal, claimed: (p) => ctx.addPartial(p) },
			);
			const stem = basename(finalPath, extname(finalPath));
			for (const sc of captionResult?.sidecars ?? []) {
				const ext = extname(sc.name);
				const rest = sc.name.slice(sc.name.indexOf('.'), -ext.length || undefined);
				sc.path = await copyNoOverwrite(
					join(dir, 'captions', sc.name),
					join(dirname(finalPath), `${stem}${rest}${ext}`),
					{ signal: ctx.signal, claimed: (p) => ctx.addPartial(p) },
				);
			}
		}
		const result = {
			downloadUrl,
			byteSize,
			...(encoder ? { encoder: encoder.encoder, container: encoder.container } : {}),
			durationSec: planned.output.durationSec,
			frames,
			path: finalPath,
			renderPath: path,
			...(remotionOutput ? { remotionOutput } : {}),
			...(warnings.length ? { warnings } : {}),
			...(audio
				? {
						audioLoudness: {
							integratedLufs: Number.isFinite(audio.loudness.integrated) ? audio.loudness.integrated : null,
							truePeakDbtp: Number.isFinite(audio.loudness.truePeakDb) ? audio.loudness.truePeakDb : null,
							lra: Number.isFinite(audio.loudness.lra) ? audio.loudness.lra : null,
							...(audio.normalized ? { normalizedGainDb: audio.normalized.gainDb } : {}),
						},
					}
				: {}),
			...(captionResult ? { captions: captionResult } : {}),
			planId: planned.plan.planId,
		};
		this.commitRefs(ctx, planned, 'export');
		this.deps.broadcaster.publish(
			'export.finished',
			{
				jobId: ctx.job.id,
				downloadUrl,
				byteSize,
				durationSec: planned.output.durationSec,
				...(finalPath ? { outputPath: finalPath } : {}),
			},
			planned.document.projectId,
		);
		await rm((ctx.input as { request: string }).request, { force: true });
		return result;
	}

	private async runStill(ctx: JobContext): Promise<unknown> {
		const stored = await this.loadRequest(ctx);
		if (stored.kind !== 'still') throw new JobError('BAD_REQUEST', 'Not a still request', false);
		const req = stored.request;
		const settings: ExportSettings = {
			sequenceId: req.sequenceId,
			range: { type: 'entire' },
			container: 'mp4',
			engine: 'auto',
			destination: { type: 'download' },
		};
		let planned: PlannedExport;
		const input: Parameters<typeof planExport>[0] = {
			envelope: req.envelope,
			sequenceId: req.sequenceId,
			settings,
			rangeOverride: { start: req.frame, end: req.frame + 1 },
			still: true,
		};
		try {
			planned = await planExport(input, {
				registry: this.deps.registry,
				fonts: this.deps.fonts,
				capabilities: await this.deps.capabilities(),
				extensions: this.nativeExtensions.all(),
			});
		} catch (e) {
			if (e instanceof PlanError) throw new JobError(e.code, e.message, false, e.detail);
			throw e;
		}
		const seqW = planned.snapshot.settings.width;
		const seqH = planned.snapshot.settings.height;
		if (req.width && req.width !== seqW) {
			try {
				assertFrameSize('The frame', req.width, Math.round((req.width * seqH) / seqW));
			} catch (e) {
				if (e instanceof PlanError) throw new JobError(e.code, e.message, false);
				throw e;
			}
			planned.output.width = req.width;
			planned.output.height = Math.max(2, Math.round((req.width * seqH) / seqW / 2) * 2);
			planned.output.scaling = 'stretch';
		}
		const dir = await this.outDir(ctx);
		const output = join(dir, 'output.png');
		ctx.addPartial(dir);
		let path = planned.plan.path;
		let masters = new Map<string, string>();
		const warnings: { code: string; message: string }[] = [];
		if (path === 'native' || path === 'hybrid') {
			const m = await this.collectMgMasters(planned, ctx);
			if (m === null) path = 'remotion';
			else masters = m;
		}
		if (path === 'native' || path === 'hybrid') {
			// S11:LBK-025: stills and MCP `render_frame` take the export's path — one baked frame per DOM layer
			// (or its cached master / still) — and fall back to Remotion like `auto` exports (LBK-023).
			try {
				await this.runNative(planned, masters, output, ctx, true);
			} catch (e) {
				const replanned = await this.fallbackToRemotion(e, input, ctx, warnings);
				if (!replanned) throw this.unwrap(e);
				planned = replanned;
				path = 'remotion';
			}
		}
		if (path === 'remotion') {
			const prepared = await this.prepareForRemotion(planned, ctx);
			await this.deps.remotion.renderStill({
				inputProps: this.remotionProps(planned, prepared),
				output,
				frame: 0,
				...(req.width && req.width !== seqW ? { scale: req.width / seqW } : {}),
				signal: ctx.signal,
			});
			// color-mgmt: the display rendition of the working space, as the native still path draws it.
			const lut = await displayLutFilter(planned.snapshot.settings.color, await ctx.scratchDir());
			if (lut) {
				const tmp = join(await ctx.scratchDir(), 'display.png');
				await this.deps.ff.run(['-y', '-i', output, '-vf', `format=rgba,${lut}`, '-frames:v', '1', tmp], {
					signal: ctx.signal,
					onSpawn: ctx.trackChild,
				});
				await rename(tmp, output);
			}
		}
		// gaps (File ▸ Export ▸ Frame): the chosen file format and destination folder.
		const format = req.format ?? 'png';
		const ext = STILL_FORMAT_EXTENSIONS[format];
		let written = output;
		try {
			written = await convertStill(this.deps.ff, output, format, ext, {
				...(req.jpegQuality ? { jpegQuality: req.jpegQuality } : {}),
				curve: stillCurveFor(planned.snapshot.settings.color?.space),
				scratch: await ctx.scratchDir(),
				signal: ctx.signal,
				onSpawn: ctx.trackChild,
			});
		} catch (e) {
			if (ctx.signal.aborted) throw e;
			throw new JobError(
				'STILL_FORMAT_FAILED',
				`Writing the ${format.toUpperCase()} file failed: ${(e as Error).message}`,
				false,
			);
		}
		let destPath: string | undefined;
		if (req.destination) {
			try {
				destPath = await copyNoOverwrite(
					written,
					join(req.destination.folder, `${req.destination.name}.${ext}`),
					{
						signal: ctx.signal,
						claimed: (p) => ctx.addPartial(p),
					},
				);
			} catch (e) {
				if (ctx.signal.aborted) throw e;
				const code = (e as NodeJS.ErrnoException).code;
				throw new JobError(
					code === 'ENOSPC' ? 'DISK_FULL' : 'DESTINATION_FAILED',
					`Could not write the frame to ${req.destination.folder}: ${(e as Error).message}`,
					false,
				);
			}
		}
		this.commitRefs(ctx, planned, 'still');
		await rm((ctx.input as { request: string }).request, { force: true });
		return {
			url: `/renders/${ctx.job.id}/output`,
			renderPath: path,
			format,
			...(destPath ? { path: destPath } : {}),
			...(warnings.length ? { warnings } : {}),
		};
	}
}

function sequenceName(p: PlannedExport): string {
	for (const item of Object.values(p.document.items)) {
		if (item.kind === 'sequence' && item.sequenceId === p.sequenceId) return item.name;
	}
	return p.document.name;
}

/** `dest` with the extension of the file actually written (a WebM fallback never lands in `x.mp4`). */
function withExtension(dest: string, ext: string): string {
	const cur = extname(dest);
	if (cur.toLowerCase() === ext.toLowerCase()) return dest;
	return /^\.(mp4|webm|mov|m4v|mkv)$/i.test(cur) ? dest.slice(0, -cur.length) + ext : dest + ext;
}

/**
 * Copies to `dest`, appending " (2)", " (3)"… instead of overwriting (S04:EX-007). The name is claimed with an
 * exclusive create (no race with another export picking the same name) and reported through `claimed` before
 * any byte is written, so a cancelled job can delete it; the copy stops when `signal` aborts (mcp-cli §2).
 */
export async function copyNoOverwrite(
	src: string,
	dest: string,
	opts: { signal?: AbortSignal; claimed?(path: string): void } = {},
): Promise<string> {
	await mkdir(dirname(dest), { recursive: true });
	const ext = extname(dest);
	const stem = basename(dest, ext);
	for (let i = 1; ; i++) {
		const candidate = i === 1 ? dest : join(dirname(dest), `${stem} (${i})${ext}`);
		opts.signal?.throwIfAborted();
		let out: FileHandle;
		try {
			out = await open(candidate, 'wx');
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
			throw e;
		}
		opts.claimed?.(candidate);
		try {
			await pipeline(createReadStream(src), out.createWriteStream(), { signal: opts.signal });
		} catch (e) {
			await rm(candidate, { force: true }).catch(() => undefined);
			throw e;
		} finally {
			await out.close().catch(() => undefined);
		}
		return candidate;
	}
}
