// Invariants and repair of sound-design data (spec 12 §2.2): `Sequence.soundDesign` (INV-SOUND) and `AudioClip.sfx`
// (INV-SFX) must be readable; references between them and the edit are soft (editing never fails because a cue's clip
// went away) and `repairDocument` tidies them on load: dangling anchors → null (with a report line), placed clips that
// are gone pruned, a clip's missing cue → `cueId: null`, malformed or duplicate cue ids renamed, settings naming
// missing tracks pruned. Idempotent. Pure (works on a plain, mutable copy of the document).
import { type IdSource, isValidId } from '../ids.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';
import {
	type ClipSfx,
	clipSfxIssue,
	readClipSfx,
	readSoundDesign,
	type SoundCue,
	type SoundDesign,
	soundDesignIssue,
} from '../schema/sound.ts';
import { cueAnchorTargetExists } from './anchor.ts';

const isRecord = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === 'object' && !Array.isArray(v);

/** INV-SOUND: what is wrong with a sequence's stored sound design (schema, cue ids), or null. */
export function sequenceSoundDesignIssue(seq: { soundDesign?: unknown }): string | null {
	const sd = seq.soundDesign;
	if (sd === undefined) return null;
	const bad = soundDesignIssue(sd);
	if (bad) return bad;
	for (const id of Object.keys((sd as SoundDesign).cues))
		if (!isValidId(id, 'cue')) return `cue id ${id} is malformed (expected cue_…)`;
	return null;
}

/** INV-SFX: what is wrong with a clip's `sfx`, or null (only audio clips carry it). */
export function clipSfxProblem(c: { kind: string; sfx?: unknown }): string | null {
	const sfx = (c as { sfx?: unknown }).sfx;
	if (sfx === undefined) return null;
	if (c.kind !== 'audio') return `a ${c.kind} clip cannot carry sound-design metadata`;
	return clipSfxIssue(sfx);
}

/** The cues of a sequence (empty when it has none or they are unreadable). */
export function soundCuesOf(seq: { soundDesign?: unknown }): SoundCue[] {
	const sd = seq.soundDesign;
	if (!isRecord(sd) || !isRecord(sd.cues)) return [];
	return Object.values(sd.cues as Record<string, SoundCue>);
}

/** Every audio track id of a sequence (and submix ids). */
function trackIds(seq: Sequence): { audio: Set<string>; submix: Set<string> } {
	return {
		audio: new Set(seq.audioTracks.map((t) => t.id)),
		submix: new Set((seq.submixTracks ?? []).map((t) => t.id)),
	};
}

/**
 * Whether the document has soft references to tidy (dangling anchors, placed clips or cues that are gone, cue ids
 * shared by two sequences, settings naming missing tracks). Invariant problems are reported by INV-SOUND / INV-SFX;
 * `loadProject` also repairs when this is true.
 */
export function soundDesignNeedsRepair(doc: ProjectDocument): boolean {
	const seenCue = new Set<string>();
	for (const seq of Object.values(doc.sequences) as Sequence[]) {
		const sd = seq.soundDesign as SoundDesign | undefined;
		const cueIds = new Set<string>();
		if (sd !== undefined) {
			if (sequenceSoundDesignIssue(seq)) return true;
			for (const cue of Object.values(sd.cues)) {
				if (seenCue.has(cue.id)) return true;
				seenCue.add(cue.id);
				cueIds.add(cue.id);
				if (cue.anchor && !cueAnchorTargetExists(doc, seq, cue.anchor)) return true;
				for (const id of cue.placedClipIds ?? []) if (seq.clips[id]?.kind !== 'audio') return true;
			}
			const s = sd.settings;
			if (s) {
				const t = trackIds(seq);
				if (s.sfxTrackIds.some((id) => !t.audio.has(id))) return true;
				if (s.roomBus !== null && !t.submix.has(s.roomBus)) return true;
			}
		}
		for (const c of Object.values(seq.clips)) {
			const sfx = (c as { sfx?: unknown }).sfx;
			if (sfx === undefined) continue;
			if (clipSfxProblem(c as Clip & { sfx?: unknown })) return true;
			const id = (sfx as ClipSfx).cueId;
			if (id !== null && !cueIds.has(id)) return true;
		}
	}
	return false;
}

type Note = (action: string, entity: string, detail: string) => void;

/**
 * Repairs sound-design data in place (`doc` is a mutable copy): unreadable data is read leniently or dropped, cue ids
 * made valid and unique, dangling references removed. Idempotent: a repaired document needs no further repair.
 */
export function repairSoundDesign(doc: ProjectDocument, ids: IdSource, note: Note): void {
	const seenCue = new Set<string>();
	for (const seq of Object.values(doc.sequences) as Sequence[]) {
		const r = seq as { soundDesign?: unknown };
		// Clip metadata first: unreadable → read leniently, on another kind of clip → dropped.
		for (const c of Object.values(seq.clips)) {
			const cr = c as { sfx?: unknown };
			if (cr.sfx === undefined || clipSfxProblem(c as Clip & { sfx?: unknown }) === null) continue;
			const fixed = c.kind === 'audio' ? readClipSfx(cr.sfx) : null;
			if (fixed) {
				cr.sfx = fixed;
				note('repair-sfx', c.id, 'sound-design metadata repaired');
			} else {
				delete cr.sfx;
				note('drop-sfx', c.id, 'unreadable sound-design metadata removed (the clip stays)');
			}
		}
		let sd: SoundDesign | undefined;
		if (r.soundDesign !== undefined) {
			if (soundDesignIssue(r.soundDesign) === null) sd = r.soundDesign as SoundDesign;
			else {
				const fixed = readSoundDesign(r.soundDesign);
				if (fixed) {
					sd = fixed;
					r.soundDesign = fixed;
					note('repair-sound-design', seq.id, 'sound cues repaired (unreadable cues or fields removed)');
				} else {
					delete r.soundDesign;
					note('drop-sound-design', seq.id, 'unreadable sound design removed');
				}
			}
		}
		const renamed = new Map<string, string>();
		if (sd) {
			// Cue ids: well-formed `cue_…`, unique in the document (a sequence copied by an older build may share them).
			const cues: Record<string, SoundCue> = Object.create(null);
			for (const cue of Object.values(sd.cues)) {
				let id = cue.id;
				if (!isValidId(id, 'cue') || seenCue.has(id)) {
					id = ids.next('cue');
					renamed.set(cue.id, id);
					note('reid-cue', seq.id, `cue ${cue.id} renamed ${id} (malformed or duplicate id)`);
				}
				seenCue.add(id);
				cues[id] = id === cue.id ? cue : { ...cue, id };
			}
			sd.cues = cues;
			const t = trackIds(seq);
			for (const cue of Object.values(sd.cues)) {
				if (cue.anchor && !cueAnchorTargetExists(doc, seq, cue.anchor)) {
					note(
						'drop-cue-anchor',
						cue.id,
						`the ${cue.anchor.type} the cue followed is gone: it stays at frame ${cue.frame}`,
					);
					cue.anchor = null;
				}
				if (cue.placedClipIds) {
					const keep = cue.placedClipIds.filter(
						(id, i, a) => seq.clips[id]?.kind === 'audio' && a.indexOf(id) === i,
					);
					if (keep.length !== cue.placedClipIds.length) {
						note(
							'prune-cue-clips',
							cue.id,
							`${cue.placedClipIds.length - keep.length} placed clip(s) no longer exist`,
						);
						if (keep.length) cue.placedClipIds = keep;
						else delete cue.placedClipIds;
					}
				}
			}
			const s = sd.settings;
			if (s) {
				const keep = s.sfxTrackIds.filter((id) => t.audio.has(id));
				if (keep.length !== s.sfxTrackIds.length) {
					s.sfxTrackIds = keep;
					note('prune-sfx-tracks', seq.id, 'sound-design SFX tracks that no longer exist removed');
				}
				if (s.roomBus !== null && !t.submix.has(s.roomBus)) {
					s.roomBus = null;
					note('reset-room-bus', seq.id, 'the SFX room submix no longer exists');
				}
			}
		}
		// A clip's cue must be a cue of its own sequence (renamed with it).
		for (const c of Object.values(seq.clips)) {
			const sfx = (c as { sfx?: ClipSfx }).sfx;
			if (!sfx || sfx.cueId === null) continue;
			const id = renamed.get(sfx.cueId) ?? sfx.cueId;
			if (sd && Object.hasOwn(sd.cues, id)) {
				if (id !== sfx.cueId) sfx.cueId = id;
				continue;
			}
			sfx.cueId = null;
			note('unlink-sfx', c.id, 'the sound cue it filled no longer exists');
		}
	}
}

/**
 * A copied sequence's sound design follows the copy (`sequence.duplicate`): new cue ids, placed clips, anchors and
 * clip links mapped to the copy's clips, transitions, tracks and markers (references that did not come along dangle,
 * like after an edit, and are dropped). Mutates `seq` (a plain copy).
 */
export function remapSoundDesign(
	seq: Sequence,
	maps: {
		clips: ReadonlyMap<string, string>;
		tracks: ReadonlyMap<string, string>;
		transitions: ReadonlyMap<string, string>;
		markers: ReadonlyMap<string, string>;
	},
	newCueId: () => string,
): void {
	const r = seq as { soundDesign?: unknown };
	const cueMap = new Map<string, string>();
	const sd = r.soundDesign;
	if (isRecord(sd) && isRecord(sd.cues)) {
		const m = (map: ReadonlyMap<string, string>, id: string) => map.get(id) ?? id;
		const cues: Record<string, SoundCue> = Object.create(null);
		for (const raw of Object.values(sd.cues as Record<string, SoundCue>)) {
			if (!isRecord(raw)) continue;
			const id = newCueId();
			cueMap.set(raw.id, id);
			const cue: SoundCue = { ...raw, id };
			if (cue.placedClipIds)
				cue.placedClipIds = cue.placedClipIds.map((c) => maps.clips.get(c)).filter((c): c is string => !!c);
			const a = cue.anchor;
			if (a && isRecord(a)) {
				switch (a.type) {
					case 'edit':
						cue.anchor = {
							...a,
							trackId: m(maps.tracks, a.trackId),
							outgoingClipId: m(maps.clips, a.outgoingClipId),
							incomingClipId: m(maps.clips, a.incomingClipId),
						};
						break;
					case 'transition':
						cue.anchor = { ...a, transitionId: m(maps.transitions, a.transitionId) };
						break;
					case 'marker':
						cue.anchor = { ...a, markerId: m(maps.markers, a.markerId) };
						break;
					case 'scene':
						break;
					default:
						cue.anchor = { ...a, clipId: m(maps.clips, a.clipId) } as SoundCue['anchor'];
				}
			}
			cues[id] = cue;
		}
		(sd as { cues: unknown }).cues = cues;
		const s = sd.settings;
		if (isRecord(s) && Array.isArray(s.sfxTrackIds))
			s.sfxTrackIds = (s.sfxTrackIds as string[])
				.map((t) => maps.tracks.get(t))
				.filter((t): t is string => !!t);
	}
	for (const c of Object.values(seq.clips)) {
		const sfx = (c as { sfx?: unknown }).sfx;
		if (!isRecord(sfx) || typeof sfx.cueId !== 'string') continue;
		sfx.cueId = cueMap.get(sfx.cueId) ?? null;
	}
}
