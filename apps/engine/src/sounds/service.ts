// The engine's sound library service (spec 12 §2.1, §2.8; wp-note "WP1.2"): the index, user folders, the bundled
// starter kit, Jasper Synth, search with facets, files and visual data of a sound, and registering a sound into a
// project. Routes: routes/sounds.ts.
import { realpath, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import {
	type EngineJob,
	type RegisteredMedia,
	type RegisterSoundResponse,
	SOUND_SEARCH_DEFAULT_LIMIT,
	SOUND_SOURCE_TYPES,
	type SoundEntry,
	type SoundFacets,
	type SoundLibraryStatus,
	type SoundRoot,
	type SoundRootsPutRequest,
	type SoundSearchQuery,
	type SoundSearchResponse,
	type SoundSourceType,
	type SoundVisual,
} from '@jasper/api';
import {
	isSoundTypeId,
	LIBRARY_LEAD_SILENCE_SEC,
	LIBRARY_PAD_MAX_SECONDS,
	type LibraryProvenance,
	LibraryProvenanceSchema,
	libraryLeadSilenceSamples,
	licenseClass,
	rankSounds,
	resolveTypeNames,
	SOUND_TYPES,
	type SoundRankRequest,
	shiftLibraryDescriptors,
	typesOfFamily,
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
import { SoundLibrary } from './library.ts';
import { paddedFileName, probeAudioStream, writePaddedSound } from './pad.ts';
import { SoundRootStore } from './roots.ts';
import { isSoundFileName, type LoadedManifest, loadManifest, starterDir } from './starter.ts';
import { ensureSynthFile, synthItems } from './synth.ts';
import { readVisual, visualCacheFile, writeVisual } from './visual.ts';

/** Turn `JASPER_SOUND_AUTO_INDEX=0` to keep the engine from indexing by itself (default on; off under vitest). */
export const AUTO_INDEX_ENV = 'JASPER_SOUND_AUTO_INDEX';
/** Visual data computed on request at once (each decodes up to 30 s of audio). */
const VISUAL_CONCURRENCY = 2;

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

	constructor(
		private readonly core: CoreServices,
		private readonly opts: { env?: Record<string, string | undefined>; log?: (m: string) => void } = {},
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

	/** Starts (or joins) an index job. */
	startIndex(opts: { full?: boolean; origin?: EngineJob['origin'] } = {}): EngineJob {
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

	/** Indexes by itself when the library needs it, unless `JASPER_SOUND_AUTO_INDEX=0` (default off under vitest). */
	async autoIndex(): Promise<EngineJob | null> {
		const env = this.env();
		const flag = env[AUTO_INDEX_ENV] ?? (env.VITEST ? '0' : '1');
		if (flag === '0' || flag === 'false') return null;
		if (this.activeIndexJob()) return null;
		if (!(await this.needsIndex())) return null;
		return this.startIndex({ origin: { type: 'system' } });
	}

	async get(id: string): Promise<SoundEntry> {
		const e = typeof id === 'string' && /^snd_[0-9a-f]{16}$/.test(id) ? await this.library.get(id) : null;
		if (!e) throw notFound(id);
		return e;
	}

	async search(q: SoundSearchQuery): Promise<SoundSearchResponse> {
		const snapshot = await this.library.snapshot();
		const all = Object.keys(snapshot.sounds)
			.sort()
			.map((id) => snapshot.sounds[id]!);
		const byRoot = q.rootId
			? all.filter((e) => e.source.type === 'folder' && e.source.rootId === q.rootId)
			: all;
		const sources = q.sources?.length ? new Set<string>(q.sources) : null;
		const pool = sources ? byRoot.filter((e) => sources.has(e.source.type)) : byRoot;

		let types: string[] | undefined;
		// A family and types that share nothing match nothing.
		let none = false;
		if (q.family) {
			const fam: string[] = typesOfFamily(q.family);
			types = q.types?.length ? resolveTypeNames(q.types).filter((t) => fam.includes(t)) : fam;
			none = types.length === 0;
		} else if (q.types?.length) types = q.types;
		let similarTo: SoundRankRequest['similarTo'];
		if (q.similarTo) {
			const ref = snapshot.sounds[q.similarTo];
			if (!ref) throw notFound(q.similarTo);
			similarTo = { id: ref.id, descriptors: ref.descriptors };
		}
		const req: SoundRankRequest = {
			...(q.q !== undefined ? { query: q.q } : {}),
			...(types ? { types } : {}),
			...(q.visualKind ? { visualKind: q.visualKind } : {}),
			...(q.windowSec !== undefined ? { windowSec: q.windowSec } : {}),
			...(q.align ? { align: q.align } : {}),
			...(q.length ? { length: q.length } : {}),
			...(q.tone ? { tone: q.tone } : {}),
			...(q.attack ? { attack: q.attack } : {}),
			...(q.weight ? { weight: q.weight } : {}),
			...(q.texture ? { texture: q.texture } : {}),
			license: q.license ?? 'commercial-safe',
			...(similarTo ? { similarTo } : {}),
		};
		const ctx = q.usedNearby?.length ? { usedNearby: q.usedNearby } : {};
		const ranked = none ? [] : rankSounds(pool, req, ctx);

		// Disjunctive facets: each dimension counts with every filter but its own.
		const facets: SoundFacets = { types: {}, families: {}, licenses: {}, sources: {} };
		const bump = (rec: Record<string, number>, k: string) => {
			rec[k] = (rec[k] ?? 0) + 1;
		};
		const { types: _t, ...noTypes } = req;
		for (const r of rankSounds(pool, noTypes)) {
			const fams = new Set<string>();
			for (const t of r.entry.types)
				if (isSoundTypeId(t)) {
					bump(facets.types, t);
					fams.add(SOUND_TYPES[t].family);
				}
			for (const f of fams) bump(facets.families, f);
		}
		if (!none) {
			for (const r of rankSounds(pool, { ...req, license: 'any' }))
				bump(facets.licenses, licenseClass(r.entry.license));
			for (const r of rankSounds(byRoot, req)) bump(facets.sources, r.entry.source.type);
		}

		const offset = q.offset ?? 0;
		const limit = q.limit ?? SOUND_SEARCH_DEFAULT_LIMIT;
		return {
			snapshotHash: snapshot.snapshotHash,
			librarySize: all.length,
			total: ranked.length,
			offset,
			results: ranked
				.slice(offset, offset + limit)
				.map((r) => ({ sound: r.entry, score: r.score, parts: r.parts })),
			facets,
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
		return real;
	}

	/** The content type an audio file is served with (audio types only). */
	audioType(file: string): string {
		const type = contentTypeFor(file, '');
		if (!type.startsWith('audio/')) throw new HttpError(403, 'NOT_A_SOUND', 'Only audio files are served');
		return type;
	}

	async visual(e: SoundEntry): Promise<SoundVisual> {
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
			let decoded: Awaited<ReturnType<typeof decodeSound>>;
			try {
				decoded = await decodeSound(this.core.ffmpeg, path);
			} catch (err) {
				if (err instanceof JobError) throw new HttpError(422, err.code, err.message);
				throw err;
			}
			let v: SoundVisual;
			try {
				v = (
					await this.analyzer.run({
						kind: 'visual',
						soundId: e.id,
						fingerprint: e.fingerprint,
						durationSec: e.descriptors.durationSec,
						peakSec: e.descriptors.peakSec,
						channels: decoded.channels,
						rate: decoded.rate,
					})
				).visual;
			} catch (err) {
				const code = (err as { code?: string }).code;
				throw new HttpError(422, code ?? 'ANALYSIS_FAILED', (err as Error).message);
			}
			await writeVisual(file, v);
			return v;
		});
	}

	/**
	 * Registers a sound's file as media for a project. A sound whose head is not quiet (and which is at most
	 * `LIBRARY_PAD_MAX_SECONDS` long) is registered as a managed WAV copy with `LIBRARY_LEAD_SILENCE_SEC` of silence in
	 * front (`pad.ts`), whatever its source, so placement is sample-exact; the provenance's descriptors then describe that
	 * file and `leadSilenceSec` says how much was added. Other sounds: starter, pack and synth files are copied into
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
		const maybePad =
			e.descriptors.headQuietSec < LIBRARY_LEAD_SILENCE_SEC &&
			e.descriptors.durationSec > 0 &&
			e.descriptors.durationSec <= LIBRARY_PAD_MAX_SECONDS;
		const stream = maybePad ? await this.mediaCall(() => probeAudioStream(this.core.ffmpeg, path)) : null;
		const samples = stream?.sampleRate ? libraryLeadSilenceSamples(e.descriptors, stream.sampleRate) : 0;
		if (samples > 0 && stream?.sampleRate) {
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
	 * Applies a new folder list: saves it, takes the sounds of removed or disabled folders out of the index at once and
	 * starts a rescan when a folder was added, enabled or relicensed. (Approval is the route's business.)
	 */
	async applyRoots(
		next: SoundRoot[],
		changes: { added: SoundRoot[]; removed: SoundRoot[]; relicensed: SoundRoot[] },
		origin: EngineJob['origin'],
	): Promise<{ roots: SoundRoot[]; job: EngineJob | null; removedSounds: number }> {
		const before = await this.roots.list();
		const roots = await this.roots.save(next);
		const live = new Set(roots.filter((r) => r.enabled).map((r) => r.id));
		const gone = before.filter((r) => !live.has(r.id) || changes.removed.some((x) => x.id === r.id));
		const goneIds = new Set(gone.map((r) => r.id));
		const removedSounds = gone.length
			? await this.library.remove(
					(e) => e.source.type === 'folder' && goneIds.has(e.source.rootId),
					gone.map((r) => `folder:${r.id}:`),
				)
			: 0;
		const enabledNow = roots.filter((r) => r.enabled && !before.some((b) => b.id === r.id && b.enabled));
		const needScan = changes.added.length > 0 || changes.relicensed.length > 0 || enabledNow.length > 0;
		return { roots, job: needScan ? this.startIndex({ origin }) : null, removedSounds };
	}

	async plannedRoots(body: SoundRootsPutRequest) {
		if (!this.local)
			throw new HttpError(403, 'LOCAL_MODE_ONLY', 'Sound folders are only available with a local engine');
		return this.roots.plan(body, new Date().toISOString());
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
