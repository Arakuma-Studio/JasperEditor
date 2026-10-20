// Listening transcript (spec 12 §4 P6-E6, P6-E7; wp-note "Phase 6 → WP-E3"): an agent's ears for the whole mix. The
// `sound-listen` job renders a range (≤ 10 min) once — the mix and one LANE per set of clips that never overlap, so a
// lane's signal at any moment belongs to one clip (`stems.ts`: every clip is decoded once; the dialogue / music /
// ambience / sound-effect stem curves are the lanes' energy by the class of the clip playing) — and:
//   1. detects the events of every lane and of the mix (`ListenMeter`: onsets refined to the attack, swells, silences,
//      accents); a clip's own onset is also looked at in the mix where the mix's onset curve hides it, and kept when
//      the mix still rises ≥ 3 dB over its bed in some band there (`guided`);
//   2. attributes each mix event to the clip whose OWN event explains it (the most prominent lane event within 30 ms;
//      60 ms for swells), else to the clip that is loudest there (`explainedBy: 'level'`), and to the cue it fills; an
//      attributed event starts at the earlier of its own attack and the mix's (a bed can hide the first milliseconds);
//   3. labels sections by the Essential Sound / Auto Tag class audible per stem (dialogue, music with its ducking depth
//      and how far it sits under the voice, ambience, effects, silence);
//   4. matches the picture events — cuts and transitions (`pictureEditEvents`), the sound cues, the cached measured
//      picture motion (`analyze_picture_motion`; never started here) — to the mix event that answers each (OK within a
//      frame, near ≤ 100 ms, swell ≤ 300 ms, else none), with the CHANCE level of every share and on-beat stats when the
//      music's beats are cached;
//   5. writes the transcript: one chronological line per section, silence, (detail-selected) event and picture event
//      with no sound, after a summary and the sync lines. The panel's Log tab and MCP `listen_to_sequence` print these
//      lines verbatim.
// Levels are as delivered when the Mix normalises and its loudness analysis is current (as the visual route). Nothing
// is written to the project.
import {
	SOUND_LISTEN_LIMITS,
	type SoundCheckReport,
	type SoundListenDetail,
	type SoundListenEvent,
	type SoundListenLine,
	type SoundListenPictureEvent,
	type SoundListenPlaced,
	type SoundListenRequest,
	SoundListenRequestSchema,
	type SoundListenResult,
	type SoundListenSection,
	type SoundListenSyncStats,
} from '@jasper/api';
import {
	answerPictureEvent,
	CURVE_HOP_SEC,
	integratedOf,
	type ListenAnalysis,
	type ListenEvent,
	ListenMeter,
	loudnessCurve,
	type PictureAnswer,
	type StemCurves,
	syncIndex,
	syncStats,
} from '@jasper/audio-fx';
import {
	type AudioClip,
	type Clip,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	frameToSample,
	isSfxClip,
	type MediaAsset,
	type ProjectDocument,
	pictureEditEvents,
	type Rational,
	readClipSfx,
	readEssentialSound,
	readLibraryProvenance,
	type Sequence,
	sequenceDuration,
	sequenceTimecode,
	sequenceWords,
	soundCuesOf,
	trackLabel,
} from '@jasper/project';
import type { AgentService } from '../agent/service.ts';
import type { JobContext } from '../jobs/types.ts';
import { JobError } from '../jobs/types.ts';
import type { MediaRegistry } from '../media/registry.ts';
import { vadThreshold } from '../speech/core/vad.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { HttpError } from '../tools/reply.ts';
import { audioWorld, VAD_FLOOR_DBFS } from './bed.ts';
import type { EngineCueSources } from './engine-cues.ts';
import { type NameWindows, tagListenEvents } from './listen-tags.ts';
import { liveDocument, PlanInputError, planSequence } from './plan.ts';
import { classifyStems, mixLayoutOf, renderStems } from './stems.ts';
import { deliveredGain } from './visual.ts';

/** Context rendered before and after the range (s): the bed, the z window and the decay of the last event. */
const PRE_SEC = 2.5;
const POST_SEC = 2.5;
/** Clips this close on a lane (s) are put on different lanes, so an effect tail is not attributed to the next clip. */
const LANE_GAP_SEC = 0.25;
/** A lane event explains a mix event this close (ms, the onset merge window; swells: their peaks). */
const EXPLAIN_MS = 30;
const EXPLAIN_SWELL_MS = 60;
/** A clip's own onset is a hint for the mix when it rises this much over the clip's own bed (dB). */
const HINT_DB = 3;
/** A placed sound is heard when a mix event attributed to it is this close to its own event (ms). */
const HEARD_MS = 30;
/** Its own event is searched this far around its aligned point (ms). */
const OWN_MS = 100;
/** An event after a clip's end still belongs to it (its tail, reverb) for this long (ms). */
const TAIL_MS = 2000;
/** A stem is audible in a section when its momentary loudness is over −50 LUFS and within 20 LU of the mix's. */
const AUDIBLE_LUFS = -50;
const AUDIBLE_UNDER_LU = 20;
/** Sections shorter than this are folded into a neighbour (hops of 10 ms). */
const MIN_SECTION_HOPS = 100;
const MAX_SECTIONS = 400;

const r1 = (x: number) => Math.round(x * 10) / 10;
const q = (s: string, n = 48) => `"${s.length > n ? `${s.slice(0, n - 1)}…` : s}"`;
const signed = (x: number, unit: string) => `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x))} ${unit}`;
const pct = (x: number) => `${Math.round(x * 100)} %`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export class ListenInputError extends Error {
	constructor(
		readonly code: 'RANGE_TOO_LONG' | 'RANGE_EMPTY',
		message: string,
	) {
		super(message);
	}
}

/** The frames a request covers (clamped to the sequence), or a typed error (≤ 10 min). */
export function listenRange(
	seq: Sequence,
	req: Pick<SoundListenRequest, 'range'>,
): { start: number; end: number; whole: boolean } {
	const rate = seq.settings.frameRate as Rational;
	const fps = rate.num / rate.den;
	const duration = Math.max(0, Math.ceil(sequenceDuration(seq)));
	const start = Math.min(req.range?.start ?? 0, duration);
	const end = Math.min(req.range?.end ?? duration, duration);
	if (end <= start)
		throw new ListenInputError('RANGE_EMPTY', `The range is outside the sequence (0–${duration} frames)`);
	if ((end - start) / fps > SOUND_LISTEN_LIMITS.maxSeconds + 1e-9)
		throw new ListenInputError(
			'RANGE_TOO_LONG',
			`At most ${SOUND_LISTEN_LIMITS.maxSeconds / 60} minutes per listen: give a range`,
		);
	return { start, end, whole: start === 0 && end >= duration };
}

export type ListenEnv = {
	ff: Ffmpeg;
	registry: Pick<MediaRegistry, 'get' | 'resolvePath'>;
	/** Cached beats and measured picture motion (never analysed here). */
	engineCues?: EngineCueSources | undefined;
	/** The last Sound Check report of this sequence (when it measured this mix, its normalisation gain is the export's). */
	checkReport?: SoundCheckReport | null;
	signal?: AbortSignal;
	onSpawn?(child: import('node:child_process').ChildProcess): void;
	onProgress?(fraction: number, stage: string): void;
};

export type ListenOptions = {
	projectId: string;
	revision: number | null;
	range?: { start: number; end: number } | undefined;
	detail?: SoundListenDetail | undefined;
};

type StemKind = 'sfx' | 'dialogue' | 'music' | 'ambience' | 'other';
type LaneClip = { clipId: string; trackId: string; a: number; b: number };
type Owner = {
	clipId: string;
	stem: StemKind;
	track: string | null;
	name: string;
	cueId: string | null;
	cueKind: SoundListenEvent['cueKind'];
	role: SoundListenEvent['role'];
};

/** Clips that never overlap (with a gap) share a lane; greedy by start. */
function assignLanes(clips: LaneClip[], max: number): { lanes: LaneClip[][]; shared: number } {
	const lanes: LaneClip[][] = [];
	let shared = 0;
	for (const c of clips.slice().sort((x, y) => x.a - y.a || (x.clipId < y.clipId ? -1 : 1))) {
		let lane = lanes.find((l) => l[l.length - 1]!.b <= c.a);
		if (!lane && lanes.length < max) {
			lane = [];
			lanes.push(lane);
		}
		if (!lane) {
			// more overlapping clips than lanes: the lane that frees first takes it (attribution by start there)
			lane = lanes.reduce((best, l) => (l[l.length - 1]!.b < best[best.length - 1]!.b ? l : best));
			shared++;
		}
		lane.push(c);
	}
	return { lanes, shared };
}

/** The clip of a lane that plays at `ms` (or whose tail it is). */
function laneClipAt(lane: readonly LaneClip[], ms: number): LaneClip | null {
	let tail: LaneClip | null = null;
	for (const c of lane) {
		if (ms >= c.a && ms < c.b) return c;
		if (c.b <= ms && ms - c.b <= TAIL_MS && (!tail || c.b > tail.b)) tail = c;
	}
	return tail;
}

/** StemCurves of a listen analysis' 10 ms hops (for `loudnessCurve`). */
function curvesOf(a: ListenAnalysis): StemCurves {
	return {
		sampleRate: a.sampleRate,
		hop: a.hop10.samples,
		count: a.hop10.count,
		kEnergy: a.hop10.kEnergy,
		msDb: new Float32Array(a.hop10.count),
		loudestDb: new Float32Array(a.hop10.count),
		peakDb: a.hop10.peakDb,
	};
}

/** Listens to `seq` over the request's range (see the module docs). */
export async function listenSequence(
	doc: ProjectDocument,
	seq: Sequence,
	opts: ListenOptions,
	env: ListenEnv,
): Promise<SoundListenResult> {
	const t0 = Date.now();
	const timings: Record<string, number> = {};
	const warnings: SoundListenResult['warnings'] = [];
	const progress = (f: number, s: string) => env.onProgress?.(f, s);
	const aborted = () => {
		if (env.signal?.aborted) throw new JobError('CANCELLED', 'Cancelled', false);
	};
	const detail: SoundListenDetail = opts.detail ?? 'normal';
	const range = listenRange(seq, { range: opts.range });
	const rate = seq.settings.frameRate as Rational;
	const fps = rate.num / rate.den;
	const frameMs = 1000 / fps;
	const F = flicksPerFrame(rate);
	const tc = (f: number) => sequenceTimecode(seq, Math.max(0, Math.round(f)));
	const frameOfMs = (ms: number) => Math.max(0, Math.floor((ms / 1000) * fps + 1e-6));
	const rangeStartMs = (range.start / fps) * 1000;
	const rangeEndMs = (range.end / fps) * 1000;

	// ── the world, the stems and the lanes ─────────────────────────────────────────────────────────────────────────
	progress(0.02, 'Reading the mix');
	const world = await audioWorld(doc, seq.id, env.registry);
	const snap = world.snapshot;
	const sr = snap.audioMix?.sampleRate ?? snap.settings.sampleRate;
	const hop = Math.max(1, Math.round(sr * CURVE_HOP_SEC));
	const rangeStart = frameToSample(range.start, rate, sr);
	const rangeEnd = Math.max(rangeStart, frameToSample(range.end, rate, sr));
	const preHops = Math.min(Math.round(PRE_SEC * 100), Math.floor(rangeStart / hop));
	const renderStart = rangeStart - preHops * hop;
	const renderEnd = rangeEnd + Math.round(POST_SEC * 100) * hop;
	const rangeHops = Math.ceil((rangeEnd - rangeStart) / hop);
	const renderMs0 = (renderStart / sr) * 1000;
	const { channels } = mixLayoutOf(snap);
	const stems = classifyStems(
		seq,
		snap.audioClips.map((c) => c.clipId),
	);
	const stemOf = (clipId: string): StemKind =>
		stems.sfx.has(clipId)
			? 'sfx'
			: stems.dialogue.has(clipId)
				? 'dialogue'
				: stems.music.has(clipId)
					? 'music'
					: stems.ambience.has(clipId)
						? 'ambience'
						: 'other';
	const msOfFrame = (f: number) => (f / fps) * 1000;
	const laneClips: LaneClip[] = snap.audioClips
		.map((c) => ({
			clipId: c.clipId,
			trackId: c.trackId,
			a: msOfFrame(c.start - (c.headHandle ?? 0)),
			b: msOfFrame(c.start + c.duration + (c.tailHandle ?? 0)) + LANE_GAP_SEC * 1000,
		}))
		.filter((c) => c.b > renderMs0 && c.a < (renderEnd / sr) * 1000);
	const { lanes, shared } = assignLanes(laneClips, SOUND_LISTEN_LIMITS.lanes);
	if (shared)
		warnings.push({
			code: 'W_LANES_SHARED',
			message: `${shared} clip(s) overlap more than ${SOUND_LISTEN_LIMITS.lanes} others: they share a lane, and an event there is given to the clip that starts last`,
		});
	// lane intervals without the gap
	for (const l of lanes) for (const c of l) c.b -= LANE_GAP_SEC * 1000;

	const mixMeter = new ListenMeter(sr, channels);
	// each clip's own onsets that rise over its own bed are hints for the mix: a sound the mix's onset curve hides is
	// still found there when the mix rises ≥ 3 dB at that attack (lanes render before the mix in every block)
	const laneMeters = lanes.map(
		() =>
			new ListenMeter(sr, channels, {
				onHit: (e) => {
					if (e.prominenceDb >= HINT_DB) mixMeter.hint([e.ms]);
				},
			}),
	);
	const tr = Date.now();
	if (stems.mix.size > 0) {
		progress(0.05, 'Rendering the mix and every clip');
		await renderStems({
			ff: env.ff,
			snapshot: snap,
			media: world.media,
			startSample: renderStart,
			samples: renderEnd - renderStart,
			stems: [
				...lanes.map((l, i) => ({ name: `lane:${i}`, clipIds: new Set(l.map((c) => c.clipId)) })),
				{ name: 'mix', clipIds: null },
			],
			...(env.signal ? { signal: env.signal } : {}),
			...(env.onSpawn ? { onSpawn: env.onSpawn } : {}),
			onProgress: (f) => progress(0.05 + 0.8 * f, 'Listening'),
			onBlock: (i, planar, n) => {
				if (i < lanes.length) laneMeters[i]!.push(planar, n);
				else mixMeter.push(planar, n);
			},
		});
	}
	aborted();
	timings.renderAndDetectMs = Date.now() - tr;
	const td = Date.now();
	progress(0.88, 'Attributing the events');
	// the lanes first: their last onsets are hints for the mix
	const laneA = laneMeters.map((m) => m.finish());
	const mixA = mixMeter.finish();
	// the stems' 10 ms curves from the lanes (no extra render): at any hop a lane plays one clip, whose stem gets the
	// lane's energy; overlapping clips of one stem add as uncorrelated sounds
	const total = Math.ceil((renderEnd - renderStart) / hop);
	const STEMS = ['dialogue', 'music', 'ambience', 'sfx'] as const;
	const stemK = Object.fromEntries(STEMS.map((s) => [s, new Float64Array(total)])) as Record<
		(typeof STEMS)[number],
		Float64Array
	>;
	const stemMs = Object.fromEntries(STEMS.map((s) => [s, new Float64Array(total)])) as Record<
		(typeof STEMS)[number],
		Float64Array
	>;
	laneA.forEach((a, li) => {
		const lane = lanes[li]!;
		let k = 0;
		for (let h = 0; h < Math.min(total, a.hop10.count); h++) {
			const ms = renderMs0 + h * 10 + 5;
			while (k < lane.length && lane[k]!.b <= ms) k++;
			// the clip playing at this hop, else the tail of the one before
			const c = k < lane.length && lane[k]!.a <= ms ? lane[k]! : laneClipAt(lane, ms);
			if (!c) continue;
			const st = stemOf(c.clipId);
			if (st === 'other') continue;
			stemK[st][h]! += a.hop10.kEnergy[h]!;
			stemMs[st][h]! += a.hop10.meanSquare[h]!;
		}
	});
	const stemCurves = Object.fromEntries(
		STEMS.map((s) => [
			s,
			{
				sampleRate: sr,
				hop,
				count: total,
				kEnergy: stemK[s],
				msDb: Float32Array.from(stemMs[s], (v) => (v > 0 ? Math.max(-120, 10 * Math.log10(v)) : -120)),
				loudestDb: new Float32Array(total).fill(-120),
				peakDb: new Float32Array(total).fill(-120),
			} satisfies StemCurves,
		]),
	) as Record<(typeof STEMS)[number], StemCurves>;

	// as delivered
	const norm = deliveredGain(doc, seq, env.checkReport ?? null);
	const gain = norm.gainDb;

	// ── owners: what each clip is ─────────────────────────────────────────────────────────────────────────────────
	const cues = soundCuesOf(seq);
	const cueById = new Map(cues.map((c) => [c.id, c]));
	const ownerCache = new Map<string, Owner>();
	const ownerOf = (clipId: string, trackId: string): Owner => {
		const hit = ownerCache.get(clipId);
		if (hit) return hit;
		const c = seq.clips[clipId] as (Clip & { name?: unknown; sfx?: unknown }) | undefined;
		const a = c?.kind === 'audio' ? (c as AudioClip & { sfx?: unknown }) : null;
		const sfx = a?.sfx !== undefined ? readClipSfx(a.sfx) : null;
		const own = sfx?.cueId ? cueById.get(sfx.cueId) : undefined;
		const cue = own && (own.placedClipIds ?? []).includes(clipId) ? own : null;
		const asset = a
			? (doc.media?.[a.mediaId] as (MediaAsset & { library?: unknown }) | undefined)
			: undefined;
		const prov = readLibraryProvenance(asset?.library);
		const name =
			(isSfxClip(c) && prov?.title) ||
			(typeof c?.name === 'string' && c.name.trim()) ||
			(asset as { originalName?: string } | undefined)?.originalName ||
			clipId;
		const o: Owner = {
			clipId,
			stem: stemOf(clipId),
			track: trackLabel(seq, c?.trackId ?? trackId) ?? null,
			name: String(name).slice(0, 200),
			cueId: cue?.id ?? null,
			cueKind: cue?.kind ?? null,
			role: sfx?.role ?? null,
		};
		ownerCache.set(clipId, o);
		return o;
	};

	// ── lane events with their clips ──────────────────────────────────────────────────────────────────────────────
	type LaneEvent = { lane: number; e: ListenEvent; seqMs: number; clip: LaneClip };
	const laneEvents: LaneEvent[] = [];
	laneA.forEach((a, li) => {
		for (const e of a.events) {
			const seqMs = renderMs0 + e.ms;
			const clip = laneClipAt(lanes[li]!, seqMs);
			if (clip) laneEvents.push({ lane: li, e, seqMs, clip });
		}
	});
	laneEvents.sort((x, y) => x.seqMs - y.seqMs);
	const laneMsSorted = laneEvents.map((l) => l.seqMs);
	const lanesNear = (ms: number, radius: number): LaneEvent[] => {
		let lo = 0;
		let hi = laneMsSorted.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (laneMsSorted[mid]! < ms - radius) lo = mid + 1;
			else hi = mid;
		}
		const out: LaneEvent[] = [];
		for (let i = lo; i < laneMsSorted.length && laneMsSorted[i]! <= ms + radius; i++)
			out.push(laneEvents[i]!);
		return out;
	};

	// ── mix events in the range, attributed ───────────────────────────────────────────────────────────────────────
	const mixEvents = mixA.events.filter((e) => {
		const ms = renderMs0 + e.ms;
		return ms >= rangeStartMs && ms < rangeEndMs;
	});
	type Attributed = {
		e: ListenEvent;
		seqMs: number;
		owner: Owner | null;
		by: 'event' | 'level' | 'none';
		own: LaneEvent | null;
	};
	const attributed: Attributed[] = mixEvents.map((e) => {
		const seqMs = renderMs0 + e.ms;
		const radius = e.shape === 'swell' ? EXPLAIN_SWELL_MS : EXPLAIN_MS;
		// a hit is explained by a hit of a clip, a swell by a swell
		const cands = lanesNear(seqMs, radius).filter((c) => c.e.shape === e.shape);
		if (cands.length) {
			// the clip whose own event rises most (a flicker of a loud bed does not outrank a quiet hit), then the closest
			let best = cands[0]!;
			const score = (c: LaneEvent) => c.e.prominenceDb + c.e.contrastDb / 100;
			for (const c of cands)
				if (
					score(c) > score(best) ||
					(score(c) === score(best) && Math.abs(c.seqMs - seqMs) < Math.abs(best.seqMs - seqMs))
				)
					best = c;
			return {
				e,
				seqMs,
				owner: ownerOf(best.clip.clipId, best.clip.trackId),
				by: 'event' as const,
				own: best,
			};
		}
		// no own event: the clip loudest at that moment (its 10 ms peaks over the event's first 50 ms)
		let bestLane = -1;
		let bestDb = -90;
		laneA.forEach((a, li) => {
			const h0 = Math.floor(e.ms / 10);
			for (let h = h0; h < Math.min(a.hop10.count, h0 + 5); h++)
				if (a.hop10.peakDb[h]! > bestDb) {
					bestDb = a.hop10.peakDb[h]!;
					bestLane = li;
				}
		});
		const clip = bestLane >= 0 ? laneClipAt(lanes[bestLane]!, seqMs) : null;
		return clip
			? { e, seqMs, owner: ownerOf(clip.clipId, clip.trackId), by: 'level' as const, own: null }
			: { e, seqMs, owner: null, by: 'none' as const, own: null };
	});

	// ── picture events and their answers ──────────────────────────────────────────────────────────────────────────
	type Pic = Omit<SoundListenPictureEvent, 'status' | 'offsetMs' | 'at' | 'event' | 'nearestStrongMs'>;
	const pics: Pic[] = [];
	for (const p of pictureEditEvents(doc, seq.id, range))
		pics.push({ kind: p.kind, key: p.key, frame: p.frame, timecode: tc(p.frame), label: p.label });
	for (const c of cues) {
		if (c.muted || c.frame < range.start || c.frame >= range.end) continue;
		pics.push({
			kind: 'cue',
			key: `cue:${c.id}`,
			frame: c.frame,
			timecode: tc(c.frame),
			label: `cue ${c.kind} (${c.weight})${c.label ? ` ${q(c.label, 40)}` : ''}`,
			cueId: c.id,
			weight: c.weight,
		});
	}
	let motionAnalysed = false;
	let beatsMs: number[] | null = null;
	if (env.engineCues) {
		try {
			const got = await env.engineCues.collect(doc, seq, {
				sources: ['pixel'],
				snapToBeats: true,
				mode: { kind: 'cached' },
				range: { start: range.start, end: range.end },
				...(env.signal ? { signal: env.signal } : {}),
			});
			motionAnalysed = got.pixelCurves.length > 0 || got.analysis.pixel?.state === 'ready';
			for (const x of got.extraCues) {
				if (!Number.isInteger(x.frame) || x.frame < range.start || x.frame >= range.end) continue;
				pics.push({
					kind: 'motion',
					key: `motion:${x.kind}:${x.frame}`,
					frame: x.frame,
					timecode: tc(x.frame),
					label: `picture ${x.kind}${x.reason ? `: ${x.reason.slice(0, 80)}` : ''}`,
				});
			}
			if (got.beatFrames && got.beatFrames.length > 1) beatsMs = got.beatFrames.map(msOfFrame);
		} catch (e) {
			warnings.push({
				code: 'W_ENGINE_SOURCES',
				message: `Measured picture motion and beats were not read: ${(e as Error).message}`.slice(0, 300),
			});
		}
	}
	pics.sort((a, b) => a.frame - b.frame || (a.key < b.key ? -1 : 1));
	// an attributed event starts at the earlier of the clip's own attack (measured without the other clips, whose bed
	// can hide its first milliseconds) and the attack the mix shows (`mixMs`)
	const timeOf = (x: Attributed) =>
		x.own && x.own.e.shape === x.e.shape ? Math.min(x.own.seqMs, x.seqMs) : x.seqMs;
	const peakOf = (x: Attributed) =>
		renderMs0 + (x.own && x.own.e.shape === x.e.shape ? x.own.e.peakMs : x.e.peakMs);
	const ix = syncIndex(attributed.map((x) => ({ ...x.e, ms: timeOf(x), peakMs: peakOf(x) })));
	const answers: PictureAnswer[] = pics.map((p) => answerPictureEvent(ix, msOfFrame(p.frame), frameMs));
	const pictureEvents: SoundListenPictureEvent[] = pics.map((p, i) => ({
		...p,
		status: answers[i]!.status,
		offsetMs: answers[i]!.offsetMs,
		at: answers[i]!.at,
		event: answers[i]!.event,
		nearestStrongMs: answers[i]!.nearestStrongMs,
	}));
	const statsOf = (pred: (p: Pic) => boolean): SoundListenSyncStats | null => {
		const sel = pics.map((p, i) => ({ p, i })).filter(({ p }) => pred(p));
		return syncStats(
			ix,
			sel.map(({ p }) => msOfFrame(p.frame)),
			sel.map(({ i }) => answers[i]!),
			frameMs,
			beatsMs,
		);
	};
	const sync: SoundListenResult['sync'] = {
		cuts: statsOf((p) => p.kind === 'cut'),
		transitions: statsOf((p) => p.kind === 'transition'),
		cues: statsOf((p) => p.kind === 'cue'),
		motion: statsOf((p) => p.kind === 'motion'),
		all: statsOf(() => true),
		beatsKnown: !!beatsMs,
		motionAnalysed,
	};

	// ── events (output) ───────────────────────────────────────────────────────────────────────────────────────────
	const answersOf = new Map<
		number,
		{ key: string; status: PictureAnswer['status']; offsetMs: number; at: 'attack' | 'peak' }[]
	>();
	pictureEvents.forEach((p) => {
		if (p.event === null || p.status === 'none') return;
		const list = answersOf.get(p.event) ?? [];
		list.push({ key: p.key, status: p.status, offsetMs: p.offsetMs ?? 0, at: p.at ?? 'attack' });
		answersOf.set(p.event, list);
	});
	const eventsAll: SoundListenEvent[] = attributed.map((x, i) => ({
		frame: frameOfMs(timeOf(x)),
		timecode: tc(frameOfMs(timeOf(x))),
		ms: r1(timeOf(x)),
		mixMs: r1(x.seqMs),
		peakMs: r1(peakOf(x)),
		shape: x.e.shape,
		band: x.e.band,
		prominenceDb: x.e.prominenceDb,
		bedDb: r1(x.e.bedDb + (x.e.bedDb > -80 ? gain : 0)),
		contrastDb: x.e.contrastDb,
		lengthMs: x.e.lengthMs,
		peakDb: r1(x.e.peakDb + (x.e.peakDb > -120 ? gain : 0)),
		...(x.e.riseMs !== undefined ? { riseMs: x.e.riseMs } : {}),
		accent: x.e.accent,
		guided: x.e.guided === true,
		stem: x.owner?.stem ?? null,
		clipId: x.owner?.clipId ?? null,
		track: x.owner?.track ?? null,
		clipName: x.owner?.name ?? null,
		cueId: x.owner?.cueId ?? null,
		cueKind: x.owner?.cueKind ?? null,
		role: x.owner?.role ?? null,
		explainedBy: x.by,
		answers: answersOf.get(i) ?? [],
	}));

	// ── placed sounds ─────────────────────────────────────────────────────────────────────────────────────────────
	const placed: SoundListenPlaced[] = [];
	for (const c of Object.values(seq.clips).sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1))) {
		if (c.kind !== 'audio' || !isSfxClip(c)) continue;
		if (!(c.start < range.end && c.start + c.duration > range.start)) continue;
		const a = c as AudioClip & { sfx?: unknown };
		const sfx = a.sfx !== undefined ? readClipSfx(a.sfx) : null;
		const into = sfx?.placement ? (sfx.placement.peakFlicks - a.sourceIn) / (a.speed?.rate || 1) / F : null;
		const alignedFrame = into === null ? null : a.start + (a.speed?.reverse ? a.duration - into : into);
		const alignedMs = alignedFrame === null ? null : msOfFrame(alignedFrame);
		const ref = alignedMs ?? msOfFrame(c.start);
		// its own event: the one whose moment is nearest the aligned point — the attack of a start-aligned sound, the
		// peak (the descriptors' definition) of an end-aligned one (risers and reverses peak at their end), the attack
		// or the peak of a peak-aligned one (a hit's library peak is often its attack)
		const align = sfx?.placement?.align ?? null;
		const momentOf = (l: LaneEvent) => {
			const peak = renderMs0 + l.e.peakMs;
			if (align === 'start') return l.seqMs;
			if (align === 'end') return peak;
			return Math.abs(l.seqMs - ref) <= Math.abs(peak - ref) ? l.seqMs : peak;
		};
		const own = laneEvents
			.filter((l) => l.clip.clipId === c.id && Math.abs(momentOf(l) - ref) <= OWN_MS)
			.sort((x, y) => Math.abs(momentOf(x) - ref) - Math.abs(momentOf(y) - ref))[0];
		const at = own?.seqMs ?? ref;
		let mixIdx: number | null = null;
		attributed.forEach((x, i) => {
			if (x.owner?.clipId !== c.id || Math.abs(x.seqMs - at) > HEARD_MS) return;
			if (mixIdx === null || Math.abs(x.seqMs - at) < Math.abs(attributed[mixIdx]!.seqMs - at)) mixIdx = i;
		});
		// events are ordered by their mix attack; the output keeps that order
		const o = ownerOf(c.id, c.trackId);
		placed.push({
			clipId: c.id,
			title: o.name,
			track: o.track ?? '',
			alignedMs: alignedMs === null ? null : r1(alignedMs),
			align: sfx?.placement?.align ?? null,
			cueId: o.cueId,
			role: o.role,
			ownEventMs: own ? r1(own.seqMs) : null,
			ownOffsetMs: own && alignedMs !== null ? r1(momentOf(own) - alignedMs) : null,
			heard: mixIdx !== null,
			mixEvent: mixIdx,
			prominenceDb: mixIdx !== null ? attributed[mixIdx]!.e.prominenceDb : null,
		});
	}

	// ── sections ──────────────────────────────────────────────────────────────────────────────────────────────────
	const mixCurve = curvesOf(mixA);
	const mixMom = loudnessCurve(mixCurve, 0.4, gain);
	const momOf = (s: 'dialogue' | 'music' | 'ambience' | 'sfx') => loudnessCurve(stemCurves[s], 0.4, gain);
	const mom = {
		dialogue: momOf('dialogue'),
		music: momOf('music'),
		ambience: momOf('ambience'),
		sfx: momOf('sfx'),
	};
	// speech: transcript words ∪ the dialogue stem's voice activity, gaps under 0.3 s bridged (as the check)
	const speech = new Uint8Array(rangeHops);
	try {
		for (const w of sequenceWords(doc, seq)) {
			const a = Math.max(0, Math.floor(((w.start / FLICKS_PER_SECOND) * sr - rangeStart) / hop));
			const b = Math.min(rangeHops, Math.ceil(((w.end / FLICKS_PER_SECOND) * sr - rangeStart) / hop));
			for (let i = a; i < b; i++) speech[i] = 1;
		}
	} catch {
		// voice activity only
	}
	if (stems.dialogue.size > 0) {
		const db = stemCurves.dialogue.msDb.subarray(preHops, preHops + rangeHops);
		const th = Math.max(vadThreshold(db), VAD_FLOOR_DBFS);
		for (let i = 0; i < db.length; i++) if (db[i]! >= th) speech[i] = 1;
	}
	for (let i = 0, last = -1; i < rangeHops; i++)
		if (speech[i]) {
			if (last >= 0 && i - last > 1 && i - last <= 30) for (let k = last + 1; k < i; k++) speech[k] = 1;
			last = i;
		}
	const silentHop = new Uint8Array(rangeHops);
	for (const s of mixA.silences) {
		const a = Math.max(0, Math.floor(s.startMs / 10) - preHops);
		const b = Math.min(rangeHops, Math.ceil(s.endMs / 10) - preHops);
		for (let i = a; i < b; i++) silentHop[i] = 1;
	}
	const audible = (v: number, mix: number) => v > AUDIBLE_LUFS && v >= mix - AUDIBLE_UNDER_LU;
	const labelOfHop = (i: number): string => {
		const k = preHops + i;
		if (silentHop[i]) return 'silence';
		const m = mixMom[k]!;
		const set: string[] = [];
		if (speech[i] && stems.dialogue.size > 0) set.push('dialogue');
		if (audible(mom.music[k]!, m)) set.push('music');
		if (audible(mom.ambience[k]!, m)) set.push('ambience');
		if (!set.length) set.push(audible(mom.sfx[k]!, m) ? 'effects' : m > AUDIBLE_LUFS ? 'other' : 'silence');
		return set.join('+');
	};
	type Run = { a: number; b: number; key: string };
	let runs: Run[] = [];
	for (let i = 0; i < rangeHops; i++) {
		const key = labelOfHop(i);
		const last = runs[runs.length - 1];
		if (last && last.key === key) last.b = i + 1;
		else runs.push({ a: i, b: i + 1, key });
	}
	// fold short runs into their longer neighbour, shortest first
	for (;;) {
		let k = -1;
		for (let i = 0; i < runs.length; i++)
			if (
				runs[i]!.b - runs[i]!.a < MIN_SECTION_HOPS &&
				(k < 0 || runs[i]!.b - runs[i]!.a < runs[k]!.b - runs[k]!.a)
			)
				k = i;
		if (k < 0 || runs.length === 1) break;
		const prev = runs[k - 1];
		const next = runs[k + 1];
		const into = !prev ? next! : !next ? prev : prev.b - prev.a >= next.b - next.a ? prev : next;
		into.a = Math.min(into.a, runs[k]!.a);
		into.b = Math.max(into.b, runs[k]!.b);
		runs.splice(k, 1);
		const merged: Run[] = [];
		for (const r of runs) {
			const l = merged[merged.length - 1];
			if (l && l.key === r.key) l.b = r.b;
			else merged.push(r);
		}
		runs = merged;
	}
	if (runs.length > MAX_SECTIONS) {
		warnings.push({
			code: 'W_SECTIONS_TRUNCATED',
			message: `Only the first ${MAX_SECTIONS} sections are listed`,
		});
		runs = runs.slice(0, MAX_SECTIONS);
	}
	const hopFrame = (i: number) =>
		Math.min(range.end, Math.max(range.start, Math.round(((rangeStart + i * hop) / sr) * fps)));
	const energyLufs = (c: StemCurves, a: number, b: number, use?: (i: number) => boolean): number | null => {
		let e = 0;
		let n = 0;
		for (let i = a; i < b; i++) {
			if (use && !use(i)) continue;
			e += c.kEnergy[preHops + i] ?? 0;
			n++;
		}
		if (!n || !(e > 0)) return null;
		return -0.691 + 10 * Math.log10(e / (n * c.hop)) + gain;
	};
	const musicClipsIn = (aF: number, bF: number) =>
		[...stems.music]
			.map((id) => seq.clips[id] as AudioClip | undefined)
			.filter((c): c is AudioClip => !!c && c.start < bF && c.start + c.duration > aF);
	const sections: SoundListenSection[] = runs.map((r) => {
		const classes = r.key.split('+') as SoundListenSection['classes'];
		const start = hopFrame(r.a);
		const end = Math.max(start + 1, hopFrame(r.b));
		const lufs = energyLufs(mixCurve, r.a, r.b);
		let music: SoundListenSection['music'];
		let musicText = '';
		if (classes.includes('music')) {
			const ducks = musicClipsIn(start, end)
				.map((c) => readEssentialSound(c.essential))
				.filter((es) => es?.ducking.enabled)
				.map((es) => es!.ducking.reduceDb);
			const duckDb = ducks.length ? Math.min(...ducks) : null;
			let underVoiceLu: number | null = null;
			if (classes.includes('dialogue')) {
				const v = energyLufs(stemCurves.dialogue, r.a, r.b, (i) => speech[i] === 1);
				const m = energyLufs(stemCurves.music, r.a, r.b, (i) => speech[i] === 1);
				if (v !== null && m !== null) underVoiceLu = r1(v - m);
			}
			music = { duckDb: duckDb === null ? null : r1(duckDb), underVoiceLu };
			const parts: string[] = [];
			if (duckDb !== null) parts.push(`ducked ${signed(duckDb, 'dB')}`);
			else if (classes.includes('dialogue')) parts.push('not ducked');
			if (underVoiceLu !== null)
				parts.push(
					`${Math.abs(underVoiceLu).toFixed(0)} LU ${underVoiceLu >= 0 ? 'under' : 'over'} the voice`,
				);
			if (parts.length) musicText = ` (music ${parts.join(', ')})`;
		}
		const names = classes.map((c) =>
			c === 'effects' ? 'effects only' : c === 'other' ? 'untyped audio' : c,
		);
		return {
			start,
			end,
			startTimecode: tc(start),
			endTimecode: tc(end),
			classes,
			label: `${names.join(' + ')}${musicText}`,
			lufs: lufs === null ? null : r1(lufs),
			...(music ? { music } : {}),
		};
	});

	// ── silences, loudness ────────────────────────────────────────────────────────────────────────────────────────
	const silences = mixA.silences
		.map((s) => ({ ...s, a: renderMs0 + s.startMs, b: renderMs0 + s.endMs }))
		.filter((s) => s.b > rangeStartMs && s.a < rangeEndMs)
		.map((s) => {
			const a = Math.max(s.a, rangeStartMs);
			const b = Math.min(s.b, rangeEndMs);
			return {
				start: frameOfMs(a),
				end: Math.max(frameOfMs(a) + 1, Math.ceil((b / 1000) * fps - 1e-6)),
				startTimecode: tc(frameOfMs(a)),
				kind: s.kind,
				levelLufs: r1(s.levelLufs + (s.levelLufs > -70 ? gain : 0)),
				seconds: Math.round(b - a) / 1000,
			};
		});
	const inRange = mixCurve.kEnergy.subarray(preHops, preHops + rangeHops);
	const integrated = integratedOf(inRange, mixCurve.hop);
	const st = loudnessCurve(mixCurve, 3, gain);
	const maxOf = (c: Float32Array) => {
		let best = -1;
		for (let i = preHops; i < Math.min(c.length, preHops + rangeHops); i++)
			if (best < 0 || c[i]! > c[best]!) best = i;
		return best >= 0 && c[best]! > -70 ? { v: r1(c[best]!), f: hopFrame(best - preHops) } : null;
	};
	const mm = maxOf(mixMom);
	const ms3 = maxOf(st);
	const loudness: SoundListenResult['loudness'] = {
		integratedLufs: integrated === null ? null : r1(integrated + gain),
		maxMomentaryLufs: mm?.v ?? null,
		maxMomentaryFrame: mm?.f ?? null,
		maxShortTermLufs: ms3?.v ?? null,
		maxShortTermFrame: ms3?.f ?? null,
		normalization: {
			applied: norm.applied,
			gainDb: r1(gain),
			...(norm.reason ? { reason: norm.reason } : {}),
		},
	};

	// ── the transcript ────────────────────────────────────────────────────────────────────────────────────────────
	// normal: what a placed sound or the picture is about — each placed sound's own event in the mix, every event
	// answering the picture, every one rising ≥ 6 dB (the flicker inside a sound's tail is left to "high")
	const placedEvents = new Set(placed.map((p) => p.mixEvent).filter((i): i is number => i !== null));
	const keepEvent = (e: SoundListenEvent, i: number): boolean =>
		detail === 'high' ||
		e.accent ||
		(detail === 'normal' && (placedEvents.has(i) || e.answers.length > 0 || e.prominenceDb >= 6));
	const lines: SoundListenLine[] = [];
	const at = (
		frame: number,
		kind: SoundListenLine['kind'],
		text: string,
		extra: Partial<SoundListenLine> = {},
	) => lines.push({ frame, timecode: tc(frame), kind, text, ...extra });
	const accents = eventsAll.filter((e) => e.accent).length;
	const swells = eventsAll.filter((e) => e.shape === 'swell').length;
	const unanswered = pictureEvents.filter((p) => p.status === 'none');
	at(
		range.start,
		'summary',
		`Listened ${tc(range.start)}–${tc(range.end)}: ${plural(eventsAll.length, 'sound event')} (${plural(accents, 'accent')}, ${plural(swells, 'swell')}), ${plural(sections.length, 'section')}, ${plural(silences.length, 'silence')}; integrated ${loudness.integratedLufs === null ? 'not measurable' : `${loudness.integratedLufs.toFixed(1)} LUFS`}${norm.applied ? ' as delivered' : ' as mixed'}.`,
	);
	const syncLine = (name: string, s: SoundListenSyncStats | null) => {
		if (!s) return;
		const parts = [
			`${s.ok}/${s.n} have a sound within 1 frame (${pct(s.okShare)}; chance ${pct(s.okChance)})`,
			`${s.ok + s.near}/${s.n} within 100 ms (${pct(s.within100Share)}; chance ${pct(s.within100Chance)})`,
		];
		if (s.accentOkShare !== null && s.accentOkChance !== null)
			parts.push(`an accent within 1 frame ${pct(s.accentOkShare)} (chance ${pct(s.accentOkChance)})`);
		if (s.swell) parts.push(`${s.swell} answered by a swell`);
		if (s.onBeatShare !== null && s.onBeatChance !== null)
			parts.push(`on the beat ${pct(s.onBeatShare)} (chance ${pct(s.onBeatChance)})`);
		at(range.start, 'sync', `Sync, ${name}: ${parts.join('; ')}.`);
	};
	syncLine('cuts', sync.cuts);
	syncLine('transitions', sync.transitions);
	syncLine('cues', sync.cues);
	syncLine('measured picture motion', sync.motion);
	if (!pics.length)
		at(range.start, 'sync', 'Sync: no cuts, transitions, cues or measured picture motion in the range.');
	if (!motionAnalysed)
		at(
			range.start,
			'note',
			'Footage motion is not analysed for this range: run analyze_picture_motion to match sounds to what moves on screen.',
		);
	type Row = { ms: number; order: number; line: Omit<SoundListenLine, 'timecode'> };
	const rows: Row[] = [];
	for (const s of sections)
		rows.push({
			ms: msOfFrame(s.start),
			order: 0,
			line: {
				frame: s.start,
				kind: 'section',
				text: `== ${s.label} until ${s.endTimecode}${s.lufs !== null ? ` · ${s.lufs.toFixed(0)} LUFS` : ''}`,
			},
		});
	for (const s of silences)
		rows.push({
			ms: msOfFrame(s.start),
			order: 1,
			line: {
				frame: s.start,
				kind: 'silence',
				text: `${s.kind} ${s.seconds.toFixed(2)} s (${s.levelLufs <= -70 ? 'under −70' : s.levelLufs.toFixed(0)} LUFS)`,
			},
		});
	const pictureLabel = new Map(pictureEvents.map((p) => [p.key, p.label]));
	eventsAll.forEach((e, i) => {
		if (!keepEvent(e, i)) return;
		const what =
			e.shape === 'swell'
				? `swell (build-up), ${e.band} band, rises ${e.prominenceDb.toFixed(0)} dB over ${((e.riseMs ?? 0) / 1000).toFixed(1)} s`
				: `hit, ${e.band} band, ${e.bedDb > -60 ? `${signed(e.prominenceDb, 'dB')} over the bed` : `${signed(e.prominenceDb, 'dB')} out of silence`}`;
		const who = (() => {
			if (!e.clipId) return 'not attributed to a clip';
			const kind = e.stem === 'sfx' ? 'SFX' : e.stem === 'other' ? 'production audio,' : `${e.stem},`;
			const extra = [e.role, e.cueKind ? `cue ${e.cueKind}` : null].filter(Boolean).join(', ');
			return `${kind} ${e.track ?? '?'} ${q(e.clipName ?? e.clipId)}${extra ? ` (${extra})` : ''}${e.explainedBy === 'level' ? ' — loudest there, no event of its own' : ''}`;
		})();
		const ans = e.answers
			.map(
				(a) =>
					`answers ${pictureLabel.get(a.key) ?? a.key}, ${signed(a.offsetMs, 'ms')}${a.at === 'peak' && e.shape === 'hit' ? ' at its peak' : ''}${a.status === 'ok' ? '' : ` (${a.status})`}`,
			)
			.join('; ');
		rows.push({
			ms: e.ms,
			order: 2,
			line: {
				frame: e.frame,
				kind: 'event',
				text: `${what}${e.accent ? ' · accent' : ''} · ${who}${ans ? ` · ${ans}` : ''}`,
				event: i,
			},
		});
	});
	for (const p of unanswered)
		rows.push({
			ms: msOfFrame(p.frame),
			order: 3,
			line: {
				frame: p.frame,
				kind: 'unanswered',
				text: `NO SOUND for ${p.label}${p.nearestStrongMs !== null ? ` (a strong sound ${signed(p.nearestStrongMs, 'ms')})` : ' (nothing within 250 ms)'}`,
				key: p.key,
			},
		});
	rows.sort((a, b) => a.ms - b.ms || a.order - b.order);
	for (const r of rows)
		at(r.line.frame, r.line.kind, r.line.text, {
			...(r.line.event !== undefined ? { event: r.line.event } : {}),
			...(r.line.key !== undefined ? { key: r.line.key } : {}),
		});
	if (lines.length > SOUND_LISTEN_LIMITS.lines) {
		const dropped = lines.length - SOUND_LISTEN_LIMITS.lines + 1;
		lines.length = SOUND_LISTEN_LIMITS.lines - 1;
		at(range.end, 'note', `… ${dropped} more lines: listen to a shorter range or with detail "low".`);
		warnings.push({ code: 'W_LINES_TRUNCATED', message: `${dropped} transcript lines were left out` });
	}
	const events = eventsAll.slice(0, SOUND_LISTEN_LIMITS.events);
	if (events.length < eventsAll.length)
		warnings.push({
			code: 'W_EVENTS_TRUNCATED',
			message: `${eventsAll.length - events.length} events were left out: listen to a shorter range`,
		});
	if (mixA.truncated)
		warnings.push({ code: 'W_TRUNCATED', message: 'The range was cut at 2 hours of audio' });
	timings.analyseMs = Date.now() - td;
	timings.totalMs = Date.now() - t0;
	progress(1, 'Listened');
	return {
		projectId: opts.projectId,
		sequenceId: seq.id,
		revision: opts.revision,
		range: { start: range.start, end: range.end },
		rangeTimecode: { start: tc(range.start), end: tc(range.end) },
		wholeSequence: range.whole,
		fps: { num: rate.num, den: rate.den },
		detail,
		lines,
		text: lines.map((l) => `${l.timecode}  ${l.text}`).join('\n'),
		events,
		sections,
		silences,
		pictureEvents,
		unanswered,
		sync,
		placed,
		loudness,
		counts: {
			events: eventsAll.length,
			accents,
			swells,
			sections: sections.length,
			silences: silences.length,
			pictureEvents: pictureEvents.length,
			unanswered: unanswered.length,
			lanes: lanes.length,
			eventsDropped: eventsAll.length - events.length,
		},
		warnings,
		timings,
	};
}

// ── the job ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type SoundListenDeps = {
	agent: () => AgentService | undefined;
	ffmpeg: Ffmpeg;
	registry: Pick<MediaRegistry, 'get' | 'resolvePath'>;
	engineCues?: () => EngineCueSources | undefined;
	/** The sequence's last kept Sound Check report (its normalisation gain is the export's when it measured this mix). */
	lastCheckReport?: (projectId: string, sequenceId: string) => Promise<SoundCheckReport | null>;
	/** P6-E14 `tags`: the Describe-it search model's namer (absent: the sound library is not running). */
	nameWindows?: () => NameWindows | null;
};

/** The `sound-listen` job runner. */
export async function runSoundListen(ctx: JobContext, deps: SoundListenDeps): Promise<SoundListenResult> {
	try {
		const parsed = SoundListenRequestSchema.safeParse((ctx.input as { request?: unknown } | null)?.request);
		if (!parsed.success) throw new JobError('VALIDATION_FAILED', 'The listen request is invalid', false);
		const req = parsed.data;
		const agent = deps.agent();
		if (!agent) throw new JobError('NOT_AVAILABLE', 'The agent service is not running', true);
		ctx.progress(0.01, { stage: 'Reading the edit' });
		const live = await liveDocument(agent, req.projectId);
		const seq = planSequence(live.doc, req.sequenceId);
		const result = await listenSequence(
			live.doc,
			seq,
			{ projectId: req.projectId, revision: live.revision, range: req.range, detail: req.detail },
			{
				ff: deps.ffmpeg,
				registry: deps.registry,
				engineCues: deps.engineCues?.(),
				checkReport: (await deps.lastCheckReport?.(req.projectId, seq.id).catch(() => null)) ?? null,
				signal: ctx.signal,
				onSpawn: ctx.trackChild,
				onProgress: (f, stage) => ctx.progress(0.02 + 0.97 * f, { stage }),
			},
		);
		ctx.log(`listen: ${JSON.stringify(result.counts)} ${JSON.stringify(result.timings)}`);
		if (!req.tags) return result;
		// P6-E14: name the events with the Describe-it search model; without it the transcript says why
		const namer = deps.nameWindows?.() ?? null;
		const unavailable = (why: string): SoundListenResult => ({
			...result,
			warnings: [
				...result.warnings,
				{ code: 'W_TAGS_UNAVAILABLE', message: `The sounds were not named: ${why}` },
			],
		});
		if (!namer) return unavailable('the sound library is not running');
		ctx.progress(0.99, { stage: 'Naming the sounds' });
		try {
			const t0 = Date.now();
			const tagged = await tagListenEvents(result, live.doc, deps.registry, namer, ctx.signal);
			ctx.log(`listen: named ${tagged.named} events in ${Date.now() - t0} ms`);
			return { ...tagged.result, timings: { ...tagged.result.timings, tagsMs: Date.now() - t0 } };
		} catch (e) {
			if (ctx.signal.aborted) throw new JobError('CANCELLED', 'Cancelled', false);
			return unavailable((e as Error).message);
		}
	} catch (e) {
		if (e instanceof HttpError) throw new JobError(e.code, e.message, e.status === 503, e.detail);
		if (e instanceof PlanInputError) throw new JobError(e.code, e.message, false);
		if (e instanceof ListenInputError) throw new JobError(e.code, e.message, false);
		throw e;
	}
}
