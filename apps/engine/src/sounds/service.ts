// The engine's sound library service (spec 12 §2.1, §2.8; wp-note "WP1.2"): the index, user folders, the bundled
// starter kit, Jasper Synth, search with facets, files and visual data of a sound, and registering a sound into a
// project. Routes: routes/sounds.ts.
import { mkdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import {
	type EngineJob,
	type JobKind,
	type RegisteredMedia,
	type RegisterSoundResponse,
	SOUND_ANALYSIS_SECONDS,
	SOUND_PACK_ID_RE,
	SOUND_SOURCE_TYPES,
	type SoundEntry,
	type SoundLibraryStatus,
	type SoundPackInstallResult,
	type SoundPackRemoveResponse,
	type SoundPacksResponse,
	type SoundRoot,
	type SoundRootsPutRequest,
	type SoundSearchQuery,
	type SoundSearchResponse,
	type SoundSourceType,
	type SoundVisual,
	soundEntryById,
	withOfferedTakes,
} from '@jasper/api';
import {
	LIBRARY_PAD_MAX_SECONDS,
	type LibraryInexactReason,
	type LibraryProvenance,
	LibraryProvenanceSchema,
	libraryLeadSilenceSamples,
	libraryTrailSilenceSamples,
	SOUND_REF_RE,
	shiftLibraryDescriptors,
} from '@jasper/project';
import { isLoopbackHost } from '../context.ts';
import { type JobContext, JobError } from '../jobs/types.ts';
import { fingerprintFile, fingerprintHex } from '../media/fingerprint.ts';
import type { ProcessingService } from '../processing/service.ts';
import { freeDiskBytes } from '../tools/fs.ts';
import { contentTypeFor } from '../tools/http.ts';
import { HttpError } from '../tools/reply.ts';
import type { CoreServices } from '../tools/services.ts';
import { resolveSoundWorker, SoundAnalyzer } from './analysis.ts';
import { decodeSound } from './decode.ts';
import { ANALYSIS_VERSION, SoundIndexer } from './index-job.ts';
import { type LibrarySnapshot, SoundLibrary } from './library.ts';
import { loadPackCatalog, type PackCatalog, SOUND_CATALOG_ENV, SoundPackStore } from './packs.ts';
import {
	copyCodecFor,
	estimateCopyBytes,
	isPcmCodec,
	paddedFileName,
	probeAudioStream,
	writePaddedSound,
} from './pad.ts';
import { SoundRootStore, type SoundRootsPlan } from './roots.ts';
import { searchSoundEntries } from './search.ts';
import { SemanticService } from './semantic/service.ts';
import { isSoundFileName, type LoadedManifest, loadManifest, starterDir } from './starter.ts';
import { ensureSynthFile, synthItems } from './synth.ts';
import {
	readVisual,
	takeAudioCacheFile,
	takeVisualCacheFile,
	visualCacheFile,
	writeVisual,
} from './visual.ts';

const PACK_JOB: JobKind = 'sound-pack-install';

/**
 * Largest managed copy registering writes (WP6.5b): 2 GiB — under WAV's 4 GiB limit; a 1 h stereo 48 kHz float copy is
 * 1.4 GB. `JASPER_SOUND_COPY_MAX_BYTES` overrides it (tests).
 */
export const SOUND_COPY_MAX_BYTES = 2 * 1024 ** 3;
/** Free disk space a copy must leave on the media volume (projects, renders and the cache need room too). */
export const SOUND_COPY_RESERVE_BYTES = 512 * 1024 ** 2;
const SOUND_PACK_ID = SOUND_PACK_ID_RE;

/** Turn `JASPER_SOUND_AUTO_INDEX=0` to keep the engine from indexing by itself (default on; off under vitest). */
export const AUTO_INDEX_ENV = 'JASPER_SOUND_AUTO_INDEX';
/** Visual data computed on request at once (each decodes up to 30 s of audio). */
const VISUAL_CONCURRENCY = 2;
/** A visual analysis that takes longer is stopped (its worker ended) so it cannot hold a slot for ever. */
export const VISUAL_TIMEOUT_MS = 120_000;
/** Automatic indexing after a failed automatic job waits this long, doubling per failure up to AUTO_RETRY_MAX_MS. */
export const AUTO_RETRY_BASE_MS = 60_000;
export const AUTO_RETRY_MAX_MS = 60 * 60_000;

/** The last automatic index job: whether (and when) automatic indexing may try again. */
type AutoAttempt = { jobId: string; starterHash: string; failures: number; retryAt: number };

const notFound = (id: string) =>
	new HttpError(404, 'SOUND_NOT_FOUND', `Unknown sound: ${String(id).slice(0, 80)}`);

function semaphore(n: number) {
	let active = 0;
	const waiting: (() => void)[] = [];
	return async <T>(fn: () => Promise<T>): Promise<T> => {
		if (active >= n) await new Promise<void>((r) => waiting.push(r));
		active++;
		try {
			return await fn();
		} finally {
			active--;
			waiting.shift()?.();
		}
	};
}

/** `child` is `base` or inside it (both real paths). */
function inside(base: string, child: string): boolean {
	return child === base || child.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * The provenance a registered library sound carries in the project (`MediaAsset.library`): the library entry's, with
 * time points of the registered file (`leadSilenceSec` in front, `trailSilenceSec` after). `tailSec` (where the sound has
 * faded to −60 dB) is kept only when the library's analysis covered the whole file. A take's (P6-E9) names its
 * recording and range (`take`).
 */
export function provenanceOf(
	e: SoundEntry,
	snapshotHash: string,
	leadSilenceSec = 0,
	trailSilenceSec = 0,
	/** The sound is registered as it is although it needed a sample-exact copy (`LibraryProvenance.inexact`). */
	inexact?: LibraryInexactReason,
): LibraryProvenance {
	const lead = leadSilenceSec > 0 ? leadSilenceSec : 0;
	const trail = trailSilenceSec > 0 ? trailSilenceSec : 0;
	// Analyses cached by older builds (or ffprobe's estimate for a broken file) may hold values the provenance schema
	// bounds: keep them inside, so registering never fails on a number.
	const clamp = (v: number, lo: number, hi: number) =>
		Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
	const sec = (v: number) => clamp(v, 0, 86_400 - 1);
	const raw = e.descriptors;
	const d = {
		...raw,
		peakSec: sec(raw.peakSec),
		onsetSec: sec(raw.onsetSec),
		headQuietSec: sec(raw.headQuietSec),
		durationSec: sec(raw.durationSec),
		octaveBandsDb: raw.octaveBandsDb.map((v) => clamp(v, -400, 400)),
		centroidHz: clamp(raw.centroidHz, 0, 1_000_000),
		maxMomentaryLufs:
			raw.maxMomentaryLufs === null || !Number.isFinite(raw.maxMomentaryLufs) || raw.maxMomentaryLufs < -400
				? null
				: Math.min(400, raw.maxMomentaryLufs),
		// analyses cached before true peak was part of them (or digital silence) carry none
		truePeakDb:
			typeof raw.truePeakDb !== 'number' || !Number.isFinite(raw.truePeakDb) || raw.truePeakDb < -400
				? null
				: Math.min(400, raw.truePeakDb),
	};
	// the tail is measured on the analysed span: only a whole-file analysis says where the sound fades
	const tailKnown =
		typeof raw.tailSec === 'number' &&
		Number.isFinite(raw.tailSec) &&
		raw.tailSec >= 0 &&
		d.durationSec <= SOUND_ANALYSIS_SECONDS &&
		d.peakSec + raw.tailSec <= d.durationSec + 0.001;
	const candidate = {
		soundId: e.id,
		title: e.title,
		types: e.types,
		source: e.source,
		license: e.license,
		...(e.licenseUrl ? { licenseUrl: e.licenseUrl } : {}),
		author: e.author,
		...(e.sourceUrl ? { sourceUrl: e.sourceUrl } : {}),
		attribution: e.attribution,
		// The registered file's time points: the library file's, moved by the silence put in front of it.
		descriptors: shiftLibraryDescriptors(
			{
				peakSec: d.peakSec,
				onsetSec: d.onsetSec,
				headQuietSec: d.headQuietSec,
				durationSec: d.durationSec,
				octaveBandsDb: d.octaveBandsDb,
				centroidHz: d.centroidHz,
				maxMomentaryLufs: d.maxMomentaryLufs,
				truePeakDb: d.truePeakDb,
				...(tailKnown ? { tailSec: Math.min(raw.tailSec, d.durationSec - d.peakSec + 0.001) } : {}),
			},
			lead,
			trail,
		),
		...(lead > 0 ? { leadSilenceSec: lead } : {}),
		...(trail > 0 ? { trailSilenceSec: trail } : {}),
		snapshotHash,
		...(inexact ? { inexact: { reason: inexact } } : {}),
		// a take (P6-E9): where it lies in its recording
		...(e.take
			? {
					take: {
						soundId: e.take.soundId,
						index: e.take.index,
						sourceStartSec: sec(e.take.startSec),
						sourceEndSec: sec(e.take.endSec),
					},
				}
			: {}),
	};
	return LibraryProvenanceSchema.parse(candidate) as LibraryProvenance;
}

/**
 * A take's range in source samples (P6-E9): the analysis measured it at the file's own rate up to 48 kHz (above, at
 * 48 kHz), so the boundaries are whole samples of the source at its own rate. Null without a known rate.
 */
export function takeRange(
	take: { startSec: number; endSec: number },
	sampleRate: number | null | undefined,
): { startSample: number; endSample: number } | null {
	if (!sampleRate || !(sampleRate > 0)) return null;
	const startSample = Math.max(0, Math.round(take.startSec * sampleRate));
	const endSample = Math.round(take.endSec * sampleRate);
	return endSample > startSample ? { startSample, endSample } : null;
}

/** Remembers `v` under `k` in a bounded insertion-ordered map. */
function remember<T>(m: Map<string, T>, k: string, v: T, max = 4096): void {
	m.delete(k);
	m.set(k, v);
	while (m.size > max) m.delete(m.keys().next().value!);
}

export class SoundService {
	readonly library: SoundLibrary;
	readonly roots: SoundRootStore;
	readonly indexer: SoundIndexer;
	readonly analyzer: SoundAnalyzer;
	/** Downloadable packs (WP6.1): the catalogue, installs and removals. */
	readonly packs: SoundPackStore;
	/** Describe-it search and Find Moment (P6-E14, WP-E9): the optional audio-text model's embeddings and searches. */
	readonly semantic: SemanticService;
	/** Leftovers of earlier runs (staging folders, stale partial downloads) are deleted before the first install. */
	private readonly packsReady: Promise<void>;
	private catalogCache: PackCatalog | null = null;
	private readonly limitVisual = semaphore(VISUAL_CONCURRENCY);
	private starterCache: { at: number; manifest: LoadedManifest } | null = null;
	/** The index's entries in id order, for the snapshot they were made from (search). */
	private sorted: { sounds: LibrarySnapshot['sounds']; list: SoundEntry[] } | null = null;
	private auto: AutoAttempt | null = null;
	/** Registering (bounded, per engine): a sound file's audio stream by content fingerprint… */
	private readonly streamOf = new Map<string, Awaited<ReturnType<typeof probeAudioStream>>>();
	/** …and the media key of its padded / PCM copy by content, padding, codec and rate. */
	private readonly copyOf = new Map<string, string>();

	constructor(
		private readonly core: CoreServices,
		opts: {
			log?: (m: string) => void;
			/** The processing service (its model catalogue holds the Describe-it search model); none: describe is unavailable. */
			processing?: ProcessingService | null;
		} = {},
	) {
		const paths = core.config.paths;
		this.library = new SoundLibrary(paths.soundLibraryIndex, {
			onChange: (s) => {
				core.broadcaster.publish('sounds.changed', s);
				core.capabilities.changed();
			},
			...(opts.log ? { log: opts.log } : {}),
		});
		this.roots = new SoundRootStore(paths.soundRootsFile, opts.log);
		this.analyzer = new SoundAnalyzer(resolveSoundWorker(process.env), opts.log);
		this.indexer = new SoundIndexer({
			library: this.library,
			roots: this.roots,
			ffmpeg: core.ffmpeg,
			analyzer: this.analyzer,
			starterDir: () => this.starterDir(),
			packsDir: paths.soundPacksDir,
			synthDir: paths.soundSynthDir,
			cacheDir: paths.soundCacheDir,
			synthItems: () => synthItems(process.env),
			local: () => this.local,
			followUp: (jobId, full) => {
				void core.queue
					.wait(jobId)
					.then(() => this.startIndex({ ...(full ? { full: true } : {}), origin: { type: 'system' } }))
					.catch(() => undefined);
			},
			...(opts.log ? { log: opts.log } : {}),
		});
		core.queue.registerRunner('sound-index', (ctx) => this.indexer.run(ctx));
		const env = process.env;
		const ms = (k: string) => {
			const v = Number(env[k]);
			return Number.isFinite(v) && v > 0 ? v : undefined;
		};
		const stallMs = ms('JASPER_SOUND_PACK_STALL_MS');
		const timeoutMs = ms('JASPER_SOUND_PACK_TIMEOUT_MS');
		const fileIntervalMs = ms('JASPER_SOUND_PACK_FILE_INTERVAL_MS');
		this.packs = new SoundPackStore({
			packsDir: paths.soundPacksDir,
			catalog: () => this.packCatalog(),
			...(stallMs ? { stallMs } : {}),
			...(timeoutMs ? { timeoutMs } : {}),
			...(fileIntervalMs ? { fileIntervalMs } : {}),
		});
		this.packsReady = this.packs
			.cleanup()
			.catch((e) => opts.log?.(`sound packs: cleanup failed: ${(e as Error).message}`));
		core.queue.registerRunner(PACK_JOB, (ctx) => this.runPackInstall(ctx));
		this.semantic = new SemanticService(
			core,
			opts.processing ?? null,
			{
				entries: async () => (await this.rankingPool()).entries,
				allEntries: async () => withOfferedTakes(this.sortedEntries(await this.library.snapshot())),
				get: (id) => this.get(id),
				fileOf: (e) => this.fileOf(e),
				...(opts.log ? { log: opts.log } : {}),
			},
			process.env,
		);
	}

	/** The pack catalogue (the built-in one is read once; a `JASPER_SOUND_CATALOG` override on every call). */
	async packCatalog(): Promise<PackCatalog> {
		if (process.env[SOUND_CATALOG_ENV]) return loadPackCatalog(process.env);
		this.catalogCache ??= await loadPackCatalog(process.env);
		return this.catalogCache;
	}

	/** The queued or running install job of a pack. */
	packJob(packId: string): EngineJob | null {
		return (
			this.core.queue
				.list({ active: true, kind: PACK_JOB })
				.find((j) => j.dedupeKey === `sound-pack:${packId}`) ?? null
		);
	}

	async listPacks(): Promise<SoundPacksResponse> {
		const snapshot = await this.library.snapshot();
		const counts = new Map<string, number>();
		for (const e of Object.values(snapshot.sounds))
			if (e.source.type === 'pack') counts.set(e.source.packId, (counts.get(e.source.packId) ?? 0) + 1);
		return this.packs.list({ indexed: (id) => counts.get(id) ?? 0, job: (id) => this.packJob(id) });
	}

	/** Starts (or joins) the `sound-pack-install` job of a catalogue pack (404 when the catalogue has no such pack). */
	async submitPackInstall(packId: string, origin: EngineJob['origin']): Promise<EngineJob> {
		const e = SOUND_PACK_ID.test(packId) ? await this.packs.entry(packId) : null;
		if (!e)
			throw new HttpError(404, 'SOUND_PACK_UNKNOWN', `Unknown sound pack ${String(packId).slice(0, 64)}`);
		return this.core.queue.submit({
			kind: PACK_JOB,
			title: `Install sound pack – ${e.title}`,
			priority: 'user',
			cpuSlots: 0,
			origin,
			dedupeKey: `sound-pack:${packId}`,
			input: { packId },
			stage: 'Waiting',
		});
	}

	private async runPackInstall(ctx: JobContext): Promise<SoundPackInstallResult> {
		const { packId } = (ctx.input ?? {}) as { packId?: unknown };
		if (typeof packId !== 'string' || !SOUND_PACK_ID.test(packId))
			throw new JobError('SOUND_PACK_UNKNOWN', 'Invalid pack id', false);
		await this.packsReady;
		let r: Omit<SoundPackInstallResult, 'indexJobId'>;
		try {
			r = await this.packs.install(packId, {
				signal: ctx.signal,
				jobId: ctx.job.id,
				progress: (p, stage) => ctx.progress(p, { stage }),
			});
		} catch (e) {
			if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
			if (e instanceof JobError) throw e;
			const code = (e as NodeJS.ErrnoException).code;
			if (code === 'ENOSPC') throw new JobError('DISK_FULL', 'The disk is full', false);
			throw e;
		}
		ctx.log(
			`${packId}: ${r.alreadyInstalled ? 'already installed' : `installed ${r.sounds} files, ${r.downloadedBytes} bytes downloaded`}`,
		);
		// The library picks the pack up incrementally (only its new files are analysed).
		const snapshot = await this.library.snapshot();
		const indexed = Object.values(snapshot.sounds).filter(
			(s) => s.source.type === 'pack' && s.source.packId === packId,
		).length;
		const needIndex = !r.alreadyInstalled || indexed === 0 || !snapshot.packs[packId];
		const job = needIndex ? this.startIndex({ origin: ctx.job.origin }) : null;
		this.core.capabilities.changed();
		return { ...r, indexJobId: job?.id ?? null };
	}

	/**
	 * Removes an installed pack (approval is the route's business): its folder goes, its sounds leave the index at once,
	 * and an index job runs so a sound also found in another source comes back under it. Projects that use its sounds
	 * keep their managed copies.
	 */
	async removePack(packId: string, origin: EngineJob['origin']): Promise<SoundPackRemoveResponse> {
		if (this.packJob(packId))
			throw new HttpError(409, 'SOUND_PACK_BUSY', 'The pack is being installed; cancel the job first');
		const r = await this.packs.remove(packId);
		if (!r.removed) return { packId, removed: false, removedSounds: 0, freedBytes: 0, job: null };
		const removedSounds = await this.library.remove(
			(e) => e.source.type === 'pack' && e.source.packId === packId,
			[`pack:${packId}:`],
			[packId],
		);
		this.core.capabilities.changed();
		return {
			packId,
			removed: true,
			removedSounds,
			freedBytes: r.freedBytes,
			job: this.startIndex({ origin }),
		};
	}

	/** Folders and their files may be used (local mode, D-47). */
	get local(): boolean {
		const { config } = this.core;
		return config.dev || isLoopbackHost(config.host);
	}

	starterDir(): string {
		return starterDir(process.env);
	}

	/** The starter manifest (re-read at most every 5 s). */
	async starter(): Promise<LoadedManifest> {
		const now = Date.now();
		if (this.starterCache && now - this.starterCache.at < 5000) return this.starterCache.manifest;
		const manifest = await loadManifest(this.starterDir());
		this.starterCache = { at: now, manifest };
		return manifest;
	}

	/** The queued or running index job, if any. */
	activeIndexJob(): EngineJob | null {
		return this.core.queue.list({ active: true, kind: 'sound-index' })[0] ?? null;
	}

	/**
	 * Starts an index job, or joins the queued or running one; a joined job scans once more after its current scan
	 * (full when `full` is asked), so neither a new request nor a full rebuild is lost.
	 */
	startIndex(opts: { full?: boolean; origin?: EngineJob['origin'] } = {}): EngineJob {
		const active = this.activeIndexJob();
		if (active) {
			this.indexer.requestPass(opts.full === true);
			// A job being cancelled scans no more: the request runs as a new job once it has ended.
			if (active.state === 'cancelling')
				void this.core.queue
					.wait(active.id)
					.then(() => {
						if (!this.activeIndexJob()) this.startIndex(opts);
					})
					.catch(() => undefined);
			return active;
		}
		// The user (or an agent) asking for an index lifts the hold on automatic indexing.
		if (opts.origin?.type !== 'system') this.auto = null;
		const job = this.core.queue.submit({
			kind: 'sound-index',
			title: opts.full ? 'Rebuild the sound library' : 'Index the sound library',
			priority: 'background',
			cpuSlots: 1,
			origin: opts.origin ?? { type: 'user' },
			dedupeKey: 'sound-index',
			input: opts.full ? { full: true } : {},
			stage: 'Waiting',
		});
		// P6-E14: new sounds get their Describe-it embeddings after the index (when the model is installed)
		void this.core.queue
			.wait(job.id)
			.then((j) => (j.state === 'succeeded' ? this.semantic.autoEmbed() : null))
			.catch(() => undefined);
		return job;
	}

	/**
	 * Whether the library should be (re)indexed: never indexed, rebuilt after damage, the starter kit changed, or sounds
	 * were analysed by an older analysis version (an upgrade: their takes, materials and new judge flags come with it).
	 */
	async needsIndex(): Promise<boolean> {
		if (await this.library.neverIndexed()) return true;
		const s = await this.library.snapshot();
		const starter = await this.starter();
		if (s.starterHash !== starter.hash) return true;
		for (const e of Object.values(s.sounds)) if (e.analysisVersion !== ANALYSIS_VERSION) return true;
		return false;
	}

	/**
	 * Indexes by itself when the library needs it, unless `JASPER_SOUND_AUTO_INDEX=0` (default off under vitest).
	 * Remembers its last job: after the user cancelled it, it does not start again until the starter kit changes or an
	 * index is asked for; after a failure it waits (1 min, doubling per failure, at most 1 h).
	 */
	async autoIndex(): Promise<EngineJob | null> {
		const env = process.env;
		const flag = env[AUTO_INDEX_ENV] ?? (env.VITEST ? '0' : '1');
		if (flag === '0' || flag === 'false') return null;
		if (this.activeIndexJob()) return null;
		if (!(await this.needsIndex())) return null;
		const starterHash = (await this.starter()).hash;
		const last = this.auto;
		let failures = 0;
		if (last) {
			const job = this.core.queue.get(last.jobId);
			const state = job?.state;
			if (state === 'queued' || state === 'running' || state === 'cancelling') return null;
			const sameKit = last.starterHash === starterHash;
			if (state === 'cancelled' && sameKit) return null;
			if (state === 'failed' || state === 'interrupted') {
				if (sameKit && Date.now() < last.retryAt) return null;
				failures = sameKit ? last.failures : 0;
			}
			// A job that succeeded was the last one (a later need, e.g. a new kit, may start one at once).
		}
		const job = this.startIndex({ origin: { type: 'system' } });
		const next = failures + 1;
		this.auto = {
			jobId: job.id,
			starterHash,
			failures: next,
			retryAt: Date.now() + Math.min(AUTO_RETRY_MAX_MS, AUTO_RETRY_BASE_MS * 2 ** (next - 1)),
		};
		return job;
	}

	/** A recording, or a take entry for a take id (`snd_<16 hex>~t<n>`, P6-E9); 404 when unknown. */
	async get(id: string): Promise<SoundEntry> {
		const e = typeof id === 'string' && SOUND_REF_RE.test(id) ? await this.library.get(id) : null;
		if (!e) throw notFound(id);
		return e;
	}

	/** The index's entries in id order (sorted once per snapshot). */
	private sortedEntries(snapshot: LibrarySnapshot): SoundEntry[] {
		if (this.sorted?.sounds !== snapshot.sounds) {
			const sounds = snapshot.sounds;
			this.sorted = {
				sounds,
				list: Object.keys(sounds)
					.sort()
					.map((id) => sounds[id]!),
			};
		}
		return this.sorted.list;
	}

	async search(q: SoundSearchQuery, signal?: AbortSignal): Promise<SoundSearchResponse> {
		const snapshot = await this.library.snapshot();
		const all = this.sortedEntries(snapshot);
		// P6-E14: describe mode ranks by the audio-text model (every visible sound and offered take is scored once);
		// without it, the description's words are searched.
		const text = q.describe?.trim() ? q.describe : undefined;
		const described = text
			? await this.semantic.describe(
					text,
					withOfferedTakes(all.filter((e) => this.local || e.source.type !== 'folder')),
					signal,
				)
			: null;
		const out = searchSoundEntries(all, q, {
			lookup: (id) =>
				soundEntryById(id, (k) => (Object.hasOwn(snapshot.sounds, k) ? snapshot.sounds[k] : undefined)) ??
				undefined,
			// Folder sounds are not offered by a remote engine (D-47), even when an index from a local run has them.
			includeFolders: this.local,
			...(described && text
				? described.scores
					? { semantic: { scores: described.scores, text, matches: described.matches! } }
					: { describeAsKeywords: text }
				: {}),
		});
		return {
			snapshotHash: snapshot.snapshotHash,
			librarySize: all.length,
			...out,
			indexing: this.activeIndexJob() !== null,
			...(described ? { describe: described.info } : {}),
		};
	}

	/**
	 * The entries ranking may pick from (id order), for the sound-design plan: folder sounds only on a local engine (D-47),
	 * and only of the given sources when `sources` is set; the offered takes of multi-hit recordings follow their
	 * recording (P6-E9: a typing run's key presses are candidates of their own, and `pickVariant` rotates over them).
	 */
	async rankingPool(
		sources?: readonly SoundSourceType[],
	): Promise<{ entries: SoundEntry[]; snapshotHash: string; librarySize: number }> {
		const snapshot = await this.library.snapshot();
		const all = this.sortedEntries(snapshot);
		const allowed = sources?.length ? new Set<string>(sources) : null;
		const entries = withOfferedTakes(
			all.filter(
				(e) => (this.local || e.source.type !== 'folder') && (!allowed || allowed.has(e.source.type)),
			),
		);
		return { entries, snapshotHash: snapshot.snapshotHash, librarySize: all.length };
	}

	/**
	 * The file of a sound on this engine, checked: inside its kit, pack or folder after resolving links, an audio file,
	 * existing. Synth sounds are rendered when their file is gone. Folder sounds need local mode.
	 */
	async fileOf(e: SoundEntry): Promise<string> {
		const src = e.source;
		let base: string;
		let path: string;
		if (src.type === 'synth') {
			try {
				return await ensureSynthFile(this.core.config.paths.soundSynthDir, src.recipe, src.seed);
			} catch (err) {
				throw new HttpError(
					404,
					'SOUND_FILE_MISSING',
					`The synth sound cannot be rendered: ${(err as Error).message}`,
				);
			}
		}
		if (src.type === 'starter') {
			base = this.starterDir();
			path = join(base, ...src.file.split('/'));
		} else if (src.type === 'pack') {
			if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(src.packId)) throw notFound(e.id);
			base = join(this.core.config.paths.soundPacksDir, src.packId);
			path = join(base, ...src.file.split('/'));
		} else {
			if (!this.local)
				throw new HttpError(
					403,
					'LOCAL_MODE_ONLY',
					'Sounds of user folders are only available with a local engine',
				);
			const root = (await this.roots.list()).find((r) => r.id === src.rootId && r.enabled);
			if (!root)
				throw new HttpError(404, 'SOUND_FILE_MISSING', 'The sound’s folder is no longer in the library');
			base = root.path;
			path = join(base, ...src.relPath.split('/'));
		}
		let realBase: string;
		let real: string;
		try {
			realBase = await realpath(base);
			real = await realpath(path);
		} catch {
			throw new HttpError(404, 'SOUND_FILE_MISSING', 'The sound’s file is missing; rescan the sound library');
		}
		if (!inside(realBase, real) || !isSoundFileName(real))
			throw new HttpError(403, 'NOT_A_SOUND', 'The sound’s file now points outside its folder');
		// A regular file only: a FIFO or device named like a sound would block whoever reads it.
		const st = await stat(real).catch(() => null);
		if (!st)
			throw new HttpError(404, 'SOUND_FILE_MISSING', 'The sound’s file is missing; rescan the sound library');
		if (!st.isFile()) throw new HttpError(403, 'NOT_A_SOUND', 'The sound’s file is not a regular file');
		return real;
	}

	/** The content type an audio file is served with (audio types only). */
	audioType(file: string): string {
		const type = contentTypeFor(file, '');
		if (!type.startsWith('audio/')) throw new HttpError(403, 'NOT_A_SOUND', 'Only audio files are served');
		return type;
	}

	async visual(e: SoundEntry): Promise<SoundVisual> {
		// Folder sounds need local mode, also when their visual data is cached.
		if (e.source.type === 'folder' && !this.local)
			throw new HttpError(
				403,
				'LOCAL_MODE_ONLY',
				'Sounds of user folders are only available with a local engine',
			);
		if (e.take) return this.takeVisual(e, e.take);
		const file = visualCacheFile(this.core.config.paths.soundCacheDir, fingerprintHex(e.fingerprint));
		const cached = await readVisual(file, e.fingerprint);
		if (cached) return cached;
		return this.limitVisual(async () => {
			const again = await readVisual(file, e.fingerprint);
			if (again) return again;
			const path = await this.fileOf(e);
			if ((await fingerprintFile(path)).fingerprint !== e.fingerprint)
				throw new HttpError(
					409,
					'SOUND_CHANGED',
					'The file changed since it was indexed; rescan the sound library',
				);
			const decoded = await this.mediaCall(() => decodeSound(this.core.ffmpeg, path));
			let v: SoundVisual;
			try {
				v = (
					await this.analyzer.run(
						{
							kind: 'visual',
							soundId: e.id,
							fingerprint: e.fingerprint,
							durationSec: e.descriptors.durationSec,
							peakSec: e.descriptors.peakSec,
							channels: decoded.channels,
							rate: decoded.rate,
						},
						undefined,
						{ timeoutMs: VISUAL_TIMEOUT_MS },
					)
				).visual;
			} catch (err) {
				const code = (err as { code?: string }).code;
				const busy = code === 'ANALYSIS_TIMEOUT' || code === 'INTERRUPTED';
				throw new HttpError(busy ? 503 : 422, code ?? 'ANALYSIS_FAILED', (err as Error).message);
			}
			await writeVisual(file, v);
			return v;
		});
	}

	/**
	 * The visual data of a take (P6-E9): written by the index; when it is gone, computed from the recording's samples of
	 * the take (the file decoded from its start, so the range is exact).
	 */
	private async takeVisual(e: SoundEntry, take: NonNullable<SoundEntry['take']>): Promise<SoundVisual> {
		const file = takeVisualCacheFile(
			this.core.config.paths.soundCacheDir,
			fingerprintHex(e.fingerprint),
			take.index,
		);
		const cached = await readVisual(file, e.fingerprint);
		if (cached && cached.soundId === e.id) return cached;
		return this.limitVisual(async () => {
			const again = await readVisual(file, e.fingerprint);
			if (again && again.soundId === e.id) return again;
			const path = await this.fileOf(e);
			if ((await fingerprintFile(path)).fingerprint !== e.fingerprint)
				throw new HttpError(
					409,
					'SOUND_CHANGED',
					'The file changed since it was indexed; rescan the sound library',
				);
			const decoded = await this.mediaCall(() =>
				decodeSound(this.core.ffmpeg, path, { seconds: Math.ceil(take.endSec + 0.1) }),
			);
			const a = Math.round(take.startSec * decoded.rate);
			const b = Math.round(take.endSec * decoded.rate);
			let v: SoundVisual;
			try {
				v = (
					await this.analyzer.run(
						{
							kind: 'take-visual',
							soundId: e.id,
							fingerprint: e.fingerprint,
							durationSec: e.descriptors.durationSec,
							peakSec: e.descriptors.peakSec,
							channels: decoded.channels.map((c) => c.slice(Math.min(a, c.length), Math.min(b, c.length))),
							rate: decoded.rate,
						},
						undefined,
						{ timeoutMs: VISUAL_TIMEOUT_MS },
					)
				).visual;
			} catch (err) {
				const code = (err as { code?: string }).code;
				const busy = code === 'ANALYSIS_TIMEOUT' || code === 'INTERRUPTED';
				throw new HttpError(busy ? 503 : 422, code ?? 'ANALYSIS_FAILED', (err as Error).message);
			}
			await writeVisual(file, v);
			return v;
		});
	}

	/**
	 * The file a sound's audio route serves: the library file, or for a take (P6-E9) its range of the recording as a
	 * PCM WAV in the cache (written once, sample-exact from the full decode), so auditioning plays the take alone.
	 */
	async audioFileOf(e: SoundEntry): Promise<string> {
		const take = e.take;
		if (!take) return this.fileOf(e);
		const path = await this.fileOf(e);
		const out = takeAudioCacheFile(
			this.core.config.paths.soundCacheDir,
			fingerprintHex(e.fingerprint),
			take.index,
		);
		if ((await stat(out).catch(() => null))?.isFile()) return out;
		return this.limitVisual(async () => {
			if ((await stat(out).catch(() => null))?.isFile()) return out;
			if ((await fingerprintFile(path)).fingerprint !== e.fingerprint)
				throw new HttpError(
					409,
					'SOUND_CHANGED',
					'The file changed since it was indexed; rescan the sound library',
				);
			const stream = await this.streamFor(e, path);
			const range = takeRange(take, stream.sampleRate);
			if (!range) throw new HttpError(422, 'SOUND_UNSUPPORTED', 'The sound’s sample rate is unknown');
			const tmp = await this.mediaCall(() =>
				writePaddedSound(this.core.ffmpeg, {
					path,
					samples: 0,
					trailSamples: 0,
					codec: stream.codec,
					outCodec: copyCodecFor(stream),
					durationSec: e.descriptors.durationSec,
					range,
					tmpDir: join(this.core.config.paths.soundCacheDir, '.tmp'),
				}),
			);
			try {
				await mkdir(dirname(out), { recursive: true });
				await rename(tmp, out);
			} catch (err) {
				await rm(tmp, { force: true });
				throw err;
			}
			return out;
		});
	}

	/** The audio stream of a sound's content (probed once per engine). */
	private async streamFor(
		e: SoundEntry,
		path: string,
	): Promise<Awaited<ReturnType<typeof probeAudioStream>>> {
		let stream = this.streamOf.get(e.fingerprint) ?? null;
		if (!stream) {
			stream = await this.mediaCall(() => probeAudioStream(this.core.ffmpeg, path));
			remember(this.streamOf, e.fingerprint, stream);
		}
		return stream;
	}

	/**
	 * Registers a sound's file as media for a project. A sound whose head is not quiet (and which is at most
	 * `LIBRARY_PAD_MAX_SECONDS` long) is registered as a managed WAV copy with `LIBRARY_LEAD_SILENCE_SEC` of silence in
	 * front (`pad.ts`), whatever its source, so placement is sample-exact; a sound that does not end in
	 * `LIBRARY_TRAIL_SILENCE_SEC` of quiet gets that much silence after it too, so a placed clip (whole frames, rounded up
	 * to the sound's end) stays inside its media; the provenance's descriptors then describe that file and
	 * `leadSilenceSec` / `trailSilenceSec` say how much was added. A lossy sound (Vorbis, MP3…) of that length is also registered
	 * as a PCM WAV copy (without silence when its head is quiet): seeks into lossy streams are not sample-exact. Copies
	 * are written by ffmpeg file to file in the narrowest PCM that holds the decoded samples (`copyCodecFor`), for sounds
	 * up to `LIBRARY_PAD_MAX_SECONDS` (1 h) whose copy fits `SOUND_COPY_MAX_BYTES` and leaves
	 * `SOUND_COPY_RESERVE_BYTES` free on the media volume. A take (P6-E9) is always a copy: its range of the recording,
	 * with the same lead and trailing silence rules applied to the take's own descriptors (a cut take is refused). Other sounds (PCM needing no silence, or a copy refused by those
	 * limits — then `inexact` says why): starter, pack and synth files are copied into managed media, folder files
	 * registered in place (local mode). Returns the registered media, the provenance to commit and the saved project's
	 * media that already is this file.
	 */
	async register(id: string, projectId: string): Promise<RegisterSoundResponse> {
		const e = await this.get(id);
		if (e.take?.flags.length)
			throw new HttpError(
				422,
				'SOUND_TAKE_CUT',
				`Take ${e.take.index} is cut (${e.take.flags.join(', ')}): it is never offered; use a clean take of the recording`,
			);
		const project = await this.core.projects.get(projectId);
		const path = await this.fileOf(e);
		const snapshot = await this.library.snapshot();
		// Checked before any file is copied: a sound whose provenance cannot be written is refused, not half-registered.
		try {
			provenanceOf(e, snapshot.snapshotHash);
		} catch {
			throw new HttpError(
				422,
				'SOUND_UNSUPPORTED',
				'This sound’s library data is unusable; rescan the sound library',
			);
		}
		const changed = () =>
			new HttpError(409, 'SOUND_CHANGED', 'The file changed since it was indexed; rescan the sound library');
		let reg: RegisteredMedia;
		let leadSec = 0;
		const durationSec = e.descriptors.durationSec;
		const copyable = durationSec > 0 && durationSec <= LIBRARY_PAD_MAX_SECONDS;
		// the audio stream of this content (probed once per engine: a plan registers the same sounds on every run)
		const stream = await this.streamFor(e, path);
		const range = e.take ? takeRange(e.take, stream.sampleRate) : undefined;
		if (e.take && !range) throw new HttpError(422, 'SOUND_UNSUPPORTED', 'The sound’s sample rate is unknown');
		const samples = stream?.sampleRate ? libraryLeadSilenceSamples(e.descriptors, stream.sampleRate) : 0;
		const trailSamples = stream?.sampleRate
			? libraryTrailSilenceSamples(e.descriptors, stream.sampleRate, { analysedSec: SOUND_ANALYSIS_SECONDS })
			: 0;
		let trailSec = 0;
		// A lossy source (Vorbis, Opus, MP3, AAC…) is copied as PCM even when its head is quiet: ffmpeg's seeked
		// decode of such a stream is not sample-aligned with its full decode (Vorbis: 128 samples late), and the
		// descriptors (the peak) are measured on the full decode, so an In point after 0 would play the peak late.
		const lossy = !!stream?.codec && !isPcmCodec(stream.codec);
		const outCodec = copyCodecFor(stream);
		let inexact: RegisterSoundResponse['inexact'];
		let wantsCopy = (samples > 0 || trailSamples > 0 || lossy || !!range) && !!stream?.sampleRate;
		const mb = (n: number) => `${Math.ceil(n / 1_048_576)} MB`;
		if (!copyable && durationSec > LIBRARY_PAD_MAX_SECONDS) {
			// beyond the limit nothing is copied: a lossy or unpadded long sound is placed within a frame
			wantsCopy = false;
			inexact = {
				reason: 'too-long',
				message: `Sounds over ${LIBRARY_PAD_MAX_SECONDS / 60} min are used as they are: placement is exact to a frame, not to the sample`,
				limitSeconds: LIBRARY_PAD_MAX_SECONDS,
			};
		} else if (wantsCopy && stream.sampleRate) {
			const bytes = estimateCopyBytes(
				durationSec + (samples + trailSamples) / stream.sampleRate,
				stream.sampleRate,
				stream.channels ?? 2,
				outCodec,
			);
			const max = this.envBytes('JASPER_SOUND_COPY_MAX_BYTES') ?? SOUND_COPY_MAX_BYTES;
			const reserve = this.envBytes('JASPER_SOUND_COPY_RESERVE_BYTES') ?? SOUND_COPY_RESERVE_BYTES;
			const free = bytes > max ? null : await freeDiskBytes(this.core.config.paths.mediaDir);
			if (bytes > max) {
				wantsCopy = false;
				inexact = {
					reason: 'too-large',
					message: `A sample-exact copy would take ${mb(bytes)} (at most ${mb(max)}): the sound is used as it is, placement exact to a frame`,
					bytes: Math.ceil(bytes),
					maxBytes: Math.floor(max),
				};
			} else if (free !== null && free < bytes + reserve) {
				wantsCopy = false;
				inexact = {
					reason: 'disk-space',
					message: `Not enough free disk space for a sample-exact copy (${mb(bytes)} needed, ${mb(free)} free): the sound is used as it is, placement exact to a frame`,
					bytes: Math.ceil(bytes),
					freeBytes: Math.max(0, Math.floor(free)),
				};
			}
		}
		if (wantsCopy && stream?.sampleRate) {
			if ((await fingerprintFile(path)).fingerprint !== e.fingerprint) throw changed();
			// the same content padded the same way is the same managed file: reuse it while it is online
			const copyKey = `${e.fingerprint}|${samples}|${trailSamples}|${stream.codec ?? ''}|${stream.sampleRate}|${outCodec}|${range ? `${range.startSample}-${range.endSample}` : ''}`;
			const known = this.copyOf.get(copyKey);
			const again = known ? await this.core.media.registeredIfOnline(known, { projectId }) : null;
			if (again) reg = again;
			else {
				const tmp = await this.mediaCall(() =>
					writePaddedSound(this.core.ffmpeg, {
						path,
						samples,
						trailSamples,
						codec: stream.codec,
						outCodec,
						durationSec,
						...(range ? { range } : {}),
						tmpDir: join(this.core.config.paths.mediaDir, '.sound-tmp'),
					}),
				);
				try {
					reg = await this.core.media.registerUploaded(
						tmp,
						paddedFileName(path, e.take ? e.take.index : undefined),
						{ projectId },
					);
				} finally {
					await rm(tmp, { force: true });
				}
				remember(this.copyOf, copyKey, reg.mediaKey);
			}
			leadSec = samples / stream.sampleRate;
			trailSec = trailSamples / stream.sampleRate;
		} else {
			reg = await this.core.media.registerPath(path, {
				projectId,
				...(e.source.type === 'folder' ? {} : { copyIntoProject: true }),
			});
			if (reg.fingerprint !== e.fingerprint) throw changed();
		}
		const library = provenanceOf(e, snapshot.snapshotHash, leadSec, trailSec, inexact?.reason);
		let existingMediaId: string | null = null;
		const media = (project.envelope.document as { media?: unknown }).media;
		if (media && typeof media === 'object')
			for (const [mid, m] of Object.entries(media as Record<string, unknown>)) {
				const a = m as { fingerprint?: unknown; derivation?: unknown } | null;
				if (a && a.fingerprint === reg.fingerprint && !a.derivation) {
					existingMediaId = mid;
					break;
				}
			}
		return { ...reg, library, existingMediaId, ...(inexact ? { inexact } : {}) };
	}

	/** A positive byte count from the engine's environment, else undefined. */
	private envBytes(key: string): number | undefined {
		const v = Number(process.env[key]);
		return Number.isFinite(v) && v > 0 ? v : undefined;
	}

	/** Runs an ffmpeg step of registering; its job errors become HTTP errors (422 with the code). */
	private async mediaCall<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (err) {
			if (err instanceof JobError)
				throw new HttpError(err.code === 'BINARY_MISSING' ? 503 : 422, err.code, err.message);
			throw err;
		}
	}

	/**
	 * Applies a planned folder list: saves it (refused with 409 `SOUND_ROOTS_CHANGED` when the list changed since the
	 * plan was made), takes the sounds of removed or disabled folders out of the index at once and starts a rescan
	 * when a folder was added, enabled, relicensed or credited differently. (Approval is the route's business.)
	 */
	async applyRoots(
		plan: SoundRootsPlan,
		origin: EngineJob['origin'],
	): Promise<{ roots: SoundRoot[]; job: EngineJob | null; removedSounds: number }> {
		const before = await this.roots.list();
		const roots = await this.roots.save(plan.next, plan.revision);
		const live = new Set(roots.filter((r) => r.enabled).map((r) => r.id));
		const gone = before.filter((r) => !live.has(r.id) || plan.removed.some((x) => x.id === r.id));
		const goneIds = new Set(gone.map((r) => r.id));
		const removedSounds = gone.length
			? await this.library.remove(
					(e) => e.source.type === 'folder' && goneIds.has(e.source.rootId),
					gone.map((r) => `folder:${r.id}:`),
				)
			: 0;
		const enabledNow = roots.filter((r) => r.enabled && !before.some((b) => b.id === r.id && b.enabled));
		const needScan =
			plan.added.length > 0 ||
			plan.relicensed.length > 0 ||
			plan.recredited.length > 0 ||
			enabledNow.length > 0;
		return { roots, job: needScan ? this.startIndex({ origin }) : null, removedSounds };
	}

	async plannedRoots(body: SoundRootsPutRequest): Promise<SoundRootsPlan> {
		if (!this.local)
			throw new HttpError(403, 'LOCAL_MODE_ONLY', 'Sound folders are only available with a local engine');
		return this.roots.plan(body, new Date().toISOString());
	}

	/** The folder list as callers may see it: paths only in local mode (D-47); a remote engine lists none. */
	async visibleRoots(): Promise<SoundRoot[]> {
		return this.local ? this.roots.list() : [];
	}

	async status(): Promise<SoundLibraryStatus> {
		const s = await this.library.snapshot();
		const starter = await this.starter();
		const bySource = Object.fromEntries(SOUND_SOURCE_TYPES.map((t) => [t, 0])) as Record<
			SoundSourceType,
			number
		>;
		for (const e of Object.values(s.sounds)) bySource[e.source.type]++;
		return {
			snapshotHash: s.snapshotHash,
			sounds: Object.keys(s.sounds).length,
			bySource,
			packs: Object.keys(s.packs).length,
			roots: (await this.roots.list()).length,
			starter: { status: starter.status, sounds: starter.sounds.length, errors: starter.errors.slice(0, 50) },
			indexedAt: s.indexedAt,
			needsIndex: await this.needsIndex(),
			recovered: this.library.recovered,
			indexing: this.activeIndexJob(),
			synth: true,
			local: this.local,
		};
	}

	async capability(): Promise<{
		library: { sounds: number; packs: number };
		synth: boolean;
		describe: { status: 'ready' | 'not-installed' | 'unavailable' };
	}> {
		const s = await this.library.snapshot();
		const d = await this.semantic.status().catch(() => null);
		return {
			library: { sounds: Object.keys(s.sounds).length, packs: Object.keys(s.packs).length },
			synth: true,
			describe: { status: d?.status ?? 'unavailable' },
		};
	}
}
