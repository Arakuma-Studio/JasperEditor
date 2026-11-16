// Export and still jobs (ARCHITECTURE §9.5, S04 §10–§13): plan → native filtergraph (ffmpeg) or Remotion
// `renderMedia`; outputs in `<appdir>/renders/<jobId>/`; frame-count verification (FRAME_COUNT_MISMATCH);
// progress mapping (S04:RN-030); `export.finished` event. Motion-graphic masters come from a provider that
// WP-2G registers (`registerMgMasterProvider`).

import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
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
	type AlphaDeliveryRequest,
	type EngineJob,
	type ExportPipeline,
	type ExportResult,
	type ExportSettings,
	type ExportStartRequest,
	type ExportVerifyRequest,
	type GamutCheckRequest,
	type PsdPlan,
	type PsdRequest,
	STILL_FORMAT_EXTENSIONS,
	type StillRequest,
	type StillSheetRequest,
	type StillSheetResult,
} from '@jasper/api';
import {
	buildRenderSnapshot,
	clipContentTime,
	copyableRuns,
	type MediaHandle,
	mediaDecodeHints,
	type RenderSnapshot,
	type RenderVisualClip,
	resolveLayerProps,
	rotoStorePath,
	writeCaptionFile,
} from '@jasper/project';
import { hasSoxr, resamplerArgs } from '../audio/decode.ts';
import { type DeliveryCodec, measureEncodedAudio, needsDecodedCheck } from '../audio/deliver.ts';
import { layoutOf, type MixdownResult, type MixSource, renderMixdown } from '../audio/mixdown.ts';
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
import { variantHasAlpha } from '../imports/variants.ts';
import type { JobQueue } from '../jobs/queue.ts';
import { type JobContext, JobError } from '../jobs/types.ts';
import type { MediaRegistry } from '../media/registry.ts';
import { assertLgplFilters } from '../processing/proc/filters.ts';
import { engineTemplateAssets } from '../remote-assets/plan.ts';
import { appendEncoderArgs, planRemotionExport } from '../remotion/export-plan.ts';
import type { RemotionService } from '../remotion/service.ts';
import { exportAudioWorkers } from '../sound-design/measure-pool.ts';
import { audioEncodeArgs, type EncoderService, pixFmtFor, videoEncodeArgs } from '../tools/encoders.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { exists, fsyncDir, randomId } from '../tools/fs.ts';
import { ToolError, terminateTree } from '../tools/process.ts';
import { LOCAL_PROTOCOLS } from '../tools/protocols.ts';
import { runBlendPipeline } from './blend/run.ts';
import {
	embedArgs,
	embeddedTracks,
	sidecarBytes,
	sidecarName,
	sidecarTracks,
	subtitleCodecFor,
} from './captions.ts';
import { audioOnlyMuxArgs, gifGraphs, gifMuxLoop, gifToRgb } from './deliverables.ts';
import { type DeliveryDeps, type DeliveryFrames, runAlphaDelivery } from './delivery/alpha.ts';
import { runGamutCheck } from './delivery/gamut.ts';
import { runPsdExport } from './delivery/psd-job.ts';
import { planPsd } from './delivery/psd-plan.ts';
import { gpuDecodePolicyFromEnv, nvdecEligible, nvdecForGraph, probeCudaDecode } from './gpu.ts';
import { motionStage } from './keyframed.ts';
import { guardMediaDuring, offlineUsesOf } from './media-guard.ts';
import {
	compositeMemoryBudget,
	compositeProfile,
	estimateFrom,
	memoryFloor,
	memoryRoom,
	overlaysFrom,
} from './memory.ts';
import {
	BT709_FRAME_TAGS,
	buildNativeGraph,
	coverCandidate,
	mixAudioFilters,
	motionCovers,
	SWS_FLAGS,
} from './native.ts';
import {
	type DeferredLayer,
	LayerBakeError,
	layerOverride,
	layerSpan,
	type NativeExtension,
	NativeExtensionRegistry,
	type PreparedExtensions,
	prepareExtensions,
	prepareNestedExtensions,
} from './native-ext.ts';
import { type CompositeSizePlan, outputSizeSnapshot, planCompositeSize } from './output-size.ts';
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
import { joinedRanges, joinPlans, joinRefusal, overlapRefusal } from './ranges.ts';
import { ExportRunReport } from './run-report.ts';
import {
	planPictureSegments,
	type SegmentMemory,
	type SegmentPlan,
	segmentPolicyFromEnv,
} from './segments.ts';
import {
	probeSourceFrames,
	proresProfileMatches,
	SOURCE_CODECS,
	type SourceFrames,
	smartCodecOf,
	smartPieces,
} from './smart.ts';
import {
	CREDITS_DIR,
	CREDITS_FILE_RE,
	type CreditsFormat,
	creditsFileBytes,
	creditsFileName,
	exportSoundCredits,
	resultSoundWarnings,
	soundPlanWarnings,
} from './sound-credits.ts';
import { convertStill, stillCurveFor } from './still-formats.ts';
import { openClPolicyFromEnv, probeOpenClTaps } from './stream/opencl.ts';
import type { StreamLayerPlan } from './stream/plan.ts';
import { streamLayer } from './stream/run.ts';
import { BakeChangedError, streamTaps } from './stream/taps.ts';
import { createSyntheticExtension } from './synthetic.ts';
import { concatFilter, type ExportRun, exportRuns, fallbackRuns, type PreviewPiece } from './use-previews.ts';
import { buildVerifyContext, type OfflineSpan, soundEditsOf, writeVerifyContext } from './verify-context.ts';
import { deliverableOfContainer, EXPORT_JOB_ID_RE, runExportVerify, targetRefusal } from './verify-job.ts';

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

/** Seconds at most between the frames of failed layer bakes rendered as one Remotion stretch (`fallbackRuns`). */
const FALLBACK_MERGE_SEC = 2;
/** Remotion stretches of an export whose layer bakes failed at most; more: the whole range on the Remotion path. */
const MAX_FALLBACK_STRETCHES = 8;
/**
 * The share of a native export's bar its preparation's bakes fill while they report (`NativePrepareContext.progress`);
 * the composite fills the rest. An estimate (≈): the bakes of a measured graphics-heavy export took 222 of 487 s
 * (job log of a 20 270-frame hybrid export, 121 renders), and exports whose bakes are cached take none.
 */
const BAKE_SHARE = 0.3;

/** Remotion concurrency of an export with `slots` CPU slots (S04:RR-004; the Remotion path's bakes follow it). */
function remotionConcurrency(slots: number): number {
	return Math.max(1, Math.min(slots, Math.floor(availableParallelism() / 2)));
}

/** Remotion pages of the native path's layer bakes (`NativePrepareContext.bakePages`): one per granted CPU slot. */
function bakePages(slots: number): number {
	return Math.max(1, Math.min(slots, availableParallelism()));
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
	| { kind: 'still'; request: StillRequest }
	| { kind: 'still-sheet'; request: StillSheetRequest }
	| { kind: 'alpha'; request: AlphaDeliveryRequest }
	| { kind: 'psd'; request: PsdRequest }
	| { kind: 'gamut'; request: GamutCheckRequest };

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

	/** Phases and pipeline of each running export job (result `timings` / `pipeline`). */
	private readonly runReports = new WeakMap<JobContext, ExportRunReport>();
	private report(ctx: JobContext): ExportRunReport {
		let r = this.runReports.get(ctx);
		if (!r) {
			r = new ExportRunReport();
			this.runReports.set(ctx, r);
		}
		return r;
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
		this.deps.queue.registerRunner('still-sheet', (ctx) =>
			this.withRequestCleanup(ctx, () => this.runStillSheet(ctx)),
		);
		// spec 19 §12
		this.deps.queue.registerRunner('alpha-delivery', (ctx) =>
			this.withRequestCleanup(ctx, () => this.runAlpha(ctx)),
		);
		this.deps.queue.registerRunner('psd-export', (ctx) =>
			this.withRequestCleanup(ctx, () => this.runPsd(ctx)),
		);
		this.deps.queue.registerRunner('gamut-check', (ctx) =>
			this.withRequestCleanup(ctx, () => this.runGamut(ctx)),
		);
		// spec 18 AF-VER-001: verification of a finished export
		this.deps.queue.registerRunner('export-verify', (ctx) =>
			runExportVerify(ctx, { ff: this.deps.ff, rendersDir: this.deps.rendersDir, queue: this.deps.queue }),
		);
	}

	/**
	 * `POST /api/exports/:jobId/verify` (spec 18 AF-VER-001): an `export-verify` job measuring a finished export (`fast`
	 * = streams, duration, A/V skew; `full`, the default, = every check) and, with a delivery target, its `target-*` rows.
	 */
	verify(
		exportId: string,
		req: ExportVerifyRequest,
		origin: EngineJob['origin'] = { type: 'user' },
	): EngineJob {
		const job = EXPORT_JOB_ID_RE.test(exportId) ? this.deps.queue.get(exportId) : null;
		if (job?.kind !== 'export') throw new PlanError('NOT_FOUND', 404, `No export job ${exportId}`);
		if (job.state !== 'succeeded')
			throw new PlanError(
				'EXPORT_NOT_FINISHED',
				409,
				`Export ${exportId} is ${job.state}: only a finished export can be verified`,
			);
		// AF-EXP: platform delivery checks are for video files; a GIF or an audio-only file is refused by code
		const container = (job.result as { container?: unknown } | undefined)?.container;
		if (req.target && deliverableOfContainer(container) !== 'video')
			throw new PlanError('TARGET_NOT_APPLICABLE', 400, targetRefusal(container));
		const checks = req.checks ?? 'full';
		// The same checks of the same file give the same rows: a verification this engine ran on the export's output
		// as it still is (size and modification time) is returned again instead of measuring it a second time. Only
		// this process's verifications count, so a newer build with other checks measures again.
		const stamp = this.outputStamp(exportId);
		const key = `export-verify:${exportId}:${checks}:${req.target ?? ''}:${stamp}`;
		const earlier = stamp ? this.verifications.get(key) : undefined;
		const reused = earlier ? this.deps.queue.get(earlier) : null;
		if (reused?.state === 'succeeded') return reused;
		const submitted = this.deps.queue.submit({
			kind: 'export-verify',
			title: `Verify – ${job.title.replace(/^Export – /, '')}${req.target ? ` (${req.target})` : ''}`,
			priority: checks === 'fast' ? 'interactive' : 'user',
			cpuSlots: checks === 'fast' ? 1 : 2,
			minSlots: 1,
			origin,
			...(job.projectId ? { projectId: job.projectId } : {}),
			parentId: exportId,
			dedupeKey: key,
			stage: 'Queued',
			input: { exportId, checks, ...(req.target ? { target: req.target } : {}) },
		});
		if (stamp) this.verifications.set(key, submitted.id);
		return submitted;
	}

	/** Verification jobs of this process by what they measured (`verify`). */
	private readonly verifications = new Map<string, string>();

	/** Size and modification time of a finished export's output file, or '' when it cannot be read. */
	private outputStamp(exportId: string): string {
		try {
			const dir = join(this.deps.rendersDir, exportId);
			const name = readdirSync(dir).find((n) => n.startsWith('output.'));
			if (!name) return '';
			const st = statSync(join(dir, name));
			return `${st.size}:${st.mtimeMs}`;
		} catch {
			return '';
		}
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
		const ranges = joinedRanges(req.settings);
		if (ranges?.length === 1) return this.plan(asOneRange(req));
		if (ranges) {
			const overlap = overlapRefusal(ranges);
			if (overlap) throw new PlanError('VALIDATION_FAILED', 400, overlap);
			return this.planJoined(req, ranges);
		}
		const caps = await this.deps.capabilities();
		const planned = await planExport(
			{
				envelope: req.envelope,
				sequenceId: req.sequenceId,
				settings: { ...req.settings, sequenceId: req.sequenceId },
			},
			this.planDeps(caps),
		);
		const kind = planned.deliverable?.kind;
		// spec 18 AF-EXP: an audio-only file has no picture (the planner says previews are unused); a GIF's picture is
		// rendered and converted, never stream-copied
		if (req.settings.usePreviews && kind !== 'audio') await this.attachPreviews(planned, req.settings);
		if (kind) {
			if (req.settings.smartRender === true)
				planned.plan.smart = {
					used: false,
					copiedFrames: 0,
					reasons: [
						kind === 'gif'
							? 'GIF frames are always rendered and converted'
							: 'Audio-only exports have no picture to copy',
					],
				};
		} else if (!planned.previews) await this.attachSmart(planned, req.settings);
		if ((planned.plan.path === 'native' || planned.plan.path === 'hybrid') && kind !== 'audio')
			planned.plan.pipeline = await this.expectedPipeline(planned);
		return planned;
	}

	/**
	 * ranges.ts: a multi-range export, planned as one `custom` range export per range (picture only: the sound is mixed
	 * per range and joined by `renderAudio`) and joined into the plan of the file. Use Previews and smart rendering do
	 * not apply (each range renders through its own path).
	 */
	private async planJoined(
		req: { envelope: { revision: number; document: unknown }; sequenceId: string; settings: ExportSettings },
		ranges: readonly { start: number; end: number }[],
	): Promise<PlannedExport> {
		const parts: PlannedExport[] = [];
		for (const r of ranges)
			parts.push(
				await this.plan({
					...req,
					settings: {
						...req.settings,
						range: { type: 'custom', startFrame: r.start, endFrame: r.end },
						usePreviews: false,
						smartRender: false,
					},
				}),
			);
		const first = parts[0]!;
		const refusal = joinRefusal(req.settings, first);
		if (refusal) throw new PlanError('VALIDATION_FAILED', 400, refusal);
		const sound = soundPlanWarnings(
			first.document,
			first.sequenceId,
			{ audioClips: parts.flatMap((p) => p.snapshot.audioClips) },
			req.settings,
		);
		const joined = joinPlans(parts, req.settings, sound);
		if (req.settings.usePreviews)
			joined.plan.warnings.push({
				code: 'PREVIEWS_UNUSED',
				message: 'Several ranges render through their own paths: render previews are not used',
			});
		return joined;
	}

	/** How the composite of a native / hybrid export is expected to run (plan `pipeline`; the result's is what ran). */
	private async expectedPipeline(planned: PlannedExport): Promise<ExportPipeline> {
		const snap = planned.snapshot;
		const gpu = gpuDecodePolicyFromEnv();
		const nvdec =
			gpu.mode === 'auto' &&
			gpu.maxInputs > 0 &&
			snap.videoTracks.some((t) =>
				t.clips.some((c) => {
					const m = 'mediaId' in c.source ? planned.media[c.source.mediaId] : undefined;
					return c.kind === 'video' && !!m && nvdecEligible(m);
				}),
			) &&
			(await probeCudaDecode(this.deps.ff)).ok;
		// (the export job asks for every CPU slot of the queue: the segments it will plan)
		const { segments, reason, concurrency, peakBytes } = planPictureSegments({
			snapshot: snap,
			output: planned.output,
			slots: this.deps.queue.totalSlots,
			policy: segmentPolicyFromEnv(),
			memory: segmentMemory(snap),
		});
		const comp = planCompositeSize(snap, planned.output);
		const drawSnap = outputSizeSnapshot(snap, comp);
		const size = drawSnap.settings;
		// The builder's graphs (§12, AS-072): base pieces draw no overlay, a track's constant-picture layers one per kernel
		// stream, which the plain layer count did not know (345 planned, 5 built on the real project).
		const exts = this.nativeExtensions.all();
		const fps = drawSnap.settings.fps;
		const covers = (c: RenderVisualClip): boolean => {
			if (!coverCandidate(c) || exts.some((e) => e.claimsLayer?.(c) || e.retimes?.(c))) return false;
			const m = 'mediaId' in c.source ? planned.media[c.source.mediaId] : undefined;
			if (!m || variantHasAlpha(m.record, m.pixel ?? null)) return false;
			const [f0, f1] = layerSpan(c, drawSnap.range);
			if (f1 <= f0) return false;
			const bw = Math.max(1, Math.round(c.intrinsicBox.width));
			const bh = Math.max(1, Math.round(c.intrinsicBox.height));
			const { width: W, height: H } = drawSnap.settings;
			const props = resolveLayerProps(c, clipContentTime(c, f0, fps));
			const motion = motionStage({
				clip: c,
				f0,
				f1,
				R0: drawSnap.range.start,
				fps,
				props,
				bw,
				bh,
				W,
				H,
				label: 'p',
			});
			return motionCovers(motion, bw, bh, W, H);
		};
		const profile = compositeProfile(drawSnap, covers);
		// docs/wp-notes/export-performance.md §10: where kernel streams will be drawn (streams that do not fit the OpenCL
		// program are known when the graphs are built: the result names them)
		const cl = await probeOpenClTaps(this.deps.ff, openClPolicyFromEnv());
		return {
			decode: nvdec ? 'nvdec' : 'cpu',
			composite: {
				device: 'cpu',
				size: comp.size,
				...(comp.fallbackReasons.length ? { fallbackReasons: comp.fallbackReasons } : {}),
			},
			kernel: cl.ok ? { device: 'opencl' } : { device: 'cpu', fallbackReasons: [cl.reason] },
			segments: segments.length,
			concurrency,
			overlays: Math.max(0, ...segments.map((s) => overlaysFrom(drawSnap, profile, s))),
			compositeSize: { width: size.width, height: size.height },
			memoryBytes: peakBytes,
			...(reason ? { reason } : {}),
		};
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
				ctx.log(`ffmpeg ${commandLine(args)}`);
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
		const audioIn = audioStream(planned, audio, soxr);
		const audioInput = o.videoOnly
			? []
			: audioIn
				? ['-i', audioIn.file]
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
						...(audioIn?.args ?? [
							...audioEncodeArgs(audioCodecOf(o.encoder, o), o.audioBitrateKbps, o.audioChannels),
							'-ar',
							String(o.audioSampleRate),
							'-ac',
							String(o.audioChannels),
						]),
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
			ctx.log(`ffmpeg ${commandLine(vargs)}`);
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
		ctx.log(`ffmpeg ${commandLine(args)}`);
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

	/** Warnings of the extensions' preparations (`NativePrepareContext.warn`) by job, until the render takes them. */
	private readonly prepareWarnings = new Map<string, { code: string; message: string }[]>();
	private prepareWarn(ctx: JobContext): (w: { code: string; message: string }) => void {
		return (w) => {
			const list = this.prepareWarnings.get(ctx.job.id) ?? [];
			list.push(w);
			this.prepareWarnings.set(ctx.job.id, list);
		};
	}
	private takePrepareWarnings(ctx: JobContext): { code: string; message: string }[] {
		const list = this.prepareWarnings.get(ctx.job.id) ?? [];
		this.prepareWarnings.delete(ctx.job.id);
		return list;
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
	 * encodes previews + intermediates with the export's encoder and mix. A multi-range export (ranges.ts) renders every
	 * range so, to ProRes 4444 (4:4:4, no chroma loss before the one encode), joined in the order given.
	 */
	private async renderWithPreviews(
		ctx: JobContext,
		req: ExportStartRequest,
		planned: PlannedExport,
		output: string,
		runs: ExportRun[],
		/** The export's mix when it was started already (a render that left the native path). */
		mix?: Promise<MixdownResult | null>,
	): Promise<{
		planned: PlannedExport;
		frames: number;
		path: 'copy' | 'native' | 'hybrid' | 'remotion';
		remotionOutput: 'direct' | 'intermediate' | undefined;
		warnings: { code: string; message: string }[];
		audio: MixdownResult | null;
	}> {
		const audio = planned.output.videoOnly ? null : await (mix ?? this.renderAudio(planned, ctx));
		const seq = planned.snapshot.settings;
		const files: string[] = [];
		const counts: number[] = [];
		const warnings: { code: string; message: string }[] = [];
		let path: 'native' | 'hybrid' | 'remotion' = 'native';
		const total = Math.max(
			1,
			runs.reduce((n, r) => n + r.end - r.start, 0),
		);
		const proresProfile = planned.joined ? '4444' : 'hq';
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
							...(r.engine ? { engine: r.engine } : {}),
							video: {
								codec: 'prores',
								proresProfile,
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
			// ProRes 4444 intermediates of joined ranges: no 8-bit rounding (and its dither) before the one encode
			...(planned.joined ? { pixFmt: 'yuv444p12le' } : {}),
		});
		assertLgplFilters(filter); // AF-SEC-003: the script file is not an argument Ffmpeg.run can check
		const script = join(await ctx.scratchDir(), 'previews-graph.txt');
		await writeFile(script, filter);
		const soxr = await hasSoxr(this.deps.ff);
		const audioIn = audioStream(planned, audio, soxr);
		const ai = files.length;
		const args = [
			...enc.pre,
			...files.flatMap((f) => ['-i', f]),
			...(audioIn ? ['-i', audioIn.file] : []),
			'-filter_complex_script',
			script,
			'-map',
			'[vout]',
			...(audioIn ? ['-map', `${ai}:a:0`] : []),
			...enc.video,
			...['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'],
			'-r',
			`${o.fps.num}/${o.fps.den}`,
			'-frames:v',
			String(o.frames),
			...(audioIn ? [...audioIn.args, '-shortest'] : ['-an']),
			'-threads',
			String(Math.max(1, ctx.slots)),
			...(o.encoder?.container !== 'webm' ? ['-movflags', '+faststart'] : []),
			'-f',
			o.encoder?.container ?? 'mp4',
			output,
		];
		ctx.log(`ffmpeg ${commandLine(args)}`);
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
		// touching ranges that merge into one are stored as the plain range export they are (fallbacks re-plan it)
		req = asOneRange(req);
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

	/** `POST /api/stills/sheet` (spec 19 TL-103): several stills as one job, cancelled and waited on as one. */
	async stillSheet(
		req: StillSheetRequest,
		origin: EngineJob['origin'] = { type: 'user' },
	): Promise<EngineJob> {
		const file = await this.storeRequest({ kind: 'still-sheet', request: req });
		const doc = req.documents[0]!.document as { projectId?: string };
		return this.deps.queue.submit({
			kind: 'still-sheet',
			title: `${req.cells.length} frames`,
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
			ctx.log(`ffmpeg ${commandLine(args)}`);
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

	/**
	 * spec 12 §2.11: the sound credits sidecar (`credits/output.credits.<ext>` in the job directory, so `output.*` stays
	 * the job's only output file): the library sounds the export's mixer plays. No file when none is heard.
	 */
	private async writeCreditsSidecar(
		planned: PlannedExport,
		settings: ExportSettings,
		dir: string,
		ctx: JobContext,
	): Promise<NonNullable<ExportResult['credits']> | null> {
		const format = settings.credits?.sidecar as CreditsFormat | null | undefined;
		if (!format || planned.output.videoOnly || planned.output.alpha) return null;
		const scope = settings.credits?.scope === 'attribution' ? 'attribution' : 'all';
		// ranges.ts: the sounds heard in any of a multi-range export's ranges
		const heard = planned.joined
			? { audioClips: planned.joined.flatMap((p) => p.snapshot.audioClips) }
			: planned.snapshot;
		const credits = exportSoundCredits(planned.document, planned.sequenceId, heard, scope);
		const bytes = creditsFileBytes(credits, format);
		if (!bytes) {
			ctx.log('credits: no library sound is heard in the exported range; no credits file');
			return { format, scope, count: 0 };
		}
		const name = creditsFileName('output', format);
		await mkdir(join(dir, CREDITS_DIR), { recursive: true });
		await writeFile(join(dir, CREDITS_DIR, name), bytes);
		return {
			format,
			scope,
			count: credits.rows.length,
			name,
			url: `/renders/${ctx.job.id}/${CREDITS_DIR}/${encodeURIComponent(name)}`,
		};
	}

	/**
	 * spec 18 AF-VER-001: `verify.json` in the job directory (the export settings and the range's cuts with what the
	 * timeline intends at each). A failure only costs the later verification its context (rows say `unverified`).
	 */
	private async writeVerifyContext(
		planned: PlannedExport,
		dir: string,
		hasAudio: boolean,
		frames: number,
		ctx: JobContext,
		offline: readonly OfflineSpan[],
	): Promise<void> {
		const del = planned.deliverable;
		try {
			const o = planned.output;
			const enc = o.encoder;
			await writeVerifyContext(
				dir,
				buildVerifyContext({
					document: planned.document,
					sequenceId: planned.sequenceId,
					range: planned.range,
					...(planned.joined ? { pieces: planned.joined.map((p) => p.range) } : {}),
					soundEdits: soundEditsOf(planned.joined?.map((p) => p.snapshot) ?? [planned.snapshot]),
					offline,
					output: { ...o, encoder: enc ? { container: enc.container, codec: enc.codec } : null },
					pixFmt: enc
						? o.alpha
							? 'yuva444p10le'
							: pixFmtFor(enc.encoder, o.proresProfile, o.color?.bitDepth ?? 8)
						: null,
					audioEncoder: hasAudio ? audioCodecOf(enc ?? null, o) : null,
					...(del?.kind === 'gif'
						? {
								deliverable: {
									kind: 'gif' as const,
									fps: del.gif.fps,
									width: del.gif.width,
									height: del.gif.height,
									frames,
								},
							}
						: del?.kind === 'audio'
							? {
									deliverable: {
										kind: 'audio' as const,
										container: del.audio.container,
										codec: del.audio.codec,
										bitDepth: del.audio.bitDepth,
									},
								}
							: {}),
				}),
			);
		} catch (e) {
			ctx.log(`verify context not written: ${(e as Error).message}`);
		}
	}

	/** The sound credits sidecar of a finished render job (`/renders/:jobId/credits/:name`). */
	async creditsFile(jobId: string, name: string): Promise<string | null> {
		if (!JOB_ID_RE.test(jobId) || !CREDITS_FILE_RE.test(name)) return null;
		const job = this.deps.queue.get(jobId);
		if (job && job.state !== 'succeeded') return null;
		const file = join(this.deps.rendersDir, jobId, CREDITS_DIR, name);
		return (await exists(file)) ? file : null;
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

	/** A cell of a finished `still-sheet` job (`/renders/:jobId/cells/:index`). */
	async sheetCellFile(jobId: string, index: string): Promise<string | null> {
		if (!JOB_ID_RE.test(jobId) || !/^\d{1,3}$/.test(index)) return null;
		const job = this.deps.queue.get(jobId);
		if (job && job.state !== 'succeeded') return null;
		const file = join(this.deps.rendersDir, jobId, `cell-${Number(index)}.png`);
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
		/** The clips to pin (default: all; §13: a deferred bake's once it is ready). */
		only: (clipId: string) => boolean = () => true,
	): Promise<void> {
		if (!this.cache) return;
		const paths = new Set(masters.values());
		for (const clip of planned.snapshot.videoTracks.flatMap((t) => t.clips)) {
			if (!only(clip.clipId)) continue;
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
		audioIn: MixdownResult | null | Promise<MixdownResult | null> = null,
		pipeline = true,
		/** One graph for the range whatever the segment policy says (segments that could not be joined). */
		segmentsOff = false,
		/**
		 * output-size.ts: composite at the sequence size for these reasons (a picture placed in sequence pixels did not land
		 * on whole output pixels; the extensions prepare again at the sequence size). Null = decide by `planCompositeSize`.
		 */
		compositeFallback: string[] | null = null,
		/** docs/wp-notes/export-performance.md §10: the OpenCL kernel failed in an earlier attempt (the CPU draws). */
		openClFailure: string | null = null,
	): Promise<number> {
		// output-size.ts: decided before the extensions prepare (the layer bake renders masters at the composite size)
		const comp0: CompositeSizePlan = compositeFallback
			? { size: 'sequence', scale: 1, fallbackReasons: compositeFallback }
			: planCompositeSize(planned.snapshot, planned.output, { still });
		const plannedC: PlannedExport = { ...planned, composite: comp0 };
		const exts = this.nativeExtensions.all();
		let prepared: Map<string, unknown>;
		let nested: Map<string, PreparedExtensions>;
		// spec 13 AS-076: work the extensions continue during the composite (pipelined still bakes).
		const background: Promise<void>[] = [];
		const settle = () => Promise.allSettled(background);
		// Stopped with the job, and when the export fails otherwise (nothing waits for the stills then).
		const bgAbort = new AbortController();
		const onAbortBg = () => bgAbort.abort();
		ctx.signal.addEventListener('abort', onAbortBg, { once: true });
		let bgError: unknown = null;
		const abandon = async () => {
			bgAbort.abort();
			await settle();
		};
		/** `e`, or the background failure that caused it (a preparation error). */
		const failure = (e: unknown) => (bgError !== null ? new NativePrepareError(bgError) : e);
		/** A pipelined still came out different: everything again without the pipeline (its bakes are cached). */
		const restart = async (why: string): Promise<number> => {
			ctx.log(`native: ${why}; preparing again without pipelined stills`);
			await settle();
			ctx.signal.removeEventListener('abort', onAbortBg);
			if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
			return this.runNative(
				planned,
				masters,
				output,
				ctx,
				still,
				audioIn,
				false,
				segmentsOff,
				compositeFallback,
				openClFailure,
			);
		};
		const report = this.report(ctx);
		const endBake = report.begin('bake');
		/**
		 * docs/wp-notes/export-performance.md §13: bakes that continue beside the composite (`NativePrepareContext.defer`).
		 * A segment is built and started once those drawn in its frames are ready.
		 */
		const deferred: DeferredLayer[] = [];
		/** Deferred bakes that are done. */
		const baked = new Set<DeferredLayer>();
		/** Lanes waiting for a composite to end, a bake to be ready or the export to stop. */
		const waiting: (() => void)[] = [];
		const wake = () => {
			for (const w of waiting.splice(0)) w();
		};
		/** Where the preparation's bakes moved the bar (`BAKE_SHARE` once done; 0 without any): the composite goes on from it. */
		let bakeBar = 0;
		try {
			const pctx = {
				signal: ctx.signal,
				stage: (text: string) => ctx.progress(bakeBar, { stage: text }),
				progress: (f: number, text: string) => {
					bakeBar = Math.max(bakeBar, BAKE_SHARE * Math.min(1, Math.max(0, Number.isFinite(f) ? f : 0)));
					ctx.progress(bakeBar, { stage: text });
				},
				scratchDir: () => ctx.scratchDir(),
				log: (text: string) => ctx.log(text),
				jobId: ctx.job.id,
				...(planned.document.projectId ? { projectId: planned.document.projectId } : {}),
				purpose: 'native' as const,
				concurrency: remotionConcurrency(ctx.slots),
				bakePages: bakePages(ctx.slots),
				...(this.pinFor(ctx) ? { pin: this.pinFor(ctx) } : {}),
				pipeline: pipeline && !still,
				backgroundSignal: bgAbort.signal,
				warn: this.prepareWarn(ctx),
				background: (work: Promise<void>) => {
					// A failure of the work itself (not our abort): the export fails as a preparation does (LBK-023
					// fallback to the Remotion path for `auto`).
					work.catch((e) => {
						if (!bgAbort.signal.aborted) bgError ??= e;
					});
					background.push(work);
				},
				...(pipeline && !still
					? {
							defer: (d: DeferredLayer) => {
								deferred.push(d);
								d.ready.then(
									() => {
										baked.add(d);
										wake();
									},
									() => wake(),
								);
							},
						}
					: {}),
			};
			prepared = await prepareExtensions(exts, plannedC, pctx);
			// edit-structure: nested sequences are drawn in the same graph; their layers get their own preparations
			// (without pipelined stills or deferred bakes: nested stacks have no kernel stream members of their own to wait).
			nested = await prepareNestedExtensions(exts, planned, { ...pctx, pipeline: false });
		} catch (e) {
			await abandon();
			if (ctx.signal.aborted) throw e;
			throw new NativePrepareError(e);
		} finally {
			// (the bake phase lasts until the deferred bakes are done)
			if (deferred.length) void Promise.allSettled(deferred.map((d) => d.ready)).then(endBake);
			else endBake();
		}
		if (bakeBar > 0) bakeBar = BAKE_SHARE;
		const deferredClips = new Set(deferred.flatMap((d) => d.clipIds));
		// The mixdown (started before the preparation): an input of a one-graph composite, which waits for it; segments
		// render while it is delivered (their sound is encoded and joined when it is ready).
		const audioP = Promise.resolve(audioIn);
		audioP.catch(() => {});
		const endPlan = report.begin('plan');
		await this.pinInputs(ctx, planned, exts, prepared, masters, (id) => !deferredClips.has(id));
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
		ctx.progress(bakeBar, { stage: 'Planning layers' });
		// Parallel picture segments (segments.ts): each an export of its own sub-range, picture only, joined below.
		const snap = planned.snapshot;
		const segPlan: SegmentPlan = still
			? { segments: [{ start: snap.range.start, end: snap.range.end }], concurrency: 1, peakBytes: 0 }
			: planPictureSegments({
					snapshot: snap,
					output: planned.output,
					slots: ctx.slots,
					policy: segmentsOff ? { ...segmentPolicyFromEnv(), count: 1 } : segmentPolicyFromEnv(),
					memory: segmentMemory(snap),
				});
		// spec 13 AS-074 / AGENTS §0: refused by name when even one short segment at a time would not fit (memory taken
		// since the plan), never an out-of-memory kill
		if (segPlan.blocker) {
			endPlan();
			await abandon();
			throw new JobError('INSUFFICIENT_MEMORY', `Not enough memory: ${segPlan.blocker}`, true, {
				estimateBytes: segPlan.peakBytes,
			});
		}
		const split = segPlan.segments.length > 1;
		let audio: MixdownResult | null = null;
		if (!split) {
			const endWait = report.begin('audioWait');
			audio = await audioP
				.catch(async (e) => {
					endPlan();
					await abandon();
					throw e;
				})
				.finally(endWait);
		}
		/** Segments rendering at once. */
		const atOnce = split ? Math.max(1, Math.min(segPlan.concurrency, segPlan.segments.length)) : 1;
		const fps = snap.settings.fps;
		const frameSec = fps.den / fps.num;
		const ext = planned.output.encoder?.container ?? 'mp4';
		const soxr = await hasSoxr(this.deps.ff);
		// GPU decode (gpu.ts): NVDEC for the graphs' own video inputs when a CUDA device works
		const gpuPolicy = gpuDecodePolicyFromEnv();
		const nvdec =
			!still && gpuPolicy.mode === 'auto' && gpuPolicy.maxInputs > 0
				? await probeCudaDecode(this.deps.ff)
				: {
						ok: false,
						reason: still ? 'stills decode on the CPU' : 'GPU decode is off (JASPER_EXPORT_NVDEC=0)',
					};
		if (!still) ctx.log(`native: decode ${nvdec.ok ? 'NVDEC (cuda)' : `CPU (${nvdec.reason})`}`);
		// docs/wp-notes/export-performance.md §10: kernel streams drawn by the OpenCL program when a device passes the probe
		const openCl = still
			? ({ ok: false, reason: 'stills draw on the CPU' } as const)
			: openClFailure
				? ({ ok: false, reason: openClFailure } as const)
				: await probeOpenClTaps(this.deps.ff, openClPolicyFromEnv());
		type Part = { graph: ReturnType<typeof buildNativeGraph>; file: string; args: string[]; label: string };
		/** The segments' composites, built once the bakes they draw are ready (§13). */
		const parts: (Part | undefined)[] = segPlan.segments.map(() => undefined);
		const labels = segPlan.segments.map((s, i) =>
			split ? `segment ${i + 1}/${segPlan.segments.length} [${s.start}, ${s.end})` : '',
		);
		/** The deferred bakes drawn in each segment's frames. */
		const needs = segPlan.segments.map((s) => deferred.filter((d) => d.start < s.end && d.end > s.start));
		const isReady = (i: number) => needs[i]!.every((d) => baked.has(d));
		/**
		 * §13: the pipelined stills each segment draws (rendered in time order beside the composites): a segment starts
		 * once they are written, except the earliest one left, which streams behind them (a composite that started ahead
		 * of them would hold its place while it waits).
		 */
		const stillsWritten = new Set<Promise<unknown>>();
		const stills = segPlan.segments.map((s) => {
			const list = new Set<Promise<unknown>>();
			for (const c of snap.videoTracks.flatMap((t) => t.clips)) {
				if (deferredClips.has(c.clipId)) continue;
				const [f0, f1] = layerSpan(c, s);
				const ready = f1 > f0 ? layerOverride(exts, prepared, c)?.ready : undefined;
				if (ready) list.add(ready);
			}
			return [...list];
		});
		for (const r of new Set(stills.flat()))
			r.then(
				() => {
					stillsWritten.add(r);
					wake();
				},
				() => wake(),
			);
		const stillsReady = (i: number) => stills[i]!.every((r) => stillsWritten.has(r));
		// output-size.ts: a downscaled export is composited on an output-size canvas, unless a feature needs the sequence
		// size — or a picture placed in sequence pixels would not land on whole output pixels (then built again)
		const comp = comp0;
		const drawSnap = outputSizeSnapshot(snap, comp);
		const threads = split ? Math.max(1, Math.floor(ctx.slots / atOnce)) : ctx.slots;
		/** Pins the cache files of the deferred bakes a segment draws (they were ready after `pinInputs`). */
		const pinned = new Set<DeferredLayer>();
		const buildPart = async (i: number): Promise<Part> => {
			for (const d of needs[i]!) {
				if (pinned.has(d)) continue;
				pinned.add(d);
				await this.pinInputs(ctx, planned, exts, prepared, new Map(), (id) => d.clipIds.includes(id));
			}
			const s = segPlan.segments[i]!;
			const n = s.end - s.start;
			const file = split ? join(await ctx.scratchDir(), `segment-${i}.${ext}`) : output;
			const graph = buildNativeGraph({
				colorLut,
				snapshot: split ? { ...drawSnap, range: { start: s.start, end: s.end } } : drawSnap,
				...(comp.size === 'output' ? { compositeScale: comp.scale } : {}),
				output: split
					? { ...planned.output, frames: n, durationSec: n * frameSec, videoOnly: true }
					: planned.output,
				outputFile: file,
				sources: {
					media: (id) => planned.media[id] ?? null,
					mgMaster: (id) => masters.get(id) ?? null,
				},
				threads,
				...(split ? { filterThreads: threads } : {}),
				// (the export's GPU decoders are shared by its concurrent segments)
				...(nvdec.ok ? { hwDecode: nvdecForGraph(Math.floor(gpuPolicy.maxInputs / atOnce)) } : {}),
				...(openCl.ok ? { openCl: openCl.taps } : {}),
				still,
				trackStreams: process.env.JASPER_EXPORT_TRACK_STREAMS !== '0',
				coverBase: process.env.JASPER_EXPORT_COVER_BASE !== '0',
				extensions: { list: exts, prepared },
				...(audio?.path && !split
					? {
							audio: {
								file: audio.path,
								sampleRate: audio.sampleRate,
								soxr,
								// the delivery's checked encode: muxed by stream copy
								...(deliveredEncode(planned, audio) ? { encoded: deliveredEncode(planned, audio)! } : {}),
							},
						}
					: {}),
				nested,
			});
			// AF-SEC-003: no GPL-only filter in the composite's or a blend segment's graph, before anything starts (a
			// long graph goes to a -filter_complex_script file, which Ffmpeg.run's own argument check cannot see).
			assertLgplFilters(graph.filter);
			for (const seg of graph.blend?.segments ?? []) assertLgplFilters(seg.filter);
			const part: Part = { graph, file, args: graph.args, label: labels[i]! };
			if (graph.filter.length > 60_000) {
				const script = join(await ctx.scratchDir(), `graph-${i}.txt`);
				await writeFile(script, graph.filter);
				const k = part.args.indexOf('-filter_complex');
				part.args = [...part.args.slice(0, k), '-filter_complex_script', script, ...part.args.slice(k + 2)];
			}
			for (const [k, seg] of (graph.blend?.segments ?? []).entries()) {
				if (seg.filter.length > 60_000) {
					const script = join(await ctx.scratchDir(), `blend-${i}-${k}.txt`);
					await writeFile(script, seg.filter);
					const a = seg.args.indexOf('-filter_complex');
					seg.args = [...seg.args.slice(0, a), '-filter_complex_script', script, ...seg.args.slice(a + 2)];
				}
				ctx.log(
					`ffmpeg (${part.label ? `${part.label}, ` : ''}blend layer ${k + 1}) ${commandLine(seg.args)}`,
				);
			}
			ctx.log(`ffmpeg${part.label ? ` (${part.label})` : ''} ${commandLine(part.args)}`);
			parts[i] = part;
			if (parts.every((p) => p !== undefined)) reportPipeline(parts as Part[]);
			return part;
		};
		/** The result's `pipeline`, once every composite is built. */
		const reportPipeline = (built: readonly Part[]): void => {
			const kernel = {
				opencl: built.reduce((n, p) => n + p.graph.kernel.opencl, 0),
				cpu: built.reduce((n, p) => n + p.graph.kernel.cpu, 0),
				fallbackReasons: [
					...new Set([
						...(openCl.ok ? [] : [openCl.reason]),
						...built.flatMap((p) => p.graph.kernel.fallbackReasons),
					]),
				].slice(0, 20),
			};
			if (still) return;
			report.pipeline = {
				decode: built.some((p) => p.graph.hwDecoded > 0) ? 'nvdec' : 'cpu',
				composite: {
					device: 'cpu',
					size: comp.size,
					...(comp.fallbackReasons.length ? { fallbackReasons: comp.fallbackReasons } : {}),
				},
				...(kernel.opencl + kernel.cpu > 0
					? {
							kernel: {
								device: kernel.opencl > 0 ? ('opencl' as const) : ('cpu' as const),
								streams: { opencl: kernel.opencl, cpu: kernel.cpu },
								...(kernel.fallbackReasons.length ? { fallbackReasons: kernel.fallbackReasons } : {}),
							},
						}
					: {}),
				segments: built.length,
				concurrency: atOnce,
				memoryBytes: segPlan.peakBytes,
				overlays: Math.max(...built.map(graphOverlays)),
				compositeSize: { width: drawSnap.settings.width, height: drawSnap.settings.height },
				...(segPlan.reason ? { reason: segPlan.reason } : {}),
			};
			if (kernel.opencl + kernel.cpu > 0)
				ctx.log(
					`native: kernel streams: ${kernel.opencl} on the OpenCL device, ${kernel.cpu} on the CPU${kernel.fallbackReasons.length ? ` (${kernel.fallbackReasons.join('; ')})` : ''}`,
				);
		};
		/** Composited at the sequence size instead (prepared for the output size: masters rendered at it). */
		const atSequenceSize = async (inexact: string[]): Promise<number> => {
			ctx.log(`native: composited at the sequence size instead: ${inexact.slice(0, 5).join('; ')}`);
			await settle();
			ctx.signal.removeEventListener('abort', onAbortBg);
			if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
			return this.runNative(
				planned,
				masters,
				output,
				ctx,
				still,
				audioIn,
				pipeline,
				segmentsOff,
				inexact.slice(0, 20),
				openClFailure,
			);
		};
		const inexactOf = (p: Part) => (comp.size === 'output' ? p.graph.inexact : []);
		try {
			for (const i of segPlan.segments.keys()) if (isReady(i)) await buildPart(i);
		} catch (e) {
			await abandon();
			throw e;
		} finally {
			endPlan();
		}
		const inexact = [...new Set(parts.flatMap((p) => (p ? inexactOf(p) : [])))];
		if (inexact.length) return atSequenceSize(inexact);
		if (!still)
			ctx.log(
				`native: composited at the ${comp.size} size (${drawSnap.settings.width}×${drawSnap.settings.height})${comp.fallbackReasons.length ? `: ${comp.fallbackReasons.join('; ')}` : ''}`,
			);
		ctx.log(
			`native: estimated composite memory ${(segPlan.peakBytes / 1024 ** 3).toFixed(1)} GB of a ${(compositeMemoryBudget() / 1024 ** 3).toFixed(1)} GB budget`,
		);
		if (split)
			ctx.log(
				`native: ${segPlan.segments.length} picture segments, ${atOnce} at a time${segPlan.reason ? ` (${segPlan.reason})` : ''}: ${labels.join(', ')}`,
			);
		else if (segPlan.reason) ctx.log(`native: one graph (${segPlan.reason})`);
		if (deferred.length > baked.size)
			ctx.log(
				`native: ${deferred.length - baked.size} bake(s) still rendering; ${segPlan.segments.filter((_, i) => !isReady(i)).length} segment(s) start when theirs are ready`,
			);
		const total = segPlan.segments.reduce(
			(t, s) => t + (split ? (s.end - s.start) * frameSec : planned.output.durationSec),
			0,
		);
		const started = Date.now();
		// Sub-pixel layers stream into the composite's pipes while it runs (stream/run.ts). A failed stream stops the
		// composite and is the reported error.
		const streamAbort = new AbortController();
		// Every segment's composite stops when the job is cancelled or another segment fails (its error is reported).
		const runAbort = new AbortController();
		const onJobAbort = () => {
			streamAbort.abort();
			runAbort.abort();
		};
		ctx.signal.addEventListener('abort', onJobAbort, { once: true });
		if (ctx.signal.aborted) onJobAbort();
		const producers: Promise<void>[] = [];
		let streamError: Error | null = null;
		// (streams the OpenCL kernel draws use no kernel threads)
		const cpuStreams = (streams: ReturnType<typeof buildNativeGraph>['streams']) =>
			streams.filter((s) => !('kind' in s.plan && s.plan.kind === 'taps' && s.plan.gpu)).length;
		// (the streams of the segments rendering at once share the CPU)
		const workersFor = (graph: Part['graph']) =>
			Math.max(
				2,
				Math.floor(
					Math.max(1, ctx.slots) /
						Math.max(
							1,
							(cpuStreams(graph.streams) +
								(graph.blend?.segments.reduce((m, sg) => m + cpuStreams(sg.streams) + 1, 0) ?? 0)) *
								atOnce,
						),
				),
			);
		/** `onSpawn`: each decoder process the streams start (the job tracks it; the watchdog counts its memory). */
		const runStreams = (
			child: ChildProcess,
			streams: ReturnType<typeof buildNativeGraph>['streams'],
			workers: number,
			onSpawn: (c: ChildProcess) => void,
		) => {
			for (const s of streams) {
				const sink = child.stdio[s.fd] as Writable;
				const run = { workers, signal: streamAbort.signal, onSpawn };
				producers.push(
					('kind' in s.plan && s.plan.kind === 'taps'
						? streamTaps(this.deps.ff, s.plan, sink, run)
						: streamLayer(this.deps.ff, s.plan as StreamLayerPlan, sink, run)
					).catch((e: Error) => {
						if (streamAbort.signal.aborted) return;
						streamError ??= e;
						void terminateTree(child, 500);
					}),
				);
			}
		};
		// keyframes-blend: the processes before the composite run while it runs; the last kernel feeds its pipe:3.
		const runBlend = (
			child: ChildProcess,
			blend: ReturnType<typeof buildNativeGraph>['blend'],
			workers: number,
			onSpawn: (c: ChildProcess) => void,
		) => {
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
						onSpawn,
						runStreams: (c, streams) => runStreams(c, streams, workers, onSpawn),
					},
				).catch((e: Error) => {
					if (streamAbort.signal.aborted) return;
					streamError ??= e;
					void terminateTree(child, 500);
				}),
			);
		};
		const done = segPlan.segments.map(() => 0);
		/** The bar at `encoded` seconds of `total`: from where the bakes left it to 96 % (segments: joined after) or 98 %. */
		const bar = (encoded: number) => bakeBar + (encoded / total) * ((split ? 0.96 : 0.98) - bakeBar);
		const fraction = () => (still || total <= 0 ? bakeBar : bar(done.reduce((a, b) => a + b, 0)));
		/**
		 * What ended the composites early: a failure (`part` = the composite it came from, if any), or the export to run
		 * again another way (`again`: a pipelined still changed, a picture off the output grid).
		 */
		let failed: { error: unknown; part?: Part; again?: () => Promise<number> } | null = null;
		runAbort.signal.addEventListener('abort', wake, { once: true });
		const fail = (f: NonNullable<typeof failed>) => {
			failed ??= f;
			runAbort.abort();
		};
		// §13: a failed deferred bake fails the export with its error, stopping the composites (a cancelled one is the
		// job's cancellation).
		for (const d of deferred)
			d.ready.catch((e: unknown) => {
				if (!bgAbort.signal.aborted) fail({ error: new NativePrepareError(bgError ?? e) });
			});
		// the sound of a segmented export is encoded while the segments render (the join then only copies)
		const sound = split ? this.segmentSound(planned, audioP, soxr, ctx, runAbort.signal) : null;
		// a failed mixdown or sound encode fails the export and stops the segments
		sound?.catch((error: unknown) => fail({ error }));
		const endEncode = report.begin(still ? 'still' : 'encode');
		// Memory watchdog (AGENTS §0): sampled every second, the export's memory is the larger of the composites' own
		// (each composite with the decoder and blend processes that feed it) and what the machine has taken since the
		// composites started (render browsers of bakes still running, GPU driver memory and anything else outside the
		// composites: MemAvailable). Past the budget, or with less than the floor still available, the most recently
		// started segment is stopped and queued again with one segment fewer at a time; a lone composite fails the export
		// by name when its own memory is past the budget or the machine runs short — the system's out-of-memory killer
		// (or a frozen machine) never decides.
		const budget = still ? 0 : compositeMemoryBudget();
		const floor = memoryFloor();
		const takenAtStart = memoryRoom().taken;
		const running = new Map<
			number,
			{ ac: AbortController; pid: number | null; helpers: Set<number>; since: number; part: Part }
		>();
		const requeued = new Set<number>();
		/** Segments the watchdog stopped whose process has not ended yet (their memory is still counted). */
		const stopping = new Set<number>();
		const pending = segPlan.segments.map((_, i) => i);
		let limit = atOnce;
		/**
		 * §13: composites at once while deferred bakes still render (their render browsers and stitches take cores);
		 * `JASPER_EXPORT_BAKE_OVERLAP` (default: all of them).
		 */
		const overlap = bakeOverlapFromEnv(atOnce);
		const limitNow = () => (baked.size < deferred.length ? Math.min(limit, overlap) : limit);
		/** Lanes between taking a segment and the end of its composite. */
		let active = 0;
		/** One composite (a segment, or the whole range). */
		const runPart = (part: Part, i: number): Promise<void> => {
			const { graph } = part;
			const pipes = graph.streams.length + (graph.blend ? 1 : 0);
			const workers = workersFor(graph);
			const ac = new AbortController();
			const stop = () => ac.abort();
			runAbort.signal.addEventListener('abort', stop, { once: true });
			const slot = { ac, pid: null as number | null, helpers: new Set<number>(), since: Date.now(), part };
			running.set(i, slot);
			/** A process feeding this composite (decoder, blend stage): tracked by the job, counted with the composite. */
			const helper = (c: ChildProcess) => {
				ctx.trackChild(c);
				if (c.pid) slot.helpers.add(c.pid);
			};
			return this.deps.ff
				.run(part.args, {
					signal: ac.signal,
					...(pipes > 0 ? { pipes } : {}),
					onSpawn: (child) => {
						ctx.trackChild(child);
						slot.pid = child.pid ?? null;
						if (graph.streams.length > 0) runStreams(child, graph.streams, workers, helper);
						runBlend(child, graph.blend, workers, helper);
					},
					onProgress: (p) => {
						if (still || total <= 0) return;
						done[i] = Math.min(graph.durationSec, p.outTimeUs / 1e6);
						const sum = done.reduce((a, b) => a + b, 0);
						const elapsed = (Date.now() - started) / 1000;
						const speed = split
							? elapsed > 0
								? sum / elapsed
								: undefined
							: (p.speed ?? (elapsed > 0 ? sum / elapsed : undefined));
						ctx.progress(bar(sum), {
							stage: split ? `Encoding (native, ${segPlan.segments.length} segments)` : 'Encoding (native)',
							...(speed ? { speed, etaSec: (total - sum) / speed } : {}),
						});
					},
				})
				.then(() => {
					// (§13: when each segment ran, beside the bakes)
					if (split)
						ctx.log(
							`native: ${part.label} encoded in ${((Date.now() - slot.since) / 1000).toFixed(1)} s, from ${((slot.since - started) / 1000).toFixed(1)} s`,
						);
				})
				.catch((error: unknown) => {
					if (requeued.delete(i)) {
						// stopped by the watchdog: rendered again when memory allows
						done[i] = 0;
						pending.unshift(i);
						return;
					}
					// the first failure is the export's; the other segments are stopped (their cancellation is not)
					fail({ error, part });
				})
				.finally(() => {
					running.delete(i);
					stopping.delete(i);
					runAbort.signal.removeEventListener('abort', stop);
					wake();
				});
		};
		const watchdog =
			budget > 0 && process.platform === 'linux'
				? setInterval(() => {
						let rss = 0;
						for (const r of running.values())
							for (const pid of [r.pid, ...r.helpers]) rss += pid ? residentBytes(pid) : 0;
						const room = memoryRoom();
						const used = Math.max(rss, room.taken - takenAtStart);
						const short = room.available < floor;
						// (one stop at a time: the stopped process's memory is counted until it has ended)
						if ((used <= budget && !short) || stopping.size > 0) return;
						const gbs = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
						const why = short
							? `${gbs(room.available)} of memory left on the machine, under the ${gbs(floor)} floor`
							: `export at ${gbs(used)} (composites ${gbs(rss)}), over the ${gbs(budget)} budget`;
						if (running.size > 1) {
							const [i, r] = [...running.entries()].sort((a, b) => b[1].since - a[1].since)[0]!;
							limit = Math.max(1, Math.min(limit, running.size) - 1);
							stopping.add(i);
							requeued.add(i);
							ctx.log(`native: ${why}: ${labels[i]} stopped and queued again, ${limit} at a time`);
							r.ac.abort();
						} else if (failed === null && (rss > budget || short)) {
							fail({
								error: new JobError(
									'INSUFFICIENT_MEMORY',
									short
										? `Not enough memory: only ${gbs(room.available)} of memory is left on this machine while the export composites; close other applications or export a shorter range`
										: `Not enough memory: the export's compositor reached ${gbs(rss)}, over the ${gbs(budget)} this machine has available for it; close other applications or export a shorter range`,
									true,
									{ rssBytes: rss, budgetBytes: budget, availableBytes: room.available },
								),
								...([...running.values()][0] ? { part: [...running.values()][0]!.part } : {}),
							});
						} else if (limit > 1) {
							// a lone composite within the budget while other processes took the rest: no other one starts
							limit = 1;
							ctx.log(`native: ${why}: 1 at a time`);
						}
					}, 1000)
				: null;
		try {
			// at most `limit` composites at a time, the first ready segment in range order (§13: a segment waits for the
			// deferred bakes it draws); none starts after a failure or a cancellation
			const lane = async (lane: number) => {
				while (failed === null && !runAbort.signal.aborted) {
					if (lane >= limit) return;
					const k =
						active < limitNow() ? pending.findIndex((i, n) => isReady(i) && (n === 0 || stillsReady(i))) : -1;
					if (k < 0) {
						// nothing left (a segment may still come back from the watchdog while others run), or waiting for a
						// place, a bake or a stopped segment
						if (pending.length === 0 && active === 0) return;
						if (active === 0 && deferred.length > baked.size)
							ctx.progress(fraction(), { stage: `Baking graphics: ${baked.size}/${deferred.length} ready` });
						await new Promise<void>((resolve) => waiting.push(resolve));
						continue;
					}
					const i = pending.splice(k, 1)[0]!;
					active++;
					try {
						let part = parts[i];
						if (!part) {
							part = await report.time('plan', () => buildPart(i));
							const off = inexactOf(part);
							if (off.length) {
								fail({ error: null, again: () => atSequenceSize(off) });
								return;
							}
						}
						// Pipelined stills the composite opens as inputs are written first.
						const waitFor = part.graph.waitFor ?? [];
						if (waitFor.length) {
							const unique = new Set(waitFor).size;
							if (running.size === 0)
								ctx.progress(fraction(), {
									stage: `Waiting for ${unique} baked graphic${unique === 1 ? '' : 's'}`,
								});
							const ready = await report
								.time('bakeWait', () => Promise.all(waitFor))
								.catch((e: unknown) => {
									// Only a failed background bake rejects these.
									fail({ error: new NativePrepareError(bgError ?? e) });
									return null;
								});
							const changed = ready?.find((r) => !r.ok);
							if (changed && !changed.ok) fail({ error: null, again: () => restart(changed.reason) });
							if (!ready || failed !== null || runAbort.signal.aborted) return;
						}
						await runPart(part, i);
					} catch (e) {
						fail({ error: e });
					} finally {
						active--;
						wake();
					}
				}
			};
			await Promise.all(Array.from({ length: atOnce }, (_, l) => lane(l)));
			// cancelled between two segments: nothing failed, but the export did not finish
			if (failed === null && runAbort.signal.aborted)
				failed = { error: new JobError('JOB_CANCELLED', 'Cancelled') };
		} finally {
			if (watchdog) clearInterval(watchdog);
			endEncode();
			ctx.signal.removeEventListener('abort', onJobAbort);
			runAbort.signal.removeEventListener('abort', wake);
		}
		if (failed !== null) {
			const { error: e, part, again } = failed as NonNullable<typeof failed>;
			await sound?.catch(() => {});
			streamAbort.abort();
			await Promise.all(producers);
			if (again && !ctx.signal.aborted) return again();
			// A stream that lost its pipe only reports the composite's death: the composite's own error then wins.
			const se = streamError as Error | null;
			if (se instanceof BakeChangedError && !ctx.signal.aborted) return restart(se.message);
			const consequence = !se || /^layer stream:/.test(se.message);
			// §10: a composite that failed in the OpenCL kernel (device lost, out of video memory…) is rendered again with
			// the CPU kernel, named in `pipeline.kernel.fallbackReasons`
			const clError = part && part.graph.kernel.opencl > 0 && consequence ? openClErrorOf(e) : null;
			if (clError && !ctx.signal.aborted && bgError === null) {
				const why = `the OpenCL kernel failed: ${clError}`;
				ctx.log(`native: ${why}; rendering again with the CPU kernel`);
				await settle();
				ctx.signal.removeEventListener('abort', onAbortBg);
				if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
				return this.runNative(
					planned,
					masters,
					output,
					ctx,
					still,
					audioIn,
					pipeline,
					segmentsOff,
					compositeFallback,
					why,
				);
			}
			await abandon();
			if (bgError !== null && !ctx.signal.aborted) throw failure(e);
			if (e === null) throw new JobError('JOB_CANCELLED', 'Cancelled');
			throw consequence ? killedComposite(e, part?.graph.inputs.length ?? 0, ctx.signal.aborted) : se;
		}
		// The composite succeeded (and the frame count is checked below): a stream it stopped reading ends here.
		streamAbort.abort();
		await Promise.all(producers);
		// Pipelined work ends with the composite (its errors fail the export).
		await Promise.all(background).catch((e) => {
			throw failure(e);
		});
		ctx.signal.removeEventListener('abort', onAbortBg);
		if (still) return 1;
		if (split) {
			// (every segment was built: the lanes ran them all)
			const built = parts as Part[];
			const joined = await this.joinSegments(planned, built, output, await sound!, ctx);
			if (!joined) {
				ctx.log(
					'native: the segments were encoded with different parameter sets; rendering one graph instead',
				);
				for (const p of built) await rm(p.file, { force: true });
				return this.runNative(
					planned,
					masters,
					output,
					ctx,
					still,
					audioP,
					pipeline,
					true,
					compositeFallback,
					openClFailure,
				);
			}
		}
		const count = await report.time('frameCheck', () =>
			this.deps.ff.countVideoFrames(output, { signal: ctx.signal }),
		);
		const expected = planned.output.frames;
		if (count !== expected) {
			throw new JobError(
				'FRAME_COUNT_MISMATCH',
				`Expected ${expected} frames, the output has ${count}`,
				true,
				{
					expected,
					actual: count,
				},
			);
		}
		return count;
	}

	/**
	 * The sound stream of a segmented export, as a file the join copies: the delivery's checked encode as it is, else
	 * the mix WAV (or silence) through the chain and encoder a one-graph export uses (`mixAudioFilters`), encoded into
	 * the scratch directory while the segments render. Null for a picture-only export.
	 */
	private async segmentSound(
		planned: PlannedExport,
		audioP: Promise<MixdownResult | null>,
		soxr: boolean,
		ctx: JobContext,
		signal: AbortSignal,
	): Promise<string | null> {
		const o = planned.output;
		if (o.videoOnly) return null;
		const audio = await audioP;
		const encoded = deliveredEncode(planned, audio);
		if (encoded) return encoded;
		const ext = o.encoder?.container ?? 'mp4';
		const file = join(await ctx.scratchDir(), `sound.${ext}`);
		const layout = o.audioChannels === 1 ? 'mono' : o.audioChannels === 6 ? '5.1' : 'stereo';
		const totalSamples = Math.round(o.durationSec * o.audioSampleRate);
		const args = [
			...(audio?.path
				? ['-i', audio.path, '-af', mixAudioFilters({ sampleRate: audio.sampleRate, soxr }, o).join(',')]
				: [
						...['-f', 'lavfi', '-i', `anullsrc=r=${o.audioSampleRate}:cl=${layout}`],
						...['-af', `atrim=end_sample=${totalSamples}`],
					]),
			'-vn',
			...audioEncodeArgs(audioCodecOf(o.encoder, o), o.audioBitrateKbps, o.audioChannels),
			...['-ar', String(o.audioSampleRate), '-ac', String(o.audioChannels), '-f', ext, file],
		];
		ctx.log(`ffmpeg (sound) ${commandLine(args)}`);
		await this.report(ctx).time('sound', () => this.deps.ff.run(args, { signal, onSpawn: ctx.trackChild }));
		return file;
	}

	/**
	 * Joins the encoded picture segments by stream copy (concat demuxer: each segment's timestamps continue from the
	 * previous one's duration; every segment starts with a key frame) with the export's sound (`segmentSound`, copied)
	 * into `output`. Checks each segment's frame count first (FRAME_COUNT_MISMATCH names it). False, without writing,
	 * when the segments' parameter sets differ (a concatenated stream must share them).
	 */
	private async joinSegments(
		planned: PlannedExport,
		parts: readonly { graph: { outputFrames: number }; file: string; label: string }[],
		output: string,
		sound: string | null,
		ctx: JobContext,
	): Promise<boolean> {
		const report = this.report(ctx);
		const o = planned.output;
		const ext = o.encoder?.container ?? 'mp4';
		const checks = await report.time('frameCheck', () =>
			Promise.all(
				parts.map(async (p) => {
					const count = await this.deps.ff.countVideoFrames(p.file, { signal: ctx.signal });
					const j = await this.deps.ff.probeJson(
						[
							'-show_data_hash',
							'SHA256',
							'-select_streams',
							'v:0',
							'-show_entries',
							'stream=extradata_hash',
							p.file,
						],
						{ signal: ctx.signal },
					);
					const hash = (j.streams as { extradata_hash?: string }[] | undefined)?.[0]?.extradata_hash ?? '';
					return { count, hash };
				}),
			),
		);
		for (const [i, c] of checks.entries()) {
			const want = parts[i]!.graph.outputFrames;
			if (c.count !== want)
				throw new JobError(
					'FRAME_COUNT_MISMATCH',
					`Expected ${want} frames in ${parts[i]!.label}, it has ${c.count}`,
					true,
					{ expected: want, actual: c.count, segment: i },
				);
		}
		if (new Set(checks.map((c) => c.hash)).size > 1) return false;
		const scratch = await ctx.scratchDir();
		const list = join(scratch, 'segments.txt');
		await writeFile(list, `${parts.map((p) => `file '${p.file.replace(/'/g, "'\\''")}'`).join('\n')}\n`);
		const args = [
			...['-f', 'concat', '-safe', '0', '-i', list],
			...(sound ? ['-i', sound] : []),
			...['-map', '0:v:0'],
			...(sound ? ['-map', '1:a:0', '-c', 'copy'] : ['-c:v', 'copy', '-an']),
			...(ext !== 'webm' ? ['-movflags', '+faststart'] : []),
			...['-f', ext, output],
		];
		ctx.progress(0.97, { stage: `Joining ${parts.length} segments${sound ? ' and the sound' : ''}` });
		ctx.log(`ffmpeg ${commandLine(args)}`);
		await report.time('join', () => this.deps.ff.run(args, { signal: ctx.signal, onSpawn: ctx.trackChild }));
		for (const p of parts) await rm(p.file, { force: true });
		return true;
	}

	/**
	 * audio-mix: the deliverable's audio for every path — the offline mixer over the export range (clip levels, pan,
	 * buses, sends, automation, 5.1) with two-pass loudness normalisation when requested.
	 */
	private async renderAudio(
		planned: PlannedExport,
		ctx: JobContext,
		opts: { deliver?: boolean; onProgress?: (fraction: number, stage: string) => void } = { deliver: true },
	): Promise<MixdownResult> {
		ctx.progress(0, { stage: 'Mixing audio' });
		const o = planned.output;
		const sr = planned.snapshot.audioMix?.sampleRate ?? 48000;
		const t0 = performance.now();
		// The media the mix plays, as files (plain data: the mix runs on a worker thread).
		const media: Record<string, MixSource> = {};
		// ranges.ts: a multi-range export mixes each range from its own snapshot and joins the mixes (`pieces`)
		const pieces = planned.joined?.map((p) => ({
			snapshot: { ...p.snapshot, videoTracks: [] },
			range: p.range,
		}));
		for (const c of planned.joined?.flatMap((p) => p.snapshot.audioClips) ?? planned.snapshot.audioClips) {
			const m = planned.media[c.mediaId];
			if (!m || Object.hasOwn(media, c.mediaId)) continue;
			media[c.mediaId] = {
				path: m.path,
				streams: m.record.probe.streams.filter((x) => x.type === 'audio') as never,
				container: m.record.container,
			};
		}
		const scratchDir = await ctx.scratchDir();
		const length = Math.round(o.durationSec * sr);
		const outputLayout = layoutOf(o.audioChannels);
		const onProgress = (f: number, stage: string) =>
			opts.onProgress ? opts.onProgress(f, stage) : ctx.progress(0, { stage });
		// wp-note export-performance "Audio delivery": the mix and the delivery's passes and decoded checks run on
		// worker threads (the same functions: the same bytes), off the event loop the layer bake's pages wait on
		const workers = exportAudioWorkers(
			{ ff: this.deps.ff, signal: ctx.signal, onSpawn: ctx.trackChild },
			o.durationSec,
			(m) => ctx.log(m),
		);
		const mix = await this.report(ctx).time('audio', async () => {
			// (an audio-only export, which reports the mix's progress and runs nothing beside it, mixes here)
			const pass1 = opts.onProgress
				? undefined
				: await workers.mixPass1({
						// the mixer reads the audio, the Mix and the settings: the picture's tracks stay here
						snapshot: { ...planned.snapshot, videoTracks: [] },
						media,
						range: planned.range,
						...(pieces ? { pieces } : {}),
						length,
						outputLayout,
						normalize: o.normalize ?? null,
						scratchDir,
					});
			return renderMixdown({
				ff: this.deps.ff,
				snapshot: planned.snapshot,
				media: (id) => (Object.hasOwn(media, id) ? media[id]! : null),
				range: planned.range,
				...(pieces ? { pieces } : {}),
				length,
				outputLayout,
				normalize: o.normalize,
				// the deliverable's encoding: a lossy codec's limiter headroom and the decoded check (deliver.ts)
				...(opts.deliver
					? { deliver: deliveryCodecOf(planned), parallel: Math.min(3, Math.max(1, ctx.slots)) }
					: {}),
				scratchDir,
				signal: ctx.signal,
				onSpawn: ctx.trackChild,
				onProgress,
				...(pass1 ? { pass1 } : {}),
				runner: workers.runner,
			});
		});
		const d = mix.normalized?.delivery;
		const t = (ms: number) => `${Math.round(ms)} ms`;
		ctx.log(
			d
				? `audio: mixed (${t(mix.mixMs ?? 0)}) and delivered in ${t(performance.now() - t0)} — ${d.passes} passes (${t(d.timings.passesMs)}: ${d.passKinds.converge} converging, ${d.passKinds.alternative} lower-ceiling candidates, ${d.passKinds.probe} probes, ${d.passKinds.rewrite} rewritten), ${d.encodePasses} encodes (${t(d.timings.encodeMs)} summed), decoded checks ${t(d.timings.decodeMs)}${d.cached ? ', reused an earlier delivery of this mix' : ''}${d.encoded ? ', the checked encode is muxed as it is' : ''}`
				: `audio: mixed in ${t(performance.now() - t0)}`,
		);
		return mix;
	}

	/** Whether this export's delivery encodes and checks a lossy (or resampled) stream: normalised, not picture-only. */
	private deliveryEncodes(planned: PlannedExport): boolean {
		const o = planned.output;
		const sr = planned.snapshot.audioMix?.sampleRate ?? 48000;
		return !o.videoOnly && !!o.normalize && needsDecodedCheck(deliveryCodecOf(planned), sr);
	}

	/**
	 * The native path with the audio delivery alongside (wp-note sound-design "Fix: … delivery speed"): the picture is
	 * rendered alone into the scratch directory while the mix is delivered (its encodes on other cores), then the two
	 * are joined by stream copy — the delivery's checked encode as it is (or, without one, the WAV encoded as every
	 * mux does). The delivered file is the one the sequential path writes; the encodes no longer wait for each other.
	 */
	private async runNativeAlongside(
		planned: PlannedExport,
		masters: Map<string, string>,
		output: string,
		ctx: JobContext,
		audioP: Promise<MixdownResult | null>,
	): Promise<number> {
		const ext = planned.output.encoder?.container ?? 'mp4';
		const picture = join(await ctx.scratchDir(), `picture-only.${ext}`);
		const pictureOnly = { ...planned, output: { ...planned.output, videoOnly: true } };
		const frames = await this.runNative(pictureOnly, masters, picture, ctx, false, null);
		ctx.progress(0.97, { stage: 'Joining the picture and the delivered sound' });
		const audio = await audioP;
		const a = audioStream(planned, audio, await hasSoxr(this.deps.ff));
		if (!a) {
			await rename(picture, output);
			return frames;
		}
		const args = [
			'-i',
			picture,
			'-i',
			a.file,
			'-map',
			'0',
			'-map',
			'1:a:0',
			'-c',
			'copy',
			...a.args,
			...(ext !== 'webm' ? ['-movflags', '+faststart'] : []),
			'-f',
			ext,
			output,
		];
		ctx.log(`ffmpeg ${commandLine(args)}`);
		await this.report(ctx).time('join', () =>
			this.deps.ff.run(args, { signal: ctx.signal, onSpawn: ctx.trackChild }),
		);
		await rm(picture, { force: true });
		return frames;
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
		const audioIn = audioStream(planned, audio, await hasSoxr(this.deps.ff))!;
		const args = [
			'-i',
			video,
			'-i',
			audioIn.file,
			'-map',
			'0:v:0',
			'-map',
			'1:a:0',
			'-c:v',
			'copy',
			...audioIn.args,
			'-shortest',
			...(o.encoder?.container !== 'webm' ? ['-movflags', '+faststart'] : []),
			'-f',
			o.encoder?.container ?? 'mp4',
			output,
		];
		ctx.log(`ffmpeg ${commandLine(args)}`);
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
		const audioIn = audioStream(planned, audio ?? null, await hasSoxr(this.deps.ff));
		const args = [
			...enc.pre,
			'-i',
			input,
			...(audioIn ? ['-i', audioIn.file] : []),
			'-map',
			'0:v:0',
			...(o.videoOnly ? [] : ['-map', audioIn ? '1:a:0' : '0:a:0?']),
			'-vf',
			vf.join(','),
			...enc.video,
			...(o.color
				? colorTagArgs(o.color)
				: ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']),
			'-frames:v',
			String(frames),
			...(o.videoOnly
				? ['-an']
				: (audioIn?.args ?? [
						...audioEncodeArgs(audioCodecOf(choice, o), o.audioBitrateKbps, o.audioChannels),
						'-ar',
						String(o.audioSampleRate),
						'-ac',
						String(o.audioChannels),
					])),
			'-threads',
			String(Math.max(1, ctx.slots)),
			...(choice.container !== 'webm' ? ['-movflags', '+faststart'] : []),
			'-f',
			choice.container,
			output,
		];
		ctx.log(`ffmpeg ${commandLine(args)}`);
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
			warn: this.prepareWarn(ctx),
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
		/** Why the failed layers' frames alone could not be rendered on the Remotion path (`renderAroundFailedLayers`). */
		whole: string | null = null,
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
		const message = `The native path could not be prepared (${e.message.slice(0, 600)}); rendered with Remotion instead${whole ? ` (${whole})` : ''}`;
		warnings.push({ code: 'NATIVE_FALLBACK', message });
		ctx.log(`warning NATIVE_FALLBACK: ${message}`);
		ctx.progress(0, { stage: 'Falling back to Remotion' });
		return planned;
	}

	/**
	 * A layer bake still failed after its retries (`LayerBakeError`) in an `auto` export: the frames its layers are
	 * drawn on are rendered on the Remotion path (the whole stack, exactly as a Remotion export draws them) and the rest
	 * of the range on the native path, joined as Use Previews joins its runs (ProRes intermediates, one encode with the
	 * export's mix). Returns the render; or why it cannot (the caller then renders the whole range on the Remotion path);
	 * or null when the failure is not a layer bake's or the export may not leave the native path.
	 */
	private async renderAroundFailedLayers(
		e: unknown,
		ctx: JobContext,
		req: ExportStartRequest,
		planned: PlannedExport,
		output: string,
		audioIn: Promise<MixdownResult | null>,
		warnings: { code: string; message: string }[],
	): Promise<Awaited<ReturnType<ExportService['renderWithPreviews']>> | string | null> {
		const failure = e instanceof NativePrepareError ? e.failure : null;
		if (!(failure instanceof LayerBakeError) || ctx.signal.aborted || req.settings.engine === 'native')
			return null;
		if (planned.deliverable?.kind === 'audio') return null;
		if (planned.output.alpha) return 'an alpha output is rendered as one Remotion master';
		if (!isPlainRec709Output(planned.output.color)) return 'colour-managed outputs are rendered in one piece';
		const fps = planned.snapshot.settings.fps;
		const runs = fallbackRuns(planned.range, failure.layers, {
			mergeFrames: Math.max(1, Math.round((FALLBACK_MERGE_SEC * fps.num) / Math.max(1, fps.den))),
			maxStretches: MAX_FALLBACK_STRETCHES,
		});
		if (!runs) return 'the layers that could not be baked are drawn across most of the range';
		const stretches = runs.filter((r) => r.kind === 'render' && r.engine === 'remotion');
		// Each stretch must be renderable on the Remotion path; else the whole range cannot be either (the caller fails
		// with the bake's error).
		const caps = await this.deps.capabilities();
		for (const r of stretches) {
			try {
				await planExport(
					{
						envelope: req.envelope,
						sequenceId: req.sequenceId,
						settings: {
							...req.settings,
							sequenceId: req.sequenceId,
							engine: 'remotion',
							range: { type: 'custom', startFrame: r.start, endFrame: r.end },
						},
					},
					this.planDeps(caps),
				);
			} catch {
				return null;
			}
		}
		const frames = stretches.map((r) => `${r.start}–${r.end}`).join(', ');
		const message = `${failure.message.slice(0, 600)}; frames ${frames} were rendered on the Remotion path, the rest of the range on the native path`;
		warnings.push({ code: 'LAYER_BAKE_FALLBACK', message });
		ctx.log(`warning LAYER_BAKE_FALLBACK: ${message}`);
		ctx.progress(0, { stage: `Rendering frames ${frames} with Remotion` });
		const res = await this.renderWithPreviews(ctx, req, planned, output, runs, audioIn);
		return { ...res, path: 'hybrid', warnings: [...warnings, ...res.warnings] };
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
					...mediaDecodeHints(r.probe, 'render'),
				};
			},
			resolveFont: (font, weight, italic) => {
				const f = this.deps.fonts.resolve(font.family, weight, italic);
				return f ? sign(f.url) : null;
			},
			// parity (roto): object-matte sets for the headless browser
			resolveRoto: (key) => sign(rotoStorePath(key)),
			// social-comment §7.8: template fonts and emoji (the planner made them available)
			templateAssets: engineTemplateAssets(this.deps.fonts, sign),
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
		// (a preview file is cached by its document hash: it must never hold frames of a file that changed meanwhile)
		const r = await guardMediaDuring(planned, this.mediaGuardOpts(ctx), () =>
			this.renderPlanned(ctx, req, planned, output),
		);
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
		// Render Audio keeps the float mix (no encoder follows): no codec headroom
		const audio = await this.renderAudio(planned, ctx, { deliver: false });
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
		const output = join(dir, `output.${outputExtension(planned)}`);
		ctx.addPartial(dir);
		// where the time went, in the log of a failed (or cancelled) export too; a media file that changed while it
		// rendered fails it by name (media-guard.ts)
		const first = planned;
		const rendered = await guardMediaDuring(
			first,
			this.mediaGuardOpts(ctx),
			async () => await this.renderExport(ctx, req, first, output),
		).catch((e: unknown) => {
			ctx.log(this.report(ctx).summary());
			this.prepareWarnings.delete(ctx.job.id);
			throw e;
		});
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

	private mediaGuardOpts(ctx: JobContext): { exposePaths: boolean; signal: AbortSignal } {
		return { exposePaths: this.deps.localMode, signal: ctx.signal };
	}

	/** The file of a planned export by its deliverable and path (`runExport`). */
	private renderExport(ctx: JobContext, req: ExportStartRequest, planned: PlannedExport, output: string) {
		const del = planned.deliverable;
		if (del?.kind === 'audio') return this.renderAudioOnly(ctx, planned, output);
		if (del?.kind === 'gif') return this.renderGif(ctx, req, planned, output);
		const runs = this.renderRuns(planned);
		if (runs) return this.renderWithPreviews(ctx, req, planned, output, runs);
		if (planned.smart) return this.renderSmart(ctx, req, planned, output, planned.smart);
		return this.renderPlanned(ctx, req, planned, output);
	}

	/**
	 * The runs a planned export's picture is joined from: the ranges of a multi-range export (each rendered), or the
	 * preview files and rendered stretches of a Use Previews export; null = one render.
	 */
	private renderRuns(planned: PlannedExport): ExportRun[] | null {
		if (planned.joined) return planned.joined.map(({ range }) => ({ kind: 'render', ...range }));
		return planned.previews?.some((r) => r.kind === 'preview') ? planned.previews : null;
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
		// A lossy normalised delivery (the decoded check's encodes) runs alongside the native picture render, which then
		// writes the picture alone; the two are joined by stream copy (`runNativeAlongside`). Else the mix comes first.
		const alongside = path === 'native' && this.deliveryEncodes(planned);
		const audioP = planned.output.videoOnly ? Promise.resolve(null) : this.renderAudio(planned, ctx);
		audioP.catch(() => {});
		// The mixdown runs while the native path prepares (bakes) its layers; the composite waits for it.
		let audio: MixdownResult | null = null;
		if (path === 'native' || path === 'hybrid') {
			const m = await this.report(ctx).time('masters', () => this.collectMgMasters(planned, ctx));
			if (m === null) {
				if (req.settings.engine === 'native') {
					throw new JobError('PATH_NOT_ELIGIBLE', 'Motion-graphic masters are unavailable (fframes)', false);
				}
				path = 'remotion';
			} else masters = m;
		}
		if (path === 'native' || path === 'hybrid') {
			try {
				if (alongside && path === 'native') {
					frames = await this.runNativeAlongside(planned, masters, output, ctx, audioP);
					audio = await audioP;
				} else {
					frames = await this.runNative(planned, masters, output, ctx, false, audioP);
					audio = await audioP;
				}
				warnings.push(...this.takePrepareWarnings(ctx));
			} catch (e) {
				warnings.push(...this.takePrepareWarnings(ctx));
				// A layer bake that still failed after its retries: only its frames on the Remotion path.
				const around = await this.renderAroundFailedLayers(e, ctx, req, planned, output, audioP, warnings);
				if (around && typeof around === 'object') return around;
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
					around,
				);
				if (!replanned) throw this.unwrap(e);
				planned = replanned;
				path = 'remotion';
			}
		}
		// (the mix of an export that left the native path, or whose masters were unavailable)
		if (!planned.output.videoOnly) audio ??= await audioP;
		const endRemotion = path === 'remotion' ? this.report(ctx).begin('remotion') : () => {};
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
				...(rp.mode === 'intermediate'
					? {
							intermediate: true,
							...(planned.output.proresProfile === '4444' ? { intermediate444: true } : {}),
						}
					: {}),
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
		endRemotion();
		// (a graded master the Remotion path's preparation baked again)
		warnings.push(...this.takePrepareWarnings(ctx));
		return {
			planned,
			frames,
			path: path as 'native' | 'hybrid' | 'remotion',
			remotionOutput,
			warnings,
			audio,
		};
	}

	/**
	 * spec 18 AF-EXP-001: a GIF — the picture rendered on the plan's path (native, hybrid or Remotion, with their
	 * fallbacks and Use Previews) into a ProRes 4444 intermediate in the scratch directory, then converted at the GIF rate and
	 * size in the display rendition (palette pass + dithered mapping). Progress spans both phases; the intermediate is
	 * deleted after the conversion (and with the scratch directory when the job ends any other way).
	 */
	private async renderGif(
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
		const del = planned.deliverable;
		if (del?.kind !== 'gif') throw new JobError('BAD_REQUEST', 'Not a GIF export', false);
		const gif = del.gif;
		const scratch = await ctx.scratchDir();
		const source = join(scratch, 'gif-source.mov');
		// phase 1 (render) 0–80 %, palette 80–86 %, frames 86–99 %
		const RENDER = 0.8;
		const PALETTE = 0.86;
		const sub: JobContext = {
			...ctx,
			progress: (v, extra) =>
				ctx.progress((v ?? 0) * RENDER, { ...extra, stage: `GIF 1/2 · ${extra?.stage ?? 'Rendering'}` }),
		};
		// the render paths and their fallbacks plan the intermediate's own settings
		const renderReq: ExportStartRequest = { ...req, settings: del.render };
		const runs = this.renderRuns(planned);
		const rendered = runs
			? await this.renderWithPreviews(sub, renderReq, planned, source, runs)
			: await this.renderPlanned(sub, renderReq, planned, source);
		const color = rendered.planned.output.color;
		const matrix = color?.swsMatrix === 'bt2020' ? 'bt2020' : 'bt709';
		const lut = await displayLutFilter(planned.snapshot.settings.color, scratch);
		const graphs = gifGraphs(gif, gifToRgb(gif, matrix, lut, SWS_FLAGS));
		for (const g of [graphs.palette, graphs.encode]) if (g) assertLgplFilters(g);
		const input = [...LOCAL_PROTOCOLS, '-i', source];
		let palette: string | null = null;
		if (graphs.palette) {
			palette = join(scratch, 'gif-palette.png');
			ctx.progress(RENDER, { stage: 'GIF 2/2 · Building the palette' });
			const args = [...input, '-filter_complex', graphs.palette, '-map', '[out]', '-frames:v', '1', palette];
			ctx.log(`ffmpeg ${commandLine(args)}`);
			await this.deps.ff.run(args, { signal: ctx.signal, onSpawn: ctx.trackChild });
		}
		const loop = gifMuxLoop(gif.loop);
		const args = [
			...input,
			...(palette ? [...LOCAL_PROTOCOLS, '-i', palette] : []),
			'-filter_complex',
			graphs.encode,
			'-map',
			'[out]',
			'-loop',
			String(loop),
			'-f',
			'gif',
			output,
		];
		ctx.log(`ffmpeg ${commandLine(args)}`);
		const total = planned.output.durationSec;
		ctx.progress(PALETTE, { stage: 'GIF 2/2 · Writing frames' });
		await this.deps.ff.run(args, {
			signal: ctx.signal,
			onSpawn: ctx.trackChild,
			onProgress: (p) => {
				if (total <= 0) return;
				const t = Math.min(total, p.outTimeUs / 1e6);
				ctx.progress(PALETTE + (t / total) * (0.99 - PALETTE), { stage: 'GIF 2/2 · Writing frames' });
			},
		});
		await rm(source, { force: true });
		if (palette) await rm(palette, { force: true });
		const count = await this.deps.ff.countVideoFrames(output, { signal: ctx.signal });
		if (count !== gif.frames)
			throw new JobError(
				'FRAME_COUNT_MISMATCH',
				`Expected ${gif.frames} GIF frames, the file has ${count}`,
				true,
				{
					expected: gif.frames,
					actual: count,
				},
			);
		ctx.log(
			`gif: ${count} frames at ${gif.fps} fps, ${gif.width}×${gif.height}, loop ${gif.loop} (muxer ${loop})`,
		);
		// a Remotion fallback re-planned the intermediate: the file is still this GIF
		return { ...rendered, planned: { ...rendered.planned, deliverable: del }, frames: count };
	}

	/**
	 * spec 18 AF-EXP-002: an audio-only file — the offline mix of the range (the DSP of the preview and every export path,
	 * with the export's rate, channels and loudness delivery) written as WAV, FLAC or M4A; the file's duration is checked
	 * against the range.
	 */
	private async renderAudioOnly(
		ctx: JobContext,
		planned: PlannedExport,
		output: string,
	): Promise<{
		planned: PlannedExport;
		frames: number;
		path: 'audio';
		remotionOutput: undefined;
		warnings: { code: string; message: string }[];
		audio: MixdownResult | null;
	}> {
		const del = planned.deliverable;
		if (del?.kind !== 'audio') throw new JobError('BAD_REQUEST', 'Not an audio-only export', false);
		const MIX = 0.9;
		const audio = await this.renderAudio(planned, ctx, {
			deliver: true,
			onProgress: (f, stage) => ctx.progress(Math.min(1, Math.max(0, f)) * MIX, { stage }),
		});
		const a = audioStream(planned, audio, await hasSoxr(this.deps.ff));
		if (!a) throw new JobError('MIXDOWN_FAILED', 'The mixer wrote no audio', true);
		const name = del.audio.container.toUpperCase();
		const args = [
			...LOCAL_PROTOCOLS,
			'-i',
			a.file,
			'-map',
			'0:a:0',
			...a.args,
			...audioOnlyMuxArgs(del.audio.container),
			output,
		];
		ctx.log(`ffmpeg ${commandLine(args)}`);
		const total = planned.output.durationSec;
		ctx.progress(MIX, { stage: `Writing ${name}` });
		await this.deps.ff.run(args, {
			signal: ctx.signal,
			onSpawn: ctx.trackChild,
			onProgress: (p) => {
				if (total <= 0) return;
				const t = Math.min(total, p.outTimeUs / 1e6);
				ctx.progress(MIX + (t / total) * (0.99 - MIX), { stage: `Writing ${name}` });
			},
		});
		// the file holds the range: |file − range| ≤ max(1 frame, 50 ms)
		const j = await this.deps.ff.probeJson(
			[
				...LOCAL_PROTOCOLS,
				'-select_streams',
				'a:0',
				'-show_entries',
				'stream=duration:format=duration',
				output,
			],
			{ signal: ctx.signal },
		);
		const dur = Number(
			(j.streams as { duration?: string }[] | undefined)?.[0]?.duration ??
				(j.format as { duration?: string } | undefined)?.duration,
		);
		const fps = planned.output.fps;
		const tol = Math.max(fps.den / fps.num, 0.05);
		if (!Number.isFinite(dur) || Math.abs(dur - total) > tol)
			throw new JobError(
				'DURATION_MISMATCH',
				`Expected ${total.toFixed(3)} s of audio, the ${name} file holds ${Number.isFinite(dur) ? dur.toFixed(3) : 'none'}`,
				true,
				{ expectedSec: total, actualSec: Number.isFinite(dur) ? dur : null },
			);
		return {
			planned,
			frames: planned.output.frames,
			path: 'audio',
			remotionOutput: undefined,
			warnings: [],
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
			path: 'copy' | 'native' | 'hybrid' | 'remotion' | 'audio';
			remotionOutput: 'direct' | 'intermediate' | undefined;
			warnings: { code: string; message: string }[];
			audio: MixdownResult | null;
		},
	): Promise<unknown> {
		const { frames, path, remotionOutput, warnings, audio } = r;
		const encoder = planned.output.encoder;
		const del = planned.deliverable;
		const report = this.report(ctx);
		const endFinish = report.begin('finish');
		if (!del) {
			// gaps: the sequence's pixel aspect ratio and field order signalled in the file.
			await this.writeSequenceFormat(planned, output, ctx);
			// color-mgmt: HDR static metadata boxes (`mdcv` / `clli`) in MP4 / MOV outputs.
			await this.writeHdrMetadata(planned, output, ctx);
		}
		// wp captions: embedded caption streams (remux) and sidecar files.
		const captionResult = await this.writeCaptionOutputs(planned, output, dir, ctx);
		// spec 12 §2.11: the sound credits sidecar.
		const creditsResult = await this.writeCreditsSidecar(planned, req.settings, dir, ctx);
		// spec 18 AF-VER-001: what was asked and the cuts of the range, for verify_export (with the frames drawn from
		// offline media, which the plan refuses: never encoded unsaid)
		const offline = offlineSpansOf(planned);
		await this.writeVerifyContext(planned, dir, !!audio, frames, ctx, offline);
		const byteSize = (await stat(output)).size;
		const downloadUrl = `/renders/${ctx.job.id}/output`;
		let finalPath: string | undefined;
		let requestedPath: string | undefined;
		let replaced = false;
		if (req.settings.destination?.type === 'path') {
			// Without overwrite the destination is a partial until the job succeeds: a cancel during (or right after) the
			// copy deletes it. With overwrite the new file is a temporary partial renamed over the old one when complete.
			const overwrite = req.settings.destination.overwrite === true;
			const place = async (src: string, dest: string) => {
				if (!overwrite)
					return copyNoOverwrite(src, dest, { signal: ctx.signal, claimed: (p) => ctx.addPartial(p) });
				return (await copyReplacing(src, dest, { signal: ctx.signal, claimed: (p) => ctx.addPartial(p) }))
					.path;
			};
			const wanted = withExtension(req.settings.destination.path, extname(output));
			if (overwrite) {
				const r = await copyReplacing(output, wanted, {
					signal: ctx.signal,
					claimed: (p) => ctx.addPartial(p),
				});
				finalPath = r.path;
				replaced = r.replaced;
			} else finalPath = await place(output, wanted);
			if (finalPath !== wanted) requestedPath = wanted;
			const stem = basename(finalPath, extname(finalPath));
			for (const sc of captionResult?.sidecars ?? []) {
				const ext = extname(sc.name);
				const rest = sc.name.slice(sc.name.indexOf('.'), -ext.length || undefined);
				sc.path = await place(
					join(dir, 'captions', sc.name),
					join(dirname(finalPath), `${stem}${rest}${ext}`),
				);
			}
			if (creditsResult?.name)
				creditsResult.path = await place(
					join(dir, CREDITS_DIR, creditsResult.name),
					join(dirname(finalPath), creditsFileName(stem, creditsResult.format)),
				);
		}
		const formatChanges = planned.plan.warnings
			.filter((w) => w.code === 'OUTPUT_CONTAINER_CHANGED' || w.code === 'AUDIO_CODEC_CHANGED')
			.map((w) => ({ code: w.code, message: w.message, ...(w.params ? { params: w.params } : {}) }));
		// the delivered audio itself, decoded from the file, whenever it is not the PCM mix (lossy codec or another rate),
		// normalised or not: the numbers a delivery target is met on and the ones verify_export measures (same decode,
		// same meter). A lossy encoder moves the true peak (AAC overshoots; ffmpeg's AAC turns frames over full scale
		// down), so the mix's numbers stay in `pcm`.
		// (when the file's audio stream is the delivery's checked encode, copied, its decoded numbers are the check's: the
		// same bits, decoded by the same ffmpeg — no second decode)
		const copied = audio ? deliveredEncode(planned, audio) : null;
		const checked = copied ? audio?.normalized?.delivery.decoded : null;
		const decodeFile = async () => {
			try {
				return await measureEncodedAudio({
					ff: this.deps.ff,
					file: output,
					channels: planned.output.audioChannels,
					sampleRate: planned.output.audioSampleRate,
					signal: ctx.signal,
					onSpawn: ctx.trackChild,
				});
			} catch (e) {
				// a normalised delivery is only met on the decoded file; without a target the written file is kept and
				// the result reports the PCM mix, labelled as such (`measuredOn: 'pcm'`)
				if (audio?.normalized || ctx.signal.aborted) throw e;
				return null;
			}
		};
		const audioLoudness = audio
			? audioLoudnessOf(
					audio,
					checked
						? { loudness: checked }
						: needsDecodedCheck(deliveryCodecOf(planned), audio.sampleRate)
							? await decodeFile()
							: null,
					!!copied,
				)
			: null;
		const allWarnings = [
			...formatChanges,
			...warnings,
			...(offline.length
				? [
						{
							code: 'OFFLINE_MEDIA',
							message: `${offline.length} clip(s) rendered with offline media (the Media Offline card or silence): ${offline
								.slice(0, 5)
								.map((u) => `"${u.name}" frames ${u.start}–${u.end}`)
								.join(', ')}`,
						},
					]
				: []),
			...(audioLoudness ? deliveryWarnings(audioLoudness) : []),
			...resultSoundWarnings(planned.plan, !!creditsResult?.name),
		];
		const result = {
			downloadUrl,
			byteSize,
			// spec 18 AF-EXP: the GIF / audio-only file's own format (the picture intermediate's encoder is not the file's)
			...(del?.kind === 'gif'
				? {
						encoder: 'gif',
						container: 'gif',
						gif: {
							fps: del.gif.fps,
							width: del.gif.width,
							height: del.gif.height,
							frames,
							loop: del.gif.loop,
						},
					}
				: del?.kind === 'audio'
					? { container: del.audio.container }
					: encoder
						? { encoder: encoder.encoder, container: encoder.container }
						: {}),
			...(audio ? { audioCodec: audioCodecOf(encoder ?? null, planned.output) } : {}),
			durationSec: planned.output.durationSec,
			frames,
			path: finalPath,
			...(requestedPath ? { requestedPath } : {}),
			...(replaced ? { replaced: true } : {}),
			renderPath: path,
			...(remotionOutput ? { remotionOutput } : {}),
			...(allWarnings.length ? { warnings: allWarnings } : {}),
			...(audioLoudness ? { audioLoudness } : {}),
			...(captionResult ? { captions: captionResult } : {}),
			...(creditsResult ? { credits: creditsResult } : {}),
			planId: planned.plan.planId,
			...(report.pipeline && (path === 'native' || path === 'hybrid') ? { pipeline: report.pipeline } : {}),
		};
		endFinish();
		const timings = report.timings();
		ctx.log(report.summary());
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
		return { ...result, timings };
	}

	/** One Program still as a PNG at `output`, on the export's path (S11:LBK-025). */
	private async renderStillPng(
		ctx: JobContext,
		req: Pick<StillRequest, 'envelope' | 'sequenceId' | 'frame' | 'width' | 'alpha'>,
		output: string,
	): Promise<{
		planned: PlannedExport;
		path: PlannedExport['plan']['path'];
		warnings: { code: string; message: string }[];
	}> {
		const settings: ExportSettings = {
			sequenceId: req.sequenceId,
			range: { type: 'entire' },
			container: 'mp4',
			// spec 19 TL-114: the native composite is RGB; a transparent still is drawn on the transparent page.
			engine: req.alpha ? 'remotion' : 'auto',
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
		if (req.alpha) planned.output.alpha = true;
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
		let path = planned.plan.path;
		let masters = new Map<string, string>();
		const warnings: { code: string; message: string }[] = [];
		if (path === 'native' || path === 'hybrid') {
			const m = await this.report(ctx).time('masters', () => this.collectMgMasters(planned, ctx));
			if (m === null) path = 'remotion';
			else masters = m;
		}
		if (path === 'native' || path === 'hybrid') {
			// S11:LBK-025: stills and MCP `render_frame` take the export's path — one baked frame per DOM layer
			// (or its cached master / still) — and fall back to Remotion like `auto` exports (LBK-023).
			try {
				await this.runNative(planned, masters, output, ctx, true);
				warnings.push(...this.takePrepareWarnings(ctx));
			} catch (e) {
				warnings.push(...this.takePrepareWarnings(ctx));
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
			warnings.push(...this.takePrepareWarnings(ctx));
		}
		return { planned, path, warnings };
	}

	private async runStill(ctx: JobContext): Promise<unknown> {
		const stored = await this.loadRequest(ctx);
		if (stored.kind !== 'still') throw new JobError('BAD_REQUEST', 'Not a still request', false);
		const req = stored.request;
		const dir = await this.outDir(ctx);
		const output = join(dir, 'output.png');
		ctx.addPartial(dir);
		const { planned, path, warnings } = await this.renderStillPng(ctx, req, output);
		// gaps (File ▸ Export ▸ Frame): the chosen file format and destination folder.
		const format = req.format ?? 'png';
		const ext = STILL_FORMAT_EXTENSIONS[format];
		let written = output;
		try {
			written = await convertStill(this.deps.ff, output, format, ext, {
				...(req.jpegQuality ? { jpegQuality: req.jpegQuality } : {}),
				...(req.alpha ? { alpha: true } : {}),
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

	// -- spec 19 §12: delivery on the Remotion path ------------------------------------------------------------------

	private deliveryPlanInput(envelope: unknown, sequenceId: string, range: { start: number; end: number }) {
		return {
			envelope: envelope as Parameters<typeof planExport>[0]['envelope'],
			sequenceId,
			settings: {
				sequenceId,
				range: { type: 'entire' },
				container: 'mp4',
				engine: 'remotion',
				destination: { type: 'download' },
			} as ExportSettings,
			rangeOverride: range,
			still: true,
		};
	}

	private async deliveryPlan(
		envelope: unknown,
		sequenceId: string,
		range: { start: number; end: number },
	): Promise<PlannedExport> {
		return planExport(this.deliveryPlanInput(envelope, sequenceId, range), {
			registry: this.deps.registry,
			fonts: this.deps.fonts,
			capabilities: await this.deps.capabilities(),
			extensions: this.nativeExtensions.all(),
		});
	}

	/** Frames of a request as a signed render document, plus the display LUT (a job's first step). */
	private async deliveryFrames(
		ctx: JobContext,
		envelope: unknown,
		sequenceId: string,
		range: { start: number; end: number },
	): Promise<DeliveryFrames & { planned: PlannedExport }> {
		let planned: PlannedExport;
		try {
			planned = await this.deliveryPlan(envelope, sequenceId, range);
		} catch (e) {
			if (e instanceof PlanError) throw new JobError(e.code, e.message, false, e.detail);
			throw e;
		}
		const prepared = await this.prepareForRemotion(planned, ctx);
		const { doc } = this.remotionProps(planned, prepared) as { doc: RenderSnapshot };
		const displayLut = await displayLutFilter(planned.snapshot.settings.color, await ctx.scratchDir());
		this.commitRefs(ctx, planned, 'still');
		const warnings = planned.plan.warnings.map(({ code, message }) => ({ code, message }));
		return { doc, displayLut, warnings, planned };
	}

	private deliveryDeps(): DeliveryDeps {
		return {
			frames: (ctx, envelope, sequenceId, range) => this.deliveryFrames(ctx, envelope, sequenceId, range),
			remotion: this.deps.remotion,
			ff: this.deps.ff,
			outDir: (ctx) => this.outDir(ctx),
			copyOut: (src, dest, ctx) =>
				copyNoOverwrite(src, dest, { signal: ctx.signal, claimed: (p) => ctx.addPartial(p) }).catch((e) => {
					if (ctx.signal.aborted) throw e;
					const code = (e as NodeJS.ErrnoException).code;
					throw new JobError(
						code === 'ENOSPC' ? 'DISK_FULL' : 'DESTINATION_FAILED',
						`Could not write to ${dest}: ${(e as Error).message}`,
						false,
					);
				}),
			concurrency: (ctx) => remotionConcurrency(ctx.slots),
		};
	}

	/** A local destination is validated like Export Frame's (S04:SC-002). */
	private assertDestination(d: { folder: string } | undefined): void {
		if (!d) return;
		if (!this.deps.localMode)
			throw new PlanError('LOCAL_MODE_ONLY', 403, 'Writing to a folder is only available in local mode');
		if (!isAbsolute(d.folder))
			throw new PlanError('VALIDATION_FAILED', 400, 'The destination folder must be an absolute path');
	}

	private submitDelivery(
		kind: 'alpha-delivery' | 'psd-export' | 'gamut-check',
		title: string,
		envelope: unknown,
		file: string,
		origin: EngineJob['origin'],
	): EngineJob {
		const doc = (envelope as { document?: { projectId?: string } }).document;
		return this.deps.queue.submit({
			kind,
			title,
			priority: 'interactive',
			cpuSlots: 2,
			minSlots: 1,
			origin,
			...(typeof doc?.projectId === 'string' ? { projectId: doc.projectId } : {}),
			input: { request: file },
		});
	}

	/** `POST /api/alpha-delivery` (spec 19 TL-114). */
	async alphaDelivery(
		req: AlphaDeliveryRequest,
		origin: EngineJob['origin'] = { type: 'user' },
	): Promise<EngineJob> {
		this.assertDestination(req.destination);
		const frames = req.range.end - req.range.start;
		const title = req.clipIds ? 'Export Title' : frames === 1 ? `Frame ${req.range.start}` : 'PNG sequence';
		const file = await this.storeRequest({ kind: 'alpha', request: req });
		return this.submitDelivery('alpha-delivery', title, req.envelope, file, origin);
	}

	private async runAlpha(ctx: JobContext): Promise<unknown> {
		const stored = await this.loadRequest(ctx);
		if (stored.kind !== 'alpha') throw new JobError('BAD_REQUEST', 'Not an alpha delivery request', false);
		const result = await runAlphaDelivery(ctx, stored.request, this.deliveryDeps());
		await rm((ctx.input as { request: string }).request, { force: true });
		return result;
	}

	/**
	 * `POST /api/psd/plan` (spec 19 TL-112): what the frame would become, what is baked and why it cannot be written.
	 * A sequence the render path refuses is a blocker here, not an error: the dialog shows it before anything runs.
	 */
	async psdPlan(req: PsdRequest): Promise<PsdPlan> {
		const range = { start: req.frame, end: req.frame + 1 };
		let planned: PlannedExport;
		try {
			planned = await this.deliveryPlan(req.envelope, req.sequenceId, range);
		} catch (e) {
			if (!(e instanceof PlanError) || e.status < 409) throw e;
			return {
				width: 0,
				height: 0,
				frame: req.frame,
				layers: [],
				baked: [],
				blockers: [{ code: e.code, message: e.message }],
				warnings: [],
				estimate: { renders: 0, bytes: 0 },
			};
		}
		const { plan } = planPsd(planned.snapshot, req.frame, { splitTitles: req.splitTitles === true });
		return {
			...plan,
			warnings: [...planned.plan.warnings.map(({ code, message }) => ({ code, message })), ...plan.warnings],
		};
	}

	/** `POST /api/psd` (spec 19 TL-112). */
	async psd(req: PsdRequest, origin: EngineJob['origin'] = { type: 'user' }): Promise<EngineJob> {
		this.assertDestination(req.destination);
		const file = await this.storeRequest({ kind: 'psd', request: req });
		return this.submitDelivery('psd-export', `PSD of frame ${req.frame}`, req.envelope, file, origin);
	}

	private async runPsd(ctx: JobContext): Promise<unknown> {
		const stored = await this.loadRequest(ctx);
		if (stored.kind !== 'psd') throw new JobError('BAD_REQUEST', 'Not a PSD request', false);
		const result = await runPsdExport(ctx, stored.request, this.deliveryDeps());
		await rm((ctx.input as { request: string }).request, { force: true });
		return result;
	}

	/** `POST /api/gamut-check` (spec 19 TL-116). */
	async gamutCheck(
		req: GamutCheckRequest,
		origin: EngineJob['origin'] = { type: 'user' },
	): Promise<EngineJob> {
		const file = await this.storeRequest({ kind: 'gamut', request: req });
		return this.submitDelivery(
			'gamut-check',
			`Gamut check of frame ${req.frame}`,
			req.envelope,
			file,
			origin,
		);
	}

	private async runGamut(ctx: JobContext): Promise<unknown> {
		const stored = await this.loadRequest(ctx);
		if (stored.kind !== 'gamut') throw new JobError('BAD_REQUEST', 'Not a gamut check request', false);
		const result = await runGamutCheck(ctx, stored.request, this.deliveryDeps());
		await rm((ctx.input as { request: string }).request, { force: true });
		return result;
	}

	/** Spec 19 TL-103: `cell-<n>.png` per cell, in order, as one job. A failed cell fails the job and names itself. */
	private async runStillSheet(ctx: JobContext): Promise<StillSheetResult> {
		const stored = await this.loadRequest(ctx);
		if (stored.kind !== 'still-sheet') throw new JobError('BAD_REQUEST', 'Not a sheet request', false);
		const req = stored.request;
		const dir = await this.outDir(ctx);
		ctx.addPartial(dir);
		const total = req.cells.length;
		const cells: StillSheetResult['cells'] = [];
		const warnings: { code: string; message: string }[] = [];
		let first: PlannedExport | null = null;
		for (const [i, cell] of req.cells.entries()) {
			if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
			ctx.progress(i / total, { stage: `Frame ${i + 1} of ${total}` });
			const part: JobContext = {
				...ctx,
				job: ctx.job,
				progress: (p, extra) => ctx.progress(p === null ? null : (i + Math.min(1, p)) / total, extra),
			};
			try {
				const r = await this.renderStillPng(
					part,
					{
						envelope: withHiddenClips(req.documents[cell.document]!, cell.sequenceId, cell.hide),
						sequenceId: cell.sequenceId,
						frame: cell.frame,
						...(req.width ? { width: req.width } : {}),
					},
					join(dir, `cell-${i}.png`),
				);
				first ??= r.planned;
				warnings.push(...r.warnings);
				cells.push({
					index: i,
					url: `/renders/${ctx.job.id}/cells/${i}`,
					document: cell.document,
					sequenceId: cell.sequenceId,
					frame: cell.frame,
					...(cell.tag ? { tag: cell.tag } : {}),
					renderPath: r.path,
				});
			} catch (e) {
				if (ctx.signal.aborted || !(e instanceof JobError)) throw e;
				throw new JobError(
					e.code,
					`Frame ${cell.frame} (cell ${i + 1} of ${total}): ${e.message}`,
					e.retryable,
					{
						...(e.detail && typeof e.detail === 'object' ? e.detail : {}),
						cell: i,
					},
				);
			}
		}
		if (first) this.commitRefs(ctx, first, 'still');
		await rm((ctx.input as { request: string }).request, { force: true });
		return {
			cells,
			...(req.meta ? { meta: req.meta } : {}),
			...(warnings.length ? { warnings: dedupeWarnings(warnings) } : {}),
		};
	}
}

/** A still of `envelope` with `hide`'s clips off (the document given is not changed). */
function withHiddenClips(
	envelope: StillSheetRequest['documents'][number],
	sequenceId: string,
	hide: readonly string[] | undefined,
): StillSheetRequest['documents'][number] {
	if (!hide?.length) return envelope;
	const document = structuredClone(envelope.document) as {
		sequences?: Record<string, { clips?: Record<string, { enabled?: boolean }> }>;
	};
	const clips = document.sequences?.[sequenceId]?.clips;
	if (clips) for (const id of hide) if (clips[id]) clips[id].enabled = false;
	return { ...envelope, document };
}

function dedupeWarnings(w: readonly { code: string; message: string }[]) {
	const seen = new Set<string>();
	return w.filter((x) => !seen.has(`${x.code}\n${x.message}`) && !!seen.add(`${x.code}\n${x.message}`));
}

/**
 * The delivery's checked encode (`deliver.ts`: the lossy encode whose decoded audio met the target) when it is exactly
 * this export's audio stream (same codec, bit rate, rate, channels): every mux copies it instead of encoding the WAV
 * again — the delivered bits are the checked bits, and the export saves one audio encode.
 */
/**
 * spec 13 AS-074: a composite killed by the system (SIGKILL that the job did not send: the OOM killer, a memory
 * limit) becomes an `OUT_OF_MEMORY` job error naming the cause, never a crash; other errors pass unchanged.
 */
/** The memory side of the segment plan of `snap` (spec 13 AS-074, memory.ts): the budget and one graph's estimate. */
function segmentMemory(snap: PlannedExport['snapshot']): SegmentMemory {
	const profile = compositeProfile(snap);
	return {
		budget: compositeMemoryBudget(),
		estimate: (range, threads) => estimateFrom(snap, profile, range, { threads }).bytes,
	};
}

/**
 * An ffmpeg command line for the job log, shortened in the middle when long (a composite has hundreds of inputs; the
 * log keeps its last 64,000 characters, which whole command lines pushed the segment list and the audio summary out of).
 */
function commandLine(args: readonly string[]): string {
	const text = args.join(' ').replace(/\s*\n\s*/g, ' ');
	if (text.length <= 2_000) return text;
	return `${text.slice(0, 700)} … [${args.length} arguments, ${text.length} characters] … ${text.slice(-900)}`;
}

/** Resident memory of a process (Linux `/proc/<pid>/status` VmRSS; 0 when it is gone). */
function residentBytes(pid: number): number {
	try {
		const m = /^VmRSS:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
		return m ? Number(m[1]) * 1024 : 0;
	} catch {
		return 0;
	}
}

/** Overlay filters in a filtergraph (each one is traversed by every frame of the composite). */
/** Overlays of a composite's largest graph (the main one or a blend segment's): `pipeline.overlays`. */
function graphOverlays(p: { graph: ReturnType<typeof buildNativeGraph> }): number {
	return Math.max(
		overlayCount(p.graph.filter),
		...(p.graph.blend?.segments ?? []).map((sg) => overlayCount(sg.filter)),
	);
}

/**
 * docs/wp-notes/export-performance.md §13: composites at once while deferred bakes still render
 * (`JASPER_EXPORT_BAKE_OVERLAP`, at most `atOnce`; default `atOnce`).
 */
function bakeOverlapFromEnv(atOnce: number): number {
	const n = Number(process.env.JASPER_EXPORT_BAKE_OVERLAP);
	return Number.isInteger(n) && n >= 1 ? Math.min(atOnce, n) : atOnce;
}

function overlayCount(filter: string): number {
	return filter.match(/\]overlay=/g)?.length ?? 0;
}

/**
 * §10: the line of a failed composite's error that names the OpenCL device or the filters around the OpenCL kernel
 * (`hwupload`, `program_opencl`, `hwdownload`), null when the failure is elsewhere.
 */
function openClErrorOf(e: unknown): string | null {
	if (!(e instanceof Error)) return null;
	const stderr = e instanceof ToolError && typeof e.detail?.stderr === 'string' ? e.detail.stderr : '';
	const line = `${stderr}\n${e.message}`
		.split('\n')
		.find((l) => /opencl|hwupload|hwdownload|\bCL_[A-Z_]+/i.test(l));
	return line ? line.trim().slice(0, 240) : null;
}

export function killedComposite(e: unknown, inputs: number, cancelled: boolean): unknown {
	if (cancelled || !(e instanceof Error) || !/exited SIGKILL/.test(e.message)) return e;
	return new JobError(
		'OUT_OF_MEMORY',
		`The export's compositor (ffmpeg, ${inputs} inputs) was killed by the system, most likely because the machine ran out of memory; close other applications or export a shorter range`,
		false,
		{ inputs },
	);
}

function deliveredEncode(p: PlannedExport, audio: MixdownResult | null): string | null {
	const n = audio?.normalized;
	const file = n?.delivery.encoded;
	if (!file || !n.codec) return null;
	const want = deliveryCodecOf(p);
	const c = n.codec;
	return want.codec === c.codec &&
		want.bits === c.bits &&
		want.bitrateKbps === c.bitrateKbps &&
		want.sampleRate === c.sampleRate &&
		want.channels === c.channels
		? file
		: null;
}

/**
 * The audio input of a mux and its output options: the delivery's checked encode by stream copy, else the mix WAV
 * resampled to the delivered rate when it differs and encoded with the deliverable's codec. Null without audio.
 */
function audioStream(
	p: PlannedExport,
	audio: MixdownResult | null,
	soxr: boolean,
): { file: string; args: string[] } | null {
	if (!audio?.path) return null;
	const enc = deliveredEncode(p, audio);
	if (enc) return { file: enc, args: ['-c:a', 'copy'] };
	const o = p.output;
	return {
		file: audio.path,
		args: [
			...(audio.sampleRate !== o.audioSampleRate
				? ['-af', `aresample=${o.audioSampleRate}:${resamplerArgs(soxr)}`]
				: []),
			...audioEncodeArgs(audioCodecOf(o.encoder, o), o.audioBitrateKbps, o.audioChannels, o.audioBits),
			'-ar',
			String(o.audioSampleRate),
			'-ac',
			String(o.audioChannels),
		],
	};
}

/** ranges.ts: a multi-range request whose ranges merge into one range, as that plain `custom` range export. */
function asOneRange<T extends { settings: ExportSettings }>(req: T): T {
	const ranges = joinedRanges(req.settings);
	if (ranges?.length !== 1) return req;
	const [r] = ranges;
	return {
		...req,
		settings: { ...req.settings, range: { type: 'custom', startFrame: r!.start, endFrame: r!.end } },
	};
}

/** The output file's extension: the GIF / audio-only container, else the video encoder's container. */
function outputExtension(p: PlannedExport): string {
	const d = p.deliverable;
	if (d?.kind === 'gif') return 'gif';
	if (d?.kind === 'audio') return d.audio.container;
	return p.output.encoder?.container ?? 'mp4';
}

/** The deliverable's audio encoding (what every path's mux writes: `audioEncodeArgs` with these). */
function deliveryCodecOf(p: PlannedExport): DeliveryCodec {
	const o = p.output;
	return {
		codec: audioCodecOf(o.encoder, o),
		bitrateKbps: o.audioBitrateKbps,
		sampleRate: o.audioSampleRate,
		channels: o.audioChannels,
		...(o.audioBits ? { bits: o.audioBits } : {}),
	};
}

type AudioLoudnessResult = NonNullable<import('@jasper/api').ExportResult['audioLoudness']>;

/**
 * The export result's `audioLoudness`: what the delivered file's audio measures (decoded from the file itself when it
 * is lossy or resampled) and how the delivery got there (limiter ceiling, codec headroom, passes, local corrections).
 */
function audioLoudnessOf(
	audio: MixdownResult,
	delivered: { loudness: import('@jasper/audio-dsp').LoudnessSummary } | null,
	copied: boolean,
): AudioLoudnessResult {
	const f = (x: number) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
	const m = delivered?.loudness ?? audio.loudness;
	const n = audio.normalized;
	const d = n?.delivery;
	return {
		integratedLufs: f(m.integrated),
		truePeakDbtp: f(m.truePeakDb),
		lra: f(m.lra),
		measuredOn: delivered ? 'decoded-file' : 'pcm',
		...(delivered
			? { pcm: { integratedLufs: f(audio.loudness.integrated), truePeakDbtp: f(audio.loudness.truePeakDb) } }
			: {}),
		...(n && d
			? {
					normalizedGainDb: n.gainDb,
					targetLufs: n.targetLufs,
					truePeakTargetDbtp: n.truePeakDb,
					limiterCeilingDbtp: d.params.ceilingDb,
					codecHeadroomDb: d.codecHeadroomDb,
					loudnessPasses: d.passes,
					encodePasses: d.encodePasses,
					localCorrections: { count: d.corrections.hops, maxDb: Math.round(d.corrections.maxDb * 100) / 100 },
					ceilingLimited: d.ceilingLimited,
					truePeakMet: Number.isFinite(m.truePeakDb) ? m.truePeakDb <= n.truePeakDb + 0.05 : true,
					...(d.cached ? { deliveryReused: true } : {}),
					...(copied ? { streamCopied: true } : {}),
				}
			: {}),
	};
}

/**
 * AGENTS §4 (never silent): the delivered audio misses the delivery target — its true peak over the target after the
 * bounded corrections, or a loudness the limiter's ceiling kept outside ±0.5 LU.
 */
function deliveryWarnings(
	a: AudioLoudnessResult,
): { code: string; message: string; params: Record<string, string | number> }[] {
	const out: { code: string; message: string; params: Record<string, string | number> }[] = [];
	if (a.truePeakTargetDbtp === undefined || a.targetLufs === undefined) return out;
	if (a.truePeakMet === false && a.truePeakDbtp !== null)
		out.push({
			code: 'AUDIO_TRUE_PEAK_OVER',
			// the editor says it from code + params (apps/web/src/export/warning-text.ts): in English exactly these words
			message: `The delivered audio peaks at ${a.truePeakDbtp.toFixed(1)} dBTP, over the ${a.truePeakTargetDbtp} dBTP target: lower the loudest moments or use a higher audio bit rate`,
			params: { truePeakDbtp: Math.round(a.truePeakDbtp * 10) / 10, targetDbtp: a.truePeakTargetDbtp },
		});
	if (a.integratedLufs !== null && Math.abs(a.integratedLufs - a.targetLufs) > 0.5)
		out.push({
			code: 'AUDIO_LOUDNESS_CEILING',
			message: a.ceilingLimited
				? `The delivered audio measures ${a.integratedLufs.toFixed(1)} LUFS, not the ${a.targetLufs} LUFS target: the true-peak limiter cannot make it louder under its ${(a.limiterCeilingDbtp ?? a.truePeakTargetDbtp).toFixed(1)} dBTP ceiling`
				: `The delivered audio measures ${a.integratedLufs.toFixed(1)} LUFS, not the ${a.targetLufs} LUFS target`,
			params: {
				integratedLufs: Math.round(a.integratedLufs * 10) / 10,
				targetLufs: a.targetLufs,
				ceilingDbtp: Math.round((a.limiterCeilingDbtp ?? a.truePeakTargetDbtp) * 10) / 10,
				why: a.ceilingLimited ? 'ceiling' : 'converge',
			},
		});
	return out;
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
	return /^\.(mp4|webm|mov|m4v|mkv|gif|wav|flac|m4a)$/i.test(cur)
		? dest.slice(0, -cur.length) + ext
		: dest + ext;
}

/**
 * Copies to `dest`, replacing a file there atomically (start_export `overwrite`): the bytes go to a hidden temporary
 * file in the same folder (claimed through `claimed` first, so a cancelled job deletes it), are synced, and the
 * temporary file is renamed over `dest`, then the folder is synced. The old file stays until the new one is complete;
 * a failure or cancel leaves it untouched. `replaced`: a file was there.
 */
export async function copyReplacing(
	src: string,
	dest: string,
	opts: { signal?: AbortSignal; claimed?(path: string): void } = {},
): Promise<{ path: string; replaced: boolean }> {
	const dir = dirname(dest);
	await mkdir(dir, { recursive: true });
	opts.signal?.throwIfAborted();
	const tmp = join(dir, `.${basename(dest)}.${randomBytes(6).toString('hex')}.partial`);
	const out = await open(tmp, 'wx');
	opts.claimed?.(tmp);
	try {
		// the stream closes `out` when it ends (a FileHandle cannot close under an open stream); sync through a new handle
		await pipeline(createReadStream(src), out.createWriteStream(), { signal: opts.signal });
		const fh = await open(tmp, 'r+');
		try {
			await fh.sync();
		} finally {
			await fh.close();
		}
		opts.signal?.throwIfAborted();
		const replaced = await stat(dest).then(
			(st) => st.isFile(),
			() => false,
		);
		await rename(tmp, dest);
		await fsyncDir(dir);
		return { path: dest, replaced };
	} catch (e) {
		await out.close().catch(() => undefined);
		await rm(tmp, { force: true }).catch(() => undefined);
		throw e;
	}
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

/** The clips a planned export draws with offline media, as verify.json records them (`at` in a multi-range file). */
function offlineSpansOf(planned: PlannedExport): OfflineSpan[] {
	const clips = planned.document.sequences[planned.sequenceId]?.clips;
	const names = (id: string) => clips?.[id]?.name;
	const out: OfflineSpan[] = [];
	let at = 0;
	for (const part of planned.joined ?? [{ range: planned.range, snapshot: planned.snapshot }]) {
		for (const u of offlineUsesOf(part.snapshot, names))
			out.push({
				start: u.start,
				end: u.end,
				clipId: u.clipId,
				name: u.name,
				mediaId: u.mediaId,
				sound: u.sound,
				...(planned.joined ? { at: at + u.start - part.range.start } : {}),
			});
		at += part.range.end - part.range.start;
	}
	return out;
}
