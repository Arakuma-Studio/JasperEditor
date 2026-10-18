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
	type CueMix,
	clipSfxIssue,
	type MixWrite,
	readClipSfx,
	readSoundDesign,
	readSoundDesignMix,
	SOUND_DESIGN_LIMITS,
	SOUND_MIX_LIMITS,
	type SoundCue,
	type SoundDesign,
	type SoundDesignMix,
	soundDesignIssue,
} from '../schema/sound.ts';
import { cueAnchorTargetExists } from './anchor.ts';
import { readSoundCheckVerdictMeta } from './check.ts';

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

/** INV-SOUND: what is wrong with a sequence marker's Sound Check verdict data (`soundDesign.setVerdict`), or null. */
export function markerVerdictProblem(m: { soundCheck?: unknown }): string | null {
	if (m.soundCheck === undefined) return null;
	return readSoundCheckVerdictMeta(m.soundCheck) ? null : 'its Sound Check verdict data is unreadable';
}

/** The cues of a sequence (empty when it has none or they are unreadable). */
export function soundCuesOf(seq: { soundDesign?: unknown }): SoundCue[] {
	const sd = seq.soundDesign;
	if (!isRecord(sd) || !isRecord(sd.cues)) return [];
	return Object.values(sd.cues as Record<string, SoundCue>);
}

const t0 = (seq: Sequence) => trackIds(seq);

/** Every audio track id of a sequence (and submix ids). */
function trackIds(seq: Sequence): { audio: Set<string>; submix: Set<string> } {
	return {
		audio: new Set(seq.audioTracks.map((t) => t.id)),
		submix: new Set((seq.submixTracks ?? []).map((t) => t.id)),
	};
}

/** Whether the place a mix record wrote to is still there (track / clip, and its build filter). */
function mixTargetExists(seq: Sequence, w: MixWrite): boolean {
	if (w.target === 'trackVolume' || w.target === 'trackFilter') {
		const t = seq.audioTracks.find((x) => x.id === w.trackId);
		return !!t && (w.target === 'trackVolume' || (t.effects ?? []).some((e) => e.id === w.effectInstanceId));
	}
	const c = w.clipId ? seq.clips[w.clipId] : undefined;
	if (c?.kind !== 'audio') return false;
	return w.target === 'clipVolume' || (c.effects ?? []).some((e) => e.id === w.effectInstanceId);
}

/**
 * Stale mix records (soft references): a cue record whose cue is gone, writes whose track / clip / filter is gone (a
 * record left with none dropped, unless suspended), build filters of owners or effects that are gone. Returns what is
 * stale; with `apply` removes it (empty tables it emptied go too). The automation they wrote stays as ordinary keys.
 */
function pruneMix(seq: Sequence, mix: SoundDesignMix, cueIds: ReadonlySet<string>, apply: boolean): string[] {
	const out: string[] = [];
	const m = mix as SoundDesignMix & Record<string, unknown>;
	for (const bucket of ['cues', 'orphans'] as const) {
		const table = m[bucket] as Record<string, CueMix> | undefined;
		if (!table) continue;
		for (const [k, c] of Object.entries(table)) {
			if (bucket === 'cues' && !cueIds.has(k)) {
				out.push(`the mix record of cue ${k}, which no longer exists`);
				if (apply) delete table[k];
				continue;
			}
			for (const kind of ['stopBefore', 'build'] as const) {
				const r = c[kind];
				if (!r) continue;
				const keep = r.writes.filter((w) => mixTargetExists(seq, w));
				if (keep.length === r.writes.length) continue;
				out.push(
					`${r.writes.length - keep.length} write(s) of cue ${k} on tracks, clips or filters that are gone`,
				);
				if (!apply) continue;
				if (keep.length || r.suspended === true) r.writes = keep;
				else delete c[kind];
			}
			if (apply && !c.stopBefore && !c.build) delete table[k];
		}
		if (apply && Object.keys(table).length === 0) delete m[bucket];
	}
	const filters = m.buildFilters as Record<string, string> | undefined;
	if (filters) {
		for (const [owner, fx] of Object.entries(filters)) {
			const t = seq.audioTracks.find((x) => x.id === owner);
			const c = seq.clips[owner];
			const list = t ? (t.effects ?? []) : c?.kind === 'audio' ? (c.effects ?? []) : [];
			if (list.some((e) => e.id === fx)) continue;
			out.push(`the build filter record of ${owner}, whose filter is gone`);
			if (apply) delete filters[owner];
		}
		if (apply && Object.keys(filters).length === 0) delete m.buildFilters;
	}
	return out;
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
		/** `cueId → clipId` pairs the cues list (a clip fills a cue only when the cue lists it). */
		const listed = new Set<string>();
		if (sd !== undefined) {
			if (sequenceSoundDesignIssue(seq)) return true;
			for (const cue of Object.values(sd.cues)) {
				if (seenCue.has(cue.id)) return true;
				seenCue.add(cue.id);
				cueIds.add(cue.id);
				for (const id of cue.placedClipIds ?? []) listed.add(`${cue.id}\u0000${id}`);
				if (cue.anchor && !cueAnchorTargetExists(doc, seq, cue.anchor)) return true;
				for (const id of cue.placedClipIds ?? []) if (seq.clips[id]?.kind !== 'audio') return true;
			}
			const s = sd.settings;
			if (s) {
				const t = trackIds(seq);
				if (s.sfxTrackIds.some((id) => !t.audio.has(id))) return true;
				if (s.roomBus !== null && !t.submix.has(s.roomBus)) return true;
			}
			const room = sd.mix?.room;
			if (room && !t0(seq).submix.has(room.busId)) return true;
			if (sd.mix && pruneMix(seq, sd.mix, cueIds, false).length) return true;
		}
		for (const c of Object.values(seq.clips)) {
			const sfx = (c as { sfx?: unknown }).sfx;
			if (sfx === undefined) continue;
			if (clipSfxProblem(c as Clip & { sfx?: unknown })) return true;
			const id = (sfx as ClipSfx).cueId;
			if (id !== null && (!cueIds.has(id) || !listed.has(`${id}\u0000${c.id}`))) return true;
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
		// Verdict markers: unreadable verdict data is dropped (the marker stays, as an unbound verdict).
		for (const m of seq.markers ?? []) {
			if (markerVerdictProblem(m as { soundCheck?: unknown }) === null) continue;
			delete (m as { soundCheck?: unknown }).soundCheck;
			note('drop-verdict-meta', m.id, 'unreadable Sound Check verdict data removed (the marker stays)');
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
			// The room glue record of a submix that is gone (its sends went with it).
			if (sd.mix?.room && !t.submix.has(sd.mix.room.busId)) {
				delete sd.mix.room;
				note('drop-room-glue', seq.id, 'the SFX room submix no longer exists: its glue record is removed');
			}
			// Mix records follow a renamed cue; stale ones go (their automation stays as ordinary keys).
			const mixCues = sd.mix?.cues;
			if (mixCues && renamed.size) {
				const next: Record<string, CueMix> = Object.create(null);
				for (const [k, v] of Object.entries(mixCues)) {
					const id = renamed.get(k) ?? k;
					if (!Object.hasOwn(next, id)) next[id] = v;
				}
				sd.mix!.cues = next;
			}
			if (sd.mix)
				for (const what of pruneMix(seq, sd.mix, new Set(Object.keys(sd.cues)), true))
					note('prune-mix', seq.id, `${what}: removed (its automation stays as ordinary keyframes)`);
		}
		// A clip's cue must be a cue of its own sequence (renamed with it).
		for (const c of Object.values(seq.clips)) {
			const sfx = (c as { sfx?: ClipSfx }).sfx;
			if (!sfx || sfx.cueId === null) continue;
			const id = renamed.get(sfx.cueId) ?? sfx.cueId;
			if (sd && Object.hasOwn(sd.cues, id)) {
				// The link is two-way: a copy of a filled clip (duplicate, paste) carries the cue id, but the cue does
				// not list it, so it fills nothing.
				if ((sd.cues[id]!.placedClipIds ?? []).includes(c.id)) {
					if (id !== sfx.cueId) sfx.cueId = id;
					continue;
				}
				sfx.cueId = null;
				note('unlink-sfx', c.id, 'a copy of a clip that fills a sound cue: the cue does not list it');
				continue;
			}
			sfx.cueId = null;
			note('unlink-sfx', c.id, 'the sound cue it filled no longer exists');
		}
	}
}

/**
 * A split SFX clip keeps filling its cue with both parts (`splitClipAt`): the right part (a copy carrying the same
 * `sfx`) joins the cue's `placedClipIds` right after the left one, so `soundCue.resync` / `update` move both parts and
 * `soundCue.remove` with `withClips` lifts both. When the left part is not one of the cue's placed clips (a pasted copy)
 * nothing changes; when the cue is full (`placedClips`) the right part forgets the cue. Mutates `seq` (a draft).
 */
export function followSfxSplit(seq: Sequence, leftId: string, rightId: string): void {
	const right = seq.clips[rightId] as { kind: string; sfx?: unknown } | undefined;
	const sfx = right?.sfx;
	if (right?.kind !== 'audio' || !isRecord(sfx) || typeof sfx.cueId !== 'string') return;
	const sd = (seq as { soundDesign?: unknown }).soundDesign;
	if (!isRecord(sd) || !isRecord(sd.cues) || !Object.hasOwn(sd.cues, sfx.cueId)) return;
	const cue = sd.cues[sfx.cueId];
	const list = isRecord(cue) ? cue.placedClipIds : undefined;
	if (!Array.isArray(list) || list.includes(rightId)) return;
	const i = list.indexOf(leftId);
	if (i < 0) return;
	if (list.length >= SOUND_DESIGN_LIMITS.placedClips) sfx.cueId = null;
	else list.splice(i + 1, 0, rightId);
}

/** The ids of the entities inside a clip or track (depth > 0), in document order: before / after a re-identification. */
export function nestedEntityIds(v: unknown): string[] {
	const out: string[] = [];
	const visit = (x: unknown, depth: number): void => {
		if (depth > 64 || !x || typeof x !== 'object') return;
		if (Array.isArray(x)) {
			for (const y of x) visit(y, depth + 1);
			return;
		}
		for (const [k, y] of Object.entries(x as Record<string, unknown>)) {
			if (k === 'id' && depth > 0 && typeof y === 'string') out.push(y);
			else visit(y, depth + 1);
		}
	};
	visit(v, 0);
	return out;
}

/** Whether any realisation record writes into clip `clipId` (a cheap check before a split follows the records). */
export function mixNamesClip(seq: Sequence, clipId: string): boolean {
	const mix = (seq.soundDesign as SoundDesign | undefined)?.mix;
	if (!isRecord(mix)) return false;
	if (isRecord(mix.buildFilters) && Object.hasOwn(mix.buildFilters, clipId)) return true;
	for (const bucket of [mix.cues, mix.orphans])
		for (const c of Object.values(isRecord(bucket) ? bucket : {}))
			for (const r of [c?.stopBefore, c?.build]) if (r?.writes.some((w) => w.clipId === clipId)) return true;
	return false;
}

/**
 * A split music clip keeps both parts in the mix records (`splitClipAt`): each clip Volume / clip filter write naming
 * the left part is cloned for the right part (a copy with re-identified keys and effects: `idMap` old → new ids; the
 * replaced keys get fresh ids so both parts can give theirs back), and the right part's build filter is recorded. A
 * record already at `SOUND_MIX_LIMITS.writes` leaves the right part's keys as ordinary keyframes. Mutates `seq`.
 */
export function followMixSplit(
	seq: Sequence,
	leftId: string,
	rightId: string,
	idMap: ReadonlyMap<string, string>,
	newKeyId: () => string,
): void {
	const mix = (seq.soundDesign as SoundDesign | undefined)?.mix;
	if (!isRecord(mix)) return;
	for (const bucket of [mix.cues, mix.orphans]) {
		if (!isRecord(bucket)) continue;
		for (const c of Object.values(bucket))
			for (const r of [c?.stopBefore, c?.build]) {
				if (!r) continue;
				const writes = r.writes as MixWrite[];
				for (const w of [...writes]) {
					if (w.clipId !== leftId || (w.target !== 'clipVolume' && w.target !== 'clipFilter')) continue;
					if (writes.length >= SOUND_MIX_LIMITS.writes) continue;
					const fx = w.effectInstanceId ? idMap.get(w.effectInstanceId) : undefined;
					if (w.effectInstanceId && !fx) continue;
					writes.push({
						...w,
						clipId: rightId,
						...(fx ? { effectInstanceId: fx } : {}),
						// a key the left part no longer has is not in the right part either (a fresh id: missing)
						written: w.written.map((id) => idMap.get(id) ?? newKeyId()),
						replaced: w.replaced.map((k) => ({
							...k,
							id: newKeyId(),
							easeIn: { ...k.easeIn },
							easeOut: { ...k.easeOut },
						})),
					});
				}
			}
	}
	const filters = mix.buildFilters as Record<string, string> | undefined;
	const fx = filters?.[leftId] ? idMap.get(filters[leftId]!) : undefined;
	if (filters && fx) filters[rightId] = fx;
}

/** The mix records of a sequence copy (see `remapSoundDesign`): ids mapped, anything that did not come along dropped. */
function remapMix(
	raw: unknown,
	cueMap: ReadonlyMap<string, string>,
	maps: {
		clips: ReadonlyMap<string, string>;
		tracks: ReadonlyMap<string, string>;
		children?: ReadonlyMap<string, string>;
		sends?: ReadonlyMap<string, string>;
	},
	newCueId: () => string,
	newKeyId: () => string,
): SoundDesignMix | null {
	const mix = readSoundDesignMix(raw);
	if (!mix) return null;
	const children = maps.children ?? new Map<string, string>();
	const writeOf = (w: MixWrite): MixWrite | null => {
		const trackId = w.trackId ? maps.tracks.get(w.trackId) : undefined;
		const clipId = w.clipId ? maps.clips.get(w.clipId) : undefined;
		const fx = w.effectInstanceId ? children.get(w.effectInstanceId) : undefined;
		if ((w.trackId && !trackId) || (w.clipId && !clipId) || (w.effectInstanceId && !fx)) return null;
		return {
			...w,
			...(trackId ? { trackId } : {}),
			...(clipId ? { clipId } : {}),
			...(fx ? { effectInstanceId: fx } : {}),
			// a key the original no longer has is not in the copy either (a fresh id: missing)
			written: w.written.map((id) => children.get(id) ?? newKeyId()),
			replaced: w.replaced.map((k) => ({
				...k,
				id: newKeyId(),
				easeIn: { ...k.easeIn },
				easeOut: { ...k.easeOut },
			})),
		};
	};
	const recOf = <R extends { writes: MixWrite[]; suspended?: boolean }>(r: R | undefined): R | undefined => {
		if (!r) return undefined;
		const writes = r.writes.map(writeOf).filter((w): w is MixWrite => !!w);
		return writes.length || r.suspended === true ? { ...r, writes } : undefined;
	};
	const tableOf = (t: Record<string, CueMix> | undefined, key: (k: string) => string | undefined) => {
		if (!t) return undefined;
		const out: Record<string, CueMix> = Object.create(null);
		for (const [k, v] of Object.entries(t)) {
			const id = key(k);
			if (!id) continue;
			const c: CueMix = { ...v };
			const sb = recOf(v.stopBefore as never);
			const b = recOf(v.build as never);
			if (sb) c.stopBefore = sb;
			else delete c.stopBefore;
			if (b) c.build = b;
			else delete c.build;
			if (c.stopBefore || c.build) out[id] = c;
		}
		return Object.keys(out).length ? out : undefined;
	};
	const out: SoundDesignMix & Record<string, unknown> = { ...mix };
	const cues = tableOf(mix.cues, (k) => cueMap.get(k));
	const orphans = tableOf(mix.orphans as Record<string, CueMix> | undefined, () => newCueId());
	if (cues) out.cues = cues;
	else delete out.cues;
	if (orphans) out.orphans = orphans;
	else delete out.orphans;
	if (mix.buildFilters) {
		const f: Record<string, string> = Object.create(null);
		for (const [owner, fx] of Object.entries(mix.buildFilters)) {
			const o = maps.clips.get(owner) ?? maps.tracks.get(owner);
			const x = children.get(fx);
			if (o && x) f[o] = x;
		}
		if (Object.keys(f).length) out.buildFilters = f;
		else delete out.buildFilters;
	}
	const room = mix.room;
	if (room) {
		const busId = maps.tracks.get(room.busId);
		if (!busId) delete out.room;
		else
			out.room = {
				...room,
				busId,
				reverbId: room.reverbId ? (children.get(room.reverbId) ?? null) : null,
				sends: room.sends.flatMap((x) => {
					const trackId = maps.tracks.get(x.trackId);
					const sendId = maps.sends?.get(x.sendId);
					return trackId && sendId ? [{ ...x, trackId, sendId }] : [];
				}),
				...(room.before
					? {
							before: {
								...room.before,
								roomBus: room.before.roomBus ? (maps.tracks.get(room.before.roomBus) ?? null) : null,
							},
						}
					: {}),
			};
	}
	return Object.keys(out).length ? out : null;
}

/**
 * A copied sequence's sound design follows the copy (`sequence.duplicate`): new cue ids, placed clips, anchors and
 * clip links mapped to the copy's clips, transitions, tracks and markers (references that did not come along dangle,
 * like after an edit, and are dropped), and the mix records (stop-before, build, room glue) mapped to the copy's keys,
 * filters and sends (`children`, `sends`; fresh ids for the keys they replaced). Mutates `seq` (a plain copy).
 */
export function remapSoundDesign(
	seq: Sequence,
	maps: {
		clips: ReadonlyMap<string, string>;
		tracks: ReadonlyMap<string, string>;
		transitions: ReadonlyMap<string, string>;
		markers: ReadonlyMap<string, string>;
		/** Ids of things inside clips and tracks that a copy re-identifies (keyframes, clip markers, effects). */
		children?: ReadonlyMap<string, string>;
		/** Send ids of the copy's mixer strips. */
		sends?: ReadonlyMap<string, string>;
	},
	newCueId: () => string,
	newKeyId: () => string = () => newCueId().replace(/^cue_/, 'kf_'),
): void {
	const children = maps.children ?? new Map<string, string>();
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
						// a sequence marker, else a clip marker
						cue.anchor = {
							...a,
							markerId: maps.markers.get(a.markerId) ?? m(children, a.markerId),
						};
						break;
					case 'scene':
						// the clip it was derived on follows the copy (the media is shared)
						if (typeof a.clipId === 'string') cue.anchor = { ...a, clipId: m(maps.clips, a.clipId) };
						break;
					case 'keyframe':
						cue.anchor = {
							...a,
							clipId: m(maps.clips, a.clipId),
							// `effects.<fxId>.params.<name>`: path segments naming an entity (by id) follow the copy
							property:
								typeof a.property === 'string'
									? a.property
											.split('.')
											.map((part) => m(children, part))
											.join('.')
									: a.property,
							...(typeof a.keyframeId === 'string' ? { keyframeId: m(children, a.keyframeId) } : {}),
						};
						break;
					default:
						cue.anchor = { ...a, clipId: m(maps.clips, a.clipId) } as SoundCue['anchor'];
				}
			}
			cues[id] = cue;
		}
		(sd as { cues: unknown }).cues = cues;
		// What stop-before, build and room glue wrote follows the copy: its records name the copy's cues, tracks, clips,
		// keys, filters and sends, so clearing a stop-before on the copy takes the copy's dip out exactly.
		// Acknowledged findings stay with their sequence (P6-E4): a copy's findings name its own clips and cues, and
		// what was deliberate in the original is decided again there.
		delete (sd as { acknowledged?: unknown }).acknowledged;
		const mix = remapMix((sd as { mix?: unknown }).mix, cueMap, maps, newCueId, newKeyId);
		if (mix) (sd as { mix?: unknown }).mix = mix;
		else delete (sd as { mix?: unknown }).mix;
		if (isRecord(sd.settings)) {
			const rb = (sd.settings as { roomBus?: unknown }).roomBus;
			(sd.settings as { roomBus?: unknown }).roomBus =
				typeof rb === 'string' ? (maps.tracks.get(rb) ?? null) : null;
		}
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
