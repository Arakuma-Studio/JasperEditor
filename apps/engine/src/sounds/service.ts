// The engine's sound library service (spec 12 §2.1, §2.8; wp-note "WP1.2"): the index, user folders, the bundled
// starter kit, Jasper Synth, search with facets, files and visual data of a sound, and registering a sound into a
// project. Routes: routes/sounds.ts.
import { realpath, rm, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import {
	type EngineJob,
	type RegisteredMedia,
	type RegisterSoundResponse,
	SOUND_SOURCE_TYPES,
	type SoundEntry,
	type SoundLibraryStatus,
	type SoundRoot,
	type SoundRootsPutRequest,
	type SoundSearchQuery,
	type SoundSearchResponse,
	type SoundSourceType,
	type SoundVisual,
} from '@jasper/api';
import {
	LIBRARY_PAD_MAX_SECONDS,
	type LibraryProvenance,
	LibraryProvenanceSchema,
	libraryLeadSilenceSamples,
	shiftLibraryDescriptors,
} from '@jasper/project';
import { isLoopbackHost } from '../context.ts';
import { JobError } from '../jobs/types.ts';
import { fingerprintFile, fingerprintHex } from '../media/fingerprint.ts';
import { contentTypeFor } from '../tools/http.ts';
import { HttpError } from '../tools/reply.ts';
import type { CoreServices } from '../tools/services.ts';
import { resolveSoundWorker, SoundAnalyzer } from './analysis.ts';
import { decodeSound } from './decode.ts';
import { SoundIndexer } from './index-job.ts';
import { type LibrarySnapshot, SoundLibrary } from './library.ts';
import { isPcmCodec, paddedFileName, probeAudioStream, writePaddedSound } from './pad.ts';
import { SoundRootStore, type SoundRootsPlan } from './roots.ts';
import { searchSoundEntries } from './search.ts';
import { isSoundFileName, type LoadedManifest, loadManifest, starterDir } from './starter.ts';
import { ensureSynthFile, synthItems } from './synth.ts';
import { readVisual, visualCacheFile, writeVisual } from './visual.ts';

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

/** The provenance a registered library sound carries in the project (`MediaAsset.library`). */
export function provenanceOf(e: SoundEntry, snapshotHash: string, leadSilenceSec = 0): LibraryProvenance {
	const lead = leadSilenceSec > 0 ? leadSilenceSec : 0;
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
	};
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
			},
			lead,
		),
		...(lead > 0 ? { leadSilenceSec: lead } : {}),
		snapshotHash,
	};
	return LibraryProvenanceSchema.parse(candidate) as LibraryProvenance;
}

export class SoundService {
	readonly library: SoundLibrary;
	readonly roots: SoundRootStore;
	readonly indexer: SoundIndexer;
	readonly analyzer: SoundAnalyzer;
	private readonly limitVisual = semaphore(VISUAL_CONCURRENCY);
	private starterCache: { at: number; manifest: LoadedManifest } | null = null;
	/** The index's entries in id order, for the snapshot they were made from (search). */
	private sorted: { sounds: LibrarySnapshot['sounds']; list: SoundEntry[] } | null = null;
	private auto: AutoAttempt | null = null;

	constructor(
		private readonly core: CoreServices,
		private readonly opts: {
			env?: Record<string, string | undefined>;
			log?: (m: string) => void;
			/** Tests: a smaller library cap. */
			maxSounds?: number;
			now?: () => number;
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
		this.analyzer = new SoundAnalyzer(resolveSoundWorker(this.env()), opts.log);
		this.indexer = new SoundIndexer({
			library: this.library,
			roots: this.roots,
			ffmpeg: core.ffmpeg,
			analyzer: this.analyzer,
			starterDir: () => this.starterDir(),
			packsDir: paths.soundPacksDir,
			synthDir: paths.soundSynthDir,
			cacheDir: paths.soundCacheDir,
			synthItems: () => synthItems(this.env()),
			local: () => this.local,
			...(opts.maxSounds !== undefined ? { maxSounds: opts.maxSounds } : {}),
			followUp: (jobId, full) => {
				void core.queue
					.wait(jobId)
					.then(() => this.startIndex({ ...(full ? { full: true } : {}), origin: { type: 'system' } }))
					.catch(() => undefined);
			},
			...(opts.log ? { log: opts.log } : {}),
		});
		core.queue.registerRunner('sound-index', (ctx) => this.indexer.run(ctx));
	}

	private env(): Record<string, string | undefined> {
		return this.opts.env ?? process.env;
	}

	/** Folders and their files may be used (local mode, D-47). */
	get local(): boolean {
		const { config } = this.core;
		return config.dev || isLoopbackHost(config.host);
	}

	starterDir(): string {
		return starterDir(this.env());
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

	private nowMs(): number {
		return this.opts.now?.() ?? Date.now();
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
		return this.core.queue.submit({
			kind: 'sound-index',
			title: opts.full ? 'Rebuild the sound library' : 'Index the sound library',
			priority: 'background',
			cpuSlots: 1,
			origin: opts.origin ?? { type: 'user' },
			dedupeKey: 'sound-index',
			input: opts.full ? { full: true } : {},
			stage: 'Waiting',
		});
	}

	/** Whether the library should be (re)indexed: never indexed, rebuilt after damage, or the starter kit changed. */
	async needsIndex(): Promise<boolean> {
		if (await this.library.neverIndexed()) return true;
		const s = await this.library.snapshot();
		const starter = await this.starter();
		return s.starterHash !== starter.hash;
	}

	/**
	 * Indexes by itself when the library needs it, unless `JASPER_SOUND_AUTO_INDEX=0` (default off under vitest).
	 * Remembers its last job: after the user cancelled it, it does not start again until the starter kit changes or an
	 * index is asked for; after a failure it waits (1 min, doubling per failure, at most 1 h).
	 */
	async autoIndex(): Promise<EngineJob | null> {
		const env = this.env();
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
				if (sameKit && this.nowMs() < last.retryAt) return null;
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
			retryAt: this.nowMs() + Math.min(AUTO_RETRY_MAX_MS, AUTO_RETRY_BASE_MS * 2 ** (next - 1)),
		};
		return job;
	}

	async get(id: string): Promise<SoundEntry> {
		const e = typeof id === 'string' && /^snd_[0-9a-f]{16}$/.test(id) ? await this.library.get(id) : null;
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

	async search(q: SoundSearchQuery): Promise<SoundSearchResponse> {
		const snapshot = await this.library.snapshot();
		const all = this.sortedEntries(snapshot);
		const out = searchSoundEntries(all, q, {
			lookup: (id) => (Object.hasOwn(snapshot.sounds, id) ? snapshot.sounds[id] : undefined),
			// Folder sounds are not offered by a remote engine (D-47), even when an index from a local run has them.
			includeFolders: this.local,
		});
		return {
			snapshotHash: snapshot.snapshotHash,
			librarySize: all.length,
			...out,
			indexing: this.activeIndexJob() !== null,
		};
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
	 * Registers a sound's file as media for a project. A sound whose head is not quiet (and which is at most
	 * `LIBRARY_PAD_MAX_SECONDS` long) is registered as a managed WAV copy with `LIBRARY_LEAD_SILENCE_SEC` of silence in
	 * front (`pad.ts`), whatever its source, so placement is sample-exact; the provenance's descriptors then describe that
	 * file and `leadSilenceSec` says how much was added. A lossy sound (Vorbis, MP3…) of that length is also registered
	 * as a PCM WAV copy (without silence when its head is quiet): seeks into lossy streams are not sample-exact. Other
	 * sounds (PCM, or longer than the limit): starter, pack and synth files are copied into
	 * managed media, folder files registered in place (local mode). Returns the registered media, the provenance to
	 * commit and the saved project's media that already is this file.
	 */
	async register(id: string, projectId: string): Promise<RegisterSoundResponse> {
		const e = await this.get(id);
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
		const copyable = e.descriptors.durationSec > 0 && e.descriptors.durationSec <= LIBRARY_PAD_MAX_SECONDS;
		const stream = copyable ? await this.mediaCall(() => probeAudioStream(this.core.ffmpeg, path)) : null;
		const samples = stream?.sampleRate ? libraryLeadSilenceSamples(e.descriptors, stream.sampleRate) : 0;
		// A lossy source (Vorbis, Opus, MP3, AAC…) is copied as PCM even when its head is quiet: ffmpeg's seeked
		// decode of such a stream is not sample-aligned with its full decode (Vorbis: 128 samples late), and the
		// descriptors (the peak) are measured on the full decode, so an In point after 0 would play the peak late.
		const lossy = !!stream?.codec && !isPcmCodec(stream.codec);
		if ((samples > 0 || lossy) && stream?.sampleRate) {
			if ((await fingerprintFile(path)).fingerprint !== e.fingerprint) throw changed();
			const tmp = await this.mediaCall(() =>
				writePaddedSound(this.core.ffmpeg, {
					path,
					samples,
					codec: stream.codec,
					tmpDir: join(this.core.config.paths.mediaDir, '.sound-tmp'),
				}),
			);
			try {
				reg = await this.core.media.registerUploaded(tmp, paddedFileName(path), { projectId });
			} finally {
				await rm(tmp, { force: true });
			}
			leadSec = samples / stream.sampleRate;
		} else {
			reg = await this.core.media.registerPath(path, {
				projectId,
				...(e.source.type === 'folder' ? {} : { copyIntoProject: true }),
			});
			if (reg.fingerprint !== e.fingerprint) throw changed();
		}
		const library = provenanceOf(e, snapshot.snapshotHash, leadSec);
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
		return { ...reg, library, existingMediaId };
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

	async capability(): Promise<{ library: { sounds: number; packs: number }; synth: boolean }> {
		const s = await this.library.snapshot();
		return {
			library: { sounds: Object.keys(s.sounds).length, packs: Object.keys(s.packs).length },
			synth: true,
		};
	}
}
