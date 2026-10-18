// Ambience beds and room tone (spec 12 §4 P6-E12; wp-note "Phase 6 → WP-E8"): the engine half. The model lays the
// beds (`soundDesign.layBed`, `@jasper/project` sound/ambience-bed.ts); the engine measures the recordings and the
// dialogue and writes the transaction:
//   beds        the bed of each scene (the request's sound, the scene's own, else the palette's first ambience) is
//               registered for the project when it is a library sound, decoded (≤ 10 min at 24 kHz) and measured:
//               its CLEAN WINDOW (`findCleanWindow`) and LOOP POINTS (`findLoopPoints`, the crossfade law by the
//               measured correlation), its loudness (BS.1770 of the window as it plays, stereo); the gain puts the
//               window at the ambience level of the sequence's delivery (web −30 LUFS: −16 LU under the target).
//   room tone   the holes between dialogue clips inside dialogue regions (`dialogueGaps`, or the given gaps / whole
//               regions), the dialogue's NOISE FLOOR (the quietest 20 % of its 100 ms frames outside voice activity,
//               `noiseFloorProfile`), the candidates — the palette's and library's room tones, measured on their clean
//               window — ranked by the SHAPE distance of their octave bands to the floor (`spectralDistanceDb`); the
//               closest within 3 dB is used, else the quietest 0.5–3 s without speech of the dialogue's own media
//               (`quietestStretch`), looped; its gain puts it at the floor (never under −56 dBFS: a fill is never a
//               silence itself).
//   jobs        `mode: 'propose'` (default) stores a proposal (setup items for the sounds, one bed item); `apply`
//               commits ONE transaction (the editor's: the user's own History entry).
// Measurements are cached in memory per file fingerprint and options (the same recording is measured once).
import type { ChildProcess } from 'node:child_process';
import {
	BED_SCENE_SOURCES,
	mediaRegisterCommand,
	type RegisterSoundResponse,
	SOUND_EFFECTS_BIN,
	type SoundBedsPlan,
	type SoundBedsRequest,
	SoundBedsRequestSchema,
	type SoundBedsResult,
	type SoundRoomTonePlan,
	type SoundRoomToneRequest,
	SoundRoomToneRequestSchema,
	type SoundRoomToneResult,
	SoundSearchQuerySchema,
} from '@jasper/api';
import { measureLoudness } from '@jasper/audio-dsp';
import {
	type CleanWindow,
	findCleanWindow,
	findLoopPoints,
	type LoopPoints,
	noiseFloorProfile,
	quietestStretch,
	spectralDistanceDb,
	windowSpectrum,
} from '@jasper/audio-fx';
import {
	AMBIENCE_BED_DEFAULTS,
	bedScenes,
	DELIVERY_INTEGRATED_LUFS,
	dialogueGaps,
	dialogueRegions,
	dialogueVadClips,
	existingSoundMedia,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	type MediaAsset,
	mergeSpans,
	type ProjectDocument,
	type ProposalDraft,
	type Rational,
	ROOM_TONE_DEFAULTS,
	readLibraryProvenance,
	roomToneGainDb,
	roomToneSpan,
	type Sequence,
	SFX_DEFAULT_GAIN_MAX_DB,
	SFX_DEFAULT_GAIN_MIN_DB,
	SFX_LEVEL_OFFSET_LU,
	SOUND_DESIGN_FEATURE,
	SOUND_PROPOSAL_BIN_ITEM,
	SOUND_PROPOSAL_SETUP_GROUP,
	sequenceDuration,
	sequenceTimecode,
	soundDesignSettingsOf,
	soundSetupItemId,
	type VoiceActivity,
} from '@jasper/project';
import type { AgentService } from '../agent/service.ts';
import type { JobContext } from '../jobs/types.ts';
import { JobError } from '../jobs/types.ts';
import type { MediaRegistry } from '../media/registry.ts';
import type { ProposalService, Requester } from '../proposals/service.ts';
import type { SoundService } from '../sounds/service.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { HttpError } from '../tools/reply.ts';
import type { EngineCueSources } from './engine-cues.ts';
import { liveDocument, PlanInputError, planSequence } from './plan.ts';
import { engineMediaKey, voiceServiceFor } from './voice.ts';

/** Analysis rate (Hz): octave bands to 8 kHz need ≥ 22.6 kHz. */
export const BED_ANALYSIS_RATE = 24_000;
/** Longest stretch of a recording decoded for its window (s). */
export const BED_ANALYSIS_MAX_SEC = 600;
/** Longest stretch of a dialogue clip decoded for its floor (s). */
export const ROOM_TONE_FLOOR_MAX_SEC = 120;
/** Most dialogue clips measured for the floor. */
export const ROOM_TONE_FLOOR_CLIPS = 8;
/** A library room tone within this shape distance of the floor is a match (dB; decision, wp-note). */
export const ROOM_TONE_MATCH_MAX_DB = 3;
export const BEDS_LABEL = 'Lay Ambience Bed';
export const ROOM_TONE_LABEL = 'Fill Room Tone';

const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export class BedInputError extends Error {
	constructor(
		readonly status: 400 | 404 | 422 | 503,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export type BedDeps = {
	agent: () => AgentService | undefined;
	proposals: () => ProposalService | undefined;
	sounds: () => SoundService | undefined;
	engineCues?: () => EngineCueSources | undefined;
	ffmpeg: Ffmpeg;
	registry: Pick<MediaRegistry, 'get' | 'resolvePath'>;
};

type Ctx = { signal?: AbortSignal; onSpawn?(child: ChildProcess): void };

// ── decoding and measuring ───────────────────────────────────────────────────────────────────────────────────────

/** Decodes `[start, start + duration)` of a file's first audio stream (or `stream`) to two planar channels and mono. */
export function decodeBed(
	ff: Ffmpeg,
	path: string,
	opts: { start?: number; duration: number; stream?: number | null; rate?: number },
	ctx: Ctx = {},
): Promise<{ left: Float32Array; right: Float32Array; mono: Float32Array; rate: number }> {
	const rate = opts.rate ?? BED_ANALYSIS_RATE;
	const start = Math.max(0, opts.start ?? 0);
	const args = [
		...['-ss', start.toFixed(6), '-t', Math.max(0.01, opts.duration).toFixed(6), '-i', path],
		...['-map', opts.stream === undefined || opts.stream === null ? '0:a:0' : `0:${opts.stream}`],
		...['-ac', '2', '-ar', String(rate), '-f', 'f32le', 'pipe:1'],
	];
	return new Promise((resolve, reject) => {
		const child = ff.spawnRaw(args, ctx.signal ? { signal: ctx.signal } : {});
		ctx.onSpawn?.(child);
		const chunks: Buffer[] = [];
		let size = 0;
		let err = '';
		const cap = Math.ceil((opts.duration + 1) * rate) * 8;
		child.stdout!.on('data', (c: Buffer) => {
			if (size + c.length <= cap) {
				chunks.push(c);
				size += c.length;
			}
		});
		child.stderr!.setEncoding('utf8').on('data', (c: string) => {
			err = (err + c).slice(-4000);
		});
		child.on('error', (e) => reject(new HttpError(500, 'DECODE_FAILED', e.message)));
		child.on('close', (code) => {
			if (ctx.signal?.aborted) return reject(new JobError('CANCELLED', 'Cancelled', false));
			if (code !== 0)
				return reject(
					new HttpError(422, 'DECODE_FAILED', `ffmpeg exited ${code}: ${err.trim().slice(-600)}`),
				);
			const buf = Buffer.concat(chunks);
			const n = Math.floor(buf.length / 8);
			const f = new Float32Array(buf.buffer, buf.byteOffset, n * 2);
			const left = new Float32Array(n);
			const right = new Float32Array(n);
			const mono = new Float32Array(n);
			for (let i = 0; i < n; i++) {
				left[i] = f[2 * i]!;
				right[i] = f[2 * i + 1]!;
				mono[i] = 0.5 * (left[i]! + right[i]!);
			}
			resolve({ left, right, mono, rate });
		});
	});
}

/** A recording measured as a bed: its window, loop points and loudness (seconds of the decoded stretch + `offsetSec`). */
export type BedMeasure = {
	durationSec: number;
	window: CleanWindow;
	loop: LoopPoints;
	/** Integrated loudness of the window as it plays (stereo; LUFS), null when not measurable. */
	loudnessLufs: number | null;
	spectrum: { levelDb: number; bandsDb: number[] };
};

const cache = new Map<string, Promise<BedMeasure>>();
const CACHE_MAX = 64;

function remember(key: string, p: Promise<BedMeasure>): Promise<BedMeasure> {
	cache.set(key, p);
	while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
	p.catch(() => cache.delete(key));
	return p;
}

/** Measures a bed recording (cached by `key`: the file's fingerprint). Throws `BedInputError` for a silent file. */
export function measureBed(
	ff: Ffmpeg,
	path: string,
	key: string,
	opts: { durationSec: number; frameSec: number; crossfadeSec: number },
	ctx: Ctx = {},
): Promise<BedMeasure> {
	const k = `${key}|${r3(opts.frameSec)}|${r3(opts.crossfadeSec)}`;
	const hit = cache.get(k);
	if (hit) return hit;
	return remember(
		k,
		(async () => {
			const dur = Math.min(BED_ANALYSIS_MAX_SEC, Math.max(0.05, opts.durationSec));
			const pcm = await decodeBed(ff, path, { duration: dur }, ctx);
			const window = findCleanWindow(pcm.mono, pcm.rate);
			if (!window)
				throw new BedInputError(
					422,
					'BED_SILENT',
					'The recording is silent or too short to loop (under 0.5 s)',
				);
			const loop = findLoopPoints(pcm.mono, pcm.rate, window, {
				crossfadeSec: opts.crossfadeSec,
				frameSec: opts.frameSec,
			});
			if (!loop) throw new BedInputError(422, 'BED_TOO_SHORT', 'The recording is too short to loop');
			const a = Math.floor(window.startSec * pcm.rate);
			const b = Math.ceil(window.endSec * pcm.rate);
			const lufs = measureLoudness([pcm.left.subarray(a, b), pcm.right.subarray(a, b)], pcm.rate).integrated;
			return {
				durationSec: r3(pcm.mono.length / pcm.rate),
				window,
				loop,
				loudnessLufs: fin(lufs) && lufs > -100 ? r2(lufs) : null,
				spectrum: windowSpectrum(pcm.mono, pcm.rate, window.startSec, window.endSec) ?? {
					levelDb: window.levelDb,
					bandsDb: [],
				},
			};
		})(),
	);
}

// ── media ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A bed source resolved for the transaction: the media it plays and the commands that bring it into the project. */
type BedSource = {
	soundId: string | null;
	/** A project media id, or the `$ref` its register command binds. */
	mediaId: string;
	title: string;
	path: string;
	fingerprint: string;
	durationSec: number;
	/** Setup items (bin, register / provenance) this source needs. */
	setup: SetupItem[];
};

type SetupItem = { id: string; label: string; commands: Record<string, unknown>[]; requires?: string[] };

type Sources = {
	doc: ProjectDocument;
	projectId: string;
	byKey: Map<string, Promise<BedSource>>;
	binRef: string | null;
	binItem: SetupItem | null;
	n: number;
};

function rootBin(doc: ProjectDocument, name: string): string | null {
	for (const id of doc.rootItems ?? []) {
		const it = doc.items?.[id];
		if (it?.kind === 'bin' && it.name === name) return it.id;
	}
	return null;
}

async function projectMediaSource(deps: BedDeps, doc: ProjectDocument, mediaId: string): Promise<BedSource> {
	const asset = doc.media?.[mediaId] as MediaAsset | undefined;
	if (!asset) throw new BedInputError(404, 'MEDIA_NOT_FOUND', `Media not found: ${mediaId}`);
	if (!asset.probe?.streams?.some((s) => s.type === 'audio'))
		throw new BedInputError(422, 'NO_AUDIO', `Media ${mediaId} has no sound`);
	const key = engineMediaKey(asset);
	const rec = key ? deps.registry.get(key) : null;
	const path = key && rec ? await deps.registry.resolvePath(key) : null;
	if (!path)
		throw new BedInputError(422, 'MEDIA_OFFLINE', `Media ${mediaId} is offline or not in the engine's store`);
	const prov = readLibraryProvenance((asset as { library?: unknown }).library);
	return {
		soundId: prov?.soundId ?? null,
		mediaId,
		title: prov?.title ?? asset.originalName ?? mediaId,
		path,
		fingerprint: asset.fingerprint,
		durationSec: (asset.probe?.durationFlicks ?? rec?.probe?.durationFlicks ?? 0) / FLICKS_PER_SECOND,
		setup: [],
	};
}

async function librarySource(deps: BedDeps, src: Sources, soundId: string): Promise<BedSource> {
	const sounds = deps.sounds();
	if (!sounds) throw new BedInputError(503, 'NOT_AVAILABLE', 'The sound library is not running');
	let reg: RegisterSoundResponse;
	try {
		reg = await sounds.register(soundId, src.projectId);
	} catch (e) {
		if (e instanceof HttpError) throw new BedInputError(e.status === 404 ? 404 : 422, e.code, e.message);
		throw e;
	}
	const path = await deps.registry.resolvePath(reg.mediaKey);
	if (!path) throw new BedInputError(422, 'MEDIA_OFFLINE', `The sound ${soundId} could not be registered`);
	const title = reg.library.title ?? soundId;
	const durationSec = (reg.probe.durationFlicks ?? 0) / FLICKS_PER_SECOND;
	const existing = existingSoundMedia(src.doc, {
		existingMediaId: reg.existingMediaId,
		fingerprint: reg.fingerprint,
		kind: reg.kind,
	});
	const setup: BedSource['setup'] = [];
	if (existing) {
		const own = readLibraryProvenance((src.doc.media[existing] as { library?: unknown }).library);
		if (!own)
			setup.push({
				id: soundSetupItemId(soundId),
				label: `Sound provenance: ${title}`.slice(0, 200),
				commands: [{ type: 'media.setLibraryInfo', mediaId: existing, library: reg.library }],
			});
		return { soundId, mediaId: existing, title, path, fingerprint: reg.fingerprint, durationSec, setup };
	}
	if (src.binRef === null) {
		src.binRef = '$bedBin';
		src.binItem = {
			id: SOUND_PROPOSAL_BIN_ITEM,
			label: `Bin "${SOUND_EFFECTS_BIN}"`,
			commands: [{ type: 'bin.create', name: SOUND_EFFECTS_BIN, ref: src.binRef }],
		};
	}
	const ref = `$bed${src.n}`;
	const itemRef = `$bedItem${src.n}`;
	src.n++;
	const cmd = mediaRegisterCommand(reg, ref, itemRef, title);
	setup.push({
		id: soundSetupItemId(soundId),
		label: `Import ${title}`.slice(0, 200),
		commands: [{ ...cmd, asset: { ...cmd.asset, library: reg.library }, binId: src.binRef }],
		// the bin this transaction creates comes first
		...(src.binItem && src.binRef === '$bedBin' ? { requires: [src.binItem.id] } : {}),
	});
	return { soundId, mediaId: ref, title, path, fingerprint: reg.fingerprint, durationSec, setup };
}

function sourceOf(
	deps: BedDeps,
	src: Sources,
	s: { soundId?: string; mediaId?: string },
): Promise<BedSource> {
	const key = s.soundId ? `s:${s.soundId}` : `m:${s.mediaId}`;
	let p = src.byKey.get(key);
	if (!p) {
		p = s.soundId ? librarySource(deps, src, s.soundId) : projectMediaSource(deps, src.doc, s.mediaId!);
		src.byKey.set(key, p);
	}
	return p;
}

/** The setup items of the sources used (bin first, each source's once, in first-use order). */
function setupItems(src: Sources, used: readonly BedSource[]): SetupItem[] {
	const out: SetupItem[] = [];
	const seen = new Set<string>();
	const needsBin = used.some((u) => u.setup.some((s) => s.commands.some((c) => c.binId === '$bedBin')));
	if (needsBin && src.binItem) {
		out.push(src.binItem);
		seen.add(src.binItem.id);
	}
	for (const u of used)
		for (const s of u.setup)
			if (!seen.has(s.id)) {
				seen.add(s.id);
				out.push(s);
			}
	return out;
}

const newSources = (doc: ProjectDocument, projectId: string): Sources => ({
	doc,
	projectId,
	byKey: new Map(),
	binRef: rootBin(doc, SOUND_EFFECTS_BIN),
	binItem: null,
	n: 0,
});

/** The ambience gain of a measured window: the delivery's ambience level (−16 LU under the target) over its loudness. */
export function bedGainDb(
	loudnessLufs: number | null,
	delivery: keyof typeof DELIVERY_INTEGRATED_LUFS,
): number {
	if (loudnessLufs === null) return 0;
	const target = DELIVERY_INTEGRATED_LUFS[delivery] + SFX_LEVEL_OFFSET_LU.ambience;
	const g = Math.max(SFX_DEFAULT_GAIN_MIN_DB, Math.min(SFX_DEFAULT_GAIN_MAX_DB, target - loudnessLufs));
	return Math.round(g * 10) / 10;
}

const rateOf = (seq: Sequence) => seq.settings.frameRate as Rational;
const frameSecOf = (seq: Sequence) => rateOf(seq).den / rateOf(seq).num;

// ── beds ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The palette's first ambience sound (a library sound typed ambience, not room tone), or null. */
async function paletteAmbience(
	deps: BedDeps,
	seq: Sequence,
	type: 'ambience' | 'roomtone',
): Promise<string[]> {
	const sounds = deps.sounds();
	if (!sounds) return [];
	const out: string[] = [];
	for (const id of soundDesignSettingsOf(seq).palette ?? []) {
		const e = await sounds.get(id).catch(() => null);
		if (
			e &&
			(e.types as readonly string[]).includes(type) &&
			(type === 'roomtone' || !(e.types as readonly string[]).includes('roomtone'))
		)
			out.push(id);
	}
	return out;
}

/** The plan of an ambience bed per scene (see the module docs). Registers library sounds for the project. */
export async function planBeds(
	deps: BedDeps,
	doc: ProjectDocument,
	seq: Sequence,
	projectId: string,
	req: SoundBedsRequest,
	ctx: Ctx & { progress?(f: number, stage: string): void } = {},
): Promise<{
	plan: SoundBedsPlan;
	setup: ReturnType<typeof setupItems>;
	layBed: Record<string, unknown> | null;
}> {
	const warnings: { code: string; message: string }[] = [];
	const frameSec = frameSecOf(seq);
	const total = sequenceDuration(seq);
	const crossfadeSec = req.crossfadeSec ?? AMBIENCE_BED_DEFAULTS.crossfadeSec;
	// the scenes
	type Scene = {
		start: number;
		end: number;
		reason: 'start' | 'edit' | 'marker' | 'shot' | 'user';
		label: string;
		soundId?: string;
		mediaId?: string;
	};
	let scenes: Scene[];
	const usedSources: string[] = [];
	if (Array.isArray(req.scenes)) {
		scenes = [...req.scenes]
			.sort((a, b) => a.start - b.start)
			.map((s) => ({
				start: s.start,
				end: s.end,
				reason: 'user' as const,
				label: '',
				...(s.soundId ? { soundId: s.soundId } : {}),
				...(s.mediaId ? { mediaId: s.mediaId } : {}),
			}));
		for (let i = 1; i < scenes.length; i++)
			if (scenes[i]!.start < scenes[i - 1]!.end)
				throw new BedInputError(400, 'SCENES_OVERLAP', `Scene ${i + 1} starts before scene ${i} ends`);
		usedSources.push('user');
	} else {
		const want = new Set(req.sources ?? ['edits', 'markers']);
		for (const s of BED_SCENE_SOURCES) if (want.has(s)) usedSources.push(s);
		let shotCuts: number[] = [];
		if (want.has('shots')) {
			const ec = deps.engineCues?.();
			const r = ec
				? await ec.collect(doc, seq, {
						sources: ['scene'],
						mode: { kind: 'cached' },
						...(req.range ? { range: req.range } : {}),
					})
				: null;
			shotCuts = (r?.extraCues ?? []).map((c) => c.frame).filter(fin);
			const st = r?.analysis.scene?.state;
			if (st !== 'ready' && st !== 'none')
				warnings.push({
					code: 'W_SHOTS_NOT_ANALYSED',
					message:
						'Shot changes inside the footage are not analysed yet (find_sound_cues {sources: ["scene"]} or Suggest Cues ▸ Analyze…); the scenes follow the edits and markers',
				});
		}
		// (a scene's `mediaId` is the footage it shows, not a bed)
		scenes = bedScenes(doc, seq, {
			...(req.range ? { range: req.range } : {}),
			sources: { edits: want.has('edits'), markers: want.has('markers') },
			shotCuts,
		}).map((s) => ({ start: s.start, end: s.end, reason: s.reason, label: s.label }));
	}
	scenes = scenes.filter((s) => s.end > s.start && (s.reason === 'user' || s.start < total));
	if (!scenes.length)
		throw new BedInputError(422, 'NO_SCENES', 'Nothing to lay a bed under: the sequence (or range) is empty');
	// the default bed
	let dflt: { soundId?: string; mediaId?: string } | null = req.soundId
		? { soundId: req.soundId }
		: req.mediaId
			? { mediaId: req.mediaId }
			: null;
	if (!dflt && scenes.some((s) => !s.soundId && !s.mediaId)) {
		const pal = await paletteAmbience(deps, seq, 'ambience');
		if (pal[0]) dflt = { soundId: pal[0] };
		else
			throw new BedInputError(
				422,
				'BED_SOUND_REQUIRED',
				'Name the bed: a library ambience (soundId; search_sounds {types: ["ambience"]}) or a project media (mediaId), or put an ambience in the sequence palette',
			);
	}
	const src = newSources(doc, projectId);
	const settings = soundDesignSettingsOf(seq);
	const reports: SoundBedsPlan['scenes'] = [];
	const shots: Record<string, unknown>[] = [];
	const used: BedSource[] = [];
	for (const [i, s] of scenes.entries()) {
		ctx.progress?.(
			0.1 + (0.8 * i) / scenes.length,
			`Measuring the bed of scene ${i + 1} of ${scenes.length}`,
		);
		const pick = s.soundId ? { soundId: s.soundId } : s.mediaId ? { mediaId: s.mediaId } : dflt!;
		const source = await sourceOf(deps, src, pick);
		if (!used.includes(source)) used.push(source);
		const m = await measureBed(
			deps.ffmpeg,
			source.path,
			source.fingerprint,
			{
				durationSec: source.durationSec || BED_ANALYSIS_MAX_SEC,
				frameSec,
				crossfadeSec,
			},
			ctx,
		);
		if (!m.window.clean)
			warnings.push({
				code: 'W_BED_NOT_CLEAN',
				message: `"${source.title}" has no stretch without a spike (a voice, a bump): its least busy one is used (${m.window.spikes} spike${m.window.spikes === 1 ? '' : 's'})`,
			});
		const gainDb = req.gainDb ?? bedGainDb(m.loudnessLufs, settings.delivery);
		reports.push({
			start: s.start,
			end: s.end,
			timecode: sequenceTimecode(seq, s.start),
			endTimecode: sequenceTimecode(seq, s.end),
			reason: s.reason,
			label: s.label,
			sound: {
				soundId: source.soundId,
				mediaId: source.mediaId,
				title: source.title,
				loudnessLufs: m.loudnessLufs,
				window: {
					startSec: m.window.startSec,
					endSec: m.window.endSec,
					levelDb: m.window.levelDb,
					levelStdDb: m.window.levelStdDb,
					onsetsPerMin: m.window.onsetsPerMin,
					spikes: m.window.spikes,
					clean: m.window.clean,
					whole: m.window.whole,
				},
				loop: {
					inSec: m.loop.inSec,
					outSec: r3(m.loop.outSec),
					crossfadeSec: m.loop.crossfadeSec,
					fade: m.loop.fade,
					levelDiffDb: m.loop.levelDiffDb,
					spectralDistanceDb: m.loop.spectralDistanceDb,
					correlation: m.loop.correlation,
					midpointDb: m.loop.midpointDb,
				},
			},
			gainDb,
		});
		shots.push({
			start: s.start,
			end: s.end,
			mediaId: source.mediaId,
			loop: { inSec: m.loop.inSec, outSec: m.loop.outSec },
			gainDb,
			fade: m.loop.fade,
		});
	}
	const layBed: Record<string, unknown> = {
		type: 'soundDesign.layBed',
		sequenceId: seq.id,
		purpose: 'ambience',
		shots,
		mediaId: shots[0]!.mediaId,
		crossfadeSec,
		...(req.sceneCrossfadeSec !== undefined ? { sceneCrossfadeSec: req.sceneCrossfadeSec } : {}),
		...(req.fadeSec !== undefined ? { fadeSec: req.fadeSec } : {}),
		...(req.duckUnder ? { duckUnder: req.duckUnder } : {}),
		...(req.track ? { track: req.track } : {}),
		replace: req.replace ?? true,
	};
	const setup = setupItems(src, used);
	return {
		plan: {
			sequenceId: seq.id,
			purpose: 'ambience',
			scenes: reports,
			commands: [...setup.flatMap((s) => s.commands), layBed] as SoundBedsPlan['commands'],
			warnings,
			sources: usedSources,
		},
		setup,
		layBed,
	};
}

// ── room tone ────────────────────────────────────────────────────────────────────────────────────────────────────

type FloorClip = {
	clipId: string;
	mediaId: string;
	streamIndex: number | null;
	startSec: number;
	endSec: number;
	gainDb: number;
};

/** The dialogue clips a fill listens to: those around the gaps, at most `ROOM_TONE_FLOOR_CLIPS`. */
function floorClips(doc: ProjectDocument, seq: Sequence, clipIds: readonly string[]): FloorClip[] {
	const vad = new Map(dialogueVadClips(doc, seq).map((c) => [c.clipId, c] as const));
	const F = flicksPerFrame(rateOf(seq));
	const out: FloorClip[] = [];
	for (const id of clipIds) {
		if (out.length >= ROOM_TONE_FLOOR_CLIPS) break;
		const c = seq.clips[id] as
			| (Sequence['clips'][string] & { mediaId?: string; gainDb?: number; speed?: { rate?: number } })
			| undefined;
		if (c?.kind !== 'audio' || typeof c.mediaId !== 'string') continue;
		const v = vad.get(id);
		const rate = Math.abs(c.speed?.rate ?? 1) || 1;
		const startSec = v?.mediaStartSec ?? c.sourceIn / FLICKS_PER_SECOND;
		const endSec = v?.mediaEndSec ?? (c.sourceIn + c.duration * F * rate) / FLICKS_PER_SECOND;
		const stream = (c as { channels?: { streamIndex?: unknown } }).channels?.streamIndex;
		out.push({
			clipId: id,
			mediaId: c.mediaId,
			streamIndex: v?.streamIndex ?? (Number.isSafeInteger(stream) ? (stream as number) : null),
			startSec,
			endSec: Math.min(endSec, startSec + ROOM_TONE_FLOOR_MAX_SEC),
			gainDb: fin(c.gainDb) ? c.gainDb : 0,
		});
	}
	return out;
}

type Floor = {
	levelDb: number;
	bandsDb: number[];
	seconds: number;
	clipIds: string[];
	gainDb: number;
	/** The quietest 0.5–3 s without speech of the dialogue's own media (its own room tone). */
	stretch: {
		mediaId: string;
		clipId: string;
		startSec: number;
		endSec: number;
		levelDb: number;
		spectrum: { levelDb: number; bandsDb: number[] };
		loop: LoopPoints | null;
	} | null;
};

async function measureFloor(
	deps: BedDeps,
	doc: ProjectDocument,
	seq: Sequence,
	clips: FloorClip[],
	voice: VoiceActivity,
	ctx: Ctx,
): Promise<Floor | null> {
	let e = 0;
	const bands: number[] = [];
	let seconds = 0;
	let n = 0;
	let g = 0;
	const ids: string[] = [];
	let stretch: Floor['stretch'] = null;
	for (const c of clips) {
		const asset = doc.media?.[c.mediaId] as MediaAsset | undefined;
		const key = engineMediaKey(asset);
		const path = key && deps.registry.get(key) ? await deps.registry.resolvePath(key) : null;
		if (!path) continue;
		const pcm = await decodeBed(
			deps.ffmpeg,
			path,
			{ start: c.startSec, duration: Math.max(0.2, c.endSec - c.startSec), stream: c.streamIndex },
			ctx,
		).catch(() => null);
		if (!pcm || pcm.mono.length < pcm.rate * 0.2) continue;
		const exclude = (voice[c.clipId] ?? []).map(
			([a, b]) => [a - c.startSec, b - c.startSec] as [number, number],
		);
		const f = noiseFloorProfile(pcm.mono, pcm.rate, { exclude });
		if (!f) continue;
		e += 10 ** (f.levelDb / 10);
		f.bandsDb.forEach((b, i) => {
			bands[i] = (bands[i] ?? 0) + 10 ** (b / 10);
		});
		seconds += f.seconds;
		g += c.gainDb;
		n++;
		ids.push(c.clipId);
		const q = quietestStretch(pcm.mono, pcm.rate, { exclude });
		if (
			q &&
			(!stretch ||
				q.endSec - q.startSec > stretch.endSec - stretch.startSec + 1e-9 ||
				(q.endSec - q.startSec >= stretch.endSec - stretch.startSec - 1e-9 && q.levelDb < stretch.levelDb))
		) {
			const loop = findLoopPoints(pcm.mono, pcm.rate, q, {
				crossfadeSec: Math.min(AMBIENCE_BED_DEFAULTS.crossfadeSec, (q.endSec - q.startSec) / 3),
				frameSec: frameSecOf(seq),
			});
			stretch = {
				mediaId: c.mediaId,
				clipId: c.clipId,
				startSec: r3(c.startSec + q.startSec),
				endSec: r3(c.startSec + q.endSec),
				levelDb: q.levelDb,
				spectrum: windowSpectrum(pcm.mono, pcm.rate, q.startSec, q.endSec) ?? {
					levelDb: q.levelDb,
					bandsDb: [],
				},
				loop: loop ? { ...loop, inSec: r3(c.startSec + loop.inSec), outSec: c.startSec + loop.outSec } : null,
			};
		}
	}
	if (!n) return null;
	return {
		levelDb: r2(10 * Math.log10(e / n)),
		bandsDb: bands.map((b) => r2(10 * Math.log10(b / n))),
		seconds: r3(seconds),
		clipIds: ids,
		gainDb: r2(g / n),
		stretch,
	};
}

/** The plan of a room-tone fill (see the module docs). Registers the chosen library tone for the project. */
export async function planRoomTone(
	deps: BedDeps,
	doc: ProjectDocument,
	seq: Sequence,
	projectId: string,
	req: Omit<SoundRoomToneRequest, 'projectId' | 'mode' | 'label'>,
	ctx: Ctx & { progress?(f: number, stage: string): void; voice?: VoiceActivity } = {},
): Promise<{
	plan: SoundRoomTonePlan;
	setup: ReturnType<typeof setupItems>;
	layBed: Record<string, unknown> | null;
	/** The `soundDesign.layBed` for other spans with the same tone (Sound Check's fix per finding). */
	layBedFor(spans: readonly { start: number; end: number }[]): Record<string, unknown> | null;
}> {
	const warnings: { code: string; message: string }[] = [];
	const fps = rateOf(seq);
	ctx.progress?.(0.05, 'Listening for dialogue');
	const voice =
		ctx.voice ??
		(
			await voiceServiceFor(deps.ffmpeg, deps.registry).forSequence(
				doc,
				seq,
				ctx.signal ? { signal: ctx.signal } : {},
			)
		).voice;
	const regions = dialogueRegions(doc, seq, { voice });
	// the gaps, and the spans the fill covers
	let gaps: { start: number; end: number; clipIds: string[] }[];
	let fills: { start: number; end: number }[];
	if (req.gaps) {
		gaps = req.gaps.map((g) => {
			const r = regions.find((x) => g.start < x.end && g.end > x.start);
			return { start: g.start, end: g.end, clipIds: r ? r.clipIds : [] };
		});
		fills = mergeSpans(gaps.map((g) => roomToneSpan(g, fps)));
	} else if (req.cover === 'regions') {
		gaps = regions
			.filter((r) => !req.range || (r.start < req.range.end && r.end > req.range.start))
			.map((r) => ({ start: r.start, end: r.end, clipIds: r.clipIds }));
		fills = mergeSpans(gaps);
	} else {
		gaps = dialogueGaps(doc, seq, req.range ? { range: req.range } : {}).map((g) => ({
			start: g.start,
			end: g.end,
			clipIds: [g.beforeClipId, g.afterClipId],
		}));
		fills = mergeSpans(gaps.map((g) => roomToneSpan(g, fps)));
	}
	const empty = (why: string) => ({
		plan: {
			sequenceId: seq.id,
			gaps: gaps.map((g, i) => ({
				start: g.start,
				end: g.end,
				timecode: sequenceTimecode(seq, g.start),
				fill: fills[i] ?? { start: g.start, end: g.end },
			})),
			floor: null,
			candidates: [],
			chosen: null,
			commands: [],
			warnings: [...warnings, { code: 'W_NO_ROOM_TONE', message: why }],
		} as SoundRoomTonePlan,
		setup: [],
		layBed: null,
		layBedFor: () => null,
	});
	if (!fills.length)
		return empty(
			'No gap between dialogue clips to fill (gaps of 0.1–10 s inside dialogue; give gaps or cover "regions")',
		);
	const fillOf = (g: { start: number; end: number }) =>
		fills.find((f) => f.start <= g.start && f.end >= g.end) ?? { start: g.start, end: g.end };
	// the dialogue's floor
	ctx.progress?.(0.15, "Measuring the dialogue's noise floor");
	const clipIds = [...new Set(gaps.flatMap((g) => g.clipIds))];
	const floor = await measureFloor(deps, doc, seq, floorClips(doc, seq, clipIds), voice, ctx);
	if (!floor)
		warnings.push({
			code: 'W_FLOOR_UNMEASURED',
			message:
				'The dialogue around the gaps could not be measured (offline, or no dialogue clip): the tone is not matched',
		});
	// candidates
	ctx.progress?.(0.35, 'Comparing room tones');
	const sounds = deps.sounds();
	const src = newSources(doc, projectId);
	type Cand = SoundRoomTonePlan['candidates'][number] & { measure?: BedMeasure; path?: string };
	const cands: Cand[] = [];
	const frameSec = frameSecOf(seq);
	const crossfadeSec = AMBIENCE_BED_DEFAULTS.crossfadeSec;
	const distance = (bandsDb: number[]) =>
		floor && bandsDb.length ? spectralDistanceDb(floor.bandsDb, bandsDb) : null;
	const source = req.source ?? 'auto';
	if (req.soundId || req.mediaId) {
		cands.push({
			source: 'given',
			soundId: req.soundId ?? null,
			mediaId: req.mediaId ?? null,
			title: req.soundId ?? req.mediaId!,
			distanceDb: null,
			levelDb: 0,
		});
	} else if (source !== 'dialogue' && sounds) {
		const ids = new Set<string>(await paletteAmbience(deps, seq, 'roomtone'));
		const palette = new Set(ids);
		const found = await sounds
			.search(SoundSearchQuerySchema.parse({ types: 'roomtone', limit: '24' }))
			.catch(() => null);
		for (const r of found?.results ?? []) if (ids.size < 12) ids.add(r.sound.id);
		for (const id of ids) {
			if (cands.length >= 8) break;
			const e = await sounds.get(id).catch(() => null);
			if (!e || !(e.types as readonly string[]).includes('roomtone')) continue;
			const path = await sounds.fileOf(e).catch(() => null);
			if (!path) continue;
			const m = await measureBed(
				deps.ffmpeg,
				path,
				`lib:${e.fingerprint}`,
				{ durationSec: e.descriptors.durationSec, frameSec, crossfadeSec },
				ctx,
			).catch(() => null);
			if (!m) continue;
			cands.push({
				source: palette.has(id) ? 'palette' : 'library',
				soundId: id,
				mediaId: null,
				title: e.title,
				distanceDb: distance(m.spectrum.bandsDb),
				levelDb: m.spectrum.levelDb,
				measure: m,
				path,
			});
		}
	}
	if (floor?.stretch && !req.soundId && !req.mediaId && source !== 'library') {
		const asset = doc.media[floor.stretch.mediaId] as MediaAsset | undefined;
		cands.push({
			source: 'dialogue',
			soundId: null,
			mediaId: floor.stretch.mediaId,
			title: `${asset?.originalName ?? floor.stretch.mediaId} (${floor.stretch.startSec.toFixed(2)}–${floor.stretch.endSec.toFixed(2)} s, own room tone)`,
			distanceDb: distance(floor.stretch.spectrum.bandsDb),
			levelDb: floor.stretch.levelDb,
		});
	}
	// the choice: given; else the closest palette / library tone within 3 dB; else the dialogue's own; else the closest
	const lib = cands
		.filter((c) => c.source === 'palette' || c.source === 'library')
		.sort((a, b) => (a.distanceDb ?? 99) - (b.distanceDb ?? 99) || (a.source === 'palette' ? -1 : 1));
	const own = cands.find((c) => c.source === 'dialogue') ?? null;
	let pick: Cand | null = cands.find((c) => c.source === 'given') ?? null;
	let why = 'the tone you named';
	if (!pick && source === 'dialogue') {
		pick = own;
		why = "the dialogue's own quietest stretch without speech (asked)";
	}
	if (
		!pick &&
		lib[0] &&
		(source === 'library' || !floor || (lib[0].distanceDb ?? 99) <= ROOM_TONE_MATCH_MAX_DB)
	) {
		pick = lib[0];
		why = floor
			? `the closest of ${lib.length} room tone${lib.length === 1 ? '' : 's'} to the dialogue's noise floor (shape ${lib[0].distanceDb} dB)`
			: 'the first room tone (the floor was not measured)';
	}
	if (!pick && own) {
		pick = own;
		why = lib.length
			? `the dialogue's own quietest stretch: no library room tone is within ${ROOM_TONE_MATCH_MAX_DB} dB of its floor (closest ${lib[0]!.distanceDb} dB)`
			: "the dialogue's own quietest stretch (no room tone in the palette or library)";
	}
	if (!pick && lib[0]) {
		pick = lib[0];
		why = `the closest room tone, ${lib[0].distanceDb} dB from the floor (the dialogue has no stretch without speech)`;
		warnings.push({
			code: 'W_ROOM_TONE_POOR_MATCH',
			message: `"${lib[0].title}" is ${lib[0].distanceDb} dB from the dialogue's floor: listen that it blends in`,
		});
	}
	if (!pick)
		return empty(
			'No room tone: install the BigSoundBank Ambience & Room Tone pack, put a room tone in the palette, or give soundId / mediaId',
		);
	// the chosen tone in the project, measured as laid
	ctx.progress?.(0.7, `Measuring "${pick.title}"`);
	let laid: {
		source: BedSource;
		measure: BedMeasure | null;
		loop: { inSec: number; outSec: number; crossfadeSec: number; fade: 'equal-power' | 'equal-gain' };
		levelDb: number;
	};
	if (pick.source === 'dialogue') {
		const st = floor!.stretch!;
		if (!st.loop) return empty("The dialogue's quiet stretch is too short to loop");
		const s = await projectMediaSource(deps, doc, st.mediaId);
		laid = {
			source: s,
			measure: null,
			loop: {
				inSec: st.loop.inSec,
				outSec: st.loop.outSec,
				crossfadeSec: st.loop.crossfadeSec,
				fade: st.loop.fade,
			},
			levelDb: st.levelDb,
		};
	} else {
		const s = await sourceOf(
			deps,
			src,
			pick.soundId ? { soundId: pick.soundId } : { mediaId: pick.mediaId! },
		);
		const m = await measureBed(
			deps.ffmpeg,
			s.path,
			s.fingerprint,
			{ durationSec: s.durationSec || BED_ANALYSIS_MAX_SEC, frameSec, crossfadeSec },
			ctx,
		);
		laid = {
			source: s,
			measure: m,
			loop: {
				inSec: m.loop.inSec,
				outSec: m.loop.outSec,
				crossfadeSec: m.loop.crossfadeSec,
				fade: m.loop.fade,
			},
			levelDb: m.window.levelDb,
		};
		if (pick.source === 'given') {
			pick.title = s.title;
			pick.distanceDb = distance(m.spectrum.bandsDb);
			pick.levelDb = m.spectrum.levelDb;
		}
	}
	const gainDb =
		req.gainDb ??
		roomToneGainDb(laid.levelDb, floor?.levelDb ?? ROOM_TONE_DEFAULTS.minLevelDbfs, floor?.gainDb ?? 0);
	const layBedFor = (spans: readonly { start: number; end: number }[]) =>
		spans.length
			? {
					type: 'soundDesign.layBed',
					sequenceId: seq.id,
					purpose: 'roomtone',
					shots: mergeSpans(spans).map((f) => ({ start: f.start, end: f.end })),
					mediaId: laid.source.mediaId,
					loop: { inSec: laid.loop.inSec, outSec: laid.loop.outSec },
					crossfadeSec: laid.loop.crossfadeSec,
					fade: laid.loop.fade,
					gainDb,
					replace: true,
				}
			: null;
	const setup = setupItems(src, [laid.source]);
	const layBed = layBedFor(fills);
	const m = laid.measure;
	return {
		plan: {
			sequenceId: seq.id,
			gaps: gaps.map((g) => ({
				start: g.start,
				end: g.end,
				timecode: sequenceTimecode(seq, g.start),
				fill: fillOf(g),
			})),
			floor: floor
				? { levelDb: floor.levelDb, bandsDb: floor.bandsDb, clipIds: floor.clipIds, seconds: floor.seconds }
				: null,
			candidates: cands.map(({ measure: _m, path: _p, ...c }) => c),
			chosen: {
				source: pick.source,
				sound: {
					soundId: laid.source.soundId,
					mediaId: laid.source.mediaId,
					title: pick.source === 'dialogue' ? pick.title : laid.source.title,
					loudnessLufs: m?.loudnessLufs ?? null,
					window: m
						? {
								startSec: m.window.startSec,
								endSec: m.window.endSec,
								levelDb: m.window.levelDb,
								levelStdDb: m.window.levelStdDb,
								onsetsPerMin: m.window.onsetsPerMin,
								spikes: m.window.spikes,
								clean: m.window.clean,
								whole: m.window.whole,
							}
						: {
								startSec: floor!.stretch!.startSec,
								endSec: floor!.stretch!.endSec,
								levelDb: floor!.stretch!.levelDb,
								levelStdDb: 0,
								onsetsPerMin: 0,
								spikes: 0,
								clean: true,
								whole: false,
							},
					loop: {
						inSec: laid.loop.inSec,
						outSec: r3(laid.loop.outSec),
						crossfadeSec: laid.loop.crossfadeSec,
						fade: laid.loop.fade,
						levelDiffDb: m?.loop.levelDiffDb ?? floor?.stretch?.loop?.levelDiffDb ?? 0,
						spectralDistanceDb: m?.loop.spectralDistanceDb ?? floor?.stretch?.loop?.spectralDistanceDb ?? 0,
						correlation: m?.loop.correlation ?? floor?.stretch?.loop?.correlation ?? 0,
						midpointDb: m?.loop.midpointDb ?? floor?.stretch?.loop?.midpointDb ?? 0,
					},
				},
				distanceDb: pick.distanceDb,
				gainDb,
				why,
			},
			commands: [
				...setup.flatMap((s) => s.commands),
				...(layBed ? [layBed] : []),
			] as SoundRoomTonePlan['commands'],
			warnings,
		},
		setup,
		layBed,
		layBedFor,
	};
}

// ── jobs ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type BedJobInput =
	| { beds: SoundBedsRequest; who: Requester }
	| { roomTone: SoundRoomToneRequest; who: Requester };

function whoOf(raw: { who?: { editor?: unknown; agent?: unknown } } | null): Requester {
	return {
		editor: raw?.who?.editor === true,
		agent: typeof raw?.who?.agent === 'string' ? raw.who.agent.slice(0, 64) : 'An agent',
	};
}

/** Applies a transaction as the requester (the editor's is the user's own edit). Returns the new revision. */
async function applyAs(
	agent: AgentService,
	projectId: string,
	seqId: string,
	label: string,
	commands: Record<string, unknown>[],
	who: Requester,
): Promise<number | null> {
	const now = await liveDocument(agent, projectId);
	const out = await agent.transact(
		projectId,
		{
			label,
			origin: { agent: who.agent },
			sequenceId: seqId,
			...(now.revision !== null ? { expectedRevision: now.revision } : {}),
			commands,
		},
		{ fallbackAgent: who.agent, ...(who.editor ? { preApproved: true, asUser: true } : {}) },
	);
	const r = out.result as {
		ok: boolean;
		revision?: number;
		errors?: { code: string; message: string; retryable?: boolean }[];
	};
	if (!r.ok) {
		const e = r.errors?.[0];
		const stale = e?.code === 'E_REVISION_MISMATCH' || e?.code === 'E_CONFLICT';
		throw new JobError(
			stale ? 'CONFLICT' : (e?.code ?? 'TRANSACTION_REJECTED'),
			stale
				? `The edit changed before it could be applied (${e!.message}); run it again`
				: (e?.message ?? 'The transaction was refused'),
			stale || e?.retryable === true,
			{ errors: r.errors?.slice(0, 5) ?? [] },
		);
	}
	return r.revision ?? null;
}

const asJob = (e: unknown): unknown => {
	if (e instanceof JobError) return e;
	if (e instanceof BedInputError) return new JobError(e.code, e.message, e.status === 503);
	if (e instanceof PlanInputError) return new JobError(e.code, e.message, false);
	if (e instanceof HttpError)
		return new JobError(e.code, e.message, e.status === 503 || e.code === 'PROPOSAL_LIMIT', e.detail);
	return e;
};

/** The `sound-design` job runner for beds and room tone. */
export async function runBedJob(
	ctx: JobContext,
	deps: BedDeps,
): Promise<SoundBedsResult | SoundRoomToneResult> {
	try {
		const raw = ctx.input as {
			beds?: unknown;
			roomTone?: unknown;
			who?: { editor?: unknown; agent?: unknown };
		} | null;
		const who = whoOf(raw);
		const agent = deps.agent();
		if (!agent) throw new JobError('NOT_AVAILABLE', 'The agent service is not running', true);
		const progress = (f: number, stage: string) => ctx.progress(f, { stage });
		const run = { signal: ctx.signal, onSpawn: ctx.trackChild, progress };
		if (raw?.beds !== undefined) {
			const parsed = SoundBedsRequestSchema.safeParse(raw.beds);
			if (!parsed.success) throw new JobError('VALIDATION_FAILED', 'The beds request is invalid', false);
			const req = parsed.data;
			progress(0.02, 'Reading the edit');
			const live = await liveDocument(agent, req.projectId);
			const seq = planSequence(live.doc, req.sequenceId);
			const r = await planBeds(deps, live.doc, seq, req.projectId, req, run);
			return (await finish(
				ctx,
				deps,
				agent,
				who,
				req,
				live,
				seq,
				r.setup,
				r.layBed!,
				'bed',
				r.plan,
			)) as SoundBedsResult;
		}
		const parsed = SoundRoomToneRequestSchema.safeParse(raw?.roomTone);
		if (!parsed.success) throw new JobError('VALIDATION_FAILED', 'The room-tone request is invalid', false);
		const req = parsed.data;
		progress(0.02, 'Reading the edit');
		const live = await liveDocument(agent, req.projectId);
		const seq = planSequence(live.doc, req.sequenceId);
		const r = await planRoomTone(deps, live.doc, seq, req.projectId, req, run);
		return (await finish(
			ctx,
			deps,
			agent,
			who,
			req,
			live,
			seq,
			r.setup,
			r.layBed,
			'room-tone',
			r.plan,
		)) as SoundRoomToneResult;
	} catch (e) {
		throw asJob(e);
	}
}

async function finish(
	ctx: JobContext,
	deps: BedDeps,
	agent: AgentService,
	who: Requester,
	req: { projectId: string; mode?: 'propose' | 'apply'; label?: string },
	live: { doc: ProjectDocument; revision: number | null },
	seq: Sequence,
	setup: ReturnType<typeof setupItems>,
	layBed: Record<string, unknown> | null,
	kind: 'bed' | 'room-tone',
	plan: SoundBedsPlan | SoundRoomTonePlan,
): Promise<SoundBedsResult | SoundRoomToneResult> {
	const mode = req.mode ?? 'propose';
	const base = { projectId: req.projectId, sequenceId: seq.id, mode } as const;
	const label = (req.label ?? (kind === 'bed' ? BEDS_LABEL : ROOM_TONE_LABEL)).slice(0, 200);
	if (ctx.signal.aborted) throw new JobError('CANCELLED', 'Cancelled', false);
	if (!layBed) {
		ctx.progress(1, { stage: 'Nothing to lay' });
		return { ...base, applied: false, revision: live.revision, proposalId: null, plan } as never;
	}
	if (mode === 'apply') {
		ctx.progress(0.92, { stage: 'Applying' });
		const revision = await applyAs(
			agent,
			req.projectId,
			seq.id,
			label,
			[...setup.flatMap((s) => s.commands), layBed],
			who,
		);
		ctx.progress(1, { stage: 'Applied' });
		return { ...base, applied: true, revision, proposalId: null, plan } as never;
	}
	const proposals = deps.proposals();
	if (!proposals) throw new JobError('NOT_AVAILABLE', 'The proposal service is not running', true);
	const name = Object.values(live.doc.items ?? {}).find(
		(it) => it?.kind === 'sequence' && (it as { sequenceId?: unknown }).sequenceId === seq.id,
	)?.name;
	const scenes = 'scenes' in plan ? plan.scenes : [];
	const tone = 'chosen' in plan ? plan.chosen : null;
	const itemLabel =
		kind === 'bed'
			? `Ambience bed: ${scenes.length} scene${scenes.length === 1 ? '' : 's'} · ${[...new Set(scenes.map((s) => s.sound.title))].join(', ')}`
			: `Room tone: ${(plan as SoundRoomTonePlan).gaps.length} gap${(plan as SoundRoomTonePlan).gaps.length === 1 ? '' : 's'} · ${tone?.sound.title ?? ''}`;
	const draft: ProposalDraft = {
		sequenceId: seq.id,
		feature: SOUND_DESIGN_FEATURE,
		title: (
			req.label ??
			`${kind === 'bed' ? BEDS_LABEL : ROOM_TONE_LABEL}: ${typeof name === 'string' && name ? name : seq.id}`
		).slice(0, 200),
		summary:
			kind === 'bed'
				? `An ambience bed per scene (${scenes.length}), looped at its measured loop points, crossfaded between scenes`
				: `Room tone in ${(plan as SoundRoomTonePlan).gaps.length} dialogue gap(s): ${tone?.why ?? ''}`.slice(
						0,
						1000,
					),
		items: [
			...setup.map((s) => ({
				id: s.id,
				label: s.label,
				group: SOUND_PROPOSAL_SETUP_GROUP,
				commands: s.commands,
				...(s.requires ? { requires: s.requires } : {}),
				meta: { setup: true },
			})),
			{
				id: kind,
				label: itemLabel.slice(0, 200),
				group: 'ambient',
				commands: [layBed],
				...(setup.length ? { requires: setup.map((s) => s.id) } : {}),
				meta: {
					feature: SOUND_DESIGN_FEATURE,
					kind,
					...(kind === 'bed'
						? {
								scenes: scenes.map((s) => ({
									start: s.start,
									end: s.end,
									title: s.sound.title,
									loop: s.sound.loop,
								})),
							}
						: {
								gaps: (plan as SoundRoomTonePlan).gaps,
								tone: tone
									? {
											title: tone.sound.title,
											distanceDb: tone.distanceDb,
											gainDb: tone.gainDb,
											why: tone.why,
										}
									: null,
							}),
				},
			},
		],
		report: plan as unknown as Record<string, unknown>,
	} as ProposalDraft;
	ctx.progress(0.92, { stage: 'Checking the proposal' });
	const created = await proposals.create(req.projectId, draft as unknown as Record<string, unknown>, who);
	if (ctx.signal.aborted) {
		await proposals.delete(req.projectId, created.proposal.id).catch(() => undefined);
		throw new JobError('CANCELLED', 'Cancelled', false);
	}
	ctx.progress(1, { stage: 'Proposal ready for review' });
	return {
		...base,
		applied: false,
		revision: created.revision,
		proposalId: created.proposal.id,
		plan,
	} as never;
}

/** Validates a request's sequence and refuses an early mistake before a job starts (the routes' check). */
export function bedRequestSequence(doc: ProjectDocument, sequenceId: string | undefined): Sequence {
	return planSequence(doc, sequenceId);
}
