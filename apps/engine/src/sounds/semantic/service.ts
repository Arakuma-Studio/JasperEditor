// Describe-it search and Find Moment on the engine (spec 12 P6-E14, WP-E9; wp-note "Phase 6 → WP-E9"):
//   - the model: the processing catalogue's `sound` list (models.ts), installed by the `model-download` job;
//   - `sound-embed` jobs: one embedding per library sound and offered take (frontend.ts `wholeSoundWindows`; a take
//     is its own range), computed lazily — only what the cache lacks, in id order, flushed every 32 sounds so a
//     cancelled or interrupted job keeps its work — and cached by content fingerprint and range (embeddings.ts);
//   - describe: a description's calibrated match (score.ts) to every embedded sound, which the search route blends into
//     the ranking (`SoundRankRequest.semantic`); without the model, or when it fails, the route searches the words;
//   - `sound-moment` jobs: coarse 10 s windows over a recording, the best three refined with windows of the asked
//     length, the best non-overlapping ones kept (and shrunk to their sound); window embeddings are cached per
//     recording, so another description of the same recording only embeds the text.
// The model runs in the `jasper-clap` child process (runtime.ts), never in the engine.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import {
	type EngineJob,
	type SoundDescribeInfo,
	type SoundEmbedResult,
	type SoundEntry,
	type SoundMatch,
	type SoundMomentRequest,
	type SoundMomentResult,
	type SoundSemanticModel,
	type SoundSemanticStatus,
	SOUND_DESCRIBE_MAX_CHARS,
	SOUND_MOMENT_DEFAULT_SEC,
	SOUND_MOMENT_MAX_RECORDING_SEC,
} from '@jasper/api';
import { type JobContext, JobError } from '../../jobs/types.ts';
import { fingerprintHex } from '../../media/fingerprint.ts';
import type { ProcessingService } from '../../processing/service.ts';
import { HttpError } from '../../tools/reply.ts';
import type { CoreServices } from '../../tools/services.ts';
import { SpeechModelError } from '../../speech/models.ts';
import { EMBED_RECIPE, EmbeddingStore, keyOf } from './embeddings.ts';
import { clapCommand } from './entry.ts';
import { CLAP_WINDOW_SEC, type ClapWindow, meanEmbedding, wholeSoundWindows } from './frontend.ts';
import type { SoundCatalogEntry, SoundModelStore } from './models.ts';
import { ClapError, ClapRuntime } from './runtime.ts';
import {
	type AudioStats,
	audioStats,
	type Calibration,
	calibrationOf,
	coarseWindows,
	fineWindows,
	matchOf,
	pickMoments,
	queryBias,
	type Reference,
	referenceOf,
	regionsToRefine,
	semanticScoreOf,
	verdictOf,
} from './score.ts';
import { SOUND_VOCABULARY, VOCAB_VERSION } from './vocab.ts';

const EMBED_JOB = 'sound-embed' as const;
const MOMENT_JOB = 'sound-moment' as const;
/** Sounds embedded between two writes of the cache. */
const FLUSH_EVERY = 32;
const FLUSH_MS = 15_000;
/** Windows sent to the worker per request in a moment search. */
const MOMENT_BATCH = 8;
/** Texts kept in the text cache (the vocabulary always is). */
const MAX_CACHED_QUERIES = 2000;

export type SemanticDeps = {
	/** Library sounds and offered takes the search may rank (local mode decides about folder sounds). */
	entries(): Promise<SoundEntry[]>;
	/** Every recording and offered take of the index (what the cache keeps). */
	allEntries(): Promise<SoundEntry[]>;
	get(id: string): Promise<SoundEntry>;
	fileOf(e: SoundEntry): Promise<string>;
	log?(m: string): void;
};

/** The normalised text of a description (trimmed, inner whitespace collapsed, at most 300 characters). */
export function describeText(text: string): string {
	return String(text).replace(/\s+/g, ' ').trim().slice(0, SOUND_DESCRIBE_MAX_CHARS);
}

/** The cache key of a library entry's embedding: its whole sound, or a take's range of its recording. */
export function entryKey(e: SoundEntry): string {
	return e.take ? keyOf(e.fingerprint, { startSec: e.take.startSec, endSec: e.take.endSec }) : keyOf(e.fingerprint, 'whole');
}

/** The windows an entry is embedded from (a take: its range, at most 10 s from its start). */
export function entryWindows(e: SoundEntry): ClapWindow[] {
	if (e.take) {
		const end = Math.min(e.take.endSec, e.take.startSec + CLAP_WINDOW_SEC);
		return end > e.take.startSec ? [{ startSec: e.take.startSec, endSec: end }] : [];
	}
	const dur = e.format.durationSec > 0 ? e.format.durationSec : e.descriptors.durationSec;
	return wholeSoundWindows(dur);
}

const textKey = (text: string) => `t|${createHash('sha256').update(text).digest('hex').slice(0, 40)}`;

type ModelContext = {
	entry: SoundCatalogEntry;
	dir: string;
	sounds: EmbeddingStore;
	texts: EmbeddingStore;
};

export class SemanticService {
	readonly runtime: ClapRuntime;
	private ortOk: boolean | null = null;
	private readonly stores = new Map<string, { sounds: EmbeddingStore; texts: EmbeddingStore }>();
	private readonly stats = new Map<string, AudioStats>();
	private calibration: { modelId: string; cal: Calibration; vectors: Float32Array[] } | null = null;
	private readonly recentQueries: string[] = [];

	constructor(
		private readonly core: CoreServices,
		private readonly processing: ProcessingService | null,
		private readonly deps: SemanticDeps,
		private readonly env: Record<string, string | undefined> = process.env,
	) {
		const threads = Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)));
		this.runtime = new ClapRuntime({
			command: () => clapCommand(this.env as NodeJS.ProcessEnv),
			threads,
			...(Number(env.JASPER_CLAP_IDLE_MS) > 0 ? { idleMs: Number(env.JASPER_CLAP_IDLE_MS) } : {}),
			...(deps.log ? { log: deps.log } : {}),
		});
		core.queue.registerRunner(EMBED_JOB, (ctx) => this.runEmbed(ctx));
		core.queue.registerRunner(MOMENT_JOB, (ctx) => this.runMoment(ctx));
	}

	get models(): SoundModelStore | null {
		return this.processing?.soundModels ?? null;
	}

	/** ONNX Runtime loads in this installation (the worker uses the same module). */
	ortAvailable(): boolean {
		if (this.ortOk === null) {
			try {
				createRequire(import.meta.url).resolve('onnxruntime-node');
				this.ortOk = true;
			} catch {
				this.ortOk = false;
			}
		}
		return this.ortOk;
	}

	installJob(modelId: string): EngineJob | null {
		return (
			this.core.queue
				.list({ active: true, kind: 'model-download' })
				.find((j) => j.dedupeKey === `model:${modelId}`) ?? null
		);
	}

	async listModels(): Promise<SoundSemanticModel[]> {
		const store = this.models;
		if (!store) return [];
		return (await store.list()).map((m) => ({ ...m, job: this.installJob(m.id) }));
	}

	/** The installed model to use (the catalogue's first installed one), or null. */
	private async installedModel(): Promise<SoundCatalogEntry | null> {
		const store = this.models;
		if (!store) return null;
		for (const e of store.entries) if (await store.installed(e)) return e;
		return null;
	}

	/** Why describe search cannot run here, or null. */
	private async unavailable(): Promise<{ status: 'not-installed' | 'unavailable'; reason: string } | null> {
		if (!this.models || !this.models.entries.length)
			return { status: 'unavailable', reason: 'this engine’s model catalogue has no Describe-it search model' };
		if (!this.ortAvailable())
			return { status: 'unavailable', reason: 'ONNX Runtime (onnxruntime-node) is not installed' };
		if (!this.core.ffmpeg.bins.ffmpeg) return { status: 'unavailable', reason: 'ffmpeg was not found' };
		if (!(await this.installedModel()))
			return {
				status: 'not-installed',
				reason: 'the Describe-it search model is not installed (Preferences ▸ Sound Library)',
			};
		return null;
	}

	private storesOf(e: SoundCatalogEntry): { sounds: EmbeddingStore; texts: EmbeddingStore } {
		const id = `${e.id}@${e.revision.slice(0, 12)}-r${EMBED_RECIPE}`;
		let s = this.stores.get(id);
		if (!s) {
			const dir = join(this.core.config.paths.soundCacheDir, 'semantic', id);
			s = {
				sounds: new EmbeddingStore(join(dir, 'sounds.emb'), this.deps.log),
				texts: new EmbeddingStore(join(dir, 'texts.emb'), this.deps.log),
			};
			this.stores.set(id, s);
		}
		return s;
	}

	private cacheDirOf(e: SoundCatalogEntry): string {
		return join(this.core.config.paths.soundCacheDir, 'semantic', `${e.id}@${e.revision.slice(0, 12)}-r${EMBED_RECIPE}`);
	}

	/** The installed model, verified, with its caches (typed errors when it cannot run). */
	private async context(): Promise<ModelContext> {
		const why = await this.unavailable();
		if (why)
			throw new JobError(
				why.status === 'not-installed' ? 'MODEL_NOT_INSTALLED' : 'DESCRIBE_UNAVAILABLE',
				`Describe-it search is unavailable: ${why.reason}`,
				false,
			);
		const entry = (await this.installedModel())!;
		let dir: string;
		try {
			dir = (await this.models!.resolve(entry.id)).dir;
		} catch (e) {
			if (e instanceof SpeechModelError) throw new JobError(e.code.replace('SPEECH_', ''), e.message, false);
			throw e;
		}
		return { entry, dir, ...this.storesOf(entry) };
	}

	async status(): Promise<SoundSemanticStatus> {
		const models = await this.listModels();
		const why = await this.unavailable();
		const installed = await this.installedModel();
		const model = models.find((m) => m.id === (installed?.id ?? models[0]?.id)) ?? null;
		const entries = await this.deps.entries();
		let embedded = 0;
		if (installed) {
			const store = this.storesOf(installed).sounds;
			for (const e of entries) if (await store.has(entryKey(e))) embedded++;
		}
		return {
			status: why ? why.status : 'ready',
			reason: why?.reason ?? null,
			model,
			total: entries.length,
			embedded,
			job: this.embedJob(),
		};
	}

	embedJob(): EngineJob | null {
		return this.core.queue.list({ active: true, kind: EMBED_JOB })[0] ?? null;
	}

	/** Starts (or joins) the `sound-embed` job; refused (typed) when the model cannot run. */
	async startEmbed(opts: { full?: boolean; origin?: EngineJob['origin'] } = {}): Promise<EngineJob> {
		const why = await this.unavailable();
		if (why)
			throw new HttpError(
				409,
				why.status === 'not-installed' ? 'MODEL_NOT_INSTALLED' : 'DESCRIBE_UNAVAILABLE',
				`Describe-it search is unavailable: ${why.reason}`,
			);
		return this.core.queue.submit({
			kind: EMBED_JOB,
			title: 'Prepare the sound library for Describe-it search',
			priority: 'background',
			cpuSlots: 2,
			origin: opts.origin ?? { type: 'user' },
			dedupeKey: EMBED_JOB,
			input: opts.full ? { full: true } : {},
			stage: 'Waiting',
		});
	}

	/** Starts an embed job by itself when the model is installed and sounds lack embeddings (never throws). */
	async autoEmbed(): Promise<EngineJob | null> {
		try {
			if (this.embedJob()) return this.embedJob();
			if (await this.unavailable()) return null;
			const s = await this.status();
			if (s.embedded >= s.total) return null;
			return await this.startEmbed({ origin: { type: 'system' } });
		} catch (e) {
			this.deps.log?.(`describe search: could not start embedding: ${(e as Error).message}`);
			return null;
		}
	}

	// ---- texts --------------------------------------------------------------------------------------------------

	/** Unit embeddings of texts, from the cache or the model (the cache keeps the vocabulary and recent queries). */
	private async textVectors(ctx: ModelContext, texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
		const keys = texts.map(textKey);
		const out: (Float32Array | undefined)[] = await Promise.all(keys.map((k) => ctx.texts.get(k)));
		const missing = texts.filter((_, i) => !out[i]);
		if (missing.length) {
			const vs = await this.runtime.embedTexts(ctx.dir, missing, signal);
			let j = 0;
			for (let i = 0; i < out.length; i++)
				if (!out[i]) {
					out[i] = vs[j++]!;
					await ctx.texts.set(keys[i]!, out[i]!);
				}
			const vocabKeys = new Set(SOUND_VOCABULARY.map(textKey));
			for (const k of keys)
				if (!vocabKeys.has(k)) {
					const at = this.recentQueries.indexOf(k);
					if (at >= 0) this.recentQueries.splice(at, 1);
					this.recentQueries.push(k);
				}
			while (this.recentQueries.length > MAX_CACHED_QUERIES) this.recentQueries.shift();
			const keep = new Set([...vocabKeys, ...this.recentQueries]);
			await ctx.texts.flush(ctx.texts.size > MAX_CACHED_QUERIES + vocabKeys.size + 100 ? (k) => keep.has(k) : undefined);
		}
		return out as Float32Array[];
	}

	private async calibrationFor(ctx: ModelContext, signal?: AbortSignal): Promise<Calibration> {
		const id = `${ctx.entry.id}@${ctx.entry.revision}#v${VOCAB_VERSION}`;
		if (this.calibration?.modelId === id) return this.calibration.cal;
		const vectors = await this.textVectors(ctx, [...SOUND_VOCABULARY], signal);
		const cal = calibrationOf(vectors);
		this.calibration = { modelId: id, cal, vectors };
		return cal;
	}

	private statsOf(key: string, a: Float32Array, cal: Calibration): AudioStats {
		let s = this.stats.get(key);
		if (!s) {
			s = audioStats(a, cal);
			if (this.stats.size >= 200_000) this.stats.clear();
			this.stats.set(key, s);
		}
		return s;
	}

	/** The library's embedded sounds with their stats, and the hub-damping reference. */
	private async library(
		ctx: ModelContext,
		cal: Calibration,
		entries: readonly SoundEntry[],
	): Promise<{ items: { e: SoundEntry; a: Float32Array; stats: AudioStats }[]; ref: Reference }> {
		const items: { e: SoundEntry; a: Float32Array; stats: AudioStats }[] = [];
		for (const e of entries) {
			const key = entryKey(e);
			const a = await ctx.sounds.get(key);
			if (a) items.push({ e, a, stats: this.statsOf(key, a, cal) });
		}
		return { items, ref: referenceOf(items, cal) };
	}

	/**
	 * Describe mode of a search: every embedded sound's 0…1 score and match, or (model missing, unusable or failing)
	 * the reason to search the words instead. Starts an embed job for sounds without an embedding.
	 */
	async describe(
		text: string,
		entries: readonly SoundEntry[],
		signal?: AbortSignal,
	): Promise<{ info: SoundDescribeInfo; scores?: Map<string, number>; matches?: Map<string, SoundMatch> }> {
		const fallback = (reason: string, model: string | null = null): { info: SoundDescribeInfo } => ({
			info: { mode: 'keywords', reason, model, embedded: 0, pending: entries.length, jobId: null },
		});
		const why = await this.unavailable();
		if (why) return fallback(why.reason);
		let ctx: ModelContext;
		try {
			ctx = await this.context();
		} catch (e) {
			return fallback((e as Error).message);
		}
		try {
			const cal = await this.calibrationFor(ctx, signal);
			const [q] = await this.textVectors(ctx, [describeText(text)], signal);
			const { items, ref } = await this.library(ctx, cal, entries);
			const bias = queryBias(q!, ref);
			const scores = new Map<string, number>();
			const matches = new Map<string, SoundMatch>();
			for (const it of items) {
				const m = matchOf(it.a, it.stats, q!, bias, ref);
				scores.set(it.e.id, semanticScoreOf(m.z));
				matches.set(it.e.id, { z: m.z, cosine: m.cosine, verdict: verdictOf(m.z) });
			}
			const pending = entries.length - items.length;
			const job = pending > 0 ? await this.autoEmbed() : this.embedJob();
			return {
				info: { mode: 'semantic', reason: null, model: ctx.entry.id, embedded: items.length, pending, jobId: job?.id ?? null },
				scores,
				matches,
			};
		} catch (e) {
			if (signal?.aborted) throw e;
			const code = e instanceof ClapError ? e.code : 'CLAP_FAILED';
			this.deps.log?.(`describe search fell back to keywords: ${code} ${(e as Error).message}`);
			return fallback(`the model failed (${code}): ${(e as Error).message}`, ctx.entry.id);
		}
	}

	// ---- sound-embed job ----------------------------------------------------------------------------------------

	private async runEmbed(job: JobContext): Promise<SoundEmbedResult> {
		const full = (job.input as { full?: unknown } | null)?.full === true;
		const ctx = await this.context();
		const ffmpeg = this.core.ffmpeg.bins.ffmpeg!;
		job.progress(0, { stage: 'Preparing the vocabulary' });
		await this.calibrationFor(ctx, job.signal).catch((e) => {
			throw this.jobErrorOf(e, job.signal);
		});
		const entries = await this.deps.entries();
		const all = await this.deps.allEntries();
		const store = ctx.sounds;
		const errors: SoundEmbedResult['errors'] = [];
		let embedded = 0;
		let reused = 0;
		let failed = 0;
		const todo: SoundEntry[] = [];
		for (const e of entries) {
			if (!full && (await store.has(entryKey(e)))) reused++;
			else todo.push(e);
		}
		let since = 0;
		let lastFlush = Date.now();
		const flush = async () => {
			await store.flush();
			since = 0;
			lastFlush = Date.now();
		};
		try {
			for (let i = 0; i < todo.length; i++) {
				if (job.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
				const e = todo[i]!;
				job.progress(i / Math.max(1, todo.length), { stage: `Embedding ${i + 1} of ${todo.length}` });
				const windows = entryWindows(e);
				if (!windows.length) {
					failed++;
					if (errors.length < 50) errors.push({ soundId: e.id, code: 'SOUND_EMPTY', message: 'The sound has no length' });
					continue;
				}
				let path: string;
				try {
					path = await this.deps.fileOf(e);
				} catch (err) {
					failed++;
					if (errors.length < 50)
						errors.push({ soundId: e.id, code: (err as { code?: string }).code ?? 'SOUND_FILE_MISSING', message: (err as Error).message });
					continue;
				}
				try {
					const vs = await this.runtime.embedWindows(ctx.dir, { path, ffmpeg }, windows, job.signal);
					if (await store.set(entryKey(e), meanEmbedding(vs))) embedded++;
				} catch (err) {
					if (job.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
					const code = err instanceof ClapError ? err.code : 'EMBED_FAILED';
					// the worker itself cannot run: stop here (the next job tries again)
					if (code === 'CLAP_UNAVAILABLE' || code === 'CLAP_STOPPED') throw this.jobErrorOf(err, job.signal);
					failed++;
					if (errors.length < 50) errors.push({ soundId: e.id, code, message: (err as Error).message });
					job.log(`${e.id}: ${code} ${(err as Error).message}`);
				}
				if (++since >= FLUSH_EVERY || Date.now() - lastFlush > FLUSH_MS) await flush();
			}
			// the cache keeps what the index still has (any mode: a remote run must not drop a folder's embeddings)
			const keep = new Set(all.map(entryKey));
			await store.flush((k) => keep.has(k));
		} catch (e) {
			await store.flush().catch(() => undefined);
			throw e;
		}
		job.progress(1, { stage: 'Done' });
		this.core.capabilities.changed();
		return { model: ctx.entry.id, total: entries.length, embedded, reused, failed, errors };
	}

	private jobErrorOf(e: unknown, signal: AbortSignal): JobError {
		if (signal.aborted) return new JobError('JOB_CANCELLED', 'Cancelled');
		if (e instanceof JobError) return e;
		if (e instanceof ClapError) return new JobError(e.code, e.message, e.code === 'CLAP_CRASHED' || e.code === 'CLAP_TIMEOUT');
		return new JobError('CLAP_FAILED', (e as Error).message ?? String(e), false);
	}

	// ---- sound-moment job ---------------------------------------------------------------------------------------

	/** Starts a moment search of a library sound (checks the sound and the model first: typed 4xx). */
	async submitMoments(
		soundId: string,
		req: SoundMomentRequest,
		origin: EngineJob['origin'],
	): Promise<EngineJob> {
		const e = await this.deps.get(soundId);
		const why = await this.unavailable();
		if (why)
			throw new HttpError(
				409,
				why.status === 'not-installed' ? 'MODEL_NOT_INSTALLED' : 'DESCRIBE_UNAVAILABLE',
				`Find Moment is unavailable: ${why.reason}`,
			);
		this.rangeOf(e, req);
		return this.core.queue.submit({
			kind: MOMENT_JOB,
			title: `Find moment – ${e.title.slice(0, 60)}`,
			priority: 'user',
			cpuSlots: 2,
			origin,
			input: { soundId: e.id, request: req },
			stage: 'Waiting',
		});
	}

	/** The searched range of a sound (a take: inside its range), refused (typed) when empty or too long. */
	private rangeOf(e: SoundEntry, req: SoundMomentRequest): ClapWindow {
		const from = e.take ? e.take.startSec : 0;
		const dur = e.format.durationSec > 0 ? e.format.durationSec : e.descriptors.durationSec;
		const to = e.take ? e.take.endSec : dur;
		const startSec = Math.max(from, from + (req.startSec ?? 0));
		const endSec = Math.min(to, req.endSec !== undefined ? from + req.endSec : to);
		if (!(endSec > startSec) || !Number.isFinite(endSec))
			throw new HttpError(422, 'INVALID_RANGE', 'The range to search is empty (check startSec and endSec against the sound’s length)');
		if (endSec - startSec > SOUND_MOMENT_MAX_RECORDING_SEC)
			throw new HttpError(
				422,
				'SOUND_TOO_LONG',
				`Find Moment reads at most ${SOUND_MOMENT_MAX_RECORDING_SEC / 3600} h: give startSec and endSec`,
			);
		return { startSec, endSec };
	}

	private async runMoment(job: JobContext): Promise<SoundMomentResult> {
		const input = (job.input ?? {}) as { soundId?: unknown; request?: SoundMomentRequest };
		if (typeof input.soundId !== 'string' || !input.request)
			throw new JobError('INVALID_SPEC', 'A moment search needs a sound and a request', false);
		const req = input.request;
		let e: SoundEntry;
		let range: ClapWindow;
		let path: string;
		try {
			e = await this.deps.get(input.soundId);
			range = this.rangeOf(e, req);
			path = await this.deps.fileOf(e);
		} catch (err) {
			if (err instanceof HttpError) throw new JobError(err.code, err.message, false);
			throw err;
		}
		const ctx = await this.context();
		const ffmpeg = this.core.ffmpeg.bins.ffmpeg!;
		const description = describeText(req.description);
		const lengthSec = Math.min(req.lengthSec ?? SOUND_MOMENT_DEFAULT_SEC, range.endSec - range.startSec);
		const count = req.count ?? 3;
		try {
			job.progress(0, { stage: 'Reading the description' });
			const cal = await this.calibrationFor(ctx, job.signal);
			const [q] = await this.textVectors(ctx, [description], job.signal);
			const { ref } = await this.library(ctx, cal, await this.deps.entries());
			const bias = queryBias(q!, ref);
			const store = new EmbeddingStore(
				join(this.cacheDirOf(ctx.entry), 'moments', `${fingerprintHex(e.fingerprint)}.emb`),
				this.deps.log,
			);
			let computed = 0;
			let cached = 0;
			const embedAll = async (windows: ClapWindow[], from: number, to: number) => {
				const vectors: Float32Array[] = [];
				for (let i = 0; i < windows.length; i += MOMENT_BATCH) {
					if (job.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
					const batch = windows.slice(i, i + MOMENT_BATCH);
					const keys = batch.map((w) => keyOf(e.fingerprint, w));
					const have = await Promise.all(keys.map((k) => store.get(k)));
					const need = batch.filter((_, j) => !have[j]);
					const got = need.length
						? await this.runtime.embedWindows(ctx.dir, { path, ffmpeg }, need, job.signal)
						: [];
					let g = 0;
					for (let j = 0; j < batch.length; j++) {
						let v = have[j];
						if (v) cached++;
						else {
							v = got[g++]!;
							computed++;
							await store.set(keys[j]!, v);
						}
						vectors.push(v);
					}
					job.progress(from + ((to - from) * Math.min(windows.length, i + MOMENT_BATCH)) / windows.length, {
						stage: `Listening ${Math.min(windows.length, i + MOMENT_BATCH)} of ${windows.length}`,
					});
					if (computed && computed % 64 < MOMENT_BATCH) await store.flush();
				}
				return windows.map((w, i) => {
					const a = vectors[i]!;
					return { window: w, a, ...matchOf(a, audioStats(a, cal), q!, bias, ref) };
				});
			};
			const coarse = coarseWindows(range.startSec, range.endSec);
			let regions: ClapWindow[] = [range];
			let scored: { window: ClapWindow; z: number; cosine: number }[] = [];
			if (coarse.length) {
				const c = await embedAll(coarse, 0.02, lengthSec >= CLAP_WINDOW_SEC ? 0.9 : 0.7);
				regions = regionsToRefine(c);
				if (lengthSec >= CLAP_WINDOW_SEC) scored = c;
			}
			if (!scored.length) scored = await embedAll(fineWindows(regions, lengthSec, range), coarse.length ? 0.7 : 0.02, 0.9);
			await store.flush();
			const picked = pickMoments(scored, count);
			job.progress(0.92, { stage: 'Measuring the moments' });
			const levels = await this.runtime.levels(
				ctx.dir,
				{ path, ffmpeg },
				picked.map((p) => p.window),
				req.trim !== false,
				job.signal,
			);
			const offset = e.take ? e.take.startSec : 0;
			const sec = (v: number) => Math.round((v - offset) * 1e4) / 1e4;
			job.progress(1, { stage: 'Done' });
			return {
				soundId: e.id,
				description,
				model: ctx.entry.id,
				durationSec: e.format.durationSec > 0 ? e.format.durationSec : e.descriptors.durationSec,
				startSec: sec(range.startSec),
				endSec: sec(range.endSec),
				lengthSec,
				moments: picked.map((p, i) => ({
					startSec: Math.max(0, sec(levels[i]!.startSec)),
					endSec: Math.max(0, sec(levels[i]!.endSec)),
					match: { z: p.z, cosine: p.cosine, verdict: verdictOf(p.z) },
					headDb: levels[i]!.headDb,
					tailDb: levels[i]!.tailDb,
					trimmed: levels[i]!.trimmed,
				})),
				computed,
				cached,
			};
		} catch (err) {
			throw this.jobErrorOf(err, job.signal);
		}
	}

	// ---- removal ------------------------------------------------------------------------------------------------

	/** Stops the worker and deletes a model's cached embeddings (the model itself is removed by the route). */
	async forget(modelId: string): Promise<number> {
		this.runtime.close();
		let removed = 0;
		const e = this.models?.entry(modelId);
		if (!e) return 0;
		const stores = this.storesOf(e);
		removed += await stores.sounds.clear();
		await stores.texts.clear();
		this.stats.clear();
		this.calibration = null;
		const { rm } = await import('node:fs/promises');
		await rm(this.cacheDirOf(e), { recursive: true, force: true });
		return removed;
	}

	close(): void {
		this.runtime.dispose();
	}
}
