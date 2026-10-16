// Sound design mixing handlers (spec 12 §2.4, §2.9; P4-R3, P4-R4; wp-note "Phase 4 → WP4.2a"): `audio.volumeDip`, the
// stop-before and build realizations of a cue, the "SFX Room" glue and delivery presets. Each is made of the ordinary edit
// handlers (`mixer.writeAutomation`, `mixer.addSubmix`, `mixer.addSend`, `effect.add`, `mixer.setLoudness`,
// `essentialSound.autoMatch`, `audio.autoDuck`…) so preview and every export render it with nothing new (spec 12 §1), and
// records what it wrote in `soundDesign.mix` so it can be redone or taken out exactly. The pure curve math is
// `sound/mix.ts`. This module never imports `sound.ts` (the placement handlers import its hooks).
import type { Draft } from 'immer';
import { FADER_MAX_DB, FADER_MIN_DB, MAX_SENDS } from '../../audio/strip.ts';
import { duckingDepthBy, readEssentialSound } from '../../essential/model.ts';
import { evaluate } from '../../keyframes.ts';
import type { Animatable, Keyframe } from '../../schema/common.ts';
import type { AudioClip, Clip, EffectInstance, Sequence, Track } from '../../schema/sequence.ts';
import {
	type ClipSfx,
	type CueMix,
	cueMixWritten,
	type MixWrite,
	readSoundDesignSettings,
	SOUND_MIX_LIMITS,
	type SoundCue,
	type SoundDesign,
	type SoundDesignMix,
	type SoundDesignSettings,
} from '../../schema/sound.ts';
import { DELIVERY_DUCK_DB, deliveryMatchTargets, deliveryPreset } from '../../sound/delivery.ts';
import {
	BUILD_FILTER_EFFECT_ID,
	BUILD_FILTER_PARAMS,
	BUILD_REST_HZ,
	type BuildSweep,
	buildSweepPoints,
	clipLaneTime,
	clipSweep,
	type Dip,
	type LaneTime,
	mergeDips,
	musicTracksUnder,
	ROOM_BUS_NAME,
	ROOM_GLUE_DEFAULT,
	ROOM_REVERB_EFFECT_ID,
	roomSendPlan,
	SEQUENCE_LANE,
	stopBeforeDip,
	unwriteCurve,
	writeCurve,
} from '../../sound/mix.ts';
import { sfxGainOwner } from '../../sound/level.ts';
import { flicksPerFrame, type Rational } from '../../time.ts';
import type { DDoc, DSeq, DTrack, HandlerContext } from '../context.ts';
import { assertUnlocked, findTrackIn, resolveTrackIn } from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { audioHandlers } from './audio.ts';
import { effectHandlers } from './effect.ts';
import { essentialHandlers } from './essential.ts';
import { refreshDefaultLevel } from './sound-levels.ts';
import { type HandlerMap, idList, peek, peekKeys } from './util.ts';

type DAudio = Draft<AudioClip> & { sfx?: ClipSfx };
type DAnim = Draft<Animatable<number>>;
type DEffect = Draft<EffectInstance>;

const plainCopy = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const MS = 705_600_000 / 1000;

// ---------------------------------------------------------------------------------------------------------------
// Lookups

function soundDesignOf(seq: DSeq): Draft<SoundDesign> {
	const s = seq as DSeq & { soundDesign?: Draft<SoundDesign> };
	s.soundDesign ??= { cues: {} } as Draft<SoundDesign>;
	return s.soundDesign;
}

function mixOf(seq: DSeq): Draft<SoundDesignMix> {
	const sd = soundDesignOf(seq);
	sd.mix ??= {} as Draft<SoundDesignMix>;
	return sd.mix;
}

/** The stored mix records of a sequence, read without drafting (null when there are none). */
function peekMix(seq: DSeq): SoundDesignMix | null {
	const sd = peek<SoundDesign>(seq, 'soundDesign');
	return sd ? (peek<SoundDesignMix>(sd, 'mix') ?? null) : null;
}

function settingsOf(seq: DSeq): Draft<SoundDesignSettings> {
	const sd = soundDesignOf(seq);
	const cur = sd.settings ? plainCopy(sd.settings) : undefined;
	const read = readSoundDesignSettings(cur);
	if (!sd.settings || JSON.stringify(read) !== JSON.stringify(cur)) sd.settings = read as never;
	return sd.settings!;
}

/** The cue `cueId` in `sequenceId` (else the transaction's, else any sequence). E_NOT_FOUND otherwise. */
function cueOf(
	doc: DDoc,
	h: HandlerContext,
	cueId: string,
	sequenceId?: string,
): { seq: DSeq; cue: Draft<SoundCue> } {
	const seqs = peek<Record<string, Sequence>>(doc, 'sequences')!;
	if (sequenceId && !peek(seqs, sequenceId)) h.fail('E_NOT_FOUND', `Sequence not found: ${sequenceId}`);
	const order = sequenceId ? [sequenceId] : [h.tx.sequenceId, ...peekKeys(seqs)];
	for (const sid of order) {
		if (!sid) continue;
		const raw = peek<Sequence>(seqs, sid);
		const sd = raw ? peek<SoundDesign>(raw, 'soundDesign') : undefined;
		const cues = sd ? peek<Record<string, SoundCue>>(sd, 'cues') : undefined;
		if (!cues || !Object.hasOwn(cues, cueId)) continue;
		const seq = doc.sequences[sid]!;
		return { seq, cue: soundDesignOf(seq).cues[cueId]! };
	}
	return h.fail('E_NOT_FOUND', `Sound cue not found: ${cueId}`, { path: ['cueId'] });
}

function audioTrack(seq: DSeq, id: string): DTrack | null {
	return (seq.audioTracks.find((t) => t.id === id) as DTrack | undefined) ?? null;
}

function label(seq: DSeq | Sequence, trackId: string): string {
	const i = seq.audioTracks.findIndex((t) => t.id === trackId);
	if (i >= 0) return `A${i + 1}`;
	const s = (seq.submixTracks ?? []).findIndex((t) => t.id === trackId);
	return s >= 0 ? `S${s + 1}` : trackId;
}

const rateOf = (seq: DSeq) => seq.settings.frameRate as Rational;

// ---------------------------------------------------------------------------------------------------------------
// Recorded writes
//
// Every realisation (a cue's stop-before or build) records per place it wrote to (a LANE: a track's volume, a clip's
// Volume, a build filter's cutoff) the keys it added and the keys it replaced, and its stacking `order`. Realisations
// on one lane form a stack: a later one merged with (and may have replaced keys of) the earlier ones. Taking one out
// takes the later ones on that lane out first (each exactly, top down), then itself, then writes the later ones again
// from their own records — so any removal order gives the lane back exactly, and the min-merge keeps the values right.

type Kind = 'stopBefore' | 'build';
type Bucket = 'cues' | 'orphans';
/** Where a realisation record lives: `mix.cues[cueId]` (a cue's) or `mix.orphans[cueId]` (a deleted cue's, locked). */
type RecRef = { bucket: Bucket; cueId: string; kind: Kind };
type StopRec = NonNullable<CueMix['stopBefore']>;
type BuildRec = NonNullable<CueMix['build']>;
type AnyRec = StopRec | BuildRec;
const KINDS: readonly Kind[] = ['stopBefore', 'build'];
const BUCKETS: readonly Bucket[] = ['cues', 'orphans'];

function peekRec(seq: DSeq, ref: RecRef): AnyRec | undefined {
	const mix = peekMix(seq);
	return (mix?.[ref.bucket]?.[ref.cueId]?.[ref.kind] as AnyRec | undefined) ?? undefined;
}

/** Stores a record (drafted). */
function setRec(seq: DSeq, ref: RecRef, rec: AnyRec): void {
	const mix = mixOf(seq);
	const bucket = (mix[ref.bucket] ??= {} as never) as Record<string, Draft<CueMix>>;
	const c = (bucket[ref.cueId] ??= {} as Draft<CueMix>);
	c[ref.kind] = rec as never;
}

/** Deletes a record (and its cue / orphan entry when empty). */
function dropRec(seq: DSeq, ref: RecRef): void {
	if (!peekRec(seq, ref)) return;
	const bucket = mixOf(seq)[ref.bucket] as Record<string, Draft<CueMix>>;
	const c = bucket[ref.cueId]!;
	delete c[ref.kind];
	if (!c.stopBefore && !c.build) delete bucket[ref.cueId];
}

/** Empty record tables (and an empty `mix`) go: taking everything out gives the sequence back as it was. */
function tidyMix(seq: DSeq): void {
	const m = peekMix(seq);
	if (!m) return;
	const empty = (v: unknown) => !!v && typeof v === 'object' && Object.keys(v as object).length === 0;
	if (!(empty(m.cues) || empty(m.orphans) || empty(m.buildFilters) || Object.keys(m).length === 0)) return;
	const mix = mixOf(seq);
	if (empty(m.cues)) delete mix.cues;
	if (empty(m.orphans)) delete mix.orphans;
	if (empty(m.buildFilters)) delete mix.buildFilters;
	if (Object.keys(mix).length === 0) delete soundDesignOf(seq).mix;
}

/** The animatable a recorded write points at (a draft), or null when it is gone. */
function writeTarget(seq: DSeq, w: MixWrite): { anim: DAnim; track: DTrack } | null {
	if (w.target === 'trackVolume' || w.target === 'trackFilter') {
		const t = w.trackId ? audioTrack(seq, w.trackId) : null;
		if (!t) return null;
		if (w.target === 'trackVolume') return t.volumeDb ? { anim: t.volumeDb as DAnim, track: t } : null;
		const fx = (t.effects ?? []).find((e) => e.id === w.effectInstanceId) as DEffect | undefined;
		const p = fx?.params.cutoff as DAnim | undefined;
		return p ? { anim: p, track: t } : null;
	}
	const c = w.clipId ? (seq.clips[w.clipId] as DAudio | undefined) : undefined;
	if (c?.kind !== 'audio') return null;
	const t = findTrackIn(seq, c.trackId);
	if (!t) return null;
	if (w.target === 'clipVolume') return { anim: c.volumeDb as DAnim, track: t.track as DTrack };
	const fx = c.effects.find((e) => e.id === w.effectInstanceId) as DEffect | undefined;
	const p = fx?.params.cutoff as DAnim | undefined;
	return p ? { anim: p, track: t.track as DTrack } : null;
}

/** Whether a write's lane is on a locked track. */
const lockedWrite = (seq: DSeq, w: MixWrite) => !!writeTarget(seq, w)?.track.locked;

/** Takes one recorded write out of its lane (its keys; the ones it replaced back when nothing rewrote them since). */
function unwriteRaw(seq: DSeq, w: MixWrite): boolean {
	const t = writeTarget(seq, w);
	if (!t) return false;
	const r = unwriteCurve(plainCopy(t.anim.keyframes) as Keyframe<number>[], w);
	t.anim.keyframes = r.keyframes as never;
	return r.exact;
}

/** One write of a realisation, with its lane and stacking order. */
type Entry = { ref: RecRef; index: number; order: number; w: MixWrite; lane: string };

const laneOf = (w: MixWrite): string =>
	w.target === 'trackVolume'
		? `tv:${w.trackId}`
		: w.target === 'clipVolume'
			? `cv:${w.clipId}`
			: `fx:${w.effectInstanceId}`;

const sameRef = (a: RecRef, b: RecRef) => a.bucket === b.bucket && a.cueId === b.cueId && a.kind === b.kind;

function entriesOf(seq: DSeq): Entry[] {
	const mix = peekMix(seq);
	const out: Entry[] = [];
	if (!mix) return out;
	for (const bucket of BUCKETS)
		for (const [cueId, c] of Object.entries(mix[bucket] ?? {}))
			for (const kind of KINDS) {
				const r = c[kind] as AnyRec | undefined;
				if (!r) continue;
				r.writes.forEach((w, index) =>
					out.push({ ref: { bucket, cueId, kind }, index, order: r.order ?? 0, w, lane: laneOf(w) }),
				);
			}
	return out;
}

/** Stacking order: by `order`; records of older builds (equal orders) by whose keys the other replaced, then by key. */
function stackCmp(a: Entry, b: Entry): number {
	if (a.order !== b.order) return a.order - b.order;
	const aw = new Set(a.w.written);
	if (b.w.replaced.some((k) => aw.has(k.id))) return -1;
	const bw = new Set(b.w.written);
	if (a.w.replaced.some((k) => bw.has(k.id))) return 1;
	const ka = `${a.ref.bucket}:${a.ref.cueId}:${a.ref.kind}`;
	const kb = `${b.ref.bucket}:${b.ref.cueId}:${b.ref.kind}`;
	return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** The order a new realisation stacks at: above every recorded one. */
function nextOrder(seq: DSeq): number {
	let max = 0;
	const mix = peekMix(seq);
	for (const bucket of BUCKETS)
		for (const c of Object.values(mix?.[bucket] ?? {}))
			for (const kind of KINDS) max = Math.max(max, (c[kind] as AnyRec | undefined)?.order ?? 0);
	return max + 1;
}

// ---------------------------------------------------------------------------------------------------------------
// Lane writes

/** One place written: the write, or the reason it could not be recorded (too dense), or null (nothing to write). */
type LaneOut = { write: MixWrite } | { limit: string } | null;

function limitOf(written: number, replaced: number): string | null {
	return written > SOUND_MIX_LIMITS.written || replaced > SOUND_MIX_LIMITS.replaced
		? `the automation under the cue is too dense to record (${written} keys to write, ${replaced} to replace; thin it first)`
		: null;
}

/** A dip on a music track's own volume lane (sequence time). */
function dipTrackLane(seq: DSeq, track: DTrack, dip: Dip, h: HandlerContext): LaneOut {
	const cur = (
		track.volumeDb ? plainCopy(track.volumeDb) : { value: 0, keyframes: [] }
	) as Animatable<number>;
	const r = mergeDips(cur, SEQUENCE_LANE, [dip], {
		newId: () => h.ids.next('kf'),
		clamp: [FADER_MIN_DB, FADER_MAX_DB],
	});
	if (!r) return null;
	const lim = limitOf(r.written.length, r.replaced.length);
	if (lim) return { limit: lim };
	track.volumeDb ??= { value: 0, keyframes: [] } as never;
	track.volumeDb!.keyframes = r.keyframes as never;
	return {
		write: { target: 'trackVolume', trackId: track.id, written: r.written, replaced: plainCopy(r.replaced) },
	};
}

/** A dip on a music clip's Volume (content time). */
function dipClipLane(seq: DSeq, clip: DAudio, dip: Dip, h: HandlerContext): LaneOut {
	const lane = clipLaneTime(clip as AudioClip, rateOf(seq));
	const r = mergeDips(plainCopy(clip.volumeDb) as Animatable<number>, lane, [dip], {
		newId: () => h.ids.next('kf'),
		clamp: [FADER_MIN_DB, FADER_MAX_DB],
	});
	if (!r) return null;
	const lim = limitOf(r.written.length, r.replaced.length);
	if (lim) return { limit: lim };
	clip.volumeDb.keyframes = r.keyframes as never;
	return {
		write: { target: 'clipVolume', clipId: clip.id, written: r.written, replaced: plainCopy(r.replaced) },
	};
}

type FilterOwner = { trackId: string } | { clipId: string };

/** The build filter of a track or clip (`fxId`, else the recorded one), or undefined. */
function findBuildFilter(seq: DSeq, owner: FilterOwner, fxId?: string): DEffect | undefined {
	const list =
		'trackId' in owner
			? (audioTrack(seq, owner.trackId)?.effects ?? [])
			: ((seq.clips[owner.clipId] as DAudio | undefined)?.effects ?? []);
	const id = fxId ?? peekMix(seq)?.buildFilters?.['trackId' in owner ? owner.trackId : owner.clipId];
	if (!id) return undefined;
	return list.find((e) => e.id === id && e.effectId === BUILD_FILTER_EFFECT_ID) as DEffect | undefined;
}

/** Writes a sweep on a filter's cutoff; its rest points take the curve's own value at the sweep's edges. Pure. */
function sweepWrite(anim: Animatable<number>, lane: LaneTime, sweep: BuildSweep, h: HandlerContext) {
	const restA = evaluate(anim, lane.toLane(sweep.ws));
	const restB = evaluate(anim, lane.toLane(sweep.we));
	const last = sweep.points.length - 1;
	const pts = sweep.points.map(
		([t, v], i) => [t, sweep.rest[i] ? (i === 0 ? restA : i === last ? restB : v) : v] as [number, number],
	);
	return writeCurve(anim, lane, sweep.ws, sweep.we, pts, () => h.ids.next('kf'));
}

/** A build sweep on the build filter of a track or clip (added when missing; `fxId`: that filter only). */
function sweepLane(
	doc: DDoc,
	seq: DSeq,
	owner: FilterOwner,
	lane: LaneTime,
	sweep: BuildSweep,
	h: HandlerContext,
	fxId?: string,
): LaneOut {
	const existing = findBuildFilter(seq, owner, fxId);
	if (fxId && !existing) return null;
	const anim = (
		existing?.params.cutoff ? plainCopy(existing.params.cutoff) : { value: BUILD_REST_HZ, keyframes: [] }
	) as Animatable<number>;
	const w = sweepWrite(anim, lane, sweep, h);
	const lim = limitOf(w.written.length, w.replaced.length);
	if (lim) return { limit: lim };
	const fx = existing ?? buildFilter(doc, seq, owner, h).fx;
	fx.params.cutoff ??= { value: BUILD_REST_HZ, keyframes: [] } as never;
	(fx.params.cutoff as unknown as DAnim).keyframes = w.keyframes as never;
	return {
		write: {
			target: 'trackId' in owner ? 'trackFilter' : 'clipFilter',
			...owner,
			effectInstanceId: fx.id,
			written: w.written,
			replaced: plainCopy(w.replaced),
		},
	};
}

// ---------------------------------------------------------------------------------------------------------------
// audio.volumeDip

/** Merges `dips` into an audio clip's Volume (minimum); null when no dip falls in the clip. */
function dipClip(seq: DSeq, clip: DAudio, dips: readonly Dip[], h: HandlerContext) {
	const lane = clipLaneTime(clip as AudioClip, rateOf(seq));
	const r = mergeDips(plainCopy(clip.volumeDb) as Animatable<number>, lane, dips, {
		newId: () => h.ids.next('kf'),
		clamp: [FADER_MIN_DB, FADER_MAX_DB],
	});
	if (!r) return null;
	clip.volumeDb.keyframes = r.keyframes as never;
	return r;
}

function volumeDip(doc: DDoc, cmd: CommandOf<'audio.volumeDip'>, h: HandlerContext) {
	const ids = idList(cmd.clipIds);
	const { seq, clips } = h.clipsOf(doc, ids);
	const out: Record<string, { written: number; replaced: number } | { skipped: string }> = {};
	for (const c of clips) {
		if (c.kind !== 'audio') h.fail('E_INVALID_PARAM', `${c.id} is not an audio clip`, { path: ['clipIds'] });
		assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
		const r = dipClip(seq, c as DAudio, cmd.dips, h);
		out[c.id] = r
			? { written: r.written.length, replaced: r.replaced.length }
			: { skipped: 'no dip in the clip' };
	}
	return { clips: out };
}

// ---------------------------------------------------------------------------------------------------------------
// Writing and removing realisations

type WriteSummary = { target: MixWrite['target']; track: string; clipId?: string; keyframes: number };

const summary = (seq: DSeq, w: MixWrite): WriteSummary => {
	const trackId = w.trackId ?? (w.clipId ? ((seq.clips[w.clipId] as Clip | undefined)?.trackId ?? '') : '');
	return {
		target: w.target,
		track: label(seq, trackId),
		...(w.clipId ? { clipId: w.clipId } : {}),
		keyframes: w.written.length,
	};
};

/**
 * How a realisation is written: `ambience` dips the ambience too; `skipLocked` skips locked music tracks (else
 * E_TRACK_LOCKED); `soft` (cue edits, placement) skips a place whose automation is too dense to record (else E_LIMIT).
 */
type WriteOpts = { ambience?: boolean; skipLocked?: boolean; soft?: boolean };
type WriteOut = { writes: MixWrite[]; skipped: string[]; reason: string | null };

function take(out: WriteOut, r: LaneOut, where: string, soft: boolean | undefined, h: HandlerContext): void {
	if (!r) return;
	if ('limit' in r) {
		if (!soft) h.fail('E_LIMIT', `${where}: ${r.limit}`);
		out.skipped.push(`${where}: ${r.limit}`);
		return;
	}
	out.writes.push(r.write);
}

/** Writes a stop-before dip for a hero at `frame` on the music under it. */
function writeStopBefore(
	seq: DSeq,
	spec: { seconds: number; depthDb: number },
	frame: number,
	opts: WriteOpts,
	h: HandlerContext,
): WriteOut {
	const out: WriteOut = { writes: [], skipped: [], reason: null };
	const rate = rateOf(seq);
	const F = flicksPerFrame(rate);
	const dip = stopBeforeDip(frame, spec, rate);
	if (!dip) return { ...out, reason: 'the dip has no length (seconds 0, depth 0 dB, or at the very start)' };
	const fade = dip.fadeMs * MS;
	const a = Math.max(0, Math.floor((dip.start - fade) / F));
	const b = Math.ceil((dip.end + fade) / F);
	const uses = musicTracksUnder(seq as Sequence, a, b, opts.ambience ? ['music', 'ambience'] : ['music']);
	if (uses.length === 0) return { ...out, reason: 'no music plays under the cue' };
	for (const u of uses) {
		const track = audioTrack(seq, u.trackId)!;
		const where = label(seq, track.id);
		if (track.locked) {
			if (opts.skipLocked) {
				out.skipped.push(`${where}: the track is locked`);
				continue;
			}
			assertUnlocked(track, h);
		}
		// The music track's own volume lane when only music plays there over the window and its lane is played;
		// else (shared with other audio, or automation Off) the music clips' Volume.
		if (!u.shared && !u.automationOff) {
			take(out, dipTrackLane(seq, track, dip, h), where, opts.soft, h);
			continue;
		}
		for (const id of u.clipIds)
			take(out, dipClipLane(seq, seq.clips[id] as DAudio, dip, h), where, opts.soft, h);
	}
	out.reason = out.writes.length
		? null
		: out.skipped.length
			? out.skipped.join('; ')
			: 'no music plays under the cue';
	return out;
}

/** Writes a build sweep for a hero at `frame` on the music before it. */
function writeBuild(
	doc: DDoc,
	seq: DSeq,
	spec: { seconds: number; fromHz: number; toHz: number },
	frame: number,
	opts: WriteOpts,
	h: HandlerContext,
): WriteOut {
	const out: WriteOut = { writes: [], skipped: [], reason: null };
	const rate = rateOf(seq);
	const F = flicksPerFrame(rate);
	const sweep = buildSweepPoints(frame, spec, rate);
	if (!sweep) return { ...out, reason: 'the build has no length (seconds 0, or at the very start)' };
	const a = Math.max(0, Math.floor(sweep.ws / F));
	const uses = musicTracksUnder(seq as Sequence, a, frame, ['music']);
	if (uses.length === 0) return { ...out, reason: 'no music plays before the cue' };
	for (const u of uses) {
		const track = audioTrack(seq, u.trackId)!;
		const where = label(seq, track.id);
		if (track.locked) {
			if (opts.skipLocked) {
				out.skipped.push(`${where}: the track is locked`);
				continue;
			}
			assertUnlocked(track, h);
		}
		if (!u.shared) {
			take(out, sweepLane(doc, seq, { trackId: track.id }, SEQUENCE_LANE, sweep, h), where, opts.soft, h);
			continue;
		}
		// The music shares its track with other audio: a clip filter on each music clip (the sweep cut to the clip:
		// a clip ending before the hero keeps rising to its end).
		for (const id of u.clipIds) {
			const clip = seq.clips[id] as DAudio;
			const lane = clipLaneTime(clip as AudioClip, rate);
			const cut = clipSweep(sweep, lane.span[0], lane.span[1]);
			if (!cut || cut.points.length < 2) continue;
			take(out, sweepLane(doc, seq, { clipId: id }, lane, cut, h), where, opts.soft, h);
		}
	}
	out.reason = out.writes.length
		? null
		: out.skipped.length
			? out.skipped.join('; ')
			: 'no music plays before the cue';
	return out;
}

/** Writes one recorded place again from its record (the stack's re-realisation); null when nothing falls there now. */
function rewriteEntry(doc: DDoc, seq: DSeq, e: Entry, h: HandlerContext): MixWrite | null {
	const rec = peekRec(seq, e.ref);
	if (!rec) return null;
	const rate = rateOf(seq);
	const w = e.w;
	let r: LaneOut = null;
	if (e.ref.kind === 'stopBefore') {
		const dip = stopBeforeDip(rec.frame, rec as StopRec, rate);
		if (dip && w.target === 'trackVolume') {
			const t = w.trackId ? audioTrack(seq, w.trackId) : null;
			if (t) r = dipTrackLane(seq, t, dip, h);
		} else if (dip && w.target === 'clipVolume') {
			const c = w.clipId ? (seq.clips[w.clipId] as DAudio | undefined) : undefined;
			if (c?.kind === 'audio') r = dipClipLane(seq, c, dip, h);
		}
	} else {
		const sweep = buildSweepPoints(rec.frame, rec as BuildRec, rate);
		if (sweep && w.target === 'trackFilter' && w.trackId && audioTrack(seq, w.trackId))
			r = sweepLane(doc, seq, { trackId: w.trackId }, SEQUENCE_LANE, sweep, h, w.effectInstanceId);
		else if (sweep && w.target === 'clipFilter' && w.clipId) {
			const c = seq.clips[w.clipId] as DAudio | undefined;
			if (c?.kind === 'audio') {
				const lane = clipLaneTime(c as AudioClip, rate);
				const cut = clipSweep(sweep, lane.span[0], lane.span[1]);
				if (cut && cut.points.length >= 2)
					r = sweepLane(doc, seq, { clipId: c.id }, lane, cut, h, w.effectInstanceId);
			}
		}
	}
	if (r && 'limit' in r) return h.fail('E_LIMIT', `${laneOf(w)}: ${r.limit}`);
	return r ? r.write : null;
}

/**
 * Takes one write of a record out of its lane exactly: the later writes on the lane come out first (top down), then
 * this one, then the later ones are written again from their records (fresh key ids, same order).
 */
function removeWrite(doc: DDoc, seq: DSeq, ref: RecRef, index: number, h: HandlerContext): void {
	const all = entriesOf(seq);
	const self = all.find((e) => sameRef(e.ref, ref) && e.index === index);
	if (!self) return;
	const stack = all.filter((e) => e.lane === self.lane).sort(stackCmp);
	const later = stack.slice(stack.indexOf(self) + 1);
	for (let i = later.length - 1; i >= 0; i--) unwriteRaw(seq, later[i]!.w);
	unwriteRaw(seq, self.w);
	for (const e of later) {
		const nw = rewriteEntry(doc, seq, e, h);
		const bucket = mixOf(seq)[e.ref.bucket] as Record<string, Draft<CueMix>>;
		const rec = bucket[e.ref.cueId]![e.ref.kind] as Draft<AnyRec>;
		if (nw) rec.writes[e.index] = nw as never;
		else rec.writes.splice(e.index, 1);
	}
	for (const e of later) {
		const r = peekRec(seq, e.ref);
		if (r && r.suspended !== true && r.writes.length === 0) dropRec(seq, e.ref);
	}
}

/** A build filter no build uses any more and without keys left goes (with its `buildFilters` entry). */
function dropUnusedFilters(doc: DDoc, seq: DSeq, writes: readonly MixWrite[], h: HandlerContext): void {
	const used = new Set<string>();
	for (const e of entriesOf(seq)) if (e.w.effectInstanceId) used.add(e.w.effectInstanceId);
	for (const w of writes) {
		const id = w.effectInstanceId;
		if (!id || used.has(id)) continue;
		const t = writeTarget(seq, w);
		if (!t || t.track.locked || t.anim.keyframes.length > 0) continue;
		effectHandlers['effect.remove']!(doc, { type: 'effect.remove', effectInstanceId: id }, h);
		used.add(id);
		const filters = peekMix(seq)?.buildFilters;
		if (filters)
			for (const [k, v] of Object.entries(filters)) if (v === id) delete mixOf(seq).buildFilters![k];
	}
}

/**
 * Takes a realisation out of the mix exactly (each write through its lane's stack). A write on a locked track is
 * refused (E_TRACK_LOCKED; nothing changed), or with `keepLocked` left in place and kept as an ORPHAN record
 * (`mix.orphans[cueId]`), taken out when the track is unlocked. Returns the number of writes the record had.
 */
function removeRec(
	doc: DDoc,
	seq: DSeq,
	ref: RecRef,
	h: HandlerContext,
	opts: { keepLocked?: boolean } = {},
) {
	const rec = peekRec(seq, ref);
	if (!rec) return 0;
	const copy = plainCopy(rec) as AnyRec;
	const kept = new Set<number>();
	copy.writes.forEach((w, i) => {
		const t = writeTarget(seq, w);
		if (!t?.track.locked) return;
		if (opts.keepLocked) kept.add(i);
		else assertUnlocked(t.track, h);
	});
	for (let i = copy.writes.length - 1; i >= 0; i--) if (!kept.has(i)) removeWrite(doc, seq, ref, i, h);
	dropRec(seq, ref);
	if (kept.size) {
		const { suspended: _s, ...spec } = copy as AnyRec & { suspended?: boolean };
		setRec(seq, { ...ref, bucket: 'orphans' }, {
			...spec,
			writes: copy.writes.filter((_, i) => kept.has(i)),
		} as AnyRec);
	}
	if (ref.kind === 'build')
		dropUnusedFilters(
			doc,
			seq,
			copy.writes.filter((_, i) => !kept.has(i)),
			h,
		);
	return copy.writes.length;
}

/**
 * After a track is unlocked (`track.update`): the orphan realisations of deleted cues written on it come out (exactly,
 * through the stacks). Exported for the track handlers.
 */
export function settleMixOrphans(doc: DDoc, seq: DSeq, h: HandlerContext): void {
	const orphans = peekMix(seq)?.orphans;
	if (!orphans) return;
	for (const [cueId, c] of Object.entries(orphans))
		for (const kind of KINDS) {
			const r = c[kind] as AnyRec | undefined;
			if (r && r.writes.some((w) => !lockedWrite(seq, w)))
				removeRec(doc, seq, { bucket: 'orphans', cueId, kind }, h, { keepLocked: true });
		}
	tidyMix(seq);
}

type Realized = { applied: boolean; removed: number; writes: MixWrite[]; reason: string | null };

/**
 * (Re)writes a cue's stop-before or build: the recorded one comes out first (exactly), then the cue's current field is
 * written on top of the stack. A muted cue keeps a SUSPENDED record (`writes: []`, its options) so unmuting writes it
 * again exactly as it was.
 */
function realize(
	doc: DDoc,
	seq: DSeq,
	cue: Draft<SoundCue>,
	kind: Kind,
	opts: WriteOpts,
	h: HandlerContext,
): Realized {
	const ref: RecRef = { bucket: 'cues', cueId: cue.id, kind };
	const removed = removeRec(doc, seq, ref, h);
	const spec = cue[kind];
	const none = kind === 'stopBefore' ? 'the cue has no stop-before' : 'the cue has no build';
	if (!spec) {
		tidyMix(seq);
		return { applied: false, removed, writes: [], reason: none };
	}
	const fields =
		kind === 'stopBefore'
			? {
					seconds: (spec as StopRec).seconds,
					depthDb: (spec as StopRec).depthDb,
					...(opts.ambience ? { ambience: true } : {}),
				}
			: {
					seconds: (spec as BuildRec).seconds,
					fromHz: (spec as BuildRec).fromHz,
					toHz: (spec as BuildRec).toHz,
				};
	const order = nextOrder(seq);
	if (cue.muted) {
		setRec(seq, ref, { ...fields, frame: cue.frame, writes: [], order, suspended: true } as AnyRec);
		return { applied: false, removed, writes: [], reason: 'the cue is muted' };
	}
	const r =
		kind === 'stopBefore'
			? writeStopBefore(seq, spec as StopRec, cue.frame, opts, h)
			: writeBuild(doc, seq, spec as BuildRec, cue.frame, opts, h);
	if (r.writes.length) setRec(seq, ref, { ...fields, frame: cue.frame, writes: r.writes, order } as AnyRec);
	for (const s of r.skipped)
		h.warn(
			'W_MIX_SKIPPED',
			`${kind === 'stopBefore' ? 'Stop-before' : 'Build'} of cue ${cue.id} skipped on ${s}`,
		);
	tidyMix(seq);
	return { applied: r.writes.length > 0, removed, writes: r.writes, reason: r.reason };
}

function applyStopBefore(doc: DDoc, cmd: CommandOf<'soundDesign.applyStopBefore'>, h: HandlerContext) {
	const { seq, cue } = cueOf(doc, h, cmd.cueId, cmd.sequenceId);
	const prev = peekRec(seq, { bucket: 'cues', cueId: cue.id, kind: 'stopBefore' }) as StopRec | undefined;
	const r = realize(doc, seq, cue, 'stopBefore', { ambience: cmd.ambience ?? prev?.ambience ?? false }, h);
	return {
		cueId: cue.id,
		applied: r.applied,
		removed: r.removed,
		writes: r.writes.map((w) => summary(seq, w)),
		...(r.reason ? { reason: r.reason } : {}),
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Build

/** The build filter of a track or clip (reused; added when missing). */
function buildFilter(
	doc: DDoc,
	seq: DSeq,
	owner: FilterOwner,
	h: HandlerContext,
): { fx: DEffect; created: boolean } {
	const key = 'trackId' in owner ? owner.trackId : owner.clipId;
	const found = findBuildFilter(seq, owner);
	if (found) return { fx: found, created: false };
	const r = effectHandlers['effect.add']!(
		doc,
		{
			type: 'effect.add',
			target: 'trackId' in owner ? { trackId: owner.trackId, sequenceId: seq.id } : { clipId: owner.clipId },
			effectId: BUILD_FILTER_EFFECT_ID,
			params: { ...BUILD_FILTER_PARAMS, cutoff: BUILD_REST_HZ },
		},
		h,
	) as { effectInstanceId: string };
	const mix = mixOf(seq);
	mix.buildFilters ??= {} as never;
	mix.buildFilters![key] = r.effectInstanceId;
	const after =
		'trackId' in owner
			? (audioTrack(seq, owner.trackId)!.effects ?? [])
			: (seq.clips[owner.clipId] as DAudio).effects;
	return { fx: after.find((e) => e.id === r.effectInstanceId) as DEffect, created: true };
}

function applyBuild(doc: DDoc, cmd: CommandOf<'soundDesign.applyBuild'>, h: HandlerContext) {
	const { seq, cue } = cueOf(doc, h, cmd.cueId, cmd.sequenceId);
	const r = realize(doc, seq, cue, 'build', {}, h);
	return {
		cueId: cue.id,
		applied: r.applied,
		removed: r.removed,
		writes: r.writes.map((w) => summary(seq, w)),
		...(r.reason ? { reason: r.reason } : {}),
	};
}

const sameSpec = (kind: Kind, a: Record<string, unknown>, b: Record<string, unknown>) =>
	kind === 'stopBefore'
		? a.seconds === b.seconds && a.depthDb === b.depthDb
		: a.seconds === b.seconds && a.fromHz === b.fromHz && a.toHz === b.toHz;

/**
 * Keeps a cue's stop-before and build in step with the cue (`soundCue.update`, `soundCue.resync`, `soundCue.remove`,
 * `soundDesign.place`): a removed cue or a cleared field takes its writes out; a muted cue's are taken out and kept
 * SUSPENDED (written again, with the same options, when unmuted); a moved cue or a changed field writes them again; a
 * FILLED cue (a placed sound) with a `stopBefore` / `build` not written yet gets it written — "apply when the cue is
 * filled". A cue edit never fails because of the mix: locked music tracks are skipped (a realisation already on one
 * stays as it is until the track is unlocked; a deleted cue's stays as an orphan, taken out on unlock) and a place
 * whose automation is too dense to record is skipped (W_MIX_SKIPPED). Exported for the cue and placement handlers.
 */
export function followCueMix(doc: DDoc, seq: DSeq, cueId: string, h: HandlerContext, removed: boolean): void {
	const recs = peekMix(seq)?.cues?.[cueId];
	const cue = removed ? null : (soundDesignOf(seq).cues[cueId] ?? null);
	if (!recs && !cue) return;
	const filled = !!cue && (cue.placedClipIds ?? []).some((id) => !!seq.clips[id]);
	for (const kind of KINDS) {
		const ref: RecRef = { bucket: 'cues', cueId, kind };
		const r = peekRec(seq, ref);
		const spec = cue?.[kind] as Record<string, unknown> | undefined;
		const ambience = kind === 'stopBefore' && (r as StopRec | undefined)?.ambience === true;
		const opts: WriteOpts = { ...(ambience ? { ambience: true } : {}), skipLocked: true, soft: true };
		if (r?.suspended) {
			if (!cue || !spec) dropRec(seq, ref);
			else if (!cue.muted) realize(doc, seq, cue, kind, opts, h);
			continue;
		}
		if (r) {
			if (!cue) {
				removeRec(doc, seq, ref, h, { keepLocked: true });
				continue;
			}
			const same = !cue.muted && !!spec && sameSpec(kind, spec, r as never) && cue.frame === r.frame;
			if (same) continue;
			if (r.writes.some((w) => lockedWrite(seq, w))) continue;
			realize(doc, seq, cue, kind, opts, h);
			continue;
		}
		if (cue && filled && spec && !cue.muted) realize(doc, seq, cue, kind, opts, h);
	}
	tidyMix(seq);
}

/**
 * Stop-before dips written again on a curve something rewrote (delivery ducking replaced the clips' Volume keys),
 * bottom of the stack first. Returns the cue ids.
 */
function redip(doc: DDoc, seq: DSeq, clipIds: ReadonlySet<string>, h: HandlerContext): string[] {
	const todo = Object.entries(peekMix(seq)?.cues ?? {})
		.filter(
			([, rec]) =>
				cueMixWritten(rec.stopBefore) &&
				rec.stopBefore!.writes.some((w) => w.clipId && clipIds.has(w.clipId)),
		)
		.sort(([a, x], [b, y]) => (x.stopBefore!.order ?? 0) - (y.stopBefore!.order ?? 0) || (a < b ? -1 : 1));
	const out: string[] = [];
	for (const [cueId, rec] of todo) {
		const cue = soundDesignOf(seq).cues[cueId];
		if (!cue) continue;
		realize(doc, seq, cue, 'stopBefore', { ...(rec.stopBefore!.ambience ? { ambience: true } : {}) }, h);
		out.push(cueId);
	}
	return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Room glue

/** The room bus submix of a sequence: the recorded one, else `settings.roomBus`, else one named "SFX Room". */
function findRoomBus(seq: DSeq): { bus: DTrack; recorded: boolean } | null {
	const subs = (seq.submixTracks ?? []) as DTrack[];
	const rec = peekMix(seq)?.room;
	const byRec = rec ? subs.find((t) => t.id === rec.busId) : undefined;
	if (byRec) return { bus: byRec, recorded: true };
	const settings = readSoundDesignSettings(plainCopy(peek<SoundDesign>(seq, 'soundDesign')?.settings));
	const bySettings = settings.roomBus ? subs.find((t) => t.id === settings.roomBus) : undefined;
	if (bySettings) return { bus: bySettings, recorded: false };
	const byName = subs.find((t) => t.name === ROOM_BUS_NAME);
	return byName ? { bus: byName, recorded: false } : null;
}

function setParam(fx: DEffect, name: string, value: number): void {
	const p = fx.params[name] as unknown as DAnim | undefined;
	if (!p) fx.params[name] = { value, keyframes: [] } as never;
	else if (p.keyframes.length === 0) p.value = value;
}

/** What adding a send to `t` creates: its mixer, or its sends list (removed with the glue's send). */
function madeBySend(t: DTrack): 'mixer' | 'sends' | undefined {
	const mixer = peek<{ sends?: unknown }>(t, 'mixer');
	if (!mixer) return 'mixer';
	return peek(mixer, 'sends') ? undefined : 'sends';
}

/** Removes one of the glue's sends, and what adding it created when that is empty again. */
function removeOwnSend(
	doc: DDoc,
	seq: DSeq,
	t: DTrack,
	sendId: string,
	made: 'mixer' | 'sends' | undefined,
	h: HandlerContext,
): void {
	audioHandlers['mixer.removeSend'](
		doc,
		{ type: 'mixer.removeSend', sequenceId: seq.id, stripId: t.id, sendId },
		h,
	);
	const mixer = t.mixer as (Draft<NonNullable<Track['mixer']>> & Record<string, unknown>) | undefined;
	if (!made || !mixer || (mixer.sends ?? []).length > 0) return;
	delete mixer.sends;
	if (made === 'mixer' && Object.keys(mixer).length === 0) delete (t as { mixer?: unknown }).mixer;
}

function ensureBus(doc: DDoc, cmd: CommandOf<'soundDesign.ensureBus'>, h: HandlerContext) {
	const seq = h.sequence(doc, cmd.sequenceId);
	const prev = peekMix(seq)?.room;
	// What removeBus gives back: recorded once, before the first glue changes anything.
	const sd0 = peek<SoundDesign>(seq, 'soundDesign');
	const before = prev
		? prev.before
		: {
				soundDesign: !!sd0,
				settings: !!sd0?.settings,
				submixes: !!peek(seq, 'submixTracks'),
				roomBus: readSoundDesignSettings(plainCopy(sd0?.settings)).roomBus,
			};
	const opts = {
		sendDb: cmd.roomGlue?.sendDb ?? prev?.sendDb ?? ROOM_GLUE_DEFAULT.sendDb,
		decay: cmd.roomGlue?.decay ?? prev?.decay ?? ROOM_GLUE_DEFAULT.decay,
		mix: cmd.roomGlue?.mix ?? prev?.mix ?? ROOM_GLUE_DEFAULT.mix,
		preDelayMs: cmd.roomGlue?.preDelayMs ?? prev?.preDelayMs ?? ROOM_GLUE_DEFAULT.preDelayMs,
	};
	const explicit = cmd.sfxTracks?.map((ref, i) => {
		const id = resolveTrackIn(seq, ref);
		if (!id) return h.fail('E_NOT_FOUND', `Track not found: ${ref}`, { path: ['sfxTracks', String(i)] });
		if (findTrackIn(seq, id)!.kind !== 'audio')
			h.fail('E_TRACK_KIND', `${ref} is not an audio track`, {
				path: ['sfxTracks', String(i)],
				blocking: [id],
			});
		return id;
	});
	// The bus: recorded, adopted (settings / name) or new.
	let found = findRoomBus(seq);
	let created = false;
	if (!found) {
		const r = audioHandlers['mixer.addSubmix'](
			doc,
			{ type: 'mixer.addSubmix', sequenceId: seq.id, name: ROOM_BUS_NAME, channelFormat: 'stereo' },
			h,
		) as { stripId: string };
		found = { bus: (seq.submixTracks ?? []).find((t) => t.id === r.stripId) as DTrack, recorded: false };
		created = true;
	}
	const bus = found.bus;
	const createdBus = created || (found.recorded && !!prev?.createdBus);
	// Its reverb: recorded, the first Studio Reverb on it, or new.
	bus.effects ??= [];
	let reverb =
		(prev?.reverbId ? (bus.effects.find((e) => e.id === prev.reverbId) as DEffect | undefined) : undefined) ??
		(bus.effects.find((e) => e.effectId === ROOM_REVERB_EFFECT_ID) as DEffect | undefined);
	if (!reverb) {
		const r = effectHandlers['effect.add']!(
			doc,
			{
				type: 'effect.add',
				target: { trackId: bus.id, sequenceId: seq.id },
				effectId: ROOM_REVERB_EFFECT_ID,
				params: { decay: opts.decay, mix: opts.mix, preDelay: opts.preDelayMs },
			},
			h,
		) as { effectInstanceId: string };
		reverb = bus.effects!.find((e) => e.id === r.effectInstanceId) as DEffect;
	} else {
		// Only settings that changed since the glue was recorded (or first adopted) are applied: a reverb tuned by
		// hand keeps its values when the glue is ensured again.
		const changed = (k: 'decay' | 'mix' | 'preDelayMs') => !prev || opts[k] !== prev[k];
		if (changed('decay') || changed('mix') || changed('preDelayMs')) assertUnlocked(bus, h);
		if (changed('decay')) setParam(reverb, 'decay', opts.decay);
		if (changed('mix')) setParam(reverb, 'mix', opts.mix);
		if (changed('preDelayMs')) setParam(reverb, 'preDelay', opts.preDelayMs);
	}
	// Sends.
	const plan = roomSendPlan(doc as never, seq as Sequence, explicit);
	const own = new Map((prev?.sends ?? []).map((s) => [s.trackId, s.sendId]));
	const sends: { trackId: string; sendId: string }[] = [];
	const out: { trackId: string; track: string; sendId: string; added: boolean }[] = [];
	const skipped: { trackId: string; track: string; reason: string }[] = [];
	const removed: string[] = [];
	for (const d of plan) {
		const t = audioTrack(seq, d.trackId);
		if (!t) continue;
		const list = t.mixer?.sends ?? [];
		const mine = own.get(d.trackId);
		const existing = mine ? list.find((s) => s.id === mine && s.target === bus.id) : undefined;
		if (!d.send) {
			if (existing) {
				removeOwnSend(doc, seq, t, existing.id, prev?.sends.find((x) => x.sendId === existing.id)?.made, h);
				removed.push(t.id);
			}
			skipped.push({ trackId: t.id, track: label(seq, t.id), reason: d.reason });
			continue;
		}
		if (existing) {
			// The level follows a new sendDb only while it is still the glue's own (not tuned by hand, no automation).
			const lv = existing.levelDb as unknown as Animatable<number>;
			const own = lv.keyframes.length === 0 && (!prev || Math.abs(lv.value - prev.sendDb) < 1e-9);
			if (own && lv.value !== opts.sendDb)
				audioHandlers['mixer.updateSend'](
					doc,
					{
						type: 'mixer.updateSend',
						sequenceId: seq.id,
						stripId: t.id,
						sendId: existing.id,
						patch: { levelDb: opts.sendDb },
					},
					h,
				);
			const made = (prev?.sends ?? []).find((x) => x.sendId === existing.id)?.made;
			sends.push({ trackId: t.id, sendId: existing.id, ...(made ? { made } : {}) });
			out.push({ trackId: t.id, track: label(seq, t.id), sendId: existing.id, added: false });
			continue;
		}
		if (list.some((s) => s.target === bus.id)) {
			skipped.push({
				trackId: t.id,
				track: label(seq, t.id),
				reason: `${label(seq, t.id)} already sends to the room`,
			});
			continue;
		}
		if (list.length >= MAX_SENDS) {
			skipped.push({
				trackId: t.id,
				track: label(seq, t.id),
				reason: `${label(seq, t.id)}: all ${MAX_SENDS} send slots are in use`,
			});
			continue;
		}
		const made = madeBySend(t);
		const r = audioHandlers['mixer.addSend'](
			doc,
			{ type: 'mixer.addSend', sequenceId: seq.id, stripId: t.id, target: bus.id, levelDb: opts.sendDb },
			h,
		) as { sendId: string };
		sends.push({ trackId: t.id, sendId: r.sendId, ...(made ? { made } : {}) });
		out.push({ trackId: t.id, track: label(seq, t.id), sendId: r.sendId, added: true });
	}
	// Own sends on tracks the plan no longer names (a track removed from sfxTracks, now bed-only, deleted).
	for (const [trackId, sendId] of own) {
		if (plan.some((d) => d.trackId === trackId)) continue;
		const t = audioTrack(seq, trackId);
		const s = t?.mixer?.sends?.find((x) => x.id === sendId && x.target === bus.id);
		if (t && s) {
			removeOwnSend(doc, seq, t, sendId, prev?.sends.find((x) => x.sendId === sendId)?.made, h);
			removed.push(trackId);
		}
	}
	if (sends.length > SOUND_MIX_LIMITS.sends)
		h.fail('E_LIMIT', `At most ${SOUND_MIX_LIMITS.sends} room sends`);
	settingsOf(seq).roomBus = bus.id;
	mixOf(seq).room = {
		busId: bus.id,
		reverbId: reverb.id,
		createdBus,
		...opts,
		sends,
		...(before ? { before } : {}),
	} as never;
	return {
		busId: bus.id,
		label: label(seq, bus.id),
		reverbId: reverb.id,
		created,
		sends: out,
		removed,
		skipped,
	};
}

function removeBus(doc: DDoc, cmd: CommandOf<'soundDesign.removeBus'>, h: HandlerContext) {
	const seq = h.sequence(doc, cmd.sequenceId);
	const rec = peekMix(seq)?.room;
	let removedSends = 0;
	let removedBus = false;
	if (rec) {
		for (const s of rec.sends) {
			const t = audioTrack(seq, s.trackId);
			// a send retargeted by hand is the user's now
			if (!t?.mixer?.sends?.some((x) => x.id === s.sendId && x.target === rec.busId)) continue;
			removeOwnSend(doc, seq, t, s.sendId, s.made, h);
			removedSends++;
		}
		if (rec.createdBus && (seq.submixTracks ?? []).some((t) => t.id === rec.busId)) {
			audioHandlers['mixer.removeSubmix'](
				doc,
				{ type: 'mixer.removeSubmix', sequenceId: seq.id, stripId: rec.busId },
				h,
			);
			removedBus = true;
		}
		delete mixOf(seq).room;
		tidyMix(seq);
		if (rec.before?.submixes === false && (peek<unknown[]>(seq, 'submixTracks') ?? []).length === 0)
			delete (seq as DSeq & { submixTracks?: unknown }).submixTracks;
	}
	const before = rec?.before;
	const sd = peek<SoundDesign>(seq, 'soundDesign');
	const roomBus =
		before?.roomBus && (seq.submixTracks ?? []).some((t) => t.id === before.roomBus) ? before.roomBus : null;
	if (sd?.settings && sd.settings.roomBus !== roomBus) settingsOf(seq).roomBus = roomBus;
	// Exactly as before the glue: settings it created (still the defaults) and a sound design it created (still empty) go.
	if (before && sd) {
		const defaults = JSON.stringify(readSoundDesignSettings(undefined));
		const cur = peek<SoundDesign>(seq, 'soundDesign')!;
		if (!before.settings && cur.settings && JSON.stringify(plainCopy(cur.settings)) === defaults)
			delete soundDesignOf(seq).settings;
		const left = peek<SoundDesign>(seq, 'soundDesign')!;
		if (
			!before.soundDesign &&
			Object.keys(left.cues ?? {}).length === 0 &&
			Object.keys(left).every((k) => k === 'cues')
		)
			delete (seq as DSeq & { soundDesign?: unknown }).soundDesign;
	}
	return { busId: rec?.busId ?? null, removedBus, removedSends };
}

/**
 * After a placement (`soundDesign.place`): a track a sound was placed on that should send to the room (and does not)
 * gets the room glue's send. Only adds (`ensureBus` also removes). No-op without room glue. Exported for `sound.ts`.
 */
export function syncRoomSends(doc: DDoc, seq: DSeq, trackIds: readonly string[], h: HandlerContext): void {
	const rec = peekMix(seq)?.room;
	if (!rec || trackIds.length === 0) return;
	if (!(seq.submixTracks ?? []).some((t) => t.id === rec.busId)) return;
	const plan = roomSendPlan(doc as never, seq as Sequence);
	const sends = [...rec.sends];
	for (const id of new Set(trackIds)) {
		const d = plan.find((x) => x.trackId === id);
		const t = audioTrack(seq, id);
		if (!d?.send || !t) continue;
		const list = t.mixer?.sends ?? [];
		if (list.some((s) => s.target === rec.busId) || list.length >= MAX_SENDS) continue;
		if (sends.length >= SOUND_MIX_LIMITS.sends) break;
		const made = madeBySend(t);
		const r = audioHandlers['mixer.addSend'](
			doc,
			{ type: 'mixer.addSend', sequenceId: seq.id, stripId: t.id, target: rec.busId, levelDb: rec.sendDb },
			h,
		) as { sendId: string };
		sends.push({ trackId: t.id, sendId: r.sendId, ...(made ? { made } : {}) });
	}
	if (sends.length !== rec.sends.length) mixOf(seq).room!.sends = sends as never;
}

// ---------------------------------------------------------------------------------------------------------------
// Delivery

function applyDelivery(doc: DDoc, cmd: CommandOf<'soundDesign.applyDelivery'>, h: HandlerContext) {
	const seq = h.sequence(doc, cmd.sequenceId);
	const preset = deliveryPreset(cmd.delivery);
	settingsOf(seq).delivery = cmd.delivery;
	let loudness: unknown = null;
	if (cmd.loudness !== false) {
		const r = audioHandlers['mixer.setLoudness'](
			doc,
			{
				type: 'mixer.setLoudness',
				sequenceId: seq.id,
				enabled: true,
				targetLufs: preset.integratedLufs,
				truePeakDb: preset.truePeakDb,
				...(cmd.analysis !== undefined ? { analysis: cmd.analysis } : {}),
			},
			h,
		) as { loudness: unknown };
		loudness = r.loudness;
	}
	// Auto-Match by type.
	const hasDialogue = Object.values(seq.clips).some(
		(c) =>
			c.kind === 'audio' &&
			c.enabled !== false &&
			readEssentialSound((c as AudioClip).essential)?.type === 'dialogue',
	);
	const targets = deliveryMatchTargets(cmd.delivery, hasDialogue);
	const matched: Record<string, { type: string; targetLufs: number; gainDb: number } | { skipped: string }> =
		{};
	const groups = new Map<number, Record<string, number | null>>();
	const typeOf = new Map<string, string>();
	for (const [id, lufs] of Object.entries(cmd.measuredLufs ?? {})) {
		const c = seq.clips[id] as Clip | undefined;
		if (!c) h.fail('E_NOT_FOUND', `Clip not found in ${seq.id}: ${id}`, { path: ['measuredLufs', id] });
		if (c.kind !== 'audio')
			h.fail('E_INVALID_PARAM', `${id} is not an audio clip`, { path: ['measuredLufs', id] });
		const type = readEssentialSound((c as AudioClip).essential)?.type ?? null;
		if (type === null) {
			matched[id] = { skipped: 'no audio type' };
			continue;
		}
		const target = targets[type as keyof typeof targets];
		if (target === null || target === undefined) {
			matched[id] = { skipped: 'sound effects are balanced by the masking solver' };
			continue;
		}
		typeOf.set(id, type);
		const g = groups.get(target) ?? {};
		g[id] = lufs;
		groups.set(target, g);
	}
	for (const [targetLufs, measuredLufs] of groups) {
		const r = essentialHandlers['essentialSound.autoMatch'](
			doc,
			{ type: 'essentialSound.autoMatch', measuredLufs, targetLufs },
			h,
		) as { clips: Record<string, { gainDb: number } | { skipped: string }> };
		for (const [id, v] of Object.entries(r.clips))
			matched[id] = 'gainDb' in v ? { type: typeOf.get(id)!, targetLufs, gainDb: v.gainDb } : v;
	}
	// Ducking (music / ambience under their triggers). The depth: a clip's own Ducking amount when the user set it;
	// a type default is the delivery's (DELIVERY_DUCK_DB under the matched bed, so during speech the bed sits the
	// relative target + DELIVERY_DUCK_DB under the voice) and is written into the clip's Ducking (`depthBy:
	// 'delivery'`) so the panel and Generate Keyframes show what was used.
	const ducked: Record<string, number> = {};
	const duckDepth: Record<string, { reduceDb: number; by: 'delivery' | 'user' }> = {};
	for (const [gi, g] of (cmd.ducking ?? []).entries()) {
		for (const id of g.clipIds) {
			const c = seq.clips[id] as Clip | undefined;
			if (!c) h.fail('E_NOT_FOUND', `Clip not found in ${seq.id}: ${id}`, { path: ['ducking', String(gi)] });
			const es = c.kind === 'audio' ? readEssentialSound((c as AudioClip).essential) : null;
			if (!es || (es.type !== 'music' && es.type !== 'ambience'))
				h.fail('E_INVALID_PARAM', `Ducking applies to Music or Ambience clips (${id})`, {
					path: ['ducking', String(gi)],
				});
			const by = duckingDepthBy(es);
			const reduceDb = by === 'user' || !hasDialogue ? es.ducking.reduceDb : -DELIVERY_DUCK_DB;
			const values: Record<string, unknown> = {};
			if (!es.ducking.enabled) values['ducking.enabled'] = true;
			if (reduceDb !== es.ducking.reduceDb) values['ducking.reduceDb'] = reduceDb;
			if (Object.keys(values).length)
				essentialHandlers['essentialSound.set'](
					doc,
					{ type: 'essentialSound.set', clipIds: [id], values } as CommandOf<'essentialSound.set'>,
					h,
				);
			// essentialSound.set marks a depth it sets as the user's: this one is the delivery's
			const ducking = ((seq.clips[id] as DAudio).essential as { ducking?: { depthBy?: string } } | undefined)
				?.ducking;
			if (ducking && by !== 'user' && hasDialogue && ducking.depthBy !== 'delivery')
				ducking.depthBy = 'delivery';
			duckDepth[id] = { reduceDb, by: by === 'user' || !hasDialogue ? 'user' : 'delivery' };
			const r = audioHandlers['audio.autoDuck'](
				doc,
				{
					type: 'audio.autoDuck',
					targetClipIds: [id],
					regions: g.regions,
					amountDb: -reduceDb,
					fadeMs: es.ducking.fadeSeconds * 1000,
				},
				h,
			) as { keyframes: Record<string, number> };
			ducked[id] = r.keyframes[id] ?? 0;
		}
	}
	// Ducking rewrote those clips' Volume: their stop-before dips are written again on the ducked curve.
	const redipped = redip(doc, seq, new Set(Object.keys(ducked)), h);
	// Placed sounds still at placement's default level follow the preset's default (not on a locked track).
	const levels: string[] = [];
	const levelsSkipped: { clipId: string; reason: string }[] = [];
	for (const c of Object.values(seq.clips)) {
		if (c.kind !== 'audio' || sfxGainOwner(c as DAudio) !== 'default') continue;
		if (findTrackIn(seq, c.trackId)?.track.locked) {
			levelsSkipped.push({ clipId: c.id, reason: 'its track is locked' });
			continue;
		}
		if (refreshDefaultLevel(doc, seq, c as DAudio, { onlyDefault: true })) levels.push(c.id);
	}
	return {
		sequenceId: seq.id,
		delivery: cmd.delivery,
		loudness,
		matched,
		ducked,
		duckDepth,
		redipped,
		levels,
		...(levelsSkipped.length ? { levelsSkipped } : {}),
	};
}

export const soundMixHandlers = {
	'audio.volumeDip': volumeDip,
	'soundDesign.applyStopBefore': applyStopBefore,
	'soundDesign.applyBuild': applyBuild,
	'soundDesign.ensureBus': ensureBus,
	'soundDesign.removeBus': removeBus,
	'soundDesign.applyDelivery': applyDelivery,
} satisfies HandlerMap;

export type { Track };
