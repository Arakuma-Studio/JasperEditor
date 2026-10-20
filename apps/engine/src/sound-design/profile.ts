// Reference sound profiles (spec 12 §4 P6-E8; wp-note "Phase 6 → WP-E4"): the engine half.
//   - `SoundProfileStore`: the per-user library, `<appdir>/sounds/profiles/<id>.json` (one file per profile, written
//     atomically; every file is validated on read with `readReferenceProfile` — a damaged one is moved aside and listed,
//     never thrown). Profiles hold numbers, titles and fingerprints only, never audio.
//   - The `sound-profile` job: each reference measured by `ProfileMeter` (@jasper/audio-fx) — a media file (project
//     media, or an absolute path on a local engine) streamed through ffmpeg (audio as f32le, at most 60 min; its
//     picture, when it has one, decoded small and cut by the engine's scene detector, `sceneSignature` /
//     `detectSceneCuts`), or a sequence (its mix rendered by the export mixer, its picture events the edit's cuts and
//     transitions). Then the profile is aggregated (`buildReferenceProfile`) and stored.
//   - `referenceFindings`: Sound Check's "Reference" rows (code REFERENCE, warnings and infos only) from the delivered
//     mix's measurement, with what to do and the timecodes (the cuts with no sound, the gaps, the dead end).
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type {
	SoundCheckIssue,
	SoundCheckReference,
	SoundCheckReferenceRow,
	SoundProfileBuildRequest,
	SoundProfileBuildResult,
	SoundProfileSummary,
} from '@jasper/api';
import { SoundProfileBuildRequestSchema } from '@jasper/api';
import { ProfileMeter, type ProfileResult } from '@jasper/audio-fx';
import {
	buildReferenceProfile,
	compareWithProfile,
	DEFAULT_SCENE_OPTIONS,
	detectSceneCuts,
	frameToSample,
	mixFingerprint,
	type ProjectDocument,
	pictureEditEvents,
	type Rational,
	REFERENCE_PROFILE_ID_RE,
	REFERENCE_PROFILE_LIMITS,
	type ReferenceAdviceContext,
	type ReferenceEntry,
	type ReferenceMeasurement,
	type ReferenceProfile,
	readReferenceProfile,
	referenceAdvice,
	referenceEntryOf,
	referenceMessage,
	referenceProfileIdOf,
	referenceRowMessage,
	referenceSeverity,
	SCENE_DECODE,
	type SceneSignature,
	type Sequence,
	sceneDissimilarity,
	sceneFlashTest,
	sceneSignature,
	sceneThreshold,
	sequenceDuration,
	sequenceTimecode,
} from '@jasper/project';
import type { AgentService } from '../agent/service.ts';
import { cachedFrameTimes } from '../export/retime/frames.ts';
import type { JobContext } from '../jobs/types.ts';
import { JobError } from '../jobs/types.ts';
import { fingerprintFile } from '../media/fingerprint.ts';
import { mapProbe } from '../media/probe.ts';
import type { MediaRegistry } from '../media/registry.ts';
import { LOCAL_PROTOCOLS } from '../sounds/decode.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { atomicWriteJson } from '../tools/fs.ts';
import { HttpError } from '../tools/reply.ts';
import { audioWorld } from './bed.ts';
import { liveDocument, planSequence } from './plan.ts';
import { mixLayoutOf, renderStems } from './stems.ts';
import { engineMediaKey } from './voice.ts';

/** Decoding rate and channels of a reference's audio (stereo at most: the metrics read the first two channels). */
const PROFILE_RATE = 48_000;
const PROBE_TIMEOUT_MS = 20_000;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ── the store ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function newProfileId(): string {
	return referenceProfileIdOf(randomBytes(8));
}

export function profileSummaryOf(p: ReferenceProfile): SoundProfileSummary {
	return {
		id: p.id,
		name: p.name,
		n: p.n,
		createdAt: p.createdAt,
		updatedAt: p.updatedAt,
		references: p.references.map((r) => ({
			id: r.id,
			title: r.title,
			kind: r.kind,
			durationSec: r.durationSec,
			hasPicture: r.hasPicture,
		})),
		warnings: [...p.warnings],
	};
}

/** The per-user profile library (see the module docs). Writes are serialised; reads never throw on file content. */
export class SoundProfileStore {
	private chain: Promise<unknown> = Promise.resolve();

	constructor(
		readonly dir: string,
		private readonly log: (m: string) => void = () => {},
	) {}

	private file(id: string): string | null {
		return REFERENCE_PROFILE_ID_RE.test(id) ? join(this.dir, `${id}.json`) : null;
	}

	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.chain.catch(() => undefined).then(fn);
		this.chain = next;
		return next;
	}

	/** Reads one file: the profile, or why it is unreadable (null: missing). */
	private async read(
		file: string,
	): Promise<{ ok: true; profile: ReferenceProfile } | { ok: false; error: string } | null> {
		let text: string;
		try {
			const st = await stat(file);
			if (!st.isFile()) return { ok: false, error: 'not a file' };
			if (st.size > REFERENCE_PROFILE_LIMITS.fileBytes)
				return { ok: false, error: `larger than ${REFERENCE_PROFILE_LIMITS.fileBytes} bytes` };
			text = await readFile(file, 'utf8');
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
			return { ok: false, error: (e as Error).message.slice(0, 200) };
		}
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			return { ok: false, error: 'not JSON' };
		}
		return readReferenceProfile(raw);
	}

	/** Every readable profile (newest first) and the files that were not (moved aside as `<file>.unreadable-<t>`). */
	async list(): Promise<{ profiles: ReferenceProfile[]; unreadable: { file: string; error: string }[] }> {
		await this.chain.catch(() => undefined);
		let names: string[] = [];
		try {
			names = await readdir(this.dir);
		} catch {
			return { profiles: [], unreadable: [] };
		}
		const profiles: ReferenceProfile[] = [];
		const unreadable: { file: string; error: string }[] = [];
		for (const n of names.filter((x) => /^sprf_[0-9a-f]{16}\.json$/.test(x)).sort()) {
			const file = join(this.dir, n);
			const r = await this.read(file);
			if (!r) continue;
			if (r.ok && `${r.profile.id}.json` === n) profiles.push(r.profile);
			else {
				const error = r.ok ? 'its id is not its file name' : r.error;
				unreadable.push({ file: n, error });
				const aside = `${file}.unreadable-${Date.now()}`;
				await rename(file, aside).catch(() => undefined);
				this.log(`sound profile ${n} is unreadable (${error}): moved aside to ${basename(aside)}`);
			}
		}
		profiles.sort((a, b) =>
			a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? -1 : 1,
		);
		return { profiles, unreadable };
	}

	async get(id: string): Promise<ReferenceProfile | null> {
		const f = this.file(id);
		if (!f) return null;
		await this.chain.catch(() => undefined);
		const r = await this.read(f);
		return r?.ok && r.profile.id === id ? r.profile : null;
	}

	/** Stores a new profile (refused over `REFERENCE_PROFILE_LIMITS.profiles`). */
	save(p: ReferenceProfile): Promise<ReferenceProfile> {
		return this.serial(async () => {
			const f = this.file(p.id);
			if (!f) throw new HttpError(400, 'VALIDATION_FAILED', 'A profile id is sprf_ and 16 hex digits');
			await mkdir(this.dir, { recursive: true });
			const names = (await readdir(this.dir)).filter((x) => /^sprf_[0-9a-f]{16}\.json$/.test(x));
			if (!names.includes(`${p.id}.json`) && names.length >= REFERENCE_PROFILE_LIMITS.profiles)
				throw new HttpError(
					409,
					'SOUND_PROFILE_LIMIT',
					`The library holds ${REFERENCE_PROFILE_LIMITS.profiles} reference profiles at most: delete one first`,
				);
			await atomicWriteJson(f, p, true);
			return p;
		});
	}

	rename(id: string, name: string): Promise<ReferenceProfile> {
		return this.serial(async () => {
			const f = this.file(id);
			const r = f ? await this.read(f) : null;
			if (!f || !r?.ok)
				throw new HttpError(404, 'SOUND_PROFILE_NOT_FOUND', `No reference profile ${id.slice(0, 40)}`);
			const next = buildReferenceProfile({
				...r.profile,
				name,
				updatedAt: new Date().toISOString(),
			});
			await atomicWriteJson(f, next, true);
			return next;
		});
	}

	remove(id: string): Promise<void> {
		return this.serial(async () => {
			const f = this.file(id);
			if (!f || !(await this.read(f)))
				throw new HttpError(404, 'SOUND_PROFILE_NOT_FOUND', `No reference profile ${id.slice(0, 40)}`);
			await rm(f, { force: true });
		});
	}
}

/** A profile file to import: validated (`readReferenceProfile`), then stored under a new id. */
export function importedProfile(raw: unknown, name?: string): ReferenceProfile {
	if (raw === null || typeof raw !== 'object')
		throw new HttpError(400, 'SOUND_PROFILE_INVALID', 'Not a reference profile file: expected a JSON object');
	if (JSON.stringify(raw).length > REFERENCE_PROFILE_LIMITS.fileBytes)
		throw new HttpError(
			413,
			'SOUND_PROFILE_INVALID',
			`The file is larger than ${REFERENCE_PROFILE_LIMITS.fileBytes} bytes`,
		);
	const r = readReferenceProfile(raw);
	if (!r.ok) throw new HttpError(400, 'SOUND_PROFILE_INVALID', `Not a valid reference profile: ${r.error}`);
	const now = new Date().toISOString();
	return buildReferenceProfile({
		...r.profile,
		id: newProfileId(),
		name: name ?? r.profile.name,
		createdAt: now,
		updatedAt: now,
	});
}

// ── measuring a media file ──────────────────────────────────────────────────────────────────────────────────────────

export type MeasureEnv = {
	ff: Ffmpeg;
	signal: AbortSignal;
	onSpawn?: (child: import('node:child_process').ChildProcess) => void;
	/** Fraction 0…1 of this reference. */
	onProgress?: (fraction: number, stage: string) => void;
	/** Where frame-time lists are cached (by the file's fingerprint). */
	framesDir: string;
	maxSeconds?: number;
};

/** A reference that cannot be measured: the job lists it as skipped with this reason. */
export class SkipReference extends Error {}

function cancelled(): JobError {
	return new JobError('CANCELLED', 'Cancelled', false);
}

/** Streams interleaved f32le from a child into a consumer of planar blocks; resolves when the child exits 0. */
function streamPcm(
	child: import('node:child_process').ChildProcess,
	channels: number,
	signal: AbortSignal,
	push: (planar: Float32Array[], n: number) => void,
): Promise<void> {
	return new Promise((resolveP, reject) => {
		const frameBytes = 4 * channels;
		let rest = Buffer.alloc(0);
		let stderr = '';
		child.stdout!.on('data', (c: Buffer) => {
			const buf = rest.length ? Buffer.concat([rest, c]) : c;
			const frames = Math.floor(buf.length / frameBytes);
			if (frames > 0) {
				const planar = Array.from({ length: channels }, () => new Float32Array(frames));
				for (let i = 0; i < frames; i++)
					for (let ch = 0; ch < channels; ch++) planar[ch]![i] = buf.readFloatLE((i * channels + ch) * 4);
				push(planar, frames);
			}
			rest = Buffer.from(buf.subarray(frames * frameBytes));
		});
		child.stderr?.setEncoding('utf8').on('data', (c: string) => {
			stderr = (stderr + c).slice(-2000);
		});
		child.on('error', (e) => reject(new JobError('BINARY_MISSING', `Cannot run ffmpeg: ${e.message}`)));
		child.on('close', (code) => {
			if (signal.aborted) return reject(cancelled());
			if (code !== 0)
				return reject(new SkipReference(`ffmpeg could not decode it: ${stderr.trim().slice(-200)}`));
			resolveP();
		});
	});
}

/**
 * Picture events of a media file: its frames decoded small (`SCENE_DECODE`, raw RGBA, real timestamps) and cut by the
 * scene detector (default sensitivity, the flash test streamed over a ring of six signatures). Seconds, ascending.
 */
async function pictureCuts(
	file: string,
	fingerprint: string,
	size: { width: number; height: number },
	maxSec: number,
	env: MeasureEnv,
): Promise<{ timesSec: number[]; frames: number }> {
	const ft = await cachedFrameTimes(
		env.ff,
		file,
		env.framesDir,
		fingerprint.replace(/[^\w.-]/g, '_').slice(0, 64),
		{
			signal: env.signal,
		},
	);
	const times = ft.kind === 'list' ? Array.from(ft.times).filter((t) => t < maxSec) : [];
	const count = Math.max(1, times.length);
	const s = Math.min(1, SCENE_DECODE / Math.max(size.width, size.height));
	const width = Math.max(8, Math.round((size.width * s) / 2) * 2);
	const height = Math.max(8, Math.round((size.height * s) / 2) * 2);
	const child = env.ff.spawnRaw(
		[
			...LOCAL_PROTOCOLS,
			'-i',
			file,
			...['-map', '0:v:0', '-an', '-sn', '-dn'],
			...['-vf', `scale=${width}:${height}:flags=area,format=rgba`],
			...[
				'-fps_mode',
				'passthrough',
				'-frames:v',
				String(count),
				'-f',
				'rawvideo',
				'-pix_fmt',
				'rgba',
				'pipe:1',
			],
		],
		{ signal: env.signal },
	);
	env.onSpawn?.(child);
	const thr = sceneThreshold(DEFAULT_SCENE_OPTIONS.sensitivity);
	const frameBytes = width * height * 4;
	const scores: number[] = [];
	const flash: boolean[] = [];
	const ring: (SceneSignature | undefined)[] = new Array(6).fill(undefined);
	let n = 0;
	// frame j's flash test needs frames j − 3 … j + 2: decided when frame j + 2 arrives (or at the end); the ring holds
	// the six newest frames
	const decide = (j: number, newest: number) => {
		if (j < 1 || j > newest) return;
		flash[j] = sceneFlashTest((k) => {
			const f = j + k;
			return f >= 0 && f <= newest && f > newest - 6 ? ring[f % 6] : undefined;
		}, thr);
	};
	let stderr = '';
	await new Promise<void>((res, rej) => {
		let cur = Buffer.alloc(frameBytes);
		let filled = 0;
		child.stdout!.on('data', (chunk: Buffer) => {
			let off = 0;
			while (off < chunk.length) {
				const k = Math.min(frameBytes - filled, chunk.length - off);
				chunk.copy(cur, filled, off, off + k);
				filled += k;
				off += k;
				if (filled === frameBytes) {
					const sig = sceneSignature({ width, height, data: cur });
					const prev = n > 0 ? ring[(n - 1) % 6] : undefined;
					scores.push(prev ? sceneDissimilarity(prev, sig) : 0);
					ring[n % 6] = sig;
					decide(n - 2, n);
					n++;
					cur = Buffer.alloc(frameBytes);
					filled = 0;
					if (n % 25 === 0) env.onProgress?.(Math.min(1, n / count), `Picture: frame ${n} of ${count}`);
				}
			}
		});
		child.stderr?.setEncoding('utf8').on('data', (d: string) => {
			stderr = (stderr + d).slice(-2000);
		});
		child.on('error', rej);
		child.on('close', (code) => {
			if (env.signal.aborted) return rej(cancelled());
			if (code !== 0)
				return rej(new SkipReference(`its picture could not be decoded: ${stderr.trim().slice(-200)}`));
			res();
		});
	});
	decide(n - 2, n - 1);
	decide(n - 1, n - 1);
	const cuts = detectSceneCuts(scores, DEFAULT_SCENE_OPTIONS, (i) => flash[i] === true);
	return { timesSec: cuts.map((k) => times[k] ?? k / 25).filter(fin), frames: n };
}

/** Measures one media file (a reference): audio and picture decoded in parallel. */
export async function measureMediaFile(
	file: string,
	fingerprint: string,
	env: MeasureEnv,
): Promise<{ result: ProfileResult; seconds: number }> {
	const t0 = Date.now();
	let probe: ReturnType<typeof mapProbe>;
	try {
		probe = mapProbe(
			await env.ff.probeJson([...LOCAL_PROTOCOLS, '-show_format', '-show_streams', file], {
				signal: AbortSignal.any([env.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
			}),
		);
	} catch (e) {
		if (env.signal.aborted) throw cancelled();
		throw new SkipReference(`it is not a readable media file (${(e as Error).message.slice(0, 160)})`);
	}
	const audio = probe.probe.streams.find((s) => s.type === 'audio');
	if (audio?.type !== 'audio') throw new SkipReference('it has no audio');
	const maxSec = Math.min(REFERENCE_PROFILE_LIMITS.maxSec, env.maxSeconds ?? REFERENCE_PROFILE_LIMITS.maxSec);
	const channels = audio.channels >= 2 ? 2 : 1;
	const rate =
		Number.isFinite(audio.sampleRate) && audio.sampleRate >= 8000 && audio.sampleRate <= PROFILE_RATE
			? Math.round(audio.sampleRate)
			: PROFILE_RATE;
	const video = probe.probe.streams.find((s) => s.type === 'video');
	const fpsR = video?.type === 'video' ? video.frameRate : null;
	const fps = fpsR && fpsR.den > 0 && fpsR.num > 0 ? fpsR.num / fpsR.den : null;
	const durationSec = probe.durationSec !== null && fin(probe.durationSec) ? probe.durationSec : null;
	const meter = new ProfileMeter(rate, channels, { maxSeconds: maxSec });
	const child = env.ff.spawnRaw(
		[
			...LOCAL_PROTOCOLS,
			'-i',
			file,
			...['-map', '0:a:0', '-vn', '-sn', '-dn', '-t', String(maxSec)],
			...['-ac', String(channels), '-ar', String(rate), '-f', 'f32le', 'pipe:1'],
		],
		{ signal: env.signal },
	);
	env.onSpawn?.(child);
	let audioDone = 0;
	let pictureDone = video && probe.hasVideo && fps ? 0 : 1;
	const report = () => env.onProgress?.((audioDone + pictureDone) / 2, 'Measuring');
	const audioP = streamPcm(child, channels, env.signal, (planar, n) => {
		meter.push(planar, n);
		if (durationSec) {
			audioDone = Math.min(1, meter.length / rate / Math.min(durationSec, maxSec));
			report();
		}
	});
	const display =
		probe.display ?? (video?.type === 'video' ? { width: video.width, height: video.height } : null);
	const picP: Promise<{ timesSec: number[]; frames: number } | null> =
		video?.type === 'video' && probe.hasVideo && fps && display
			? pictureCuts(file, fingerprint, display, maxSec, {
					...env,
					onProgress: (f) => {
						pictureDone = f;
						report();
					},
				}).catch((e) => {
					if (e instanceof SkipReference) return null; // a picture we cannot read: audio-only (warned)
					throw e;
				})
			: Promise.resolve(null);
	const [, pic] = await Promise.all([audioP, picP]);
	const result = meter.finish(pic ? { timesSec: pic.timesSec, fps } : null);
	return { result, seconds: (Date.now() - t0) / 1000 };
}

// ── measuring a sequence ────────────────────────────────────────────────────────────────────────────────────────────

/** Picture events of a sequence (its cuts and transitions, `pictureEditEvents`) as seconds from `range.start`. */
export function sequencePicture(
	doc: ProjectDocument,
	seq: Sequence,
	range: { start: number; end: number },
): { timesSec: number[]; fps: number } {
	const r = seq.settings.frameRate as Rational;
	const fps = r.num / r.den;
	const times = pictureEditEvents(doc, seq.id, range)
		.map((p) => (p.frame - range.start) / fps)
		.filter((t) => t >= 0);
	return { timesSec: [...new Set(times)].sort((a, b) => a - b), fps };
}

/**
 * Measures a sequence as a reference: its whole mix rendered by the export mixer (in the Mix's layout) and its edit's
 * picture events. With the Mix's loudness normalisation on, the normalisation gain is added to the integrated
 * loudness and the true peak (capped at the ceiling: the limiter is not run — decision, wp-note).
 */
export async function measureSequence(
	doc: ProjectDocument,
	seq: Sequence,
	env: Pick<MeasureEnv, 'ff' | 'signal' | 'onSpawn' | 'onProgress' | 'maxSeconds'> & {
		registry: Pick<MediaRegistry, 'get' | 'resolvePath'>;
	},
): Promise<{ result: ProfileResult; seconds: number }> {
	const t0 = Date.now();
	const world = await audioWorld(doc, seq.id, env.registry);
	const snap = world.snapshot;
	const sr = snap.audioMix?.sampleRate ?? snap.settings.sampleRate;
	const { channels } = mixLayoutOf(snap);
	const rate = seq.settings.frameRate as Rational;
	const maxSec = Math.min(REFERENCE_PROFILE_LIMITS.maxSec, env.maxSeconds ?? REFERENCE_PROFILE_LIMITS.maxSec);
	const duration = Math.max(0, Math.ceil(sequenceDuration(seq)));
	const end = Math.min(duration, Math.floor((maxSec * rate.num) / rate.den));
	const samples = frameToSample(end, rate, sr);
	const meter = new ProfileMeter(sr, channels, { maxSeconds: maxSec });
	if (snap.audioClips.length > 0 && samples > 0)
		await renderStems({
			ff: env.ff,
			snapshot: snap,
			media: world.media,
			startSample: 0,
			samples,
			stems: [{ name: 'mix', clipIds: null }],
			signal: env.signal,
			...(env.onSpawn ? { onSpawn: env.onSpawn } : {}),
			onProgress: (f) => env.onProgress?.(f, 'Rendering the mix'),
			onBlock: (_i, planar, n) => meter.push(planar, n),
		});
	else meter.push([new Float32Array(samples)], samples);
	if (env.signal.aborted) throw cancelled();
	const result = meter.finish(sequencePicture(doc, seq, { start: 0, end }));
	const loud = (seq.master as { loudness?: { enabled?: boolean; targetLufs?: number; truePeakDb?: number } })
		.loudness;
	const m = result.measurement.metrics;
	if (loud?.enabled && fin(loud.targetLufs) && fin(loud.truePeakDb) && m.lufs_i !== null) {
		const gain = loud.targetLufs - m.lufs_i;
		m.lufs_i = r3(loud.targetLufs);
		if (m.true_peak !== null) m.true_peak = r3(Math.min(loud.truePeakDb, m.true_peak + gain));
	}
	return { result, seconds: (Date.now() - t0) / 1000 };
}

// ── the job ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type SoundProfileJobInput = { request: SoundProfileBuildRequest; local: boolean };

export type SoundProfileDeps = {
	store: SoundProfileStore;
	ffmpeg: Ffmpeg;
	registry: Pick<MediaRegistry, 'get' | 'resolvePath'>;
	agent: () => AgentService | undefined;
	framesDir: string;
	/** Seconds measured per reference (tests shorten it; default 60 min). */
	maxSeconds?: number;
};

/** An absolute engine-local path checked as the Media Browser does (local engines only; the route checks that). */
export async function checkReferencePath(p: string): Promise<string> {
	if (p.includes('\0')) throw new SkipReference('the path contains a NUL byte');
	if (!isAbsolute(p)) throw new SkipReference('the path is not absolute');
	let real: string;
	try {
		real = await realpath(resolve(p));
	} catch {
		throw new SkipReference('the file does not exist');
	}
	const st = await stat(real).catch(() => null);
	if (!st?.isFile()) throw new SkipReference('it is not a file');
	if (st.size === 0) throw new SkipReference('the file is empty');
	return real;
}

type Planned =
	| { kind: 'media'; title: string; mediaId: string }
	| { kind: 'sequence'; title: string; sequenceId: string }
	| { kind: 'path'; title: string; path: string };

export async function runSoundProfileJob(
	ctx: JobContext,
	deps: SoundProfileDeps,
): Promise<SoundProfileBuildResult> {
	const input = ctx.input as SoundProfileJobInput | null;
	const parsed = SoundProfileBuildRequestSchema.safeParse(input?.request);
	if (!parsed.success) throw new JobError('VALIDATION_FAILED', 'The profile request is invalid', false);
	const req = parsed.data;
	const t0 = Date.now();
	const timings: Record<string, number> = {};
	ctx.progress(0.01, { stage: 'Reading the references' });
	let doc: ProjectDocument | null = null;
	if (req.projectId) {
		const agent = deps.agent();
		if (!agent) throw new JobError('NOT_AVAILABLE', 'The agent service is not running', true);
		doc = (await liveDocument(agent, req.projectId)).doc;
	}
	const plan: Planned[] = [];
	// titles: the bin item's name (what the user calls it), else the file's name
	const items = Object.values(
		(doc?.items ?? {}) as Record<
			string,
			{ kind?: unknown; name?: unknown; mediaId?: unknown; sequenceId?: unknown }
		>,
	);
	const itemName = (key: 'mediaId' | 'sequenceId', id: string) => {
		const it = items.find((i) => i?.[key] === id && typeof i.name === 'string' && i.name);
		return it ? String(it.name) : null;
	};
	for (const id of req.mediaIds ?? []) {
		const asset = doc?.media?.[id] as { name?: unknown; originalName?: unknown } | undefined;
		const own = typeof asset?.name === 'string' ? asset.name : asset?.originalName;
		const title = itemName('mediaId', id) ?? (typeof own === 'string' && own ? own : id);
		plan.push({ kind: 'media', mediaId: id, title });
	}
	for (const id of req.sequenceIds ?? []) {
		const seq = doc?.sequences?.[id] as { name?: unknown } | undefined;
		const title = itemName('sequenceId', id) ?? (typeof seq?.name === 'string' && seq.name ? seq.name : id);
		plan.push({ kind: 'sequence', sequenceId: id, title });
	}
	for (const p of req.paths ?? []) plan.push({ kind: 'path', path: p, title: basename(p) || p });
	const refs: ReferenceEntry[] = [];
	const skipped: { title: string; reason: string }[] = [];
	const warnings: string[] = [];
	const scratch = await ctx.scratchDir();
	const noPicture: string[] = [];
	for (const [i, ref] of plan.entries()) {
		if (ctx.signal.aborted) throw cancelled();
		const base = 0.02 + (0.93 * i) / plan.length;
		const span = 0.93 / plan.length;
		const env: MeasureEnv = {
			ff: deps.ffmpeg,
			signal: ctx.signal,
			onSpawn: ctx.trackChild,
			onProgress: (f, stage) =>
				ctx.progress(base + span * Math.min(1, Math.max(0, f)), {
					stage: `${i + 1} of ${plan.length}: ${ref.title.slice(0, 60)} — ${stage}`,
				}),
			framesDir: deps.framesDir || scratch,
			...(deps.maxSeconds ? { maxSeconds: deps.maxSeconds } : {}),
		};
		const t = Date.now();
		try {
			let measured: { result: ProfileResult; seconds: number };
			let fingerprint: string;
			if (ref.kind === 'sequence') {
				if (!doc?.sequences?.[ref.sequenceId]) throw new SkipReference('the sequence does not exist');
				const seq = planSequence(doc, ref.sequenceId);
				measured = await measureSequence(doc, seq, { ...env, registry: deps.registry });
				fingerprint = `${req.projectId}/${seq.id}@${mixFingerprint(doc, seq.id)}`;
			} else {
				let file: string;
				if (ref.kind === 'media') {
					const asset = doc?.media?.[ref.mediaId] as Parameters<typeof engineMediaKey>[0];
					if (!asset) throw new SkipReference('the media is not in the project');
					const key = engineMediaKey(asset);
					const rec = key ? deps.registry.get(key) : null;
					const path = key ? await deps.registry.resolvePath(key) : null;
					if (!rec || !path) throw new SkipReference('the media file is offline');
					file = path;
					fingerprint = rec.fingerprint;
				} else {
					if (!input?.local) throw new SkipReference('paths are only taken by a local engine');
					file = await checkReferencePath(ref.path);
					fingerprint = (await fingerprintFile(file)).fingerprint;
				}
				measured = await measureMediaFile(file, fingerprint, env);
			}
			const r = measured.result;
			if (r.unscorable) throw new SkipReference(`it is ${r.unscorable}`);
			if (r.truncated)
				warnings.push(
					`${ref.title}: only its first ${Math.round(REFERENCE_PROFILE_LIMITS.maxSec / 60)} minutes were measured`,
				);
			if (ref.kind !== 'sequence' && !r.measurement.hasPicture) noPicture.push(ref.title);
			refs.push(
				referenceEntryOf(refs.length, r.measurement, {
					title: ref.title,
					kind: ref.kind === 'sequence' ? 'sequence' : 'media',
					fingerprint,
				}),
			);
			ctx.log(`sound-profile: ${ref.title} measured in ${measured.seconds.toFixed(1)} s`);
		} catch (e) {
			if (e instanceof SkipReference) {
				skipped.push({ title: ref.title, reason: e.message });
				ctx.log(`sound-profile: skipped ${ref.title}: ${e.message}`);
			} else if (e instanceof HttpError) {
				skipped.push({ title: ref.title, reason: e.message });
			} else throw e;
		}
		timings[`ref${i + 1}`] = Date.now() - t;
	}
	if (!refs.length)
		throw new JobError(
			'NO_REFERENCES',
			`No reference could be measured: ${skipped
				.map((s) => `${s.title} (${s.reason})`)
				.join('; ')
				.slice(0, 900)}`,
			false,
			{ skipped },
		);
	if (noPicture.length)
		warnings.push(
			`${noPicture.slice(0, 5).join(', ')}${noPicture.length > 5 ? ` (+${noPicture.length - 5} more)` : ''}: no picture, so no sync numbers from ${noPicture.length === 1 ? 'it' : 'them'}`,
		);
	if (skipped.length) warnings.push(`${skipped.length} reference(s) skipped`);
	if (refs.length < 3)
		warnings.push(
			`only ${refs.length} reference(s): the ranges are the min–max of ${refs.length} value(s) plus a small tolerance, too narrow to judge by; use 5 or more`,
		);
	const now = new Date().toISOString();
	ctx.progress(0.97, { stage: 'Storing the profile' });
	const profile = await deps.store.save(
		buildReferenceProfile({ id: newProfileId(), name: req.name, createdAt: now, references: refs, warnings }),
	);
	timings.total = Date.now() - t0;
	ctx.progress(1, { stage: `Reference profile “${profile.name}”: ${profile.n} reference(s)` });
	return { profile: profileSummaryOf(profile), skipped, warnings, timings };
}

// ── Sound Check: the Reference rows ─────────────────────────────────────────────────────────────────────────────────

export type ReferenceFindingsInput = {
	measured: ProfileResult;
	profile: ReferenceProfile;
	source: 'request' | 'sequence';
	seq: Sequence;
	projectId: string;
	range: { start: number; end: number };
	wholeSequence: boolean;
	/** Adds a finding (the check's IssueList); returns the issue (null when the list is full). */
	add(i: Omit<SoundCheckIssue, 'category' | 'id'> & { subject: string }): SoundCheckIssue | null;
};

/**
 * Compares the delivered mix's measurement with the profile and adds a finding per out-of-range row of weight major
 * (warning) or minor (info): its text, what to do with timecodes, the frame to look at. Returns the report section.
 */
export function referenceFindings(x: ReferenceFindingsInput): SoundCheckReference {
	const { seq, range } = x;
	const r = seq.settings.frameRate as Rational;
	const fps = r.num / r.den;
	const frameAt = (s: number) =>
		Math.max(range.start, Math.min(range.end, range.start + Math.round(s * fps)));
	const tc = (s: number) => sequenceTimecode(seq, frameAt(s));
	const ev = x.measured.events;
	const m: ReferenceMeasurement = x.measured.measurement;
	const cmp = compareWithProfile(m, x.profile, { identity: `${x.projectId}/${seq.id}` });
	const dur = m.durationSec;
	const ctx: ReferenceAdviceContext = {
		silentCuts: ev.picture.silentSec.map(tc),
		pictureEvents: ev.picture.timesSec.length,
		withoutOnset: ev.picture.withoutOnsetSec.length,
		gaps: ev.gaps.map(([a, b]) => `${tc(a)}–${tc(b)}`),
		...(ev.soundEndSec !== null ? { soundEndsAt: tc(ev.soundEndSec) } : {}),
		...(ev.quietestSec !== null ? { quietestAt: tc(ev.quietestSec) } : {}),
		...(ev.loudestSec !== null ? { loudestAt: tc(ev.loudestSec) } : {}),
		...(ev.picture.timesSec.length
			? { lastCutAt: tc(ev.picture.timesSec[ev.picture.timesSec.length - 1]!) }
			: {}),
		...(ev.firstSoundSec !== null ? { firstSoundAt: tc(ev.firstSoundSec) } : {}),
		openingSpan: `${tc(0)}–${tc(Math.max(0.1 * dur, 0.5))}`,
		closingSpan: `${tc(dur - Math.max(0.1 * dur, 0.5))}–${tc(dur)}`,
		cutsWithoutHit: ev.picture.withoutHitSec.map(tc),
	};
	const rows: SoundCheckReferenceRow[] = [];
	for (const row of cmp.rows) {
		const out: SoundCheckReferenceRow = {
			...row,
			range: [row.range[0], row.range[1]],
			typical: row.typical ? [row.typical[0], row.typical[1]] : null,
		};
		const severity = referenceSeverity(row);
		if (severity) {
			const message = referenceRowMessage(row);
			const advice = referenceAdvice(row, ctx, m);
			// where to look: the moment the row is about, when it has one
			let at: number | null = null;
			let span: { start: number; end: number } | null = null;
			if (row.metric === 'end_silence_s' && ev.soundEndSec !== null) {
				at = ev.soundEndSec;
				span = { start: frameAt(ev.soundEndSec), end: range.end };
			} else if (row.metric === 'cuts_with_sound' && ev.picture.silentSec.length)
				at = ev.picture.silentSec[0]!;
			else if (row.metric === 'cuts_with_sound' && ev.picture.withoutOnsetSec.length)
				at = ev.picture.withoutOnsetSec[0]!;
			else if (row.metric === 'max_gap_s' && ev.gaps.length) {
				const g = [...ev.gaps].sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0]!;
				at = g[0];
				span = { start: frameAt(g[0]), end: Math.max(frameAt(g[0]) + 1, frameAt(g[1])) };
			} else if (row.metric === 'first_sound_s' && ev.firstSoundSec !== null) at = ev.firstSoundSec;
			else if (row.metric === 'final_lu' && ev.soundEndSec !== null) at = Math.max(0, ev.soundEndSec - 3);
			else if ((row.metric === 'lra' || row.metric === 'crest_lu') && ev.loudestSec !== null)
				at = ev.loudestSec;
			const issue = x.add({
				code: 'REFERENCE',
				severity,
				subject: row.metric,
				...(at !== null ? { frame: frameAt(at), timecode: tc(at) } : {}),
				...(span && span.end > span.start ? { range: span } : {}),
				message,
				advice,
				measured: {
					metric: row.metric,
					value: row.value,
					lo: row.range[0],
					hi: row.range[1],
					median: row.median,
					references: row.n,
					status: row.status,
					weight: row.weight,
					...(row.chance !== undefined ? { chance: row.chance } : {}),
					...(row.metric === 'cuts_with_sound' ? { silentCuts: ev.picture.silentSec.length } : {}),
				},
			});
			out.message = message;
			out.advice = advice;
			if (issue) out.issueId = issue.id;
		}
		rows.push(out);
	}
	return {
		profileId: cmp.profileId,
		name: cmp.name,
		n: cmp.n,
		scoredAgainst: cmp.scoredAgainst,
		leaveOneOut: cmp.leaveOneOut,
		source: x.source,
		rows,
		arc: cmp.arc,
		counts: cmp.counts,
		wholeSequence: x.wholeSequence,
	};
}

/** The warning of a check whose profile is not in the library. */
export function missingProfileWarning(id: string): { code: string; message: string } {
	return {
		code: 'W_REFERENCE_PROFILE_MISSING',
		message: referenceMessage('missing', id).text,
	};
}

/** The leave-one-out note (warnings of a report judged against the other references). */
export function looWarning(ref: SoundCheckReference): { code: string; message: string } | null {
	return ref.leaveOneOut
		? {
				code: 'W_REFERENCE_LEAVE_ONE_OUT',
				message: referenceMessage('looNote', ref.leaveOneOut.title, ref.scoredAgainst).text,
			}
		: null;
}
