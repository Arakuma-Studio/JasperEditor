// Sound design command handlers (spec 12 §2.9; owner `sound-design`): library provenance of media (P1); cues,
// placement, swap, palette and settings (P2). Placement reuses the ordinary edit machinery (`placeSource`,
// `essentialSound.setType`, `effect.add`, `clip.group`, `track.add`): every result is a normal clip (spec 12 §1).
import type { Draft } from 'immer';
import { mediaDurationFlicks } from '../../interpret/model.ts';
import type { Keyframe } from '../../schema/common.ts';
import type { MediaAsset } from '../../schema/media.ts';
import type { AudioClip, Clip, Sequence } from '../../schema/sequence.ts';
import {
	type ClipSfx,
	readSoundDesignSettings,
	SOUND_DESIGN_LIMITS,
	type SoundCue,
	type SoundDesign,
	type SoundDesignSettings,
} from '../../schema/sound.ts';
import { cueAnchorTargetExists, resolveCueAnchor } from '../../sound/anchor.ts';
import {
	audioTrackClipsIn,
	audioTrackIsFree,
	chooseSoundTrack,
	planSoundInsert,
	resolveSoundAlign,
	type SoundTiming,
	type SoundTrackSequence,
	soundTimingOf,
} from '../../sound/insert.ts';
import {
	type LibraryProvenance,
	libraryDescriptorIssue,
	readLibraryProvenance,
} from '../../sound/provenance.ts';

import { isSoundTypeId, SOUND_TYPE_IDS } from '../../sound/taxonomy.ts';
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../../time.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import { assertUnlocked, cleanupSequence, findTrackIn, removeClip, resolveTrackIn } from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import type { SoundCueInput } from '../schemas/sound.ts';
import { placeSource } from './clip-core.ts';
import { effectHandlers } from './effect.ts';
import { essentialHandlers } from './essential.ts';
import { newKeyframe } from './param.ts';
import { sequenceHandlers } from './sequence.ts';
import { structureHandlers } from './structure.ts';
import { type HandlerMap, peek, peekKeys } from './util.ts';

export const SOUND_DESIGN_OWNER = 'sound-design' as const;

/** Media kinds that can be a library sound (it is audio, or a video file whose audio is the sound). */
const SOUND_MEDIA_KINDS: ReadonlySet<string> = new Set(['audio', 'video']);
/** Pitch shifts up to this many semitones are made by varispeed (spec 12 §2.3); larger ones by the Pitch Shifter. */
export const VARISPEED_PITCH_MAX_ST = 3;
export const PITCH_SHIFTER_EFFECT_ID = 'jasper.audio.pitch-shifter';

type DAudio = Draft<AudioClip> & { sfx?: ClipSfx };
type DCue = Draft<SoundCue>;

function setLibraryInfo(doc: DDoc, cmd: CommandOf<'media.setLibraryInfo'>, h: HandlerContext) {
	const asset = doc.media[cmd.mediaId] as Draft<MediaAsset> | undefined;
	if (!asset) h.fail('E_NOT_FOUND', `Media not found: ${cmd.mediaId}`);
	if (cmd.library === null) {
		if (asset.library !== undefined) delete asset.library;
		return { mediaId: asset.id, library: null };
	}
	if (!SOUND_MEDIA_KINDS.has(asset.kind))
		h.fail('E_INVALID_PARAM', `Library provenance applies to audio media, not ${asset.kind} (${asset.id})`, {
			path: ['mediaId'],
		});
	const library = JSON.parse(JSON.stringify(cmd.library)) as LibraryProvenance;
	const bad = libraryDescriptorIssue(library);
	if (bad) h.fail('E_INVALID_PARAM', bad, { path: ['library', 'descriptors'] });
	asset.library = library as Draft<LibraryProvenance>;
	return { mediaId: asset.id, library };
}

// ---------------------------------------------------------------------------------------------------------------
// Cue lookup

const plainCopy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A sequence's sound design (created empty when `create`), or null. */
function soundDesignOf(seq: DSeq, create: true): Draft<SoundDesign>;
function soundDesignOf(seq: DSeq, create: boolean): Draft<SoundDesign> | null;
function soundDesignOf(seq: DSeq, create: boolean): Draft<SoundDesign> | null {
	const s = seq as DSeq & { soundDesign?: Draft<SoundDesign> };
	if (s.soundDesign === undefined) {
		if (!create) return null;
		s.soundDesign = { cues: {} } as Draft<SoundDesign>;
	}
	return s.soundDesign;
}

/** Whether any sequence has a cue with this id (read without drafting). */
function cueIdInUse(doc: DDoc, id: string): boolean {
	const seqs = peek<Record<string, Sequence>>(doc, 'sequences')!;
	for (const sid of peekKeys(seqs)) {
		const sd = peek<SoundDesign>(peek<Sequence>(seqs, sid)!, 'soundDesign');
		const cues = sd ? peek<Record<string, SoundCue>>(sd, 'cues') : undefined;
		if (cues && Object.hasOwn(cues, id)) return true;
	}
	return false;
}

/** The cue `cueId`, in `sequenceId` (else the transaction's sequence, else any sequence). E_NOT_FOUND otherwise. */
function findCue(
	doc: DDoc,
	h: HandlerContext,
	cueId: string,
	sequenceId?: string,
): { seq: DSeq; sd: Draft<SoundDesign>; cue: DCue } {
	const seqs = peek<Record<string, Sequence>>(doc, 'sequences')!;
	const order = [sequenceId ?? h.tx.sequenceId, ...peekKeys(seqs)].filter((s): s is string => !!s);
	if (sequenceId && !peek(seqs, sequenceId)) h.fail('E_NOT_FOUND', `Sequence not found: ${sequenceId}`);
	for (const sid of sequenceId ? [sequenceId] : order) {
		const raw = peek<Sequence>(seqs, sid);
		const sd = raw ? peek<SoundDesign>(raw, 'soundDesign') : undefined;
		const cues = sd ? peek<Record<string, SoundCue>>(sd, 'cues') : undefined;
		if (!cues || !Object.hasOwn(cues, cueId)) continue;
		const seq = doc.sequences[sid]!;
		const d = soundDesignOf(seq, true);
		return { seq, sd: d, cue: d.cues[cueId]! };
	}
	return h.fail('E_NOT_FOUND', `Sound cue not found: ${cueId}`, { path: ['cueId'] });
}

/** The audio clips of the sequence that fill a cue (dangling ids skipped). */
function placedClipsOf(seq: DSeq, cue: { placedClipIds?: readonly string[] }): DAudio[] {
	const out: DAudio[] = [];
	for (const id of cue.placedClipIds ?? []) {
		const c = seq.clips[id];
		if (c?.kind === 'audio' && !out.includes(c as DAudio)) out.push(c as DAudio);
	}
	return out;
}

function checkTypes(types: readonly string[] | null | undefined, h: HandlerContext, path: string[]): void {
	for (const t of types ?? [])
		if (!isSoundTypeId(t))
			h.fail('E_INVALID_PARAM', `Unknown sound type "${t}"; the types are ${SOUND_TYPE_IDS.join(', ')}`, {
				path,
			});
}

function checkAnchor(
	doc: DDoc,
	seq: DSeq,
	anchor: SoundCue['anchor'],
	h: HandlerContext,
	path: string[],
): void {
	if (anchor && !cueAnchorTargetExists(doc as never, seq as never, anchor))
		h.fail('E_NOT_FOUND', `The ${anchor.type} this cue anchors to does not exist in the sequence`, { path });
}

// ---------------------------------------------------------------------------------------------------------------
// Moving placed clips with their cue (resync, update)

type ClipMove = { clip: DAudio; to: number };

/**
 * Moves clips by whole frames, all or nothing: each one stays on its track, which must be unlocked
 * (E_TRACK_LOCKED) and free at the new place (E_OVERLAP: never overwrites); none may start before frame 0.
 */
function moveClips(seq: DSeq, moves: readonly ClipMove[], h: HandlerContext): void {
	if (moves.length === 0) return;
	const moving = new Set(moves.map((m) => m.clip.id));
	for (const m of moves) {
		const t = findTrackIn(seq, m.clip.trackId);
		if (!t) h.fail('E_NOT_FOUND', `Track not found: ${m.clip.trackId}`);
		assertUnlocked(t.track, h);
		if (m.to < 0)
			h.fail('E_INVALID_PARAM', `Clip ${m.clip.id} would start before frame 0`, { blocking: [m.clip.id] });
		const end = m.to + m.clip.duration;
		const blocking = Object.values(seq.clips)
			.filter(
				(c) =>
					c.trackId === m.clip.trackId && !moving.has(c.id) && c.start < end && m.to < c.start + c.duration,
			)
			.map((c) => c.id);
		for (const o of moves)
			if (o !== m && o.clip.trackId === m.clip.trackId && o.to < end && m.to < o.to + o.clip.duration)
				blocking.push(o.clip.id);
		if (blocking.length)
			h.fail('E_OVERLAP', `Clip ${m.clip.id} cannot move to frame ${m.to}: other audio is there`, {
				blocking,
			});
	}
	for (const m of moves) m.clip.start = m.to;
	cleanupSequence(seq, h);
}

// ---------------------------------------------------------------------------------------------------------------
// soundCue.*

function cueFromInput(c: SoundCueInput, id: string): SoundCue {
	const { id: _id, ref: _ref, ...rest } = c;
	const out: Record<string, unknown> = { id };
	for (const [k, v] of Object.entries(rest)) if (v !== undefined) out[k] = plainCopy(v);
	return out as SoundCue;
}

function addCues(doc: DDoc, cmd: CommandOf<'soundCue.add'>, h: HandlerContext) {
	const seq = h.sequence(doc, cmd.sequenceId);
	const sd = soundDesignOf(seq, true);
	if (Object.keys(sd.cues).length + cmd.cues.length > SOUND_DESIGN_LIMITS.cues)
		h.fail('E_LIMIT', `A sequence holds at most ${SOUND_DESIGN_LIMITS.cues} sound cues`);
	const cueIds: string[] = [];
	cmd.cues.forEach((c, i) => {
		const path = ['cues', String(i)];
		checkTypes(c.types, h, [...path, 'types']);
		checkAnchor(doc, seq, c.anchor, h, [...path, 'anchor']);
		let id: string;
		if (c.id === undefined) {
			do id = h.ids.next('cue');
			while (cueIdInUse(doc, id) || cueIds.includes(id));
		} else {
			if (!/^cue_[0-9A-Z]{16}$/.test(c.id)) h.fail('E_INVALID_PARAM', `Malformed cue id: ${c.id}`, { path });
			if (cueIdInUse(doc, c.id) || cueIds.includes(c.id))
				h.fail('E_INVALID_PARAM', `Cue id already in use: ${c.id}`, { path });
			id = c.id;
		}
		sd.cues[id] = cueFromInput(c, id) as DCue;
		cueIds.push(id);
		h.defineRef(c.ref, id);
	});
	return { sequenceId: seq.id, cueIds };
}

const CLEARABLE = [
	'label',
	'types',
	'soundIds',
	'align',
	'pan',
	'panSweep',
	'pitchSt',
	'stopBefore',
	'build',
	'confidence',
	'reason',
	'window',
] as const;

function updateCue(doc: DDoc, cmd: CommandOf<'soundCue.update'>, h: HandlerContext) {
	const { seq, cue } = findCue(doc, h, cmd.cueId);
	if (cmd.types) checkTypes(cmd.types, h, ['types']);
	if (cmd.anchor !== undefined) checkAnchor(doc, seq, cmd.anchor, h, ['anchor']);
	const before = cue.frame;
	const r = cue as unknown as Record<string, unknown>;
	for (const k of CLEARABLE) {
		const v = cmd[k];
		if (v === null) delete r[k];
		else if (v !== undefined) r[k] = plainCopy(v);
	}
	for (const k of ['kind', 'weight', 'source', 'muted'] as const) if (cmd[k] !== undefined) r[k] = cmd[k];
	if (cmd.anchor !== undefined) cue.anchor = cmd.anchor === null ? null : (plainCopy(cmd.anchor) as never);
	let moved: string[] = [];
	if (cmd.frame !== undefined && cmd.frame !== before) {
		cue.frame = cmd.frame;
		if (cmd.moveClips !== false) {
			const clips = placedClipsOf(seq, cue);
			moveClips(
				seq,
				clips.map((c) => ({ clip: c, to: c.start + (cmd.frame! - before) })),
				h,
			);
			moved = clips.map((c) => c.id);
		}
	}
	return { cueId: cue.id, frame: cue.frame, movedClipIds: moved };
}

function removeCues(doc: DDoc, cmd: CommandOf<'soundCue.remove'>, h: HandlerContext) {
	const removed: string[] = [];
	const lifted: string[] = [];
	const touched = new Set<DSeq>();
	for (const id of [...new Set(cmd.cueIds)]) {
		const { seq, sd, cue } = findCue(doc, h, id);
		const clips = placedClipsOf(seq, cue);
		if (cmd.withClips) {
			for (const c of clips) assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
			for (const c of clips) {
				removeClip(seq, c.id, h);
				lifted.push(c.id);
			}
			touched.add(seq);
		}
		// Clips that stay (and any other clip naming this cue) forget it.
		for (const c of Object.values(seq.clips)) {
			const sfx = (c as DAudio).sfx;
			if (c.kind === 'audio' && sfx?.cueId === id) sfx.cueId = null;
		}
		delete sd.cues[id];
		removed.push(id);
	}
	for (const seq of touched) cleanupSequence(seq, h);
	return { removed, liftedClipIds: lifted };
}

function resyncCues(doc: DDoc, cmd: CommandOf<'soundCue.resync'>, h: HandlerContext) {
	const seq = h.sequence(doc, cmd.sequenceId);
	const sd = soundDesignOf(seq, false);
	if (!sd) {
		if (cmd.cueIds?.length)
			h.fail('E_NOT_FOUND', `Sound cue not found: ${cmd.cueIds[0]}`, { path: ['cueIds'] });
		return { moved: [], unresolved: [], unanchored: [] };
	}
	const ids = cmd.cueIds ? [...new Set(cmd.cueIds)] : Object.keys(sd.cues);
	for (const id of ids)
		if (!Object.hasOwn(sd.cues, id))
			h.fail('E_NOT_FOUND', `Sound cue not found in sequence ${seq.id}: ${id}`, { path: ['cueIds'] });
	const opts = { mgTemplates: h.registries.mgTemplates };
	const moved: { cueId: string; from: number; to: number; clipIds: string[] }[] = [];
	const unresolved: string[] = [];
	const unanchored: string[] = [];
	const moves: ClipMove[] = [];
	const claimed = new Set<string>();
	for (const id of ids) {
		const cue = sd.cues[id]!;
		if (!cue.anchor) {
			if (cmd.cueIds) unanchored.push(id);
			continue;
		}
		const f = resolveCueAnchor(doc as never, seq as never, cue.anchor as never, opts);
		if (f === null) {
			unresolved.push(id);
			continue;
		}
		if (f === cue.frame) continue;
		const delta = f - cue.frame;
		const clips = placedClipsOf(seq, cue).filter((c) => !claimed.has(c.id));
		for (const c of clips) {
			claimed.add(c.id);
			moves.push({ clip: c, to: c.start + delta });
		}
		moved.push({ cueId: id, from: cue.frame, to: f, clipIds: clips.map((c) => c.id) });
		cue.frame = f;
	}
	moveClips(seq, moves, h);
	return { moved, unresolved, unanchored };
}

// ---------------------------------------------------------------------------------------------------------------
// soundDesign.place

/** Clip speed and Pitch Shifter semitones for a pitch shift (spec 12 §2.3). */
export function pitchPlan(pitchSt: number, rate: number): { rate: number; shifterSt: number } {
	if (!pitchSt) return { rate, shifterSt: 0 };
	if (Math.abs(pitchSt) <= VARISPEED_PITCH_MAX_ST) return { rate: rate * 2 ** (pitchSt / 12), shifterSt: 0 };
	return { rate, shifterSt: pitchSt };
}

/** The timing placement uses for a media: its provenance's descriptors, else only its length (no peak). */
function timingOfMedia(prov: LibraryProvenance | null, durFlicks: number): SoundTiming | null {
	const durationSec = durFlicks / FLICKS_PER_SECOND;
	const t = soundTimingOf(prov, { peakSec: Number.NaN, onsetSec: 0, headQuietSec: 0, durationSec });
	return Number.isFinite(t.peakSec) ? t : null;
}

/** Writes a clip's pan: static, or keyframes at frames relative to `cueFrame`. */
function writePan(
	clip: DAudio,
	pan: number | { keyframes: { offset: number; value: number }[] },
	cueFrame: number,
	rate: Rational,
	h: HandlerContext,
	path: string[],
): void {
	if (typeof pan === 'number') {
		clip.pan = { value: pan, keyframes: [] } as never;
		return;
	}
	const F = flicksPerFrame(rate);
	const keys: Keyframe<number>[] = [];
	let prev = Number.NEGATIVE_INFINITY;
	for (const k of pan.keyframes) {
		if (k.offset <= prev) h.fail('E_INVALID_PARAM', 'Pan keyframe offsets must increase', { path });
		prev = k.offset;
		// Before the media starts: held at its first sample (the clip cannot show earlier content).
		const time = Math.max(
			0,
			Math.round(clip.sourceIn + (cueFrame + k.offset - clip.start) * F * clip.speed.rate),
		);
		if (keys[keys.length - 1]?.time === time) keys.pop();
		keys.push(newKeyframe(h, time, k.value, false) as Keyframe<number>);
	}
	clip.pan = { value: keys[0]!.value, keyframes: keys } as never;
}

/**
 * The pan a cue asks for: its `panSweep` as two keyframes over its window (± 0.2 s around the cue without one), else
 * its static pan; `'auto'` without a number = centred (no pan written).
 */
function cuePan(
	cue: DCue | null,
	cueFrame: number,
	rate: Rational,
): number | { keyframes: { offset: number; value: number }[] } | undefined {
	if (!cue) return undefined;
	const sweep = cue.panSweep;
	if (sweep && sweep.from !== sweep.to) {
		const half = Math.max(1, Math.round((0.2 * rate.num) / rate.den));
		let a = cue.window ? cue.window.start - cueFrame : -half;
		let b = cue.window ? cue.window.end - cueFrame : half;
		if (!(b > a)) [a, b] = [-half, half];
		return {
			keyframes: [
				{ offset: a, value: sweep.from },
				{ offset: b, value: sweep.to },
			],
		};
	}
	return typeof cue.pan === 'number' ? cue.pan : undefined;
}

type PlacedLayer = {
	clipId: string;
	mediaId: string;
	soundId: string | null;
	trackId: string;
	trackCreated: boolean;
	layer: number;
	role: ClipSfx['role'];
	align: ClipSfx['placement']['align'];
	start: number;
	duration: number;
	sourceInFlicks: number;
	alignFlicks: number;
	errorFlicks: number;
	rate: number;
	pitchSt: number;
	trimmedHeadSec: number;
};

/** An audio track for `[start, start + frames)`: explicit (refusals), else `auto`. */
function layerTrack(
	doc: DDoc,
	seq: DSeq,
	ref: string | undefined,
	span: { start: number; frames: number },
	preferred: readonly string[],
	h: HandlerContext,
	path: string[],
): { trackId: string; created: boolean } {
	const view = seq as unknown as SoundTrackSequence;
	if (ref !== undefined && ref.toLowerCase() !== 'auto') {
		const id = resolveTrackIn(seq, ref);
		if (!id) return h.fail('E_NOT_FOUND', `Track not found: ${ref}`, { path });
		const t = findTrackIn(seq, id)!;
		if (t.kind !== 'audio')
			h.fail('E_TRACK_KIND', `${ref} is a ${t.kind} track; sounds go on audio tracks`, {
				path,
				blocking: [id],
			});
		assertUnlocked(t.track, h);
		const blocking = audioTrackClipsIn(view, id, span.start, span.frames).map((c) => c.id);
		if (blocking.length)
			h.fail(
				'E_OVERLAP',
				`${ref} has audio between frames ${span.start} and ${span.start + span.frames}; placing never overwrites (use track "auto")`,
				{ path, blocking },
			);
		return { trackId: id, created: false };
	}
	for (const id of preferred)
		if (audioTrackIsFree(view, id, span.start, span.frames)) return { trackId: id, created: false };
	const choice = chooseSoundTrack(view, span);
	if (choice.kind === 'existing') return { trackId: choice.trackId, created: false };
	const r = sequenceHandlers['track.add'](
		doc,
		{ type: 'track.add', sequenceId: seq.id, kind: 'audio', name: choice.name },
		h,
	) as { trackIds: string[] };
	return { trackId: r.trackIds[0]!, created: true };
}

function place(doc: DDoc, cmd: CommandOf<'soundDesign.place'>, h: HandlerContext) {
	if ((cmd.cueId === undefined) === (cmd.frame === undefined))
		h.fail('E_INVALID_PARAM', 'soundDesign.place needs exactly one of cueId or frame');
	let seq: DSeq;
	let cue: DCue | null = null;
	let cueFrame: number;
	if (cmd.cueId !== undefined) {
		const found = findCue(doc, h, cmd.cueId, cmd.sequenceId);
		seq = found.seq;
		cue = found.cue;
		cueFrame = cue.frame;
	} else {
		seq = h.sequence(doc, cmd.sequenceId);
		cueFrame = h.frame(seq, cmd.frame!);
		if (!Number.isSafeInteger(cueFrame) || cueFrame < 0 || cueFrame > SOUND_DESIGN_LIMITS.maxFrame)
			h.fail('E_INVALID_PARAM', `frame must be between 0 and ${SOUND_DESIGN_LIMITS.maxFrame}`, {
				path: ['frame'],
			});
	}
	const existing = cue ? placedClipsOf(seq, cue) : [];
	if (existing.length + cmd.layers.length > SOUND_DESIGN_LIMITS.layers)
		h.fail(
			'E_INVALID_PARAM',
			`A cue holds at most ${SOUND_DESIGN_LIMITS.layers} layers (it has ${existing.length})`,
			{ path: ['layers'] },
		);
	const rate = seq.settings.frameRate as Rational;
	const settings = readSoundDesignSettings((seq as { soundDesign?: SoundDesign }).soundDesign?.settings);
	const preferred: string[] = [];
	for (const ref of cmd.preferTrackIds ?? []) {
		const id = resolveTrackIn(seq, ref);
		if (!id) h.fail('E_NOT_FOUND', `Track not found: ${ref}`, { path: ['preferTrackIds'] });
		if (findTrackIn(seq, id)!.kind === 'audio' && !preferred.includes(id)) preferred.push(id);
	}
	for (const id of settings.sfxTrackIds) if (!preferred.includes(id)) preferred.push(id);

	const placed: PlacedLayer[] = [];
	for (let i = 0; i < cmd.layers.length; i++) {
		const layer = cmd.layers[i]!;
		const path = ['layers', String(i)];
		const index = existing.length + i;
		const asset = doc.media[layer.mediaId] as Draft<MediaAsset> | undefined;
		if (!asset) h.fail('E_NOT_FOUND', `Media not found: ${layer.mediaId}`, { path: [...path, 'mediaId'] });
		if (!SOUND_MEDIA_KINDS.has(asset.kind) || !asset.probe.streams.some((s) => s.type === 'audio'))
			h.fail('E_INVALID_PARAM', `Media ${asset.id} has no sound to place`, { path: [...path, 'mediaId'] });
		const prov = readLibraryProvenance((asset as { library?: unknown }).library);
		const types = prov?.types?.length ? prov.types : (cue?.types ?? []);
		const requested = layer.align && layer.align !== 'auto' ? layer.align : (cue?.align ?? 'auto');
		const align = resolveSoundAlign(types, requested);
		const dur =
			mediaDurationFlicks(asset as MediaAsset) ??
			(prov?.descriptors ? Math.round(prov.descriptors.durationSec * FLICKS_PER_SECOND) : null);
		if (!dur || !(dur > 0)) return h.fail('E_INVALID_PARAM', `Media ${asset.id} has no length`, { path });
		let timing = timingOfMedia(prov, dur);
		if (!timing) {
			if (align === 'peak')
				h.fail(
					'E_INVALID_PARAM',
					`Media ${asset.id} has no peak descriptor (not a Sound Library sound): align it by its start or end, or set its library info`,
					{ path: [...path, 'align'] },
				);
			timing = { peakSec: 0, onsetSec: 0, headQuietSec: 0, durationSec: dur / FLICKS_PER_SECOND };
		}
		const pitchSt = layer.pitchSt ?? cue?.pitchSt ?? 0;
		const pp = pitchPlan(pitchSt, layer.rate ?? 1);
		if (pp.rate < 0.01 || pp.rate > 100)
			h.fail('E_INVALID_PARAM', 'The resulting speed is out of range', { path });
		const plan = planSoundInsert({
			cueFrame,
			fps: rate,
			align,
			timing,
			mediaDurationFlicks: dur,
			rate: pp.rate,
			clampStart: cmd.clampStart ?? false,
		});
		if (!plan.ok) return h.fail(plan.code, plan.message, { path });
		const p = plan.placement;
		const track = layerTrack(doc, seq, layer.track, { start: p.start, frames: p.frames }, preferred, h, [
			...path,
			'track',
		]);
		const res = placeSource(doc, seq, h, {
			source: { mediaId: asset.id },
			at: p.start,
			mode: 'overwrite',
			audioTracks: [track.trackId],
			video: false,
			audio: true,
			audioMapping: 'stereo',
			matchSequence: 'keep',
			createTracks: false,
			fitted: { rate: pp.rate, audio: { in: p.sourceInFlicks, offset: 0, frames: p.frames } },
			...(layer.ref ? { ref: layer.ref } : {}),
		});
		const clipId = res.clipIds[0]!;
		const clip = seq.clips[clipId] as DAudio;
		if (pp.rate !== 1) {
			clip.speed.rate = pp.rate;
			clip.speed.maintainPitch = false;
		}
		essentialHandlers['essentialSound.setType'](
			doc,
			{ type: 'essentialSound.setType', clipIds: [clipId], audioType: 'sfx' },
			h,
		);
		if (layer.gainDb !== undefined) clip.gainDb = layer.gainDb;
		const pan = layer.pan ?? cuePan(cue, cueFrame, rate);
		if (pan !== undefined) writePan(clip, pan, cueFrame, rate, h, [...path, 'pan']);
		if (pp.shifterSt) {
			const whole = Math.trunc(pp.shifterSt);
			effectHandlers['effect.add']!(
				doc,
				{
					type: 'effect.add',
					target: { clipId },
					effectId: PITCH_SHIFTER_EFFECT_ID,
					params: { semitones: whole, cents: Math.round((pp.shifterSt - whole) * 100) },
				},
				h,
			);
		}
		const role = layer.role ?? (index === 0 ? (cue?.weight === 'hero' ? 'hero' : 'support') : 'layer');
		clip.sfx = {
			cueId: cue?.id ?? null,
			soundId: prov?.soundId ?? null,
			layer: index,
			role,
			...(i === 0 && cmd.alternatives?.length ? { alternatives: [...new Set(cmd.alternatives)] } : {}),
			placement: { align, peakFlicks: p.alignFlicks, errorFlicks: p.errorFlicks },
		} as ClipSfx;
		placed.push({
			clipId,
			mediaId: asset.id,
			soundId: prov?.soundId ?? null,
			trackId: track.trackId,
			trackCreated: track.created,
			layer: index,
			role,
			align,
			start: clip.start,
			duration: clip.duration,
			sourceInFlicks: clip.sourceIn,
			alignFlicks: p.alignFlicks,
			errorFlicks: p.errorFlicks,
			rate: pp.rate,
			pitchSt,
			trimmedHeadSec: p.trimmedHeadSec,
		});
	}
	const all = [...existing.map((c) => c.id), ...placed.map((p) => p.clipId)];
	let groupId: string | null = null;
	if ((cmd.group ?? true) && all.length >= 2) {
		const g = structureHandlers['clip.group'](doc, { type: 'clip.group', clipIds: all }, h) as {
			groupId: string;
		};
		groupId = g.groupId;
	}
	if (cue) {
		cue.placedClipIds = all;
		const soundIds = [...(cue.soundIds ?? [])];
		for (const p of placed) if (p.soundId) soundIds[p.layer] = p.soundId;
		const dense = soundIds.filter((s): s is string => typeof s === 'string');
		if (dense.length) cue.soundIds = dense.slice(0, SOUND_DESIGN_LIMITS.soundIds);
	}
	cleanupSequence(seq, h);
	return { sequenceId: seq.id, cueId: cue?.id ?? null, frame: cueFrame, groupId, clips: placed };
}

// ---------------------------------------------------------------------------------------------------------------
// soundDesign.swap

/** Shifts the keyframes and clip markers of an audio clip by `delta` content flicks (they keep their sequence time). */
function shiftContentTimes(clip: DAudio, delta: number): void {
	if (delta === 0) return;
	const shift = (a: { keyframes?: { time: number }[] } | undefined) => {
		for (const k of a?.keyframes ?? []) k.time = Math.max(0, Math.round(k.time + delta));
	};
	shift(clip.volumeDb as never);
	shift(clip.pan as never);
	for (const fx of clip.effects) for (const p of Object.values(fx.params)) shift(p as never);
	for (const m of clip.markers) m.flicks = Math.max(0, Math.round(m.flicks + delta));
}

function swap(doc: DDoc, cmd: CommandOf<'soundDesign.swap'>, h: HandlerContext) {
	const { seq, clip: c } = h.clip(doc, cmd.clipId);
	if (c.kind !== 'audio')
		return h.fail('E_INVALID_PARAM', `${c.id} is not an audio clip`, { path: ['clipId'] });
	const clip = c as DAudio;
	const track = findTrackIn(seq, clip.trackId);
	if (!track) return h.fail('E_NOT_FOUND', `Track not found: ${clip.trackId}`);
	assertUnlocked(track.track, h);
	if (clip.speed.reverse)
		h.fail('E_INVALID_PARAM', 'A reversed clip cannot be swapped', { path: ['clipId'] });
	const rate = seq.settings.frameRate as Rational;
	const F = flicksPerFrame(rate);
	const old = readLibraryProvenance((doc.media[clip.mediaId] as { library?: unknown } | undefined)?.library);
	const sfx = clip.sfx;
	// Where the old sound's aligned point plays (sequence flicks), and which point it is.
	let align = sfx?.placement.align;
	let pointFlicks: number;
	if (sfx)
		pointFlicks =
			clip.start * F +
			(sfx.placement.peakFlicks - clip.sourceIn) / clip.speed.rate -
			sfx.placement.errorFlicks;
	else {
		const oldDur = mediaDurationFlicks(doc.media[clip.mediaId] as MediaAsset) ?? 0;
		const t = old ? timingOfMedia(old, oldDur) : null;
		if (!t)
			return h.fail(
				'E_INVALID_PARAM',
				`${clip.id} was not placed by sound design and its media has no peak`,
				{ path: ['clipId'] },
			);
		align = resolveSoundAlign(old!.types, 'auto');
		const pt = align === 'peak' ? t.peakSec : align === 'start' ? t.onsetSec : t.durationSec;
		pointFlicks = clip.start * F + (pt * FLICKS_PER_SECOND - clip.sourceIn) / clip.speed.rate;
	}
	align = cmd.align ?? align!;
	const cueFrame = Math.round(pointFlicks / F);
	const asset = doc.media[cmd.mediaId] as Draft<MediaAsset> | undefined;
	if (!asset) return h.fail('E_NOT_FOUND', `Media not found: ${cmd.mediaId}`, { path: ['mediaId'] });
	const stream = asset.probe.streams.find((s) => s.type === 'audio');
	if (!SOUND_MEDIA_KINDS.has(asset.kind) || !stream || stream.type !== 'audio')
		return h.fail('E_INVALID_PARAM', `Media ${asset.id} has no sound`, { path: ['mediaId'] });
	const prov = readLibraryProvenance((asset as { library?: unknown }).library);
	const dur = mediaDurationFlicks(asset as MediaAsset);
	if (!dur || !(dur > 0))
		return h.fail('E_INVALID_PARAM', `Media ${asset.id} has no length`, { path: ['mediaId'] });
	let timing = timingOfMedia(prov, dur);
	if (!timing) {
		if (align === 'peak')
			h.fail('E_INVALID_PARAM', `Media ${asset.id} has no peak descriptor (not a Sound Library sound)`, {
				path: ['mediaId'],
			});
		timing = { peakSec: 0, onsetSec: 0, headQuietSec: 0, durationSec: dur / FLICKS_PER_SECOND };
	}
	const plan = planSoundInsert({
		cueFrame,
		fps: rate,
		align,
		timing,
		mediaDurationFlicks: dur,
		rate: clip.speed.rate,
		clampStart: false,
	});
	if (!plan.ok) return h.fail(plan.code, plan.message, { path: ['mediaId'] });
	const p = plan.placement;
	const end = p.start + p.frames;
	const blocking = Object.values(seq.clips)
		.filter(
			(o) =>
				o.id !== clip.id && o.trackId === clip.trackId && o.start < end && p.start < o.start + o.duration,
		)
		.map((o) => o.id);
	if (blocking.length)
		h.fail('E_OVERLAP', `The new sound does not fit on its track between frames ${p.start} and ${end}`, {
			blocking,
		});
	// Content times move with the In point and start: keyframes keep their sequence times.
	const delta = p.sourceInFlicks - clip.sourceIn - (p.start - clip.start) * F * clip.speed.rate;
	shiftContentTimes(clip, delta);
	const oldMedia = clip.mediaId;
	clip.mediaId = asset.id;
	clip.start = p.start;
	clip.duration = p.frames;
	clip.sourceIn = p.sourceInFlicks;
	if (clip.name === (doc.media[oldMedia] as MediaAsset | undefined)?.originalName)
		clip.name = asset.originalName;
	clip.channels = { streamIndex: stream.index, map: stream.channels >= 2 ? [0, 1] : [0] } as never;
	const placement = { align, peakFlicks: p.alignFlicks, errorFlicks: p.errorFlicks };
	if (sfx) {
		sfx.soundId = prov?.soundId ?? null;
		sfx.placement = placement;
	} else
		clip.sfx = {
			cueId: null,
			soundId: prov?.soundId ?? null,
			layer: 0,
			role: 'support',
			placement,
		} as ClipSfx;
	// The cue's sound list follows.
	const cueId = clip.sfx!.cueId;
	const sd = (seq as { soundDesign?: Draft<SoundDesign> }).soundDesign;
	const cue = cueId && sd && Object.hasOwn(sd.cues, cueId) ? sd.cues[cueId]! : null;
	if (cue && prov?.soundId) {
		const list = [...(cue.soundIds ?? [])];
		list[clip.sfx!.layer] = prov.soundId;
		cue.soundIds = list
			.filter((s): s is string => typeof s === 'string')
			.slice(0, SOUND_DESIGN_LIMITS.soundIds);
	}
	cleanupSequence(seq, h);
	return {
		clipId: clip.id,
		mediaId: asset.id,
		soundId: prov?.soundId ?? null,
		start: clip.start,
		duration: clip.duration,
		sourceInFlicks: clip.sourceIn,
		errorFlicks: p.errorFlicks,
		alignedFrame: cueFrame,
		align,
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Settings and palette

/** The sequence's settings, materialised with their read-time defaults (so they can be edited). */
function settingsOf(seq: DSeq): Draft<SoundDesignSettings> {
	const sd = soundDesignOf(seq, true);
	if (!sd.settings) sd.settings = readSoundDesignSettings(undefined) as Draft<SoundDesignSettings>;
	else if (!readSoundDesignSettingsValid(sd.settings))
		sd.settings = readSoundDesignSettings(plainCopy(sd.settings)) as never;
	return sd.settings!;
}

function readSoundDesignSettingsValid(s: unknown): boolean {
	return JSON.stringify(readSoundDesignSettings(plainCopy(s))) === JSON.stringify(plainCopy(s));
}

function setPalette(doc: DDoc, cmd: CommandOf<'soundDesign.setPalette'>, h: HandlerContext) {
	const seq = h.sequence(doc, cmd.sequenceId);
	const s = settingsOf(seq);
	const cur = [...(s.palette ?? [])];
	const given = [...new Set(cmd.soundIds)];
	const mode = cmd.mode ?? 'replace';
	let next: string[];
	if (mode === 'replace') next = given;
	else if (mode === 'add') next = [...cur.filter((x) => !given.includes(x)), ...given];
	else next = cur.filter((x) => !given.includes(x));
	if (next.length > SOUND_DESIGN_LIMITS.palette)
		h.fail('E_LIMIT', `A palette holds at most ${SOUND_DESIGN_LIMITS.palette} sounds`, {
			path: ['soundIds'],
		});
	s.palette = next;
	return { sequenceId: seq.id, palette: [...next] };
}

function setSettings(doc: DDoc, cmd: CommandOf<'soundDesign.setSettings'>, h: HandlerContext) {
	const seq = h.sequence(doc, cmd.sequenceId);
	const s = settingsOf(seq);
	if (cmd.delivery !== undefined) s.delivery = cmd.delivery;
	if (cmd.density !== undefined) s.density = cmd.density;
	if (cmd.seed !== undefined) s.seed = cmd.seed;
	if (cmd.agentsMayApply !== undefined) s.agentsMayApply = cmd.agentsMayApply;
	if (cmd.sfxTrackIds !== undefined) {
		const ids: string[] = [];
		for (const ref of cmd.sfxTrackIds) {
			const id = resolveTrackIn(seq, ref);
			if (!id) h.fail('E_NOT_FOUND', `Track not found: ${ref}`, { path: ['sfxTrackIds'] });
			if (findTrackIn(seq, id)!.kind !== 'audio')
				h.fail('E_TRACK_KIND', `${ref} is not an audio track`, { path: ['sfxTrackIds'], blocking: [id] });
			if (!ids.includes(id)) ids.push(id);
		}
		s.sfxTrackIds = ids;
	}
	if (cmd.roomBus !== undefined) {
		if (cmd.roomBus === null) s.roomBus = null;
		else {
			const subs = seq.submixTracks ?? [];
			const m = /^S(\d+)$/i.exec(cmd.roomBus);
			const t = m ? subs[Number(m[1]) - 1] : subs.find((x) => x.id === cmd.roomBus);
			if (!t) h.fail('E_NOT_FOUND', `Submix track not found: ${cmd.roomBus}`, { path: ['roomBus'] });
			s.roomBus = t.id;
		}
	}
	return { sequenceId: seq.id, settings: plainCopy(s) };
}

// ---------------------------------------------------------------------------------------------------------------
// soundDesign.setPeak

function setPeak(doc: DDoc, cmd: CommandOf<'soundDesign.setPeak'>, h: HandlerContext) {
	const { seq, clip: c } = h.clip(doc, cmd.clipId);
	if (c.kind !== 'audio')
		return h.fail('E_INVALID_PARAM', `${c.id} is not an audio clip`, { path: ['clipId'] });
	const clip = c as DAudio;
	const track = findTrackIn(seq, clip.trackId);
	if (!track) return h.fail('E_NOT_FOUND', `Track not found: ${clip.trackId}`);
	assertUnlocked(track.track, h);
	const media = doc.media[clip.mediaId] as MediaAsset | undefined;
	const dur = media ? (mediaDurationFlicks(media) ?? null) : null;
	if (dur !== null && cmd.peakFlicks > dur)
		h.fail('E_INVALID_PARAM', `The peak is past the end of the media (${dur} flicks)`, { path: ['peakFlicks'] });
	const lib = readLibraryProvenance((media as { library?: unknown } | undefined)?.library);
	if (!clip.sfx && !lib)
		h.fail('E_INVALID_PARAM', `${clip.id} is not a library sound (place it with soundDesign.place first)`, {
			path: ['clipId'],
		});
	// How late the new peak plays after the cue the clip fills (0 when it is early, or fills none).
	const rate = seq.settings.frameRate as Rational;
	const F = flicksPerFrame(rate);
	const cueId = clip.sfx?.cueId ?? null;
	const cue = cueId ? soundDesignOf(seq, false)?.cues[cueId] : undefined;
	const playsAt = clip.start * F + (cmd.peakFlicks - clip.sourceIn) / clip.speed.rate;
	const errorFlicks = cue ? Math.max(0, Math.round(playsAt - cue.frame * F)) : 0;
	const placement = { align: 'peak' as const, peakFlicks: cmd.peakFlicks, errorFlicks };
	if (clip.sfx) clip.sfx.placement = placement;
	else clip.sfx = { cueId: null, soundId: lib!.soundId, layer: 0, role: 'support', placement };
	return { clipId: clip.id, peakFlicks: cmd.peakFlicks, errorFlicks };
}

export const soundHandlers = {
	'media.setLibraryInfo': setLibraryInfo,
	'soundCue.add': addCues,
	'soundCue.update': updateCue,
	'soundCue.remove': removeCues,
	'soundCue.resync': resyncCues,
	'soundDesign.place': place,
	'soundDesign.swap': swap,
	'soundDesign.setPalette': setPalette,
	'soundDesign.setSettings': setSettings,
	'soundDesign.setPeak': setPeak,
} satisfies HandlerMap;

export type { Clip, DClip };
