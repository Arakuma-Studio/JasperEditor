// Sound design mixing handlers (spec 12 §2.4, §2.9; P4-R3, P4-R4; wp-note "Phase 4 → WP4.2a"): `audio.volumeDip`, the
// stop-before and build realizations of a cue, the "SFX Room" glue and delivery presets. Each is made of the ordinary edit
// handlers (`mixer.writeAutomation`, `mixer.addSubmix`, `mixer.addSend`, `effect.add`, `mixer.setLoudness`,
// `essentialSound.autoMatch`, `audio.autoDuck`…) so preview and every export render it with nothing new (spec 12 §1), and
// records what it wrote in `soundDesign.mix` so it can be redone or taken out exactly. The pure curve math is
// `sound/mix.ts`. This module never imports `sound.ts` (the placement handlers import its hooks).
import type { Draft } from 'immer';
import { FADER_MAX_DB, FADER_MIN_DB, MAX_SENDS } from '../../audio/strip.ts';
import { readEssentialSound } from '../../essential/model.ts';
import { evaluate } from '../../keyframes.ts';
import type { Animatable, Keyframe } from '../../schema/common.ts';
import type { AudioClip, Clip, EffectInstance, Sequence, Track } from '../../schema/sequence.ts';
import {
	type ClipSfx,
	type CueMix,
	type MixWrite,
	readSoundDesignSettings,
	SOUND_MIX_LIMITS,
	type SoundCue,
	type SoundDesign,
	type SoundDesignMix,
	type SoundDesignSettings,
} from '../../schema/sound.ts';
import { deliveryMatchTargets, deliveryPreset } from '../../sound/delivery.ts';
import {
	BUILD_FILTER_EFFECT_ID,
	BUILD_FILTER_PARAMS,
	BUILD_REST_HZ,
	buildSweepPoints,
	clipLaneTime,
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

/** Takes one recorded write out (its keys, and back the ones it replaced when nothing rewrote the range since). */
function unwrite(seq: DSeq, w: MixWrite, h: HandlerContext): boolean {
	const t = writeTarget(seq, w);
	if (!t) return false;
	assertUnlocked(t.track, h);
	const r = unwriteCurve(plainCopy(t.anim.keyframes) as Keyframe<number>[], w);
	t.anim.keyframes = r.keyframes as never;
	return r.exact;
}

/** A write record from the keys of a lane before and after (keys added; keys gone). */
function diffWrite(
	before: readonly Keyframe<number>[],
	after: readonly Keyframe<number>[],
	base: Omit<MixWrite, 'written' | 'replaced'>,
	h: HandlerContext,
): MixWrite {
	const was = new Set(before.map((k) => k.id));
	const now = new Set(after.map((k) => k.id));
	const written = after.filter((k) => !was.has(k.id)).map((k) => k.id);
	const replaced = before.filter((k) => !now.has(k.id));
	if (written.length > SOUND_MIX_LIMITS.written || replaced.length > SOUND_MIX_LIMITS.replaced)
		h.fail('E_LIMIT', 'The automation under the cue is too dense to record (thin it first)');
	return { ...base, written, replaced: plainCopy(replaced) };
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
// Stop-before

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

/** Takes the cue's recorded stop-before dip out of the mix. Returns the number of writes undone. */
function removeStopBefore(seq: DSeq, cueId: string, h: HandlerContext): number {
	const rec = peekMix(seq)?.cues?.[cueId]?.stopBefore;
	if (!rec) return 0;
	for (const w of rec.writes) unwrite(seq, w, h);
	const mix = mixOf(seq);
	const c = mix.cues?.[cueId];
	if (c) {
		delete c.stopBefore;
		if (!c.build) delete mix.cues![cueId];
	}
	return rec.writes.length;
}

/** Writes the cue's stop-before dip (its `stopBefore` must be set). */
function writeStopBefore(
	doc: DDoc,
	seq: DSeq,
	cue: Draft<SoundCue>,
	opts: { ambience?: boolean },
	h: HandlerContext,
): { writes: MixWrite[]; reason: string | null } {
	const spec = cue.stopBefore!;
	const rate = rateOf(seq);
	const F = flicksPerFrame(rate);
	const dip = stopBeforeDip(cue.frame, spec, rate);
	if (!dip)
		return { writes: [], reason: 'the dip has no length (seconds 0, depth 0 dB, or at the very start)' };
	const fade = dip.fadeMs * MS;
	const a = Math.max(0, Math.floor((dip.start - fade) / F));
	const b = Math.ceil((dip.end + fade) / F);
	const uses = musicTracksUnder(seq as Sequence, a, b, opts.ambience ? ['music', 'ambience'] : ['music']);
	if (uses.length === 0) return { writes: [], reason: 'no music plays under the cue' };
	const writes: MixWrite[] = [];
	for (const u of uses) {
		const track = audioTrack(seq, u.trackId)!;
		assertUnlocked(track, h);
		if (!u.shared && !u.automationOff) {
			// The music track's volume lane (mixer.writeAutomation: keys outside the range are kept).
			track.volumeDb ??= { value: 0, keyframes: [] } as never;
			const before = plainCopy(track.volumeDb!.keyframes) as Keyframe<number>[];
			const merged = mergeDips(plainCopy(track.volumeDb!) as Animatable<number>, SEQUENCE_LANE, [dip], {
				newId: () => 'tmp',
				clamp: [FADER_MIN_DB, FADER_MAX_DB],
			});
			if (!merged) continue;
			for (const [ws, we] of merged.windows) {
				const pts = merged.keyframes
					.filter((k) => k.time >= Math.round(ws) && k.time <= Math.round(we))
					.map((k) => [k.time, k.value] as [number, number]);
				if (pts.length === 0) continue;
				audioHandlers['mixer.writeAutomation'](
					doc,
					{
						type: 'mixer.writeAutomation',
						sequenceId: seq.id,
						stripId: track.id,
						lane: 'volume',
						points: pts,
						thinning: { tolerance: 0 },
					},
					h,
				);
			}
			writes.push(
				diffWrite(
					before,
					track.volumeDb!.keyframes as Keyframe<number>[],
					{ target: 'trackVolume', trackId: track.id },
					h,
				),
			);
			continue;
		}
		// Shared with other audio there (or its lane is not played): the music clips' Volume.
		for (const id of u.clipIds) {
			const clip = seq.clips[id] as DAudio;
			const before = plainCopy(clip.volumeDb.keyframes) as Keyframe<number>[];
			if (!dipClip(seq, clip, [dip], h)) continue;
			writes.push(
				diffWrite(
					before,
					clip.volumeDb.keyframes as Keyframe<number>[],
					{ target: 'clipVolume', clipId: id },
					h,
				),
			);
		}
	}
	return { writes, reason: writes.length ? null : 'no music plays under the cue' };
}

function realizeStopBefore(
	doc: DDoc,
	seq: DSeq,
	cue: Draft<SoundCue>,
	opts: { ambience?: boolean },
	h: HandlerContext,
): { applied: boolean; removed: number; writes: MixWrite[]; reason: string | null } {
	const removed = removeStopBefore(seq, cue.id, h);
	if (!cue.stopBefore) return { applied: false, removed, writes: [], reason: 'the cue has no stop-before' };
	if (cue.muted) return { applied: false, removed, writes: [], reason: 'the cue is muted' };
	const r = writeStopBefore(doc, seq, cue, opts, h);
	if (r.writes.length) {
		const mix = mixOf(seq);
		mix.cues ??= {} as never;
		const c = (mix.cues![cue.id] ??= {} as Draft<CueMix>);
		c.stopBefore = {
			seconds: cue.stopBefore.seconds,
			depthDb: cue.stopBefore.depthDb,
			frame: cue.frame,
			...(opts.ambience ? { ambience: true } : {}),
			writes: r.writes,
		} as never;
	}
	return { applied: r.writes.length > 0, removed, writes: r.writes, reason: r.reason };
}

function applyStopBefore(doc: DDoc, cmd: CommandOf<'soundDesign.applyStopBefore'>, h: HandlerContext) {
	const { seq, cue } = cueOf(doc, h, cmd.cueId, cmd.sequenceId);
	const prev = peekMix(seq)?.cues?.[cue.id]?.stopBefore as { ambience?: boolean } | undefined;
	const r = realizeStopBefore(doc, seq, cue, { ambience: cmd.ambience ?? prev?.ambience ?? false }, h);
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
	owner: { trackId: string } | { clipId: string },
	h: HandlerContext,
): { fx: DEffect; created: boolean } {
	const key = 'trackId' in owner ? owner.trackId : owner.clipId;
	const list =
		'trackId' in owner
			? (audioTrack(seq, owner.trackId)!.effects ?? [])
			: (seq.clips[owner.clipId] as DAudio).effects;
	const known = peekMix(seq)?.buildFilters?.[key];
	const found = known ? (list.find((e) => e.id === known) as DEffect | undefined) : undefined;
	if (found && found.effectId === BUILD_FILTER_EFFECT_ID) return { fx: found, created: false };
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

/** Clips a polyline (sequence flicks) to [s0, s1], with interpolated end points. */
function clipPolyline(points: readonly [number, number][], s0: number, s1: number): [number, number][] {
	const at = (t: number) => {
		if (t <= points[0]![0]) return points[0]![1];
		for (let i = 1; i < points.length; i++) {
			const [ta, va] = points[i - 1]!;
			const [tb, vb] = points[i]!;
			if (t <= tb) return tb === ta ? vb : va + ((vb - va) * (t - ta)) / (tb - ta);
		}
		return points[points.length - 1]![1];
	};
	const a = Math.max(s0, points[0]![0]);
	const b = Math.min(s1, points[points.length - 1]![0]);
	if (!(b > a)) return [];
	const out: [number, number][] = [[a, at(a)]];
	for (const p of points) if (p[0] > a && p[0] < b) out.push([p[0], p[1]]);
	out.push([b, at(b)]);
	return out;
}

/** Writes a sweep on a filter's cutoff (lane time `lane`); the rest value is the curve's own at the window's edges. */
function writeSweep(
	fx: DEffect,
	lane: LaneTime,
	sweep: { ws: number; we: number; points: [number, number][] },
	h: HandlerContext,
): { written: string[]; replaced: Keyframe<number>[] } {
	fx.params.cutoff ??= { value: BUILD_REST_HZ, keyframes: [] } as never;
	const anim = fx.params.cutoff as unknown as DAnim;
	const plain = plainCopy(anim) as Animatable<number>;
	const restA = evaluate(plain, lane.toLane(sweep.ws));
	const restB = evaluate(plain, lane.toLane(sweep.we));
	const pts = sweep.points.map(
		([t, v], i) =>
			[t, i === 0 && v === BUILD_REST_HZ ? restA : i === sweep.points.length - 1 ? restB : v] as [
				number,
				number,
			],
	);
	const w = writeCurve(plain, lane, sweep.ws, sweep.we, pts, () => h.ids.next('kf'));
	anim.keyframes = w.keyframes as never;
	return { written: w.written, replaced: w.replaced };
}

function removeBuild(doc: DDoc, seq: DSeq, cueId: string, h: HandlerContext): number {
	const rec = peekMix(seq)?.cues?.[cueId]?.build;
	if (!rec) return 0;
	for (const w of rec.writes) unwrite(seq, w, h);
	const mix = mixOf(seq);
	const c = mix.cues?.[cueId];
	if (c) {
		delete c.build;
		if (!c.stopBefore) delete mix.cues![cueId];
	}
	// A build filter no other build uses and without keys left goes.
	const used = new Set<string>();
	for (const other of Object.values(peekMix(seq)?.cues ?? {}))
		for (const w of other.build?.writes ?? []) if (w.effectInstanceId) used.add(w.effectInstanceId);
	for (const w of rec.writes) {
		const id = w.effectInstanceId;
		if (!id || used.has(id)) continue;
		const t = writeTarget(seq, w);
		if (!t || t.anim.keyframes.length > 0) continue;
		effectHandlers['effect.remove']!(doc, { type: 'effect.remove', effectInstanceId: id }, h);
		const filters = mix.buildFilters;
		if (filters) for (const [k, v] of Object.entries(filters)) if (v === id) delete filters[k];
	}
	return rec.writes.length;
}

function writeBuild(
	doc: DDoc,
	seq: DSeq,
	cue: Draft<SoundCue>,
	h: HandlerContext,
): { writes: MixWrite[]; reason: string | null } {
	const rate = rateOf(seq);
	const F = flicksPerFrame(rate);
	const sweep = buildSweepPoints(cue.frame, cue.build!, rate);
	if (!sweep) return { writes: [], reason: 'the build has no length (seconds 0, or at the very start)' };
	const a = Math.max(0, Math.floor(sweep.ws / F));
	const uses = musicTracksUnder(seq as Sequence, a, cue.frame, ['music']);
	if (uses.length === 0) return { writes: [], reason: 'no music plays before the cue' };
	const writes: MixWrite[] = [];
	for (const u of uses) {
		const track = audioTrack(seq, u.trackId)!;
		assertUnlocked(track, h);
		if (!u.shared) {
			const { fx } = buildFilter(doc, seq, { trackId: track.id }, h);
			const w = writeSweep(fx, SEQUENCE_LANE, sweep, h);
			writes.push({ target: 'trackFilter', trackId: track.id, effectInstanceId: fx.id, ...plainCopy(w) });
			continue;
		}
		// The music shares its track with other audio: a clip filter on each music clip.
		for (const id of u.clipIds) {
			const clip = seq.clips[id] as DAudio;
			const lane = clipLaneTime(clip as AudioClip, rate);
			const pts = clipPolyline(sweep.points, lane.span[0], lane.span[1]);
			if (pts.length < 2) continue;
			const { fx } = buildFilter(doc, seq, { clipId: id }, h);
			const w = writeSweep(fx, lane, { ws: pts[0]![0], we: pts[pts.length - 1]![0], points: pts }, h);
			writes.push({ target: 'clipFilter', clipId: id, effectInstanceId: fx.id, ...plainCopy(w) });
		}
	}
	return { writes, reason: writes.length ? null : 'no music plays before the cue' };
}

function realizeBuild(
	doc: DDoc,
	seq: DSeq,
	cue: Draft<SoundCue>,
	h: HandlerContext,
): { applied: boolean; removed: number; writes: MixWrite[]; reason: string | null } {
	const removed = removeBuild(doc, seq, cue.id, h);
	if (!cue.build) return { applied: false, removed, writes: [], reason: 'the cue has no build' };
	if (cue.muted) return { applied: false, removed, writes: [], reason: 'the cue is muted' };
	const r = writeBuild(doc, seq, cue, h);
	if (r.writes.length) {
		const mix = mixOf(seq);
		mix.cues ??= {} as never;
		const c = (mix.cues![cue.id] ??= {} as Draft<CueMix>);
		c.build = {
			seconds: cue.build.seconds,
			fromHz: cue.build.fromHz,
			toHz: cue.build.toHz,
			frame: cue.frame,
			writes: r.writes,
		} as never;
	}
	return { applied: r.writes.length > 0, removed, writes: r.writes, reason: r.reason };
}

function applyBuild(doc: DDoc, cmd: CommandOf<'soundDesign.applyBuild'>, h: HandlerContext) {
	const { seq, cue } = cueOf(doc, h, cmd.cueId, cmd.sequenceId);
	const r = realizeBuild(doc, seq, cue, h);
	return {
		cueId: cue.id,
		applied: r.applied,
		removed: r.removed,
		writes: r.writes.map((w) => summary(seq, w)),
		...(r.reason ? { reason: r.reason } : {}),
	};
}

/**
 * Keeps a cue's realised stop-before and build in step with the cue (`soundCue.update`, `soundCue.resync`, and
 * `soundCue.remove`): a removed cue, a cleared or muted field takes its writes out; a moved cue or a changed field
 * writes them again. Cues never realised are left alone. Exported for the cue handlers.
 */
export function followCueMix(doc: DDoc, seq: DSeq, cueId: string, h: HandlerContext, removed: boolean): void {
	const rec = peekMix(seq)?.cues?.[cueId];
	if (!rec) return;
	const cue = removed ? null : (soundDesignOf(seq).cues[cueId] ?? null);
	if (rec.stopBefore) {
		const s = cue?.stopBefore;
		const same =
			cue &&
			!cue.muted &&
			s &&
			s.seconds === rec.stopBefore.seconds &&
			s.depthDb === rec.stopBefore.depthDb &&
			cue.frame === rec.stopBefore.frame;
		if (!same) {
			if (!cue) removeStopBefore(seq, cueId, h);
			else
				realizeStopBefore(
					doc,
					seq,
					cue,
					{ ambience: (rec.stopBefore as { ambience?: boolean }).ambience },
					h,
				);
		}
	}
	if (rec.build) {
		const b = cue?.build;
		const same =
			cue &&
			!cue.muted &&
			b &&
			b.seconds === rec.build.seconds &&
			b.fromHz === rec.build.fromHz &&
			b.toHz === rec.build.toHz &&
			cue.frame === rec.build.frame;
		if (!same) {
			if (!cue) removeBuild(doc, seq, cueId, h);
			else realizeBuild(doc, seq, cue, h);
		}
	}
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

function ensureBus(doc: DDoc, cmd: CommandOf<'soundDesign.ensureBus'>, h: HandlerContext) {
	const seq = h.sequence(doc, cmd.sequenceId);
	const prev = peekMix(seq)?.room;
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
		assertUnlocked(bus, h);
		setParam(reverb, 'decay', opts.decay);
		setParam(reverb, 'mix', opts.mix);
		setParam(reverb, 'preDelay', opts.preDelayMs);
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
				audioHandlers['mixer.removeSend'](
					doc,
					{ type: 'mixer.removeSend', sequenceId: seq.id, stripId: t.id, sendId: existing.id },
					h,
				);
				removed.push(t.id);
			}
			skipped.push({ trackId: t.id, track: label(seq, t.id), reason: d.reason });
			continue;
		}
		if (existing) {
			audioHandlers['mixer.updateSend'](
				doc,
				{
					type: 'mixer.updateSend',
					sequenceId: seq.id,
					stripId: t.id,
					sendId: existing.id,
					patch: { levelDb: opts.sendDb, ...(existing.preFader ? { preFader: false } : {}) },
				},
				h,
			);
			sends.push({ trackId: t.id, sendId: existing.id });
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
		const r = audioHandlers['mixer.addSend'](
			doc,
			{ type: 'mixer.addSend', sequenceId: seq.id, stripId: t.id, target: bus.id, levelDb: opts.sendDb },
			h,
		) as { sendId: string };
		sends.push({ trackId: t.id, sendId: r.sendId });
		out.push({ trackId: t.id, track: label(seq, t.id), sendId: r.sendId, added: true });
	}
	// Own sends on tracks the plan no longer names (a track removed from sfxTracks, now bed-only, deleted).
	for (const [trackId, sendId] of own) {
		if (plan.some((d) => d.trackId === trackId)) continue;
		const t = audioTrack(seq, trackId);
		const s = t?.mixer?.sends?.find((x) => x.id === sendId);
		if (t && s) {
			audioHandlers['mixer.removeSend'](
				doc,
				{ type: 'mixer.removeSend', sequenceId: seq.id, stripId: t.id, sendId },
				h,
			);
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
			if (!t?.mixer?.sends?.some((x) => x.id === s.sendId)) continue;
			audioHandlers['mixer.removeSend'](
				doc,
				{ type: 'mixer.removeSend', sequenceId: seq.id, stripId: t.id, sendId: s.sendId },
				h,
			);
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
	}
	const sd = peek<SoundDesign>(seq, 'soundDesign');
	if (sd?.settings && sd.settings.roomBus !== null) settingsOf(seq).roomBus = null;
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
		const r = audioHandlers['mixer.addSend'](
			doc,
			{ type: 'mixer.addSend', sequenceId: seq.id, stripId: t.id, target: rec.busId, levelDb: rec.sendDb },
			h,
		) as { sendId: string };
		sends.push({ trackId: t.id, sendId: r.sendId });
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
	// Ducking (music / ambience under their triggers), each clip with its own Ducking amount and fades.
	const ducked: Record<string, number> = {};
	for (const [gi, g] of (cmd.ducking ?? []).entries()) {
		for (const id of g.clipIds) {
			const c = seq.clips[id] as Clip | undefined;
			if (!c) h.fail('E_NOT_FOUND', `Clip not found in ${seq.id}: ${id}`, { path: ['ducking', String(gi)] });
			const es = c.kind === 'audio' ? readEssentialSound((c as AudioClip).essential) : null;
			if (!es || (es.type !== 'music' && es.type !== 'ambience'))
				h.fail('E_INVALID_PARAM', `Ducking applies to Music or Ambience clips (${id})`, {
					path: ['ducking', String(gi)],
				});
			if (!es.ducking.enabled)
				essentialHandlers['essentialSound.set'](
					doc,
					{ type: 'essentialSound.set', clipIds: [id], values: { 'ducking.enabled': true } },
					h,
				);
			const r = audioHandlers['audio.autoDuck'](
				doc,
				{
					type: 'audio.autoDuck',
					targetClipIds: [id],
					regions: g.regions,
					amountDb: -es.ducking.reduceDb,
					fadeMs: es.ducking.fadeSeconds * 1000,
				},
				h,
			) as { keyframes: Record<string, number> };
			ducked[id] = r.keyframes[id] ?? 0;
		}
	}
	// Ducking rewrote those clips' Volume: their stop-before dips are written again on the ducked curve.
	const redipped: string[] = [];
	const duckedIds = new Set(Object.keys(ducked));
	for (const [cueId, rec] of Object.entries(peekMix(seq)?.cues ?? {})) {
		if (!rec.stopBefore?.writes.some((w) => w.clipId && duckedIds.has(w.clipId))) continue;
		const cue = soundDesignOf(seq).cues[cueId];
		if (!cue) continue;
		realizeStopBefore(doc, seq, cue, { ambience: (rec.stopBefore as { ambience?: boolean }).ambience }, h);
		redipped.push(cueId);
	}
	// Placed sounds still at placement's default level follow the preset's default.
	const levels: string[] = [];
	for (const c of Object.values(seq.clips))
		if (c.kind === 'audio' && refreshDefaultLevel(doc, seq, c as DAudio, { onlyDefault: true }))
			levels.push(c.id);
	return { sequenceId: seq.id, delivery: cmd.delivery, loudness, matched, ducked, redipped, levels };
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
