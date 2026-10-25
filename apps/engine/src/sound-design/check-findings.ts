// Sound Check, Phase 6 findings (spec 12 §4 P6-E1…E3, P6-E13; wp-note "Phase 6 → WP-E1"): what `check.ts` adds to its
// report from the same one-pass render, kept here so the main check stays readable.
//
//   CLICK            bursts (`ClickDetector`, adapted from earshot) in the mix and every stem, attributed to the audio
//                    clip edge, remix joint or transition edge within 2 ms (error, a 1-frame fade fixes it) or to a clip
//                    body (info: a transient in the recording).
//   EDGE             each audio clip edge that is not library padding, measured on its source: an abrupt entry, a
//                    chopped decay, chopped music at a joint (warning; the fade / crossfade that resolves it, else a
//                    trim to the decay).
//   HARSH            a placed sound's 2–6 kHz 5 ms peak more than 6 dB over the music's (else the dialogue's) loudest
//                    (warning; −excess dB, safe when MASKED still holds); a bright sound (centroid > 6.5 kHz) is info.
//   LAYER_INAUDIBLE  a layer of a multi-layer cue adding < 1 dB in every 1/3-octave band over the bed and the cue's other
//                    layers, over its loudest 60 ms (info).
//   COVERAGE         a class of action (kind + anchor source, grouped by clip / track) sounded in part (warning).
//   ENDING / HEAD    the delivered mix ends mid-sound (warning) / starts with a click (info): fades on the Mix lane.
//   ARC              the loudest 3 s of the mix holds no hero, or lies in the last 15 % without one (info).
// Everything is measured on the delivered scale (the normalisation gain added). Never throws for document data; a
// decode or render that fails leaves that edge or layer unjudged (counted in the report's warnings).
import type { ChildProcess } from 'node:child_process';
import type { SoundCheckFix, SoundCheckIssue } from '@jasper/api';
import {
	type ClickBurst,
	ClickDetector,
	decayAfterMs,
	evaluateSfxGains,
	harshExcess,
	isAbruptEntry,
	isChoppedDecay,
	isChoppedMusic,
	layerAudibility,
	loudestWindowStart,
	measureEntry,
	measureExit,
	measureSplice,
	PRESENCE_FLOOR_DB,
	PresenceMeter,
	presencePeakDb,
	type SolverEvent,
	thirdOctaveEnergies,
} from '@jasper/audio-fx';
import {
	type AudioClip,
	type Clip,
	type ClipSfx,
	CONSTANT_POWER,
	evaluate,
	FADER_MIN_DB,
	FLICKS_PER_SECOND,
	frameToSample,
	laneValueAt,
	MASKED_MIN_LIFT_DB,
	type MediaAsset,
	mediaDurationFlicks,
	type ProjectDocument,
	type Rational,
	type Registries,
	readEssentialSound,
	readLibraryProvenance,
	type Sequence,
	SOUND_CHECK_EDGE_THRESHOLDS,
	type SoundCheckCode,
	type SoundCheckMessage,
	type SoundCue,
	soundCheckMessage,
	stripView,
	type Transition,
	transitionSpan,
} from '@jasper/project';
import { JobError } from '../jobs/types.ts';
import { LOCAL_PROTOCOLS, readPlanar } from '../sounds/decode.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { sec } from '../tools/ffmpeg.ts';
import type { AudioWorld, MeasureDeps } from './bed.ts';
import { renderSequencePcm } from './bed.ts';
import type { SfxInfo } from './levels.ts';
import type { StemName } from './stems.ts';

const T = SOUND_CHECK_EDGE_THRESHOLDS;
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
/** A dB value for a message: one decimal, true minus sign. */
const fmt = (x: number) => {
	const v = Math.round(x * 10) / 10;
	return `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`;
};

export type FindingIssue = Omit<SoundCheckIssue, 'category' | 'id'> & { subject: string };

/** What the Phase 6 checks need from the check (`check.ts` builds it once). */
export type FindCtx = {
	doc: ProjectDocument;
	seq: Sequence;
	projectId: string;
	sr: number;
	rate: Rational;
	fps: number;
	/** Flicks per frame. */
	F: number;
	range: { start: number; end: number };
	whole: boolean;
	/** Sequence length (frames). */
	duration: number;
	/** First rendered sample (absolute, Mix rate), hop size, pre-roll hops, hops in the range. */
	renderStart: number;
	rangeStart: number;
	rangeEnd: number;
	hop: number;
	preHops: number;
	rangeHops: number;
	/** Loudness normalisation gain the export applies (dB), 0 without. */
	gainDb: number;
	world: AudioWorld;
	playing: ReadonlySet<string>;
	stemIds: Record<StemName, Set<string>>;
	ff: Ffmpeg;
	registry: MeasureDeps['registry'];
	registries: Registries;
	signal?: AbortSignal | undefined;
	onSpawn?: ((child: ChildProcess) => void) | undefined;
	tc(frame: number): string;
	add(i: FindingIssue): void;
	warn(code: string, message: string): void;
	dryRun(
		commands: Record<string, unknown>[],
	): { ok: true; doc: ProjectDocument } | { ok: false; message: string };
	commandFix(
		label: SoundCheckMessage,
		commands: Record<string, unknown>[],
		safe: boolean,
		why?: SoundCheckMessage,
	): SoundCheckFix;
};

/** The part of a check's sound effect row the findings read (`check.ts` `SfxRow`). */
export type FindRow = {
	clip: AudioClip & { sfx?: unknown };
	sfx: ClipSfx | null;
	info: SfxInfo;
	cue: SoundCue | null;
	frame: number;
	alignedFrame: number | null;
	codes: Set<SoundCheckCode>;
	/**
	 * The solver's measured events, their gains, this sound's index among them and the options (set by the MASKED pass
	 * when it was measured): the lift after a gain change is the solver's, the lower sound effects under it included.
	 */
	solver?: {
		events: SolverEvent[];
		gains: readonly number[];
		index: number;
		lo: { programLufs: number; truePeakCeilingDb: number };
	} | null;
};

// ── probes fed by the one-pass render ───────────────────────────────────────────────────────────────────────────────

/** Stems the click detector scans. */
export const CLICK_STEMS: readonly StemName[] = ['mix', 'sfx', 'bed'];

/** The streaming detectors of one check: clicks per stem, presence of the sound-effect, music and dialogue stems. */
export class CheckProbes {
	readonly clicks = new Map<StemName, ClickDetector>();
	readonly presence = new Map<'sfx' | 'music' | 'dialogue', PresenceMeter>();
	constructor(sampleRate: number, channels: number, stemIds: Record<StemName, Set<string>>) {
		// the mix, the sound effects and the bed: dialogue, music and ambience are parts of the bed (a click in one of them
		// is in the bed too, attributed to the same clip edges), so they are not scanned again (decision: −3 of 6 scans)
		for (const s of CLICK_STEMS)
			if (stemIds[s].size > 0) this.clicks.set(s, new ClickDetector(sampleRate, channels));
		for (const s of ['sfx', 'music', 'dialogue'] as const)
			if (stemIds[s].size > 0) this.presence.set(s, new PresenceMeter(sampleRate, channels));
	}
	/** A rendered block of a stem (blocks arrive in order from the first rendered sample). */
	push(stem: StemName, planar: readonly Float32Array[], n: number): void {
		this.clicks.get(stem)?.push(planar, n);
		if (stem === 'sfx' || stem === 'music' || stem === 'dialogue') this.presence.get(stem)?.push(planar, n);
	}
	finish(): {
		bursts: { stem: StemName; burst: ClickBurst }[];
		presence: Partial<Record<'sfx' | 'music' | 'dialogue', Float32Array>>;
	} {
		const bursts: { stem: StemName; burst: ClickBurst }[] = [];
		for (const [stem, d] of this.clicks) for (const burst of d.finish()) bursts.push({ stem, burst });
		const presence: Partial<Record<'sfx' | 'music' | 'dialogue', Float32Array>> = {};
		for (const [s, m] of this.presence) presence[s] = m.finish();
		return { bursts, presence };
	}
}

/** The first 5 ms and last 50 ms of the delivered mix (HEAD, ENDING). */
/** 10 ms blocks the ending tap keeps (0.6 s: the window `endFadeLookSec` before the end and after). */
const ENDING_FADE_BLOCKS = 60;

export class EdgeTap {
	private readonly headN: number;
	private readonly tailN: number;
	private readonly head: Float32Array[];
	private readonly tail: Float32Array[];
	private headLen = 0;
	private tailPos = 0;
	private tailLen = 0;
	/** Mean square of each 10 ms block of the last ENDING_FADE_BLOCKS blocks (a ring; `blockN` samples each). */
	private readonly blocks = new Float64Array(ENDING_FADE_BLOCKS);
	private readonly blockN: number;
	private blockPos = 0;
	private blockCount = 0;
	private blockSum = 0;
	private blockFill = 0;
	readonly sampleRate: number;
	constructor(sampleRate: number, channels: number) {
		this.sampleRate = sampleRate;
		this.headN = Math.max(1, Math.round(0.005 * sampleRate));
		this.tailN = Math.max(1, Math.round(0.05 * sampleRate));
		this.blockN = Math.max(1, Math.round(0.01 * sampleRate));
		this.head = Array.from({ length: channels }, () => new Float32Array(this.headN));
		this.tail = Array.from({ length: channels }, () => new Float32Array(this.tailN));
	}
	push(planar: readonly Float32Array[], n: number): void {
		const chans = Math.max(1, this.tail.length);
		for (let i = 0; i < n; i++) {
			const h = this.headLen < this.headN;
			let e = 0;
			for (let c = 0; c < this.tail.length; c++) {
				const raw = planar[c]?.[i] ?? 0;
				const v = Number.isFinite(raw) ? raw : 0;
				if (h) this.head[c]![this.headLen] = v;
				this.tail[c]![this.tailPos] = v;
				e += v * v;
			}
			if (h) this.headLen++;
			this.tailPos = (this.tailPos + 1) % this.tailN;
			if (this.tailLen < this.tailN) this.tailLen++;
			this.blockSum += e / chans;
			if (++this.blockFill === this.blockN) {
				this.blocks[this.blockPos] = this.blockSum / this.blockN;
				this.blockPos = (this.blockPos + 1) % ENDING_FADE_BLOCKS;
				if (this.blockCount < ENDING_FADE_BLOCKS) this.blockCount++;
				this.blockSum = 0;
				this.blockFill = 0;
			}
		}
	}
	/**
	 * Levels (dBFS): first 5 ms peak, last 50 ms RMS (all channels), last 10 ms peak; `fadeFromDb` the RMS of the 50 ms
	 * that began `T.endFadeLookSec` before the end (null when the mix is shorter); null without audio.
	 */
	result(): { headPeakDb: number; tailRmsDb: number; tailPeakDb: number; fadeFromDb: number | null } | null {
		if (this.headLen === 0 || this.tailLen === 0) return null;
		const dbOf = (v: number, power = false) =>
			v > 0 ? Math.max(-120, (power ? 10 : 20) * Math.log10(v)) : -120;
		let hp = 0;
		for (const ch of this.head) for (let i = 0; i < this.headLen; i++) hp = Math.max(hp, Math.abs(ch[i]!));
		// the tail in time order (oldest first)
		const ordered = (ch: Float32Array) => {
			const out = new Float32Array(this.tailLen);
			const start = (this.tailPos - this.tailLen + this.tailN) % this.tailN;
			for (let i = 0; i < this.tailLen; i++) out[i] = ch[(start + i) % this.tailN]!;
			return out;
		};
		let e = 0;
		let tp = 0;
		const last10 = Math.max(1, Math.round(0.01 * this.sampleRate));
		for (const ch of this.tail) {
			const o = ordered(ch);
			for (let i = 0; i < o.length; i++) {
				e += o[i]! * o[i]!;
				if (i >= o.length - last10) tp = Math.max(tp, Math.abs(o[i]!));
			}
		}
		// the 5 complete 10 ms blocks that began `endFadeLookSec` before the end (blocks are oldest first in the ring)
		const back = Math.round(T.endFadeLookSec / 0.01);
		let fadeFromDb: number | null = null;
		if (this.blockCount >= back) {
			let m = 0;
			for (let k = 0; k < 5; k++) {
				const age = back - k; // 1 = the newest complete block
				m += this.blocks[(this.blockPos - age + ENDING_FADE_BLOCKS * 2) % ENDING_FADE_BLOCKS]!;
			}
			fadeFromDb = r1(dbOf(m / 5, true));
		}
		return {
			headPeakDb: r1(dbOf(hp)),
			tailRmsDb: r1(dbOf(e / (this.tailLen * this.tail.length), true)),
			tailPeakDb: r1(dbOf(tp)),
			fadeFromDb,
		};
	}
}

// ── document helpers ────────────────────────────────────────────────────────────────────────────────────────────────

const clipEnd = (c: { start: number; duration: number }) => c.start + c.duration;

/** A clip's name for messages: its library title, its name, its media's file name, its id. */
export function clipTitle(doc: ProjectDocument, clip: Clip): string {
	const m = (doc.media?.[(clip as { mediaId?: string }).mediaId ?? ''] ?? undefined) as
		| { library?: unknown; originalName?: string }
		| undefined;
	const p = readLibraryProvenance(m?.library);
	return (p?.title || clip.name || m?.originalName || clip.id).slice(0, 200);
}

const audioClipsOf = (seq: Sequence) =>
	Object.values(seq.clips).filter((c): c is AudioClip => c.kind === 'audio') as AudioClip[];

/** The transition at a clip edge (a fade or a crossfade), if any. */
function transitionAt(seq: Sequence, clipId: string, edge: 'start' | 'end'): Transition | null {
	for (const t of Object.values(seq.transitions ?? {}))
		if (edge === 'start' ? t.incomingClipId === clipId : t.outgoingClipId === clipId) return t;
	return null;
}

/** The clip on the same track touching an edge (the other side of a cut), if any. */
function neighbourAt(seq: Sequence, clip: AudioClip, edge: 'start' | 'end'): AudioClip | null {
	for (const c of audioClipsOf(seq)) {
		if (c.id === clip.id || c.trackId !== clip.trackId || c.enabled === false) continue;
		if (edge === 'start' ? clipEnd(c) === clip.start : c.start === clipEnd(clip)) return c;
	}
	return null;
}

/**
 * The volume fade at a clip edge (ms on the timeline): a transition there (its whole span ramps the clip), else a
 * Volume keyframe ramp — the clip's volume at the edge at least 12 dB under the loudest key within 200 ms of it, the
 * fade lasting until a key within 1 dB of that. 0 without a fade.
 */
export function edgeFadeMs(
	seq: Sequence,
	clip: AudioClip,
	edge: 'start' | 'end',
	fps: number,
	F: number,
): number {
	const t = transitionAt(seq, clip.id, edge);
	let ms = t ? (t.duration / fps) * 1000 : 0;
	try {
		const anim = clip.volumeDb as { value: number; keyframes: { time: number; value: number }[] };
		const keys = (anim?.keyframes ?? []).filter((k) => fin(k?.time) && fin(k?.value));
		if (keys.length) {
			const rate = clip.speed?.rate || 1;
			const reverse = !!clip.speed?.reverse;
			// content time at the edge, and the direction into the clip
			const atStart = (edge === 'start') !== reverse;
			const t0 = atStart ? clip.sourceIn : clip.sourceIn + clip.duration * F * rate;
			const span = 0.2 * FLICKS_PER_SECOND * rate;
			const near = keys
				.filter((k) => (atStart ? k.time >= t0 && k.time <= t0 + span : k.time <= t0 && k.time >= t0 - span))
				.sort((a, b) => (atStart ? a.time - b.time : b.time - a.time));
			if (near.length) {
				const v0 = evaluate(anim as never, t0) as unknown as number;
				const top = Math.max(...near.map((k) => k.value));
				if (fin(v0) && v0 <= top - 12) {
					const reach = near.find((k) => k.value >= top - 1);
					if (reach) ms = Math.max(ms, ((Math.abs(reach.time - t0) / rate) * 1000) / FLICKS_PER_SECOND);
				}
			}
		}
	} catch {
		// a damaged lane: no keyframe fade
	}
	return ms;
}

/** Frames a fade needs to last at least `ms` (≥ 1). */
const framesFor = (ms: number, fps: number) => Math.max(1, Math.ceil((ms / 1000) * fps - 1e-9));

/** The duration of the transition at a clip edge after commands, or null. */
function transitionAfter(
	doc: ProjectDocument,
	seqId: string,
	clipId: string,
	edge: 'start' | 'end',
): number | null {
	const seq = doc.sequences[seqId];
	if (!seq) return null;
	return transitionAt(seq as Sequence, clipId, edge)?.duration ?? null;
}

/**
 * The fade fix of a clip edge lasting at least `frames`: lengthen the transition there, else add a one-sided
 * constant-power fade (`transition.add {clipId, edge}`: an audio clip edge is a fade of that clip). Null when neither
 * applies (a locked track, a clip shorter than the fade).
 */
function fadeFix(
	ctx: FindCtx,
	clip: AudioClip,
	edge: 'start' | 'end',
	frames: number,
): { label: SoundCheckMessage; commands: Record<string, unknown>[] } | null {
	const t = transitionAt(ctx.seq, clip.id, edge);
	const tries: { label: SoundCheckMessage; commands: Record<string, unknown>[] }[] = [];
	if (t && t.duration < frames)
		tries.push({
			label: soundCheckMessage('fixLengthenTransition', frames),
			commands: [{ type: 'transition.update', transitionId: t.id, duration: frames }],
		});
	if (!t)
		tries.push({
			label: soundCheckMessage(edge === 'start' ? 'fixFadeIn' : 'fixFadeOut', frames),
			commands: [
				{
					type: 'transition.add',
					clipId: clip.id,
					edge: edge === 'start' ? 'in' : 'out',
					effectId: CONSTANT_POWER,
					duration: frames,
				},
			],
		});
	for (const x of tries) {
		const run = ctx.dryRun(x.commands);
		if (!run.ok) continue;
		const d = transitionAfter(run.doc, ctx.seq.id, clip.id, edge);
		if (d !== null && d >= frames) return x;
	}
	return null;
}

/**
 * The fix of a click at an edge: a fade there lasting at least one frame, longer than what is there. At a cut between
 * two clips without a transition, a 1-frame constant-power crossfade when the media allow it, else a 1-frame fade of
 * each side.
 */
function clickFix(
	ctx: FindCtx,
	clip: AudioClip,
	edge: 'start' | 'end',
): { label: SoundCheckMessage; commands: Record<string, unknown>[] } | null {
	const t = transitionAt(ctx.seq, clip.id, edge);
	if (t) {
		const d = Math.max(2, t.duration * 2);
		const commands = [{ type: 'transition.update', transitionId: t.id, duration: d }];
		const run = ctx.dryRun(commands);
		if (run.ok && (transitionAfter(run.doc, ctx.seq.id, clip.id, edge) ?? 0) > t.duration)
			return { label: soundCheckMessage('fixLengthenTransition', d), commands };
		return null;
	}
	const other = neighbourAt(ctx.seq, clip, edge);
	if (other) {
		const at = edge === 'start' ? clip.start : clipEnd(clip);
		const xf = [
			{
				type: 'transition.add',
				sequenceId: ctx.seq.id,
				trackId: clip.trackId,
				at,
				effectId: CONSTANT_POWER,
				duration: 1,
				alignment: 'center',
			},
		];
		if (ctx.dryRun(xf).ok) return { label: soundCheckMessage('fixCrossfade', 1), commands: xf };
		const both = [
			{
				type: 'transition.add',
				clipId: clip.id,
				edge: edge === 'start' ? 'in' : 'out',
				effectId: CONSTANT_POWER,
				duration: 1,
			},
			{
				type: 'transition.add',
				clipId: other.id,
				edge: edge === 'start' ? 'out' : 'in',
				effectId: CONSTANT_POWER,
				duration: 1,
			},
		];
		if (ctx.dryRun(both).ok)
			return { label: soundCheckMessage(edge === 'start' ? 'fixFadeIn' : 'fixFadeOut', 1), commands: both };
	}
	return fadeFix(ctx, clip, edge, 1);
}

// ── CLICK and EDGE ──────────────────────────────────────────────────────────────────────────────────────────────────

type EdgeRef = {
	clip: AudioClip;
	edge: 'start' | 'end';
	frame: number;
	/** Absolute sample of the edge (Mix rate). */
	sample: number;
	kind: 'clip' | 'joint';
	neighbour: AudioClip | null;
};

/** The audio clip edges of the range the checks judge: not at the sequence's own start or end (those are HEAD / ENDING). */
function edgesOf(ctx: FindCtx): EdgeRef[] {
	const out: EdgeRef[] = [];
	for (const c of audioClipsOf(ctx.seq)) {
		if (!ctx.playing.has(c.id)) continue;
		for (const edge of ['start', 'end'] as const) {
			const frame = edge === 'start' ? c.start : clipEnd(c);
			if (frame <= 0 || frame >= ctx.duration || frame < ctx.range.start || frame >= ctx.range.end) continue;
			const neighbour = neighbourAt(ctx.seq, c, edge);
			const joint =
				!!c.remix &&
				!!neighbour?.remix &&
				(neighbour.remix as { id?: string }).id === (c.remix as { id?: string }).id;
			out.push({
				clip: c,
				edge,
				frame,
				sample: frameToSample(frame, ctx.rate, ctx.sr),
				kind: joint ? 'joint' : 'clip',
				neighbour,
			});
		}
	}
	return out.sort((a, b) => a.sample - b.sample || (a.clip.id < b.clip.id ? -1 : 1));
}

/** Two-sided transition span edges (where a crossfade's handles begin and end), with their clips. */
function transitionEdges(ctx: FindCtx): { sample: number; frame: number; clip: AudioClip; t: Transition }[] {
	const out: { sample: number; frame: number; clip: AudioClip; t: Transition }[] = [];
	for (const t of Object.values(ctx.seq.transitions ?? {})) {
		const inc = t.incomingClipId ? (ctx.seq.clips[t.incomingClipId] as AudioClip | undefined) : undefined;
		const outC = t.outgoingClipId ? (ctx.seq.clips[t.outgoingClipId] as AudioClip | undefined) : undefined;
		if (inc?.kind !== 'audio' || outC?.kind !== 'audio') continue;
		const span = transitionSpan(inc.start, t.duration, t.alignment, t.cutPosition);
		for (const f of [span.start, span.end])
			if (f > 0 && f < ctx.duration && f !== inc.start)
				out.push({
					sample: frameToSample(f, ctx.rate, ctx.sr),
					frame: f,
					clip: f < inc.start ? inc : outC,
					t,
				});
	}
	return out;
}

/** Decodes a mono span of a clip's media at the timeline's rate (null when it cannot). */
async function decodeSpan(
	ctx: FindCtx,
	clip: AudioClip,
	fileStart: number,
	fileDur: number,
): Promise<Float32Array | null> {
	const src = ctx.world.media(clip.mediaId);
	const rc = ctx.world.snapshot.audioClips.find((x) => x.clipId === clip.id);
	const stream = src?.streams.find((s) => s.index === rc?.channels.streamIndex) ?? src?.streams[0];
	if (!src || !stream || !(fileDur > 0)) return null;
	const rate = clip.speed?.rate || 1;
	const decodeRate = Math.max(1000, Math.round(ctx.sr / rate));
	const signal = ctx.signal ?? new AbortController().signal;
	let child: ChildProcess;
	try {
		child = ctx.ff.spawnRaw(
			[
				...LOCAL_PROTOCOLS,
				'-ss',
				sec(Math.max(0, fileStart)),
				'-t',
				sec(fileDur),
				'-i',
				src.path,
				'-map',
				`0:${stream.index}`,
				'-vn',
				'-af',
				`aresample=${decodeRate}`,
				'-ac',
				'1',
				'-f',
				'f32le',
				'pipe:1',
			],
			{ signal },
		);
	} catch {
		return null;
	}
	ctx.onSpawn?.(child);
	try {
		const [mono] = await readPlanar(child, 1, Math.ceil(fileDur * decodeRate) + ctx.sr, signal);
		return mono ?? null;
	} catch {
		if (signal.aborted) throw new JobError('CANCELLED', 'Cancelled', false);
		return null;
	}
}

async function pool<T>(items: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) await fn(items[next++]!);
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
}

/** Whether a clip is music for the splice rule: a remix piece or an Essential Sound music clip. */
const isMusic = (c: AudioClip) => !!c.remix || readEssentialSound(c.essential)?.type === 'music';

/**
 * CLICK and EDGE (P6-E1). `bursts` are the click detector's per stem (sample = index from the first rendered sample).
 */
export async function edgeFindings(
	ctx: FindCtx,
	bursts: { stem: StemName; burst: ClickBurst }[],
): Promise<void> {
	const edges = edgesOf(ctx);
	const trEdges = transitionEdges(ctx);
	const near = Math.round((T.clickEdgeMs / 1000) * ctx.sr);
	const seqEnd = frameToSample(ctx.duration, ctx.rate, ctx.sr);
	const inStem = (stem: StemName, clipId: string) => stem === 'mix' || ctx.stemIds[stem].has(clipId);

	// ── CLICK: clusters of bursts within 1 ms across stems, each attributed once ──
	const clicks = bursts
		.filter((b) => b.burst.kind === 'click' && b.burst.levelDb + ctx.gainDb >= T.clickMinDbfs)
		.map((b) => ({ ...b, abs: ctx.renderStart + b.burst.sample }))
		.filter((b) => b.abs >= ctx.rangeStart && b.abs < ctx.rangeEnd)
		// the sequence's own first and last samples are HEAD / ENDING (P6-E3), not an edit
		.filter((b) => b.abs >= near && b.abs <= seqEnd - near)
		.sort((a, b) => a.abs - b.abs);
	const merge = Math.max(1, Math.round(0.001 * ctx.sr));
	const clusters: (typeof clicks)[] = [];
	for (const b of clicks) {
		const last = clusters.at(-1);
		if (last && b.abs - last.at(-1)!.abs <= merge) last.push(b);
		else clusters.push([b]);
	}
	const reported = new Set<string>();
	let errors = 0;
	let infos = 0;
	for (const cl of clusters) {
		// attribution: an edge of a clip in the stem it was heard in (non-mix stems first), else a transition edge, else
		// the body of a clip
		const ordered = [...cl].sort((a, b) => Number(a.stem === 'mix') - Number(b.stem === 'mix'));
		let hit: { e: EdgeRef; b: (typeof cl)[number] } | null = null;
		for (const b of ordered) {
			let best: EdgeRef | null = null;
			for (const e of edges) {
				if (Math.abs(e.sample - b.abs) > near || !inStem(b.stem, e.clip.id)) continue;
				if (!best || Math.abs(e.sample - b.abs) < Math.abs(best.sample - b.abs)) best = e;
			}
			if (best) {
				hit = { e: best, b };
				break;
			}
		}
		const loudest = cl.reduce((m, x) => (x.burst.levelDb > m.burst.levelDb ? x : m), cl[0]!);
		const seconds = loudest.abs / ctx.sr;
		const measured = (
			b: (typeof cl)[number],
			extra: Record<string, number | string | boolean | null> = {},
		) => ({
			atSec: r4(b.abs / ctx.sr),
			stem: b.stem,
			stems: [...new Set(cl.map((x) => x.stem))].join(','),
			levelDb: r1(b.burst.levelDb + ctx.gainDb),
			overDb: b.burst.overDb,
			concentration: b.burst.concentration,
			...extra,
		});
		if (hit) {
			const { e, b } = hit;
			const subject = `${e.clip.id}:${e.edge}`;
			if (reported.has(subject) || errors >= 200) continue;
			reported.add(subject);
			errors++;
			const key = e.kind === 'joint' ? 'clickJoint' : e.edge === 'start' ? 'clickStart' : 'clickEnd';
			const fix = clickFix(ctx, e.clip, e.edge);
			ctx.add({
				subject,
				code: 'CLICK',
				severity: 'error',
				frame: e.frame,
				timecode: ctx.tc(e.frame),
				clipIds: [e.clip.id, ...(e.neighbour ? [e.neighbour.id] : [])],
				message: soundCheckMessage(key, clipTitle(ctx.doc, e.clip), ctx.tc(e.frame), fmt(b.burst.overDb)),
				measured: measured(b, { edge: e.edge, edgeOffsetMs: r2(((b.abs - e.sample) / ctx.sr) * 1000) }),
				...(fix ? { fix: ctx.commandFix(fix.label, fix.commands, true) } : {}),
			});
			continue;
		}
		const tr = trEdges.find((x) => Math.abs(x.sample - loudest.abs) <= near);
		if (tr) {
			const subject = `${tr.t.id}:${tr.frame}`;
			if (reported.has(subject) || errors >= 200) continue;
			reported.add(subject);
			errors++;
			const d = Math.max(2, tr.t.duration * 2);
			const commands = [{ type: 'transition.update', transitionId: tr.t.id, duration: d }];
			const run = ctx.dryRun(commands);
			const longer =
				run.ok &&
				((run.doc.sequences[ctx.seq.id]?.transitions?.[tr.t.id] as Transition | undefined)?.duration ?? 0) >
					tr.t.duration;
			ctx.add({
				subject,
				code: 'CLICK',
				severity: 'error',
				frame: tr.frame,
				timecode: ctx.tc(tr.frame),
				clipIds: [tr.t.outgoingClipId, tr.t.incomingClipId].filter((x): x is string => !!x),
				message: soundCheckMessage(
					'clickTransition',
					clipTitle(ctx.doc, tr.clip),
					ctx.tc(tr.frame),
					fmt(loudest.burst.overDb),
				),
				measured: measured(loudest, { edgeOffsetMs: r2(((loudest.abs - tr.sample) / ctx.sr) * 1000) }),
				...(longer
					? { fix: ctx.commandFix(soundCheckMessage('fixLengthenTransition', d), commands, true) }
					: {}),
			});
			continue;
		}
		if (infos >= 50) continue;
		const frame = Math.max(ctx.range.start, Math.floor(seconds * ctx.fps + 1e-9));
		const body = audioClipsOf(ctx.seq).find(
			(c) =>
				inStem(loudest.stem, c.id) &&
				ctx.playing.has(c.id) &&
				frameToSample(c.start, ctx.rate, ctx.sr) <= loudest.abs &&
				frameToSample(clipEnd(c), ctx.rate, ctx.sr) > loudest.abs,
		);
		const subject = `${body?.id ?? 'mix'}:${frame}`;
		if (reported.has(subject)) continue;
		reported.add(subject);
		infos++;
		ctx.add({
			subject,
			code: 'CLICK',
			severity: 'info',
			frame,
			timecode: ctx.tc(frame),
			...(body ? { clipIds: [body.id] } : {}),
			message: body
				? soundCheckMessage('clickBody', clipTitle(ctx.doc, body), ctx.tc(frame))
				: soundCheckMessage('clickMix', ctx.tc(frame)),
			measured: measured(loudest),
		});
	}
	if (errors >= 200 || infos >= 50)
		ctx.warn(
			'W_CLICKS_CAPPED',
			`More clicks than reported: the first ${errors} at edits and ${infos} inside clips are listed`,
		);

	// ── EDGE: decode each judged edge's neighbourhood of the source ──
	type Job = {
		e: EdgeRef;
		fileStart: number;
		fileDur: number;
		/** Timeline seconds of the window before / after the edge. */
		before: number;
		after: number;
		data?: Float32Array | null;
	};
	const jobs: Job[] = [];
	const byClip = new Map<string, Job>();
	const wantStart = new Set<string>();
	// a music piece's end needs the next piece's first 50 ms
	for (const e of edges)
		if (e.edge === 'end' && e.neighbour && isMusic(e.clip)) wantStart.add(e.neighbour.id);
	for (const e of edges) {
		const c = e.clip;
		if (c.speed?.reverse) continue;
		const asset = ctx.doc.media?.[c.mediaId] as MediaAsset | undefined;
		const durF = asset ? mediaDurationFlicks(asset) : null;
		if (!asset || !fin(durF) || durF <= 0) continue;
		const prov = readLibraryProvenance((asset as { library?: unknown }).library);
		const rate = c.speed?.rate || 1;
		const mediaSec = durF / FLICKS_PER_SECOND;
		const inSec = c.sourceIn / FLICKS_PER_SECOND;
		const outSec = (c.sourceIn + c.duration * ctx.F * rate) / FLICKS_PER_SECOND;
		const clipSec = c.duration / ctx.fps;
		const inside = Math.min(T.peakWindowSec, clipSec);
		if (e.edge === 'start') {
			const lead = prov?.leadSilenceSec ?? 0;
			const hasBefore = inSec > 1e-4 && inSec > lead + 1e-3;
			if (!hasBefore && !wantStart.has(c.id)) continue;
			const pre = hasBefore ? Math.min(T.edgeWindowMs / 1000, inSec / rate) : 0;
			jobs.push({
				e,
				fileStart: inSec - pre * rate,
				fileDur: (pre + inside) * rate,
				before: pre,
				after: inside,
			});
		} else {
			const trail = prov?.trailSilenceSec ?? 0;
			if (outSec >= mediaSec - Math.max(1e-3, trail)) continue;
			const post = Math.min(2, (mediaSec - outSec) / rate);
			jobs.push({
				e,
				fileStart: outSec - inside * rate,
				fileDur: (inside + post) * rate,
				before: inside,
				after: post,
			});
		}
		byClip.set(`${c.id}:${e.edge}`, jobs.at(-1)!);
	}
	if (jobs.length > T.maxEdges)
		ctx.warn('W_EDGES_CAPPED', `${jobs.length} clip edges; the first ${T.maxEdges} were judged`);
	const judged = jobs.slice(0, T.maxEdges);
	let failed = 0;
	await pool(judged, 4, async (j) => {
		j.data = await decodeSpan(ctx, j.e.clip, j.fileStart, j.fileDur);
		if (!j.data) failed++;
	});
	if (failed)
		ctx.warn('W_EDGES_UNDECODED', `${failed} clip edge(s) could not be decoded and were not judged`);
	const split = (j: Job): { before: Float32Array; after: Float32Array } | null => {
		if (!j.data) return null;
		const k = Math.min(j.data.length, Math.round(j.before * ctx.sr));
		return { before: j.data.subarray(0, k), after: j.data.subarray(k) };
	};
	const ms = (x: number) => Math.round((x / 1000) * ctx.sr);
	for (const j of judged) {
		const parts = split(j);
		if (!parts) continue;
		const c = j.e.clip;
		const title = clipTitle(ctx.doc, c);
		if (j.e.edge === 'start') {
			if (parts.before.length === 0) continue;
			const m = measureEntry(parts.after, parts.before, ctx.sr);
			const fade = edgeFadeMs(ctx.seq, c, 'start', ctx.fps, ctx.F);
			if (
				!isAbruptEntry(m, fade, {
					preDb: T.entryPreDb,
					fadeMs: T.entryFadeMs,
					attackMs: T.entryAttackMs,
					exposedDb: T.entryExposedDb,
				})
			)
				continue;
			const fix = fadeFix(ctx, c, 'start', framesFor(T.entryFadeMs, ctx.fps));
			ctx.add({
				subject: `${c.id}:start`,
				code: 'EDGE',
				severity: 'warning',
				frame: j.e.frame,
				timecode: ctx.tc(j.e.frame),
				clipIds: [c.id],
				message: soundCheckMessage('edgeEntry', title, ctx.tc(j.e.frame), fmt(-m.preDb)),
				measured: {
					variant: 'entry',
					preDb: r1(m.preDb),
					attackMs: r1(m.attackMs),
					fadeInMs: r1(fade),
					atSec: r4(j.e.sample / ctx.sr),
				},
				...(fix ? { fix: ctx.commandFix(fix.label, fix.commands, true) } : {}),
			});
			continue;
		}
		// the end of a clip: chopped music at a joint first, else a chopped decay
		const inside = parts.before;
		const after = parts.after;
		const next = j.e.neighbour;
		if (next && isMusic(c)) {
			const nj = byClip.get(`${next.id}:start`);
			const np = nj ? split(nj) : null;
			if (np) {
				const w = ms(T.musicWindowMs);
				const g = (x: AudioClip) => (fin(x.gainDb) ? x.gainDb : 0);
				const s = measureSplice(
					inside.subarray(Math.max(0, inside.length - w)),
					after.subarray(0, w),
					np.after.subarray(0, w),
				);
				const sm = { outDb: s.outDb + g(c), cutOffDb: s.cutOffDb + g(c), nextInDb: s.nextInDb + g(next) };
				const xt = transitionAt(ctx.seq, c.id, 'end');
				const xfMs = xt ? (xt.duration / ctx.fps) * 1000 : 0;
				if (
					isChoppedMusic(sm, xfMs, {
						sustainDb: T.musicSustainDb,
						overNextDb: T.musicOverNextDb,
						crossfadeMs: T.musicCrossfadeMs,
					})
				) {
					const need = framesFor(T.musicCrossfadeMs, ctx.fps);
					const commands: Record<string, unknown>[] =
						xt && xt.incomingClipId === next.id
							? [{ type: 'transition.update', transitionId: xt.id, duration: need }]
							: [
									{
										type: 'transition.add',
										sequenceId: ctx.seq.id,
										trackId: c.trackId,
										at: clipEnd(c),
										effectId: CONSTANT_POWER,
										duration: need,
										alignment: 'center',
									},
								];
					const run = ctx.dryRun(commands);
					const got = run.ok ? transitionAfter(run.doc, ctx.seq.id, c.id, 'end') : null;
					const label =
						xt && xt.incomingClipId === next.id
							? soundCheckMessage('fixLengthenTransition', need)
							: soundCheckMessage('fixCrossfade', need);
					ctx.add({
						subject: `${c.id}:end`,
						code: 'EDGE',
						severity: 'warning',
						frame: j.e.frame,
						timecode: ctx.tc(j.e.frame),
						clipIds: [c.id, next.id],
						message: soundCheckMessage(
							'edgeMusic',
							title,
							ctx.tc(j.e.frame),
							fmt(sm.cutOffDb),
							fmt(sm.nextInDb),
							Math.round(xfMs),
						),
						measured: {
							variant: 'music',
							outDb: r1(sm.outDb),
							cutOffDb: r1(sm.cutOffDb),
							nextInDb: r1(sm.nextInDb),
							crossfadeMs: r1(xfMs),
							atSec: r4(j.e.sample / ctx.sr),
						},
						...(got !== null && got >= need ? { fix: ctx.commandFix(label, commands, true) } : {}),
					});
					continue;
				}
			}
		}
		const m = measureExit(inside, after.subarray(0, ms(T.edgeWindowMs)), ctx.sr);
		const fade = edgeFadeMs(ctx.seq, c, 'end', ctx.fps, ctx.F);
		if (!isChoppedDecay(m, fade, { tailDb: T.decayTailDb, postDb: T.decayPostDb, fadeMs: T.decayFadeMs }))
			continue;
		let fix: SoundCheckFix | undefined;
		const f = fadeFix(ctx, c, 'end', framesFor(T.decayFadeMs, ctx.fps));
		if (f) fix = ctx.commandFix(f.label, f.commands, true);
		else {
			const decay = decayAfterMs(after, m.peak, T.decayPostDb, ctx.sr);
			const frames = decay === null ? 0 : framesFor(decay, ctx.fps);
			const trim = { type: 'clip.trim', clipId: c.id, edge: 'out', deltaFrames: frames };
			if (frames > 0 && ctx.dryRun([trim]).ok)
				fix = ctx.commandFix(
					soundCheckMessage('fixExtendDecay', frames),
					[trim],
					false,
					soundCheckMessage('whyExtendDecay'),
				);
		}
		ctx.add({
			subject: `${c.id}:end`,
			code: 'EDGE',
			severity: 'warning',
			frame: j.e.frame,
			timecode: ctx.tc(j.e.frame),
			clipIds: [c.id],
			message: soundCheckMessage(
				'edgeDecay',
				title,
				ctx.tc(j.e.frame),
				fmt(-m.tailDb),
				fmt(m.postDb),
				Math.round(fade),
			),
			measured: {
				variant: 'decay',
				tailDb: r1(m.tailDb),
				postDb: r1(m.postDb),
				fadeOutMs: r1(fade),
				atSec: r4(j.e.sample / ctx.sr),
			},
			...(fix ? { fix } : {}),
		});
	}
}

// ── HARSH ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** HARSH (P6-E2): `presence` are the per-hop presence levels of the stems from the first rendered sample. */
export function harshFindings(
	ctx: FindCtx,
	rows: readonly FindRow[],
	presence: Partial<Record<'sfx' | 'music' | 'dialogue', Float32Array>>,
): void {
	const sfx = presence.sfx;
	if (!sfx || !rows.length) return;
	const from = ctx.preHops;
	const to = ctx.preHops + ctx.rangeHops;
	const refName = presence.music ? 'music' : presence.dialogue ? 'dialogue' : null;
	const ref = refName ? presencePeakDb(presence[refName]!, from, to) : PRESENCE_FLOOR_DB;
	const locked = new Set(ctx.seq.audioTracks.filter((t) => t.locked).map((t) => t.id));
	// events: a cue's layers together, an unlinked sound on its own
	const events = new Map<string, FindRow[]>();
	for (const r of rows) {
		const k = r.cue ? `cue:${r.cue.id}` : `clip:${r.clip.id}`;
		events.set(k, [...(events.get(k) ?? []), r]);
	}
	const hopOf = (s: number) => Math.floor((s - ctx.renderStart) / ctx.hop);
	for (const [, ev] of events) {
		let h0 = Number.POSITIVE_INFINITY;
		let h1 = Number.NEGATIVE_INFINITY;
		for (const r of ev) {
			const a = frameToSample(r.clip.start, ctx.rate, ctx.sr);
			const b = frameToSample(clipEnd(r.clip), ctx.rate, ctx.sr);
			const align = r.sfx?.placement?.align ?? 'peak';
			let s0 = a;
			let s1 = b;
			if (align === 'peak' && r.alignedFrame !== null) {
				const p = Math.round((r.alignedFrame / ctx.fps) * ctx.sr);
				s0 = Math.max(a, p - Math.round(0.02 * ctx.sr));
				s1 = Math.min(b, p + Math.round(0.08 * ctx.sr));
			} else if (align === 'end') s0 = Math.max(a, b - 2 * ctx.sr);
			else s1 = Math.min(b, a + 2 * ctx.sr);
			h0 = Math.min(h0, hopOf(s0));
			h1 = Math.max(h1, hopOf(s1));
		}
		if (!(h1 >= h0)) continue;
		const main = ev[0]!;
		const title = main.info.title;
		const frame = main.cue ? main.cue.frame : main.frame;
		if (frame < ctx.range.start || frame >= ctx.range.end) continue;
		const peak = presencePeakDb(sfx, Math.max(from, h0), Math.min(to, h1 + 1));
		const x = refName ? harshExcess(peak, ref, T.harshOverDb) : null;
		const subject = main.cue ? main.cue.id : main.clip.id;
		if (x?.harsh) {
			for (const r of ev) r.codes.add('HARSH');
			const amount = Math.ceil((x.overDb - T.harshOverDb + 0.5) * 10) / 10;
			const clipIds = ev.map((r) => r.clip.id);
			const userOwned = ev.some((r) => r.info.owner === 'user');
			const isLocked = ev.some((r) => locked.has(r.clip.trackId));
			// the MASKED minimum after the cut, for every sound it applies to (layers ride their cue's first layer)
			let maskedAfter: number | null = null;
			let minNeeded = 0;
			// every measured sound's lift with this event's sounds lowered (the solver's joint evaluation)
			const sv = ev.find((r) => r.solver)?.solver ?? null;
			const lowered = sv
				? (() => {
						const g = [...sv.gains];
						for (const r of ev) if (r.solver) g[r.solver.index] = (g[r.solver.index] ?? 0) - amount;
						return evaluateSfxGains(sv.events, g, sv.lo);
					})()
				: null;
			const masksOk = ev.every((r) => {
				const min =
					r.info.weight === 'ambient' || r.sfx?.role === 'layer' ? null : MASKED_MIN_LIFT_DB[r.info.weight];
				if (min === null) return true;
				if (!r.solver || !lowered) return false;
				const lift = lowered[r.solver.index]?.liftDb ?? null;
				if (lift === null || lift < min) {
					maskedAfter = lift;
					minNeeded = min;
					return false;
				}
				return true;
			});
			let fix: SoundCheckFix | undefined;
			if (!isLocked) {
				const gainCmd = userOwned
					? { type: 'audio.setGain', clipIds, mode: 'adjust', db: -amount }
					: {
							type: 'soundDesign.applyGains',
							sequenceId: ctx.seq.id,
							gains: Object.fromEntries(ev.map((r) => [r.clip.id, r1(r.info.gainDb - amount)])),
							report: Object.fromEntries(
								ev.map((r) => [r.clip.id, { reason: `Sound Check: harsh, lowered ${fmt(amount)} dB` }]),
							),
						};
				const safe = masksOk && !userOwned;
				if (safe && ctx.dryRun([gainCmd]).ok)
					fix = ctx.commandFix(soundCheckMessage('fixHarshGain', fmt(amount)), [gainCmd], true);
				else {
					// a dip at the sound's presence peak with the Parametric Equalizer (band 4, peaking)
					const prov = readLibraryProvenance(
						(ctx.doc.media?.[main.clip.mediaId] as { library?: unknown } | undefined)?.library,
					);
					const bands = (prov?.descriptors as { octaveBandsDb?: number[] } | undefined)?.octaveBandsDb;
					const hz =
						bands && bands.length >= 6 ? ((bands[4] ?? -120) >= (bands[5] ?? -120) ? 2500 : 4000) : 3500;
					const dip = Math.min(30, Math.max(1, r1(amount)));
					const eq = ev.map((r) => ({
						type: 'effect.add',
						target: { clipId: r.clip.id },
						effectId: 'jasper.audio.parametric-equalizer',
						params: { b4On: true, b4Freq: hz, b4Gain: -dip, b4Q: 1.4 },
					}));
					if (ctx.dryRun(eq).ok)
						fix = ctx.commandFix(
							soundCheckMessage('fixHarshEq', hz, fmt(dip)),
							eq,
							false,
							soundCheckMessage('whyHarshEq'),
						);
					else if (ctx.dryRun([gainCmd]).ok)
						fix = ctx.commandFix(
							soundCheckMessage('fixHarshGain', fmt(amount)),
							[gainCmd],
							false,
							userOwned
								? soundCheckMessage('whyUserGain')
								: soundCheckMessage('whyHarshMasked', fmt(amount), minNeeded),
						);
				}
			}
			ctx.add({
				subject,
				code: 'HARSH',
				severity: 'warning',
				frame,
				timecode: ctx.tc(frame),
				clipIds,
				...(main.cue ? { cueId: main.cue.id } : {}),
				message: soundCheckMessage(
					refName === 'music' ? 'harshMusic' : 'harshDialogue',
					title,
					ctx.tc(frame),
					fmt(x.overDb),
					T.harshOverDb,
				),
				measured: {
					presenceDb: r1(peak + ctx.gainDb),
					referenceDb: r1(ref + ctx.gainDb),
					reference: refName,
					overDb: x.overDb,
					lowerDb: amount,
					maskedAfterDb: maskedAfter === null ? null : r1(maskedAfter),
				},
				...(fix ? { fix } : {}),
			});
		}
		// bright: the placed sound's spectral centroid (library descriptor) over 6.5 kHz
		for (const r of ev) {
			const prov = readLibraryProvenance(
				(ctx.doc.media?.[r.clip.mediaId] as { library?: unknown } | undefined)?.library,
			);
			const c = (prov?.descriptors as { centroidHz?: number } | undefined)?.centroidHz;
			if (!fin(c) || c <= T.brightCentroidHz) continue;
			ctx.add({
				subject: `bright:${r.clip.id}`,
				code: 'HARSH',
				severity: 'info',
				frame: r.frame,
				timecode: ctx.tc(r.frame),
				clipIds: [r.clip.id],
				...(r.cue ? { cueId: r.cue.id } : {}),
				message: soundCheckMessage(
					'bright',
					r.info.title,
					ctx.tc(r.frame),
					Math.round(c),
					T.brightCentroidHz,
				),
				measured: { variant: 'bright', centroidHz: Math.round(c) },
			});
		}
	}
}

// ── LAYER_INAUDIBLE ─────────────────────────────────────────────────────────────────────────────────────────────────

/** LAYER_INAUDIBLE (P6-E2): each layer of a multi-layer cue rendered alone and against the bed plus its other layers. */
export async function layerFindings(ctx: FindCtx, rows: readonly FindRow[]): Promise<void> {
	const byCue = new Map<string, FindRow[]>();
	for (const r of rows)
		if (r.cue && ctx.playing.has(r.clip.id)) byCue.set(r.cue.id, [...(byCue.get(r.cue.id) ?? []), r]);
	const layers: { r: FindRow; others: FindRow[] }[] = [];
	for (const [, list] of byCue) {
		if (list.length < 2) continue;
		for (const r of list) layers.push({ r, others: list.filter((o) => o !== r) });
	}
	if (layers.length > T.maxLayers)
		ctx.warn('W_LAYERS_CAPPED', `${layers.length} layers; the first ${T.maxLayers} were measured`);
	const deps: MeasureDeps = {
		ff: ctx.ff,
		registry: ctx.registry,
		...(ctx.signal ? { signal: ctx.signal } : {}),
		...(ctx.onSpawn ? { onSpawn: ctx.onSpawn } : {}),
	};
	const bed = [...ctx.stemIds.bed];
	for (const { r, others } of layers.slice(0, T.maxLayers)) {
		if (ctx.signal?.aborted) throw new JobError('CANCELLED', 'Cancelled', false);
		const span = {
			start: Math.max(0, r.clip.start),
			end: Math.max(r.clip.start + 1, Math.min(clipEnd(r.clip), r.clip.start + Math.ceil(3 * ctx.fps))),
		};
		let alone: Awaited<ReturnType<typeof renderSequencePcm>>;
		let rest: Awaited<ReturnType<typeof renderSequencePcm>>;
		try {
			alone = await renderSequencePcm(ctx.doc, ctx.seq.id, span, new Set([r.clip.id]), deps);
			rest = await renderSequencePcm(
				ctx.doc,
				ctx.seq.id,
				span,
				new Set([...bed, ...others.map((o) => o.clip.id)]),
				deps,
			);
		} catch (e) {
			if (ctx.signal?.aborted) throw new JobError('CANCELLED', 'Cancelled', false);
			ctx.warn('W_LAYER_UNMEASURED', `Layer ${r.clip.id} could not be rendered: ${(e as Error).message}`);
			continue;
		}
		const w = Math.max(8, Math.round((T.layerWindowMs / 1000) * alone.sampleRate));
		const at = loudestWindowStart(alone.channels, w);
		const EL = thirdOctaveEnergies(alone.channels, at, w, alone.sampleRate);
		const ER = thirdOctaveEnergies(rest.channels, at, w, rest.sampleRate);
		const a = layerAudibility(EL, ER, T.layerTargetAddDb);
		let elSum = 0;
		for (const v of EL) elSum += v;
		if (!(elSum > 0) || a.maxAddDb >= T.layerAddDb) continue;
		r.codes.add('LAYER_INAUDIBLE');
		const cue = r.cue!;
		const index = (cue.placedClipIds ?? []).indexOf(r.clip.id) + 1;
		const gain = a.gainForTargetDb;
		let fix: SoundCheckFix | undefined;
		if (gain !== null && gain <= 18) {
			const cmd = {
				type: 'audio.setGain',
				clipIds: [r.clip.id],
				mode: 'adjust',
				db: r1(Math.max(0.1, gain)),
			};
			if (ctx.dryRun([cmd]).ok)
				fix = ctx.commandFix(
					soundCheckMessage('fixLayerGain', fmt(gain), a.dominantHz),
					[cmd],
					false,
					soundCheckMessage('whyLayer'),
				);
		}
		if (!fix) {
			const cmd = { type: 'clip.lift', clipIds: [r.clip.id], groups: false };
			if (ctx.dryRun([cmd]).ok)
				fix = ctx.commandFix(
					soundCheckMessage('fixRemoveLayer'),
					[cmd],
					false,
					soundCheckMessage('whyLayer'),
				);
		}
		ctx.add({
			subject: r.clip.id,
			code: 'LAYER_INAUDIBLE',
			severity: 'info',
			frame: cue.frame,
			timecode: ctx.tc(cue.frame),
			clipIds: [r.clip.id],
			cueId: cue.id,
			message: soundCheckMessage(
				'layerInaudible',
				`${Math.max(1, index)} (${r.info.title})`,
				cue.label ?? cue.id,
				ctx.tc(cue.frame),
				fmt(a.maxAddDb),
				T.layerAddDb,
			),
			measured: {
				maxAddDb: a.maxAddDb,
				dominantHz: a.dominantHz,
				gainForTargetDb: gain,
				windowSec: r4((span.start * ctx.F) / FLICKS_PER_SECOND + at / alone.sampleRate),
			},
			...(fix ? { fix } : {}),
		});
	}
}

// ── COVERAGE ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The class of a cue (spec 12 P6-E3): kind + anchor source, text / keyframe cues by clip, cuts by track. */
export function coverageClass(c: SoundCue): string {
	const a = c.anchor;
	const src = a?.type ?? 'none';
	let group = '';
	if (a?.type === 'text' || a?.type === 'keyframe') group = a.clipId;
	else if (a?.type === 'edit') group = a.trackId;
	else if (a?.type === 'mg' || a?.type === 'clip' || a?.type === 'beat') group = a.clipId;
	return `${c.kind}|${src}|${group}`;
}

/** COVERAGE (P6-E3). `dialogue` = dialogue spans in frames (cues there are silenced by dialogue: excluded). */
export function coverageFindings(
	ctx: FindCtx,
	cues: readonly SoundCue[],
	dialogue: readonly [number, number][],
): void {
	const inDialogue = (f: number) => dialogue.some(([a, b]) => f >= a && f < b);
	const classes = new Map<string, SoundCue[]>();
	for (const c of cues) {
		if (c.muted || c.weight === 'ambient' || c.kind === 'silence') continue;
		if (c.frame < ctx.range.start || c.frame >= ctx.range.end) continue;
		const k = coverageClass(c);
		classes.set(k, [...(classes.get(k) ?? []), c]);
	}
	for (const [key, list] of classes) {
		const filled = list.filter((c) => (c.placedClipIds?.length ?? 0) > 0);
		const unfilled = list
			.filter((c) => (c.placedClipIds?.length ?? 0) === 0 && !inDialogue(c.frame))
			.sort((a, b) => a.frame - b.frame || (a.id < b.id ? -1 : 1));
		if (filled.length < 2 || unfilled.length < 1) continue;
		// the sound the class uses: the first filled cue's layers
		const model = [...filled].sort((a, b) => a.frame - b.frame)[0]!;
		const layers = (model.placedClipIds ?? [])
			.map((id) => ctx.seq.clips[id] as (AudioClip & { sfx?: unknown }) | undefined)
			.filter((c): c is AudioClip & { sfx?: unknown } => c?.kind === 'audio')
			.map((c) => {
				const sfx = (c as { sfx?: { placement?: { align?: string } } }).sfx;
				return { mediaId: c.mediaId, ...(sfx?.placement?.align ? { align: sfx.placement.align } : {}) };
			});
		const fill = unfilled.map((c) => ({
			type: 'soundDesign.place',
			sequenceId: ctx.seq.id,
			cueId: c.id,
			layers,
		}));
		const mute = unfilled.map((c) => ({ type: 'soundCue.update', cueId: c.id, muted: true }));
		const title = layers[0] ? clipTitle(ctx.doc, ctx.seq.clips[model.placedClipIds![0]!] as Clip) : '';
		let fix: SoundCheckFix | undefined;
		if (layers.length && ctx.dryRun(fill).ok)
			fix = ctx.commandFix(
				soundCheckMessage('fixFillCoverage', title),
				fill,
				false,
				soundCheckMessage('whyCoverage'),
			);
		else if (ctx.dryRun(mute).ok)
			fix = ctx.commandFix(
				soundCheckMessage('fixMuteCoverage'),
				mute,
				false,
				soundCheckMessage('whyCoverage'),
			);
		const first = unfilled[0]!;
		const last = unfilled.at(-1)!;
		const tcs = unfilled.slice(0, 8).map((c) => ctx.tc(c.frame));
		ctx.add({
			subject: key,
			code: 'COVERAGE',
			severity: 'warning',
			frame: first.frame,
			timecode: ctx.tc(first.frame),
			range: { start: first.frame, end: last.frame + 1 },
			cueId: first.id,
			clipIds: filled.flatMap((c) => c.placedClipIds ?? []).slice(0, 64),
			message: soundCheckMessage(
				'coverage',
				filled.length,
				filled.length + unfilled.length,
				first.kind,
				unfilled.length,
				`${tcs.join(', ')}${unfilled.length > 8 ? ', …' : ''}`,
			),
			measured: {
				filled: filled.length,
				unfilled: unfilled.length,
				class: key.slice(0, 200),
				cueIds: unfilled
					.slice(0, 32)
					.map((c) => c.id)
					.join(','),
			},
			...(fix ? { fix } : {}),
		});
	}
}

// ── ENDING, HEAD, ARC ──────────────────────────────────────────────────────────────────────────────────────────────

/** Points of a fade on the Mix volume lane (sequence flicks, dB), equal-power, from `v0` (fade out) or to it (in). */
function fadePoints(t0: number, t1: number, v0: number, out: boolean, steps = 16): [number, number][] {
	const pts: [number, number][] = [];
	for (let k = 0; k <= steps; k++) {
		const x = k / steps;
		const g = out ? Math.cos((Math.PI / 2) * x) : Math.sin((Math.PI / 2) * x);
		const v = g > 1e-5 ? Math.max(FADER_MIN_DB, v0 + 20 * Math.log10(g)) : FADER_MIN_DB;
		pts.push([Math.round(t0 + (t1 - t0) * x), r2(v)]);
	}
	return pts;
}

/**
 * A mix that fades out to silence over its last half second — its last 50 ms at least `endFadeDropDb` under the 50 ms
 * that began `endFadeLookSec` before the end, and its last 10 ms peak `endFadeFallDb` under that last-50 ms RMS (still
 * falling: a fade reaching zero, not one that stops at a level) — ends; it is not "mid-sound" even when the fade's last
 * 10 ms are over −60 dBFS (End on Bar's one-beat fade into the bar line; final verification B). Pure.
 */
function endsWithFadeOut(tap: {
	tailRmsDb: number;
	tailPeakDb: number;
	fadeFromDb?: number | null;
}): boolean {
	return (
		typeof tap.fadeFromDb === 'number' &&
		Number.isFinite(tap.fadeFromDb) &&
		Number.isFinite(tap.tailRmsDb) &&
		Number.isFinite(tap.tailPeakDb) &&
		tap.fadeFromDb - tap.tailRmsDb >= T.endFadeDropDb &&
		tap.tailPeakDb <= tap.tailRmsDb - T.endFadeFallDb
	);
}

/** ENDING and HEAD (P6-E3) from the delivered mix's first 5 ms and last 50 ms. */
export function endingFindings(
	ctx: Pick<FindCtx, 'seq' | 'F' | 'range' | 'duration' | 'tc' | 'add' | 'dryRun' | 'commandFix'>,
	tap: { headPeakDb: number; tailRmsDb: number; tailPeakDb: number; fadeFromDb?: number | null } | null,
): void {
	if (!tap) return;
	const fadesOut = endsWithFadeOut(tap);
	const master = stripView(ctx.seq, 'master');
	const auto =
		master && master.automation === 'off'
			? [{ type: 'mixer.updateStrip', sequenceId: ctx.seq.id, stripId: 'Mix', patch: { automation: 'read' } }]
			: [];
	const lane = (t: number) => (master ? laneValueAt(master, 'volume', t) : 0);
	if (
		ctx.range.end >= ctx.duration &&
		!fadesOut &&
		(tap.tailRmsDb > T.endRmsDbfs || tap.tailPeakDb > T.endPeakDbfs)
	) {
		const end = ctx.duration * ctx.F;
		const t0 = Math.max(0, end - T.endFadeSec * FLICKS_PER_SECOND);
		// the fade reaches silence 50 ms before the end: the last 50 ms are what this check measures
		const t1 = Math.max(t0 + 1, end - 0.05 * FLICKS_PER_SECOND);
		const points = [
			...fadePoints(t0, t1, lane(t0), true),
			[Math.round(end), FADER_MIN_DB] as [number, number],
		];
		const cmds = [
			...auto,
			{ type: 'mixer.writeAutomation', sequenceId: ctx.seq.id, stripId: 'Mix', lane: 'volume', points },
		];
		const f = ctx.duration - 1;
		ctx.add({
			subject: 'end',
			code: 'ENDING',
			severity: 'warning',
			frame: Math.max(0, f),
			timecode: ctx.tc(ctx.duration),
			message: soundCheckMessage('ending', ctx.tc(ctx.duration), fmt(tap.tailRmsDb), fmt(tap.tailPeakDb)),
			measured: { tailRmsDbfs: tap.tailRmsDb, tailPeakDbfs: tap.tailPeakDb },
			...(ctx.dryRun(cmds).ok
				? {
						fix: ctx.commandFix(
							soundCheckMessage('fixEndingFade', T.endFadeSec),
							cmds,
							false,
							soundCheckMessage('whyEnding'),
						),
					}
				: {}),
		});
	}
	if (ctx.range.start === 0 && tap.headPeakDb > T.headPeakDbfs) {
		// a dB-linear rise from silence over 20 ms keeps the first 5 ms ≥ 70 dB down (a 3 ms fade would leave the 5 ms
		// window at full level: decision, wp-note)
		const t1 = Math.round(0.02 * FLICKS_PER_SECOND);
		const points: [number, number][] = [
			[0, FADER_MIN_DB],
			[t1, r2(lane(t1))],
		];
		const cmds = [
			...auto,
			{ type: 'mixer.writeAutomation', sequenceId: ctx.seq.id, stripId: 'Mix', lane: 'volume', points },
		];
		ctx.add({
			subject: 'head',
			code: 'HEAD',
			severity: 'info',
			frame: 0,
			timecode: ctx.tc(0),
			message: soundCheckMessage('head', ctx.tc(0), fmt(tap.headPeakDb)),
			measured: { headPeakDbfs: tap.headPeakDb },
			...(ctx.dryRun(cmds).ok
				? {
						fix: ctx.commandFix(
							soundCheckMessage('fixHeadFade', 20),
							cmds,
							false,
							soundCheckMessage('whyEnding'),
						),
					}
				: {}),
		});
	}
}

/**
 * ARC (P6-E3, info): the loudest 3 s short-term window of the delivered mix (`shortTerm`, 10 ms hops over the range)
 * holds no hero cue while heroes exist, or lies in the last 15 % of the sequence with no hero there. Whole sequences only.
 */
export function arcFindings(
	ctx: FindCtx,
	shortTerm: Float32Array,
	heroes: readonly { frame: number; title: string }[],
	floorLufs: number,
): void {
	if (!ctx.whole || shortTerm.length === 0) return;
	let best = 0;
	for (let i = 1; i < shortTerm.length; i++) if (shortTerm[i]! > shortTerm[best]!) best = i;
	const lufs = shortTerm[best]!;
	if (!(lufs > floorLufs)) return;
	const frame = ctx.range.start + ((best * ctx.hop) / ctx.sr) * ctx.fps;
	const half = (T.arcWindowSec / 2) * ctx.fps;
	const inside = heroes.filter((h) => Math.abs(h.frame - frame) <= half);
	const late = frame >= ctx.duration * (1 - T.arcLateShare);
	const f = Math.round(frame);
	if (heroes.length && !inside.length) {
		const biggest = heroes[0]!;
		ctx.add({
			subject: 'arc',
			code: 'ARC',
			severity: 'info',
			frame: f,
			timecode: ctx.tc(f),
			range: {
				start: Math.max(0, Math.round(frame - half)),
				end: Math.min(ctx.duration, Math.round(frame + half) + 1),
			},
			message: soundCheckMessage(
				'arcNoHero',
				ctx.tc(f),
				fmt(lufs),
				`${biggest.title} (${ctx.tc(biggest.frame)})`,
			),
			measured: { variant: 'no-hero', shortTermLufs: r1(lufs), heroes: heroes.length },
		});
	} else if (late && !inside.length)
		ctx.add({
			subject: 'arc',
			code: 'ARC',
			severity: 'info',
			frame: f,
			timecode: ctx.tc(f),
			message: soundCheckMessage('arcLate', ctx.tc(f), fmt(lufs)),
			measured: { variant: 'late', shortTermLufs: r1(lufs) },
		});
}
