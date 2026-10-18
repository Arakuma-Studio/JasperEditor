// `soundDesign.layBed` (spec 12 §4 P6-E12; wp-note "Phase 6 → WP-E8"): ambience beds per scene and room tone in dialogue
// gaps, laid with the ordinary edit machinery (`placeSource`, `essentialSound.setType`, `transition.add`,
// `clip.group`, `track.add`, `audio.volumeDip`): every result is a normal clip, transition or keyframe (spec 12 §1).
// The layout is the pure `planBedLayout` (sound/ambience-bed.ts).
import type { Draft } from 'immer';
import { current, isDraft } from 'immer';
import { clipEnd } from '../../derive/index.ts';
import { mediaDurationFlicks } from '../../interpret/model.ts';
import type { ProjectDocument } from '../../schema/document.ts';
import type { MediaAsset } from '../../schema/media.ts';
import type { AudioClip, Sequence } from '../../schema/sequence.ts';
import {
	type BedPurpose,
	type ClipBed,
	readClipBed,
	readSoundDesignSettings,
	type SoundDesign,
} from '../../schema/sound.ts';
import {
	AMBIENCE_BED_DEFAULTS,
	type BedLayoutRun,
	type BedShotInput,
	planBedLayout,
	ROOM_TONE_DEFAULTS,
} from '../../sound/ambience-bed.ts';
import { dialogueSpans } from '../../sound/cues/dialogue.ts';
import { audioTrackIsFree, type SoundTrackSequence } from '../../sound/insert.ts';
import { defaultSfxLevel } from '../../sound/level.ts';
import { readLibraryProvenance } from '../../sound/provenance.ts';
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../../time.ts';
import { CONSTANT_GAIN, CONSTANT_POWER } from '../../transitions.ts';
import type { DDoc, DSeq, HandlerContext } from '../context.ts';
import { assertUnlocked, cleanupSequence, findTrackIn, removeClip, resolveTrackIn } from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { VOLUME_DIP_MAX } from '../schemas/sound-mix.ts';
import { placeSource } from './clip-core.ts';
import { essentialHandlers } from './essential.ts';
import { sequenceHandlers } from './sequence.ts';
import { soundMixHandlers } from './sound-mix.ts';
import { structureHandlers } from './structure.ts';
import { transitionHandlers } from './transition.ts';
import type { HandlerMap } from './util.ts';

type DAudio = Draft<AudioClip> & { bed?: ClipBed };

const SOUND_MEDIA_KINDS: ReadonlySet<string> = new Set(['audio', 'video']);

/** Whether an audio track holds no clip over any of `spans` (frames), is unlocked and exists. */
function trackFree(seq: DSeq, trackId: string, spans: readonly { start: number; end: number }[]): boolean {
	const view = seq as unknown as SoundTrackSequence;
	return spans.every((s) => audioTrackIsFree(view, trackId, s.start, s.end - s.start));
}

/** The track a bed goes on: explicit (refusals), else the first free unlocked track named like it, else a new one. */
function bedTrack(
	doc: DDoc,
	seq: DSeq,
	ref: string | undefined,
	name: string,
	spans: readonly { start: number; end: number }[],
	h: HandlerContext,
): { trackId: string; created: boolean } {
	if (ref !== undefined && ref.toLowerCase() !== 'auto') {
		const id = resolveTrackIn(seq, ref);
		if (!id) return h.fail('E_NOT_FOUND', `Track not found: ${ref}`, { path: ['track'] });
		const t = findTrackIn(seq, id)!;
		if (t.kind !== 'audio')
			h.fail('E_TRACK_KIND', `${ref} is a ${t.kind} track; a bed goes on an audio track`, {
				path: ['track'],
				blocking: [id],
			});
		assertUnlocked(t.track, h);
		if (!trackFree(seq, id, spans))
			h.fail('E_OVERLAP', `${ref} has audio where the bed goes; a bed never overwrites (use track "auto")`, {
				path: ['track'],
			});
		return { trackId: id, created: false };
	}
	const re = new RegExp(`^${name}\\b`, 'i');
	for (const t of seq.audioTracks)
		if (re.test(t.name ?? '') && !t.locked && trackFree(seq, t.id, spans))
			return { trackId: t.id, created: false };
	const taken = new Set(seq.audioTracks.map((t) => (t.name ?? '').toLowerCase()));
	let label = name;
	for (let k = 2; taken.has(label.toLowerCase()); k++) label = `${name} ${k}`;
	const r = sequenceHandlers['track.add'](
		doc,
		{ type: 'track.add', sequenceId: seq.id, kind: 'audio', name: label },
		h,
	) as { trackIds: string[] };
	return { trackId: r.trackIds[0]!, created: true };
}

/** A media that can be a bed: audio (or a video's audio) with a length. */
function bedMedia(
	doc: DDoc,
	mediaId: string,
	h: HandlerContext,
	path: string[],
): { asset: Draft<MediaAsset>; flicks: number } {
	const asset = doc.media[mediaId] as Draft<MediaAsset> | undefined;
	if (!asset) return h.fail('E_NOT_FOUND', `Media not found: ${mediaId}`, { path });
	if (!SOUND_MEDIA_KINDS.has(asset.kind) || !asset.probe.streams.some((s) => s.type === 'audio'))
		h.fail('E_INVALID_PARAM', `Media ${asset.id} has no sound to lay as a bed`, { path });
	const flicks = mediaDurationFlicks(asset as MediaAsset);
	if (!flicks || !(flicks > 0)) return h.fail('E_INVALID_PARAM', `Media ${asset.id} has no length`, { path });
	return { asset, flicks };
}

function layBed(doc: DDoc, cmd: CommandOf<'soundDesign.layBed'>, h: HandlerContext) {
	if ((cmd.range === undefined) === (cmd.shots === undefined))
		h.fail('E_INVALID_PARAM', 'soundDesign.layBed needs exactly one of range or shots');
	const seq = h.sequence(doc, cmd.sequenceId);
	const rate = seq.settings.frameRate as Rational;
	const F = flicksPerFrame(rate);
	const fps = rate.num / rate.den;
	const purpose: BedPurpose = cmd.purpose ?? 'ambience';
	const room = purpose === 'roomtone';
	const toFrames = (sec: number) => Math.round(sec * fps);
	// the shots, in order, each with its media and loop
	const raw = cmd.range
		? [{ start: cmd.range.start, end: cmd.range.end }]
		: (cmd.shots ?? []).map((s) => ({ ...s }));
	type Shot = BedShotInput & { gainDb: number | null; fade: 'equal-power' | 'equal-gain'; path: string[] };
	const shots: Shot[] = raw.map((s, i) => {
		const path = cmd.range ? ['range'] : ['shots', String(i)];
		const start = h.frame(seq, s.start as never);
		const end = h.frame(seq, s.end as never);
		if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end - start < 2)
			h.fail('E_INVALID_PARAM', `A bed span needs a start ≥ 0 and at least 2 frames (got ${start}…${end})`, {
				path,
			});
		const own = 'mediaId' in s && typeof s.mediaId === 'string' ? s.mediaId : undefined;
		const mediaId = own ?? cmd.mediaId;
		const { flicks } = bedMedia(doc, mediaId, h, own ? [...path, 'mediaId'] : ['mediaId']);
		const loopSec = ('loop' in s && s.loop) || (mediaId === cmd.mediaId ? cmd.loop : undefined) || null;
		const inFlicks = loopSec ? Math.round(loopSec.inSec * FLICKS_PER_SECOND) : 0;
		const outFlicks = loopSec ? Math.min(flicks, Math.round(loopSec.outSec * FLICKS_PER_SECOND)) : flicks;
		if (loopSec && Math.round(loopSec.inSec * FLICKS_PER_SECOND) >= flicks)
			h.fail('E_INVALID_PARAM', `The loop starts after the end of media ${mediaId}`, {
				path: [...path, 'loop'],
			});
		const gain = 'gainDb' in s && typeof s.gainDb === 'number' ? s.gainDb : (cmd.gainDb ?? null);
		const fade = ('fade' in s && s.fade) || cmd.fade || 'equal-power';
		return {
			start,
			end,
			mediaId,
			mediaFlicks: flicks,
			loop: { inFlicks, outFlicks },
			gainDb: gain,
			fade,
			path,
		};
	});
	for (let i = 1; i < shots.length; i++)
		if (shots[i]!.start < shots[i - 1]!.end)
			h.fail(
				'E_INVALID_PARAM',
				`Shot ${i + 1} starts before shot ${i} ends: shots must be in order, without overlaps`,
				{
					path: ['shots', String(i)],
				},
			);
	const spans = shots.map((s) => ({ start: s.start, end: s.end }));
	// replace: the earlier beds of this purpose over these spans go first (their transitions and groups with them)
	const replaced: string[] = [];
	if (cmd.replace) {
		const locked = new Set(seq.audioTracks.filter((t) => t.locked).map((t) => t.id));
		for (const id of Object.keys(seq.clips)) {
			const c = seq.clips[id] as DAudio;
			if (c.kind !== 'audio' || c.bed === undefined) continue;
			const bed = readClipBed(c.bed);
			if (!bed || bed.purpose !== purpose) continue;
			if (!spans.some((s) => c.start < s.end && clipEnd(c) > s.start)) continue;
			if (locked.has(c.trackId)) {
				h.warn('W_BED_LOCKED_KEPT', `Clip ${c.id} of an earlier bed is on a locked track: kept`);
				continue;
			}
			replaced.push(id);
		}
		for (const id of replaced) removeClip(seq, id, h);
	}
	const settings = readSoundDesignSettings((seq as { soundDesign?: SoundDesign }).soundDesign?.settings);
	const fadeSec = cmd.fadeSec ?? (room ? ROOM_TONE_DEFAULTS.fadeSec : AMBIENCE_BED_DEFAULTS.fadeSec);
	const crossfadeSec = cmd.crossfadeSec ?? AMBIENCE_BED_DEFAULTS.crossfadeSec;
	const sceneSec = cmd.sceneCrossfadeSec ?? AMBIENCE_BED_DEFAULTS.sceneCrossfadeSec;
	const planned = planBedLayout(shots, {
		fps: rate,
		crossfadeFrames: Math.max(2, toFrames(crossfadeSec)),
		sceneCrossfadeFrames: toFrames(sceneSec),
		fadeFrames: toFrames(fadeSec),
	});
	if (!planned.ok)
		return h.fail(planned.code, planned.message, {
			path: planned.shot !== undefined ? shots[planned.shot]!.path : [],
		});
	const layout = planned.layout;
	for (const i of layout.shortened)
		h.warn(
			'W_BED_CROSSFADE_SHORTENED',
			`Shot ${i + 1}: its loop (${((shots[i]!.loop.outFlicks - shots[i]!.loop.inFlicks) / FLICKS_PER_SECOND).toFixed(2)} s) is too short for a ${crossfadeSec} s crossfade; ${(layout.crossfades[i]! / fps).toFixed(2)} s`,
			shots[i]!.path,
		);
	const track = bedTrack(
		doc,
		seq,
		cmd.track,
		room ? ROOM_TONE_DEFAULTS.trackName : AMBIENCE_BED_DEFAULTS.trackName,
		spans,
		h,
	);
	// the default level: the gain given, else the library sound's ambience level (its descriptors), else 0 dB
	const gainOf = (s: Shot): number => {
		if (s.gainDb !== null) return s.gainDb;
		const prov = readLibraryProvenance((doc.media[s.mediaId] as { library?: unknown }).library);
		if (!prov?.descriptors) return 0;
		return defaultSfxLevel({
			role: 'support',
			types: ['ambience'],
			maxMomentaryLufs: prov.descriptors.maxMomentaryLufs ?? null,
			truePeakDb: prov.descriptors.truePeakDb ?? null,
			delivery: settings.delivery,
		}).gainDb;
	};
	const clipIds: string[] = [];
	const transitionIds: string[] = [];
	const beds: {
		start: number;
		end: number;
		clipIds: string[];
		mediaId: string;
		pieces: number;
		crossfadeFrames: number;
	}[] = [];
	const addTransition = transitionHandlers['transition.add']!;
	for (const run of layout.runs) {
		const ids: string[] = [];
		const perShot = new Map<number, string[]>();
		for (const p of run.pieces) {
			const s = shots[p.shot]!;
			const res = placeSource(doc, seq, h, {
				source: { mediaId: p.mediaId },
				at: p.start,
				mode: 'overwrite',
				audioTracks: [track.trackId],
				video: false,
				audio: true,
				audioMapping: 'stereo',
				matchSequence: 'keep',
				createTracks: false,
				fitted: { rate: 1, audio: { in: p.sourceInFlicks, offset: 0, frames: p.frames } },
			});
			const id = res.clipIds[0]!;
			const clip = seq.clips[id] as DAudio;
			clip.gainDb = gainOf(s);
			clip.bed = {
				purpose,
				shot: p.shot,
				piece: p.piece,
				loop: { inFlicks: s.loop.inFlicks, outFlicks: s.loop.outFlicks },
			};
			ids.push(id);
			perShot.set(p.shot, [...(perShot.get(p.shot) ?? []), id]);
		}
		essentialHandlers['essentialSound.setType'](
			doc,
			{ type: 'essentialSound.setType', clipIds: ids, audioType: 'ambience' },
			h,
		);
		// names: "<media> (Bed 2/7)" per shot
		for (const [shot, list] of perShot) {
			const base = (seq.clips[list[0]!]!.name || 'Bed').replace(/ \((Bed|Room Tone) \d+\/\d+\)$/, '');
			list.forEach((id, k) => {
				(seq.clips[id] as DAudio).name =
					list.length > 1 ? `${base} (${room ? 'Room Tone' : 'Bed'} ${k + 1}/${list.length})` : base;
			});
			const s = shots[shot]!;
			beds.push({
				start: s.start,
				end: s.end,
				clipIds: list,
				mediaId: s.mediaId,
				pieces: list.length,
				crossfadeFrames: layout.crossfades[shot]!,
			});
		}
		const transitionsOf = (r: BedLayoutRun) => {
			for (const j of r.joins) {
				const law =
					j.kind === 'loop' && shots[j.shot]!.fade === 'equal-gain' ? CONSTANT_GAIN : CONSTANT_POWER;
				const out = addTransition(
					doc,
					{
						type: 'transition.add',
						sequenceId: seq.id,
						trackId: track.trackId,
						at: j.at,
						effectId: law,
						duration: j.frames,
						alignment: 'center',
					},
					h,
				) as { transitionId?: string };
				if (out?.transitionId) transitionIds.push(out.transitionId);
			}
			const edge = (clipId: string, e: 'in' | 'out', frames: number) => {
				if (frames < 1) return;
				const out = addTransition(
					doc,
					{
						type: 'transition.add',
						sequenceId: seq.id,
						clipId,
						edge: e,
						effectId: CONSTANT_POWER,
						duration: frames,
					},
					h,
				) as { transitionId?: string };
				if (out?.transitionId) transitionIds.push(out.transitionId);
			};
			edge(ids[0]!, 'in', r.fadeIn);
			edge(ids[ids.length - 1]!, 'out', r.fadeOut);
		};
		transitionsOf(run);
		if (ids.length >= 2) structureHandlers['clip.group'](doc, { type: 'clip.group', clipIds: ids }, h);
		clipIds.push(...ids);
	}
	// ducking with Volume keyframes: under the dialogue (the one dialogue definition, from the document) or heroes
	let ducked = 0;
	if (cmd.duckUnder) {
		const plain = (isDraft(doc) ? current(doc) : doc) as unknown as ProjectDocument;
		const pseq = plain.sequences[seq.id] as Sequence;
		const under: { start: number; end: number }[] =
			cmd.duckUnder === 'dialogue'
				? dialogueSpans(plain, pseq).map((s) => ({ start: s.start, end: s.end }))
				: Object.values(pseq.clips)
						.filter(
							(c) =>
								c.kind === 'audio' &&
								(c as { sfx?: { role?: unknown } }).sfx?.role === 'hero' &&
								!clipIds.includes(c.id),
						)
						.map((c) => ({ start: c.start, end: clipEnd(c) }));
		const depth =
			cmd.duckDb ??
			(cmd.duckUnder === 'dialogue'
				? AMBIENCE_BED_DEFAULTS.duckDialogueDb
				: AMBIENCE_BED_DEFAULTS.duckHeroesDb);
		const fadeMs =
			cmd.duckUnder === 'dialogue'
				? AMBIENCE_BED_DEFAULTS.duckDialogueFadeMs
				: AMBIENCE_BED_DEFAULTS.duckHeroesFadeMs;
		const bedSpan = spans.length ? { start: spans[0]!.start, end: spans[spans.length - 1]!.end } : null;
		const dips = under
			.filter((u) => bedSpan && u.start < bedSpan.end && u.end > bedSpan.start)
			.map((u) => ({ start: u.start * F, end: u.end * F, depthDb: depth, fadeMs }));
		for (let k = 0; k < dips.length && depth < 0; k += VOLUME_DIP_MAX) {
			const chunk = dips.slice(k, k + VOLUME_DIP_MAX);
			const r = soundMixHandlers['audio.volumeDip'](
				doc,
				{ type: 'audio.volumeDip', clipIds, dips: chunk },
				h,
			) as {
				clips: Record<string, { written?: number }>;
			};
			if (Object.values(r.clips).some((c) => (c.written ?? 0) > 0)) ducked += chunk.length;
		}
		if (dips.length === 0)
			h.warn(
				'W_BED_NOTHING_TO_DUCK',
				`No ${cmd.duckUnder === 'dialogue' ? 'dialogue' : 'hero sound'} plays over the bed`,
			);
	}
	cleanupSequence(seq, h);
	return {
		sequenceId: seq.id,
		purpose,
		trackId: track.trackId,
		trackCreated: track.created,
		clipIds,
		transitionIds,
		beds,
		replacedClipIds: replaced,
		ducked,
	};
}

export const soundBedHandlers = {
	'soundDesign.layBed': layBed,
} satisfies HandlerMap;
