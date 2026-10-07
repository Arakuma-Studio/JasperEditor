// Audio buses handlers (workstream audio-mix): see `schemas/audio.ts` and `audio/strip.ts`.
import type { Draft } from 'immer';
import { duckClipKeyframes } from '../../audio/ducking.ts';
import {
	clampLane,
	FADER_MAX_DB,
	FADER_MIN_DB,
	LANE_PAN,
	LANE_VOLUME,
	laneAnimatable,
	laneInfo,
	laneValueAt,
	MASTER_STRIP_ID,
	MAX_SENDS,
	pan51Default,
	parseSendLane,
	resolveStripRef,
	stripView,
	thinPoints,
	writeLaneKeyframes,
} from '../../audio/strip.ts';
import { contentTimeAt } from '../../derive/index.ts';
import { createTrack } from '../../factories.ts';
import { EASE_PRESETS, evaluate } from '../../keyframes.ts';
import { STRIP_LANES, type TrackSend } from '../../schema/audio.ts';
import type { Animatable, Keyframe } from '../../schema/common.ts';
import type { AudioClip, Clip, NestAudioClip, Track } from '../../schema/sequence.ts';
import { flicksPerFrame, type Rational } from '../../time.ts';
import type { DDoc, DSeq, HandlerContext } from '../context.ts';
import { assertUnlocked, findTrackIn } from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { type HandlerMap, idList } from './util.ts';

type DTrack = Draft<Track>;
type DAnim = Draft<Animatable<number>>;

const anim = (v: number): Animatable<number> => ({ value: v, keyframes: [] });

/** A strip of the sequence: the Mix (`track` null) or an audio / submix track draft. */
function strip(
	seq: DSeq,
	ref: string,
	h: HandlerContext,
): { id: string; track: DTrack | null; submix: boolean } {
	const id = resolveStripRef(seq as never, ref);
	if (!id) return h.fail('E_NOT_FOUND', `Mixer strip not found: ${ref}`);
	if (id === MASTER_STRIP_ID) return { id, track: null, submix: false };
	const a = seq.audioTracks.find((t) => t.id === id);
	if (a) return { id, track: a, submix: false };
	const s = (seq.submixTracks ?? []).find((t) => t.id === id);
	if (s) return { id, track: s, submix: true };
	return h.fail('E_NOT_FOUND', `Mixer strip not found: ${ref}`);
}

function submixIndex(seq: DSeq, id: string): number {
	return (seq.submixTracks ?? []).findIndex((t) => t.id === id);
}

/** Validates that `target` (a submix id) can receive from strip `src` without feedback. */
function checkRoute(seq: DSeq, src: string, target: string, h: HandlerContext, what: string): void {
	const ti = submixIndex(seq, target);
	if (ti < 0) h.fail('E_INVALID_PARAM', `${what} must be a submix or the Mix`);
	if (target === src) h.fail('E_INVALID_PARAM', `A strip cannot feed itself`);
	const si = submixIndex(seq, src);
	if (si >= 0 && ti <= si)
		h.fail(
			'E_INVALID_PARAM',
			`A submix can only feed a submix after it (S${si + 1} → S${ti + 1} would loop)`,
		);
}

function validAnim(v: number | Animatable<number>, min: number, max: number, key: string, h: HandlerContext) {
	const val = typeof v === 'number' ? anim(v) : (JSON.parse(JSON.stringify(v)) as Animatable<number>);
	const bad = [val.value, ...val.keyframes.map((k) => k.value)].some((x) => !(x >= min && x <= max));
	if (bad) h.fail('E_INVALID_PARAM', `${key} must be within ${min}..${max}`);
	val.keyframes.sort((a, b) => a.time - b.time);
	return val;
}

function newKeyframe(h: HandlerContext, time: number, value: number, hold: boolean): Keyframe<number> {
	return {
		id: h.ids.next('kf'),
		time,
		value,
		interpolation: hold ? 'hold' : 'linear',
		easeIn: { ...EASE_PRESETS.linear },
		easeOut: { ...EASE_PRESETS.linear },
	};
}

/** Puts a keyframe at `time` (replacing one at the same time). */
function putKeyframe(a: DAnim, k: Keyframe<number>): void {
	const i = a.keyframes.findIndex((x) => x.time === k.time);
	if (i >= 0) a.keyframes[i]!.value = k.value;
	else {
		a.keyframes.push(k as Draft<Keyframe<number>>);
		a.keyframes.sort((x, y) => x.time - y.time);
	}
}

/** The writable animatable of a lane (created from its static value when missing). */
function laneTarget(seq: DSeq, s: ReturnType<typeof strip>, lane: string, h: HandlerContext): DAnim {
	if (!laneInfo(lane)) h.fail('E_INVALID_PARAM', `Unknown mixer lane: ${lane}`);
	if (!s.track) {
		if (lane !== LANE_VOLUME) h.fail('E_INVALID_PARAM', `The Mix has no ${lane} lane`);
		return seq.master.volumeDb as DAnim;
	}
	const t = s.track;
	if (lane === LANE_VOLUME) {
		t.volumeDb ??= anim(0);
		return t.volumeDb as DAnim;
	}
	if (lane === LANE_PAN) {
		t.pan ??= anim(0);
		return t.pan as DAnim;
	}
	const send = parseSendLane(lane);
	if (send) {
		const x = t.mixer?.sends?.find((y) => y.id === send);
		if (!x) return h.fail('E_NOT_FOUND', `Send not found: ${send}`);
		return x.levelDb as DAnim;
	}
	if (!(STRIP_LANES as readonly string[]).includes(lane))
		h.fail('E_INVALID_PARAM', `Unknown mixer lane: ${lane}`);
	t.mixer ??= {};
	t.mixer.lanes ??= {};
	if (!t.mixer.lanes[lane]) {
		const d = lane === 'mute' ? (t.mute ? 1 : 0) : (pan51Default(lane, t.channelFormat ?? 'stereo') ?? 0);
		t.mixer.lanes[lane] = anim(d);
	}
	return t.mixer.lanes[lane] as DAnim;
}

/** Static value written to the model fields that mirror a lane (`Track.mute`). */
function setStatic(s: ReturnType<typeof strip>, lane: string, a: DAnim, v: number): void {
	a.value = v;
	if (lane === 'mute' && s.track) s.track.mute = v >= 0.5;
}

function stripOrFail(seq: DSeq, id: string, h: HandlerContext) {
	const v = stripView(seq as never, id);
	if (!v) return h.fail('E_NOT_FOUND', `Mixer strip not found: ${id}`);
	return v;
}

function laneValue(seq: DSeq, id: string, lane: string, t: number): number {
	const v = stripView(seq as never, id);
	return v ? laneValueAt(v, lane, t) : 0;
}

function defaultTolerance(lane: string): number {
	return lane === LANE_PAN || lane.startsWith('pan51.') || lane === 'pan' ? 0.25 : 0.05;
}

/** One sample at the sequence rate, in flicks (the gap between a written range and what is kept). */
function epsFlicks(seq: DSeq): number {
	const sr = (seq.settings.audioSampleRate as number | undefined) ?? 48000;
	return Math.max(1, Math.round(705_600_000 / sr));
}

function isAudioClip(c: Clip): c is AudioClip | NestAudioClip {
	return c.kind === 'audio' || c.kind === 'nest-audio';
}

/** Sequence flicks → content flicks of a clip (fractional frames allowed). */
function contentAt(c: Clip, seqFlicks: number, rate: Rational): number {
	return Math.round(contentTimeAt(c, seqFlicks / flicksPerFrame(rate), rate));
}

export const AUDIO_MIX_OWNER = 'audio-mix' as const;

export const audioHandlers: HandlerMap = {
	'mixer.updateStrip': (doc: DDoc, cmd: CommandOf<'mixer.updateStrip'>, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const s = strip(seq, cmd.stripId, h);
		const p = cmd.patch;
		if (!s.track) {
			for (const k of Object.keys(p))
				if (!['automation', 'volumeDb', 'channelFormat'].includes(k))
					h.fail('E_INVALID_PARAM', `The Mix has no ${k}`);
			if (p.automation !== undefined) {
				seq.master.mixer ??= {};
				seq.master.mixer.automation = p.automation;
			}
			if (p.volumeDb !== undefined)
				seq.master.volumeDb = validAnim(p.volumeDb, FADER_MIN_DB, FADER_MAX_DB, 'volumeDb', h) as never;
			if (p.channelFormat !== undefined) seq.settings.masterLayout = p.channelFormat;
			return { stripId: s.id };
		}
		const t = s.track;
		if (p.name !== undefined) t.name = p.name;
		if (p.automation !== undefined) (t.mixer ??= {}).automation = p.automation;
		if (p.clipAutomation !== undefined) {
			if (s.submix) h.fail('E_INVALID_PARAM', 'Submixes have no clips (Audio Clip Mixer)');
			(t.mixer ??= {}).clipAutomation = p.clipAutomation;
		}
		if (p.output !== undefined) {
			const out = p.output === null ? MASTER_STRIP_ID : resolveStripRef(seq as never, p.output);
			if (!out) h.fail('E_NOT_FOUND', `Output not found: ${p.output}`);
			if (out !== MASTER_STRIP_ID) checkRoute(seq, s.id, out!, h, 'The output');
			t.mixer ??= {};
			if (out === MASTER_STRIP_ID) delete t.mixer.output;
			else t.mixer.output = out!;
		}
		if (p.recordArm !== undefined) {
			if (s.submix) h.fail('E_INVALID_PARAM', 'Submixes cannot record');
			(t.mixer ??= {}).recordArm = p.recordArm;
		}
		if (p.soloSafe !== undefined) (t.mixer ??= {}).soloSafe = p.soloSafe;
		if (p.inputMap !== undefined) (t.mixer ??= {}).inputMap = p.inputMap;
		if (p.channelFormat !== undefined) t.channelFormat = p.channelFormat;
		if (p.mute !== undefined) {
			t.mute = p.mute;
			const lane = t.mixer?.lanes?.mute;
			if (lane) lane.value = p.mute ? 1 : 0;
		}
		if (p.solo !== undefined) t.solo = p.solo;
		if (p.volumeDb !== undefined)
			t.volumeDb = validAnim(p.volumeDb, FADER_MIN_DB, FADER_MAX_DB, 'volumeDb', h) as never;
		if (p.pan !== undefined) t.pan = validAnim(p.pan, -100, 100, 'pan', h) as never;
		return { stripId: s.id };
	},

	'mixer.addSubmix': (doc, cmd: CommandOf<'mixer.addSubmix'>, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		seq.submixTracks ??= [];
		const t = createTrack(h.ids, 'audio', cmd.name ?? null);
		t.channelFormat = cmd.channelFormat ?? 'stereo';
		const index = Math.min(cmd.index ?? seq.submixTracks.length, seq.submixTracks.length);
		// Inserting before existing submixes must not create backward routes: shift is safe (order kept).
		seq.submixTracks.splice(index, 0, t as DTrack);
		h.defineRef(cmd.ref, t.id);
		return { stripId: t.id, label: `S${index + 1}` };
	},

	'mixer.removeSubmix': (doc, cmd: CommandOf<'mixer.removeSubmix'>, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const s = strip(seq, cmd.stripId, h);
		if (!s.submix || !s.track) return h.fail('E_INVALID_PARAM', `${cmd.stripId} is not a submix`);
		const gone = s.track;
		const next = gone.mixer?.output ?? null;
		for (const t of [...seq.audioTracks, ...(seq.submixTracks ?? [])]) {
			if (t.id === gone.id || !t.mixer) continue;
			// Strips that fed the removed submix now feed where it went (the Mix or a later submix).
			if (t.mixer.output === gone.id) {
				if (next) t.mixer.output = next;
				else delete t.mixer.output;
			}
			if (t.mixer.sends) t.mixer.sends = t.mixer.sends.filter((x) => x.target !== gone.id);
		}
		seq.submixTracks = (seq.submixTracks ?? []).filter((t) => t.id !== gone.id);
		return { stripId: gone.id };
	},

	'mixer.addSend': (doc, cmd: CommandOf<'mixer.addSend'>, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const s = strip(seq, cmd.stripId, h);
		if (!s.track) return h.fail('E_INVALID_PARAM', 'The Mix has no sends');
		const target = resolveStripRef(seq as never, cmd.target);
		if (!target) return h.fail('E_NOT_FOUND', `Send target not found: ${cmd.target}`);
		checkRoute(seq, s.id, target, h, 'The send target');
		s.track.mixer ??= {};
		s.track.mixer.sends ??= [];
		if (s.track.mixer.sends.length >= MAX_SENDS)
			h.fail('E_INVALID_PARAM', `All ${MAX_SENDS} send slots are in use`);
		const send: TrackSend = {
			id: h.ids.next('snd'),
			target,
			levelDb: anim(cmd.levelDb ?? 0),
			...(cmd.pan ? { pan: cmd.pan } : {}),
			...(cmd.preFader ? { preFader: true } : {}),
		};
		s.track.mixer.sends.push(send as Draft<TrackSend>);
		h.defineRef(cmd.ref, send.id);
		return { sendId: send.id };
	},

	'mixer.updateSend': (doc, cmd: CommandOf<'mixer.updateSend'>, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const s = strip(seq, cmd.stripId, h);
		const x = s.track?.mixer?.sends?.find((y) => y.id === cmd.sendId);
		if (!x) return h.fail('E_NOT_FOUND', `Send not found: ${cmd.sendId}`);
		const p = cmd.patch;
		if (p.target !== undefined) {
			const target = resolveStripRef(seq as never, p.target);
			if (!target) return h.fail('E_NOT_FOUND', `Send target not found: ${p.target}`);
			checkRoute(seq, s.id, target, h, 'The send target');
			x.target = target;
		}
		if (p.levelDb !== undefined)
			x.levelDb = validAnim(p.levelDb, FADER_MIN_DB, FADER_MAX_DB, 'levelDb', h) as never;
		if (p.pan !== undefined) x.pan = p.pan;
		if (p.preFader !== undefined) x.preFader = p.preFader;
		if (p.mute !== undefined) x.mute = p.mute;
		return { sendId: x.id };
	},

	'mixer.removeSend': (doc, cmd: CommandOf<'mixer.removeSend'>, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const s = strip(seq, cmd.stripId, h);
		const sends = s.track?.mixer?.sends;
		const i = sends?.findIndex((y) => y.id === cmd.sendId) ?? -1;
		if (!sends || i < 0) return h.fail('E_NOT_FOUND', `Send not found: ${cmd.sendId}`);
		sends.splice(i, 1);
		return { sendId: cmd.sendId };
	},

	'mixer.setInsertPosition': (doc, cmd: CommandOf<'mixer.setInsertPosition'>, h) => {
		for (const seq of Object.values(doc.sequences)) {
			const lists = [
				...seq.audioTracks.map((t) => ({ list: t.effects, track: t as DTrack | null })),
				...(seq.submixTracks ?? []).map((t) => ({ list: t.effects, track: t as DTrack | null })),
				{ list: seq.master.effects, track: null },
			];
			for (const { list, track } of lists) {
				const fx = list?.find((e) => e.id === cmd.effectInstanceId);
				if (!fx) continue;
				if (track) assertUnlocked(track, h);
				if (cmd.postFader) fx.postFader = true;
				else delete fx.postFader;
				return { effectInstanceId: fx.id, postFader: cmd.postFader };
			}
		}
		return h.fail('E_NOT_FOUND', `No track or Mix insert ${cmd.effectInstanceId}`);
	},

	'mixer.setLane': (doc, cmd: CommandOf<'mixer.setLane'>, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const s = strip(seq, cmd.stripId, h);
		if (s.track) assertUnlocked(s.track, h);
		const a = laneTarget(seq, s, cmd.lane, h);
		const v = clampLane(cmd.lane, cmd.value);
		const hold = !!laneInfo(cmd.lane)?.hold;
		if (cmd.keyframe || (a.keyframes.length > 0 && cmd.time !== undefined)) {
			if (cmd.time === undefined) h.fail('E_INVALID_PARAM', 'A keyframe needs `time` (sequence flicks)');
			putKeyframe(a, newKeyframe(h, cmd.time!, v, hold));
		} else setStatic(s, cmd.lane, a, v);
		return { value: v };
	},

	'mixer.clearLane': (doc, cmd: CommandOf<'mixer.clearLane'>, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const s = strip(seq, cmd.stripId, h);
		if (s.track) assertUnlocked(s.track, h);
		const a = laneTarget(seq, s, cmd.lane, h);
		const n = a.keyframes.length;
		a.keyframes = [];
		return { removed: n };
	},

	'mixer.writeAutomation': (doc, cmd: CommandOf<'mixer.writeAutomation'>, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const s = strip(seq, cmd.stripId, h);
		if (s.track) assertUnlocked(s.track, h);
		const info = laneInfo(cmd.lane);
		if (!info) return h.fail('E_INVALID_PARAM', `Unknown mixer lane: ${cmd.lane}`);
		const pts = cmd.points
			.map(([t, v]) => [t, clampLane(cmd.lane, v)] as [number, number])
			.sort((a, b) => a[0] - b[0]);
		const t0 = pts[0]![0];
		const t1 = pts[pts.length - 1]![0];
		const eps = epsFlicks(seq);
		// Lane values just outside the range, before writing (automation outside the pass is kept).
		const view = stripOrFail(seq, s.id, h);
		const existing = laneAnimatable(view, cmd.lane);
		const before =
			t0 > 0 && existing && existing.keyframes.length ? laneValue(seq, s.id, cmd.lane, t0 - eps) : null;
		const after = existing?.keyframes.some((k) => k.time > t1)
			? laneValue(seq, s.id, cmd.lane, t1 + eps)
			: null;
		const thinned = thinPoints(
			pts,
			info.hold ? 0 : (cmd.thinning?.tolerance ?? defaultTolerance(cmd.lane)),
			Math.round(((cmd.thinning?.minIntervalMs ?? 0) / 1000) * 705_600_000),
			info.hold,
		);
		const a = laneTarget(seq, s, cmd.lane, h);
		if (a.keyframes.length === 0) {
			// The static value stays what playback used outside the pass.
			a.value = existing?.value ?? a.value;
		}
		a.keyframes = writeLaneKeyframes(a as Animatable<number>, t0, t1, thinned, {
			before,
			after,
			eps,
			hold: info.hold,
			newId: () => h.ids.next('kf'),
		}) as never;
		return { keyframes: a.keyframes.length, written: thinned.length, from: t0, to: t1 };
	},

	'clipMixer.write': (doc, cmd: CommandOf<'clipMixer.write'>, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const s = strip(seq, cmd.trackId, h);
		if (!s.track || s.submix)
			return h.fail('E_INVALID_PARAM', 'The Audio Clip Mixer writes audio track clips');
		assertUnlocked(s.track, h);
		const rate = seq.settings.frameRate as Rational;
		const F = flicksPerFrame(rate);
		const range = cmd.lane === 'volume' ? [FADER_MIN_DB, FADER_MAX_DB] : [-100, 100];
		const pts = cmd.points
			.map(([t, v]) => [t, Math.min(range[1]!, Math.max(range[0]!, v))] as [number, number])
			.sort((a, b) => a[0] - b[0]);
		const t0 = pts[0]![0];
		const t1 = pts[pts.length - 1]![0];
		const thinned = thinPoints(
			pts,
			cmd.thinning?.tolerance ?? defaultTolerance(cmd.lane),
			Math.round(((cmd.thinning?.minIntervalMs ?? 0) / 1000) * 705_600_000),
			false,
		);
		let clips = 0;
		let keyframes = 0;
		for (const c of Object.values(seq.clips)) {
			if (c.trackId !== s.id || !c.enabled || !isAudioClip(c as Clip)) continue;
			const cs = c.start * F;
			const ce = (c.start + c.duration) * F;
			const a0 = Math.max(t0, cs);
			const a1 = Math.min(t1, ce - 1);
			if (a1 < a0) continue;
			const clip = c as Draft<AudioClip>;
			const prop = (cmd.lane === 'volume' ? clip.volumeDb : clip.pan) as DAnim;
			const before =
				a0 > cs ? evaluate(prop as Animatable<number>, contentAt(c as Clip, a0 - F / 4, rate)) : null;
			const after =
				a1 < ce - 1 ? evaluate(prop as Animatable<number>, contentAt(c as Clip, a1 + F / 4, rate)) : null;
			// The written range in content time (reversed clips run backwards).
			const k0 = contentAt(c as Clip, a0, rate);
			const k1 = contentAt(c as Clip, a1, rate);
			const lo = Math.min(k0, k1);
			const hi = Math.max(k0, k1);
			const inClip: [number, number][] = [[a0, interp(thinned, a0)]];
			for (const p of thinned) if (p[0] > a0 && p[0] < a1) inClip.push(p);
			if (a1 > a0) inClip.push([a1, interp(thinned, a1)]);
			const content = inClip.map(([t, v]) => [contentAt(c as Clip, t, rate), v] as [number, number]);
			content.sort((x, y) => x[0] - y[0]);
			const kf = writeLaneKeyframes(prop as Animatable<number>, lo, hi, content, {
				before: c.speed.reverse ? after : before,
				after: c.speed.reverse ? before : after,
				eps: Math.max(1, Math.round(epsFlicks(seq) * c.speed.rate)),
				hold: false,
				newId: () => h.ids.next('kf'),
			});
			prop.keyframes = kf as never;
			clips++;
			keyframes += kf.length;
		}
		return { clips, keyframes };
	},

	'clipMixer.set': (doc, cmd: CommandOf<'clipMixer.set'>, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const s = strip(seq, cmd.trackId, h);
		if (!s.track || s.submix)
			return h.fail('E_INVALID_PARAM', 'The Audio Clip Mixer writes audio track clips');
		assertUnlocked(s.track, h);
		const rate = seq.settings.frameRate as Rational;
		const F = flicksPerFrame(rate);
		const c = Object.values(seq.clips).find(
			(x) =>
				x.trackId === s.id &&
				isAudioClip(x as Clip) &&
				x.start * F <= cmd.time &&
				cmd.time < (x.start + x.duration) * F,
		);
		if (!c) return h.fail('E_NOT_FOUND', 'No audio clip under the playhead on that track');
		const range = cmd.lane === 'volume' ? [FADER_MIN_DB, FADER_MAX_DB] : [-100, 100];
		const v = Math.min(range[1]!, Math.max(range[0]!, cmd.value));
		const clip = c as Draft<AudioClip>;
		const prop = (cmd.lane === 'volume' ? clip.volumeDb : clip.pan) as DAnim;
		if (prop.keyframes.length)
			putKeyframe(prop, newKeyframe(h, contentAt(c as Clip, cmd.time, rate), v, false));
		else prop.value = v;
		return { clipId: c.id, value: v };
	},

	'audio.setGain': (doc, cmd: CommandOf<'audio.setGain'>, h) => {
		const ids = idList(cmd.clipIds);
		const { seq, clips } = h.clipsOf(doc, ids);
		const audio = clips.filter((c) => isAudioClip(c as Clip)) as Draft<AudioClip>[];
		if (audio.length === 0) return h.fail('E_INVALID_PARAM', 'Audio Gain applies to audio clips');
		for (const c of audio) assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
		const clampGain = (g: number) => Math.round(Math.min(96, Math.max(-96, g)) * 1000) / 1000;
		const peakOf = (c: { id: string }) => {
			const p = cmd.peaks?.[c.id];
			if (p === undefined) return h.fail('E_INVALID_PARAM', `Normalising needs the measured peak of ${c.id}`);
			return p;
		};
		const changed: Record<string, number> = {};
		if (cmd.mode === 'set') for (const c of audio) c.gainDb = clampGain(cmd.db);
		else if (cmd.mode === 'adjust') for (const c of audio) c.gainDb = clampGain(c.gainDb + cmd.db);
		else if (cmd.mode === 'normalizeAll') {
			for (const c of audio) {
				const p = peakOf(c);
				if (p === null) continue; // silent clip: nothing to normalise
				c.gainDb = clampGain(cmd.db - p);
			}
		} else {
			const peaks = audio.map((c) => peakOf(c)).filter((p): p is number => p !== null);
			if (peaks.length) {
				// The loudest peak including each clip's current gain reaches `db`; every clip moves by the same amount.
				const loudest = Math.max(...audio.map((c) => (peakOf(c) ?? -Infinity) + c.gainDb));
				const delta = cmd.db - loudest;
				for (const c of audio) c.gainDb = clampGain(c.gainDb + delta);
			}
		}
		for (const c of audio) changed[c.id] = c.gainDb;
		return { gainDb: changed };
	},

	'audio.autoDuck': (doc, cmd: CommandOf<'audio.autoDuck'>, h) => {
		const ids = idList(cmd.targetClipIds);
		const { seq, clips } = h.clipsOf(doc, ids);
		const rate = seq.settings.frameRate as Rational;
		const out: Record<string, number> = {};
		for (const c of clips) {
			if (!isAudioClip(c as Clip)) h.fail('E_INVALID_PARAM', `${c.id} is not an audio clip`);
			assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
			const clip = c as Draft<AudioClip>;
			const kfs = duckClipKeyframes(clip as AudioClip, rate, cmd.regions, {
				amountDb: cmd.amountDb,
				fadeMs: cmd.fadeMs,
			});
			clip.volumeDb.keyframes = kfs.map((k) => newKeyframe(h, k.time, k.value, false)) as never;
			out[c.id] = kfs.length;
		}
		return { keyframes: out };
	},

	'mixer.setLoudness': (doc, cmd: CommandOf<'mixer.setLoudness'>, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const cur = seq.master.loudness ?? { enabled: false, targetLufs: -23, truePeakDb: -1 };
		const next = {
			...cur,
			...(cmd.enabled !== undefined ? { enabled: cmd.enabled } : {}),
			...(cmd.targetLufs !== undefined ? { targetLufs: cmd.targetLufs } : {}),
			...(cmd.truePeakDb !== undefined ? { truePeakDb: cmd.truePeakDb } : {}),
			...(cmd.analysis !== undefined ? { analysis: cmd.analysis } : {}),
		};
		seq.master.loudness = next as never;
		return { loudness: next };
	},
};

/** Linear interpolation of a sorted point list at `t` (held at the ends). */
function interp(pts: readonly (readonly [number, number])[], t: number): number {
	if (t <= pts[0]![0]) return pts[0]![1];
	for (let i = 1; i < pts.length; i++) {
		const [ta, va] = pts[i - 1]!;
		const [tb, vb] = pts[i]!;
		if (t <= tb) return tb === ta ? vb : va + ((vb - va) * (t - ta)) / (tb - ta);
	}
	return pts[pts.length - 1]![1];
}
