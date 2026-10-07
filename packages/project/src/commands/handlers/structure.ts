// edit-structure (docs/wp-notes/edit-structure.md): nesting and unnesting, placing sequences, adjustment layers, clip
// groups, sequence duplicate/delete, Remove Unused, synthetic sources, frame holds, through edits and subsequences.
// Semantics follow Premiere Pro and S01 (SEQ-010/011, CLP-012, AST-010, KND-011/012); the algorithms port FilmCraft
// `crates/edit/src/{lib,through,multicam}.rs` and `crates/engine/src/{commands,clip_ops,sequence_tools}.rs`
// (MIT OR Apache-2.0, see licenses/ported/edit-structure.md).
import { current, type Draft, isDraft } from 'immer';
import { clipEnd, contentTimeAt, isThroughEdit } from '../../derive/index.ts';
import { anim, createSequence, defaultTransform } from '../../factories.ts';
import { contentDurationFlicks, isBoundedContent, kindCapabilities } from '../../registry/kinds.ts';
import type { ProjectItem } from '../../schema/document.ts';
import type { MediaAsset, SyntheticSource } from '../../schema/media.ts';
import type { Clip, Sequence, Track, TrackKind, Transition } from '../../schema/sequence.ts';
import { conformSequenceRate, isNestClip, wouldCreateNestCycle } from '../../structure/nest.ts';
import { SYNTHETIC_INFO, syntheticFromParams } from '../../structure/synthetic.ts';
import { clipToRange } from '../../structure/through.ts';
import { flicksPerFrame, type Rational, rationalEquals } from '../../time.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import {
	allTracksIn,
	assertUnlocked,
	cleanupSequence,
	end,
	ensureTrackAt,
	findTrackIn,
	insertShift,
	reidentifyClipChildren,
	relinkSplits,
	removeClip,
	resolveTrackIn,
	shiftMarkers,
	splitClipAt,
	syncFollowerTracks,
	trackClips,
	tracksOfKind,
} from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { commonFields, frameBox, makeRoom, newGeneratorClip, visualFields } from './clip-core.ts';
import { insertItem, projectHandlers } from './project.ts';
import { type HandlerMap, idList } from './util.ts';

export const STRUCTURE_OWNER = 'edit-structure' as const;

type DTrack = Draft<Track>;

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(isDraft(v) ? current(v as Draft<T>) : v)) as T;

/** The project item of a sequence and the bin holding it (null = root). */
function sequenceItem(doc: DDoc, seqId: string): { itemId: string | null; binId: string | null } {
	const item = Object.values(doc.items).find((it) => it.kind === 'sequence' && it.sequenceId === seqId);
	if (!item) return { itemId: null, binId: null };
	const bin = Object.values(doc.items).find((it) => it.kind === 'bin' && it.children.includes(item.id));
	return { itemId: item.id, binId: bin?.id ?? null };
}

/** `${base} 01`, `${base} 02`… — the first name no project item uses. */
function numberedName(doc: DDoc, base: string, sep = ' '): string {
	const names = new Set(Object.values(doc.items).map((it) => it.name));
	for (let k = 1; ; k++) {
		const n = `${base}${sep}${String(k).padStart(2, '0')}`;
		if (!names.has(n)) return n;
	}
}

/** Inserts `itemId` after `afterId` in its bin (or at the end of `binId`). */
function insertAfter(doc: DDoc, itemId: string, binId: string | null, afterId: string | null): void {
	const list = binId
		? (doc.items[binId] as Draft<Extract<ProjectItem, { kind: 'bin' }>>).children
		: doc.rootItems;
	const i = afterId ? list.indexOf(afterId) : -1;
	insertItem(doc, itemId, binId, i >= 0 ? i + 1 : undefined);
}

function newSequenceItem(
	doc: DDoc,
	h: HandlerContext,
	seq: Sequence,
	name: string,
	binId: string | null,
	afterId: string | null,
): string {
	doc.sequences[seq.id] = seq as Draft<Sequence>;
	const itemId = h.ids.next('itm');
	doc.items[itemId] = { id: itemId, kind: 'sequence', name, sequenceId: seq.id, label: 'forest' };
	insertAfter(doc, itemId, binId, afterId);
	return itemId;
}

/** A new sequence with `parent`'s settings and track layout (names, sync lock, channel formats). */
function sequenceLike(h: HandlerContext, parent: Sequence): Sequence {
	const seq = createSequence(h.ids, plain(parent.settings), {
		video: parent.videoTracks.length,
		audio: parent.audioTracks.length,
	});
	seq.videoTracks.forEach((t, i) => {
		t.name = parent.videoTracks[i]!.name;
	});
	seq.audioTracks.forEach((t, i) => {
		const p = parent.audioTracks[i]!;
		t.name = p.name;
		if (p.channelFormat) t.channelFormat = p.channelFormat;
	});
	return seq;
}

/** Index of the first track of `kind` at/after `from` that is free over `[a, b)` (appending one if needed). */
function freeTrack(
	seq: DSeq,
	kind: TrackKind,
	from: number,
	a: number,
	b: number,
	h: HandlerContext,
	ignore: ReadonlySet<string> = new Set(),
): DTrack {
	const list = tracksOfKind(seq, kind);
	for (let i = Math.max(0, from); i < list.length; i++) {
		const t = list[i]!;
		if (t.locked) continue;
		if (trackClips(seq, t.id).every((c) => ignore.has(c.id) || c.start >= b || end(c) <= a)) return t;
	}
	return ensureTrackAt(seq, kind, Math.max(from, list.length), h);
}

/** Members of the clip groups of `clips` (same sequence, unlocked tracks), with the clips (S01:CLP-012). */
export function expandGroups(seq: DSeq, clips: readonly DClip[]): DClip[] {
	const out = new Map(clips.map((c) => [c.id, c]));
	for (const c of clips) {
		if (!c.groupId) continue;
		for (const m of seq.groups[c.groupId]?.members ?? []) {
			const x = seq.clips[m];
			if (x && !findTrackIn(seq, x.trackId)?.track.locked) out.set(x.id, x);
		}
	}
	return [...out.values()];
}

/**
 * Copies of transitions whose clips are all in `clipMap` (old → new id), retargeted to the new clips and tracks.
 * One-sided fades follow their clip.
 */
function copyTransitions(
	src: Sequence,
	clipMap: ReadonlyMap<string, string>,
	trackOfClip: (newClipId: string) => string | undefined,
	h: HandlerContext,
	fresh: boolean,
): Transition[] {
	const out: Transition[] = [];
	for (const t of Object.values(src.transitions)) {
		const o = t.outgoingClipId;
		const i = t.incomingClipId;
		if ((o && !clipMap.has(o)) || (i && !clipMap.has(i)) || (!o && !i)) continue;
		const no = o ? clipMap.get(o)! : null;
		const ni = i ? clipMap.get(i)! : null;
		const trackId = trackOfClip((no ?? ni)!);
		if (!trackId) continue;
		out.push({
			...plain(t),
			id: fresh ? h.ids.next('trn') : t.id,
			trackId,
			outgoingClipId: no,
			incomingClipId: ni,
		});
	}
	return out;
}

/** Re-creates link groups (and optionally clip groups) of copied clips inside `seq`, with new group ids. */
function regroup(
	seq: DSeq,
	clips: readonly { oldId: string; clip: DClip }[],
	src: Sequence,
	h: HandlerContext,
	kinds: readonly ('links' | 'groups')[] = ['links'],
	keyPrefix = '',
	shared?: Map<string, string>,
): void {
	for (const kind of kinds) {
		const field = kind === 'links' ? 'linkId' : 'groupId';
		const byOld = new Map<string, DClip[]>();
		for (const { oldId, clip } of clips) {
			const g = (src.clips[oldId] as Record<string, unknown> | undefined)?.[field] as
				| string
				| null
				| undefined;
			clip[field] = null;
			if (!g) continue;
			const list = byOld.get(g) ?? [];
			list.push(clip);
			byOld.set(g, list);
		}
		for (const [g, members] of byOld) {
			const key = `${keyPrefix}${kind}:${g}`;
			let id = shared?.get(key);
			if (!id) {
				id = h.ids.next(kind === 'links' ? 'lnk' : 'grp');
				shared?.set(key, id);
			}
			const table = seq[kind];
			const existing = table[id];
			const ids = [...(existing?.members ?? []), ...members.map((m) => m.id)];
			if (ids.length < 2 && !shared) continue;
			table[id] = { id, members: ids };
			for (const m of members) m[field] = id;
		}
	}
}

/** Removes `trackedBy` links whose tracker clip is not in `seq` (clips moved across sequences). */
function dropForeignTracking(seq: DSeq, h: HandlerContext): void {
	for (const c of Object.values(seq.clips)) {
		const tb = (c as { trackedBy?: { clipId: string } }).trackedBy;
		if (tb && !seq.clips[tb.clipId]) {
			delete (c as { trackedBy?: unknown }).trackedBy;
			h.warn('W_TRACKING_UNLINKED', `Clip ${c.id} no longer follows a tracker of clip ${tb.clipId}`);
		}
	}
}

function trackRange(seq: DSeq, trackId: string): { kind: TrackKind; index: number } {
	const f = findTrackIn(seq, trackId)!;
	return { kind: f.kind, index: f.index };
}

// ---------------------------------------------------------------- clip.nest (S01:SEQ-010)

function nestHandler(doc: DDoc, cmd: CommandOf<'clip.nest'>, h: HandlerContext) {
	const { seq, clips } = h.clipsOf(doc, idList(cmd.clipIds));
	for (const c of clips) {
		assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
		if (!kindCapabilities(c.kind))
			h.fail('E_INVALID_PARAM', `Clip ${c.id} has an unsupported kind (${c.kind})`);
		if (c.kind === 'captions') h.fail('E_INVALID_PARAM', 'Caption clips cannot be nested');
	}
	const start = Math.min(...clips.map((c) => c.start));
	const stop = Math.max(...clips.map(end));
	const parent = seq as Sequence;
	const nested = sequenceLike(h, parent);
	const { itemId: parentItem, binId } = sequenceItem(doc, seq.id);
	const name = cmd.name ?? numberedName(doc, 'Nested Sequence');
	const moved = new Set(clips.map((c) => c.id));
	// Transitions between moved clips (and fades of moved clips) move with them; others touching them are removed.
	const movedTransitions = Object.values(seq.transitions).filter(
		(t) =>
			(t.outgoingClipId || t.incomingClipId) &&
			(!t.outgoingClipId || moved.has(t.outgoingClipId)) &&
			(!t.incomingClipId || moved.has(t.incomingClipId)),
	);
	const copies: { oldId: string; clip: DClip }[] = [];
	for (const c of clips) {
		const { kind, index } = trackRange(seq, c.trackId);
		const copy = plain(c) as Clip;
		copy.trackId = tracksOfKind(nested as DSeq, kind)[index]!.id;
		copy.start = c.start - start;
		nested.clips[copy.id] = copy;
		copies.push({ oldId: c.id, clip: nested.clips[copy.id] as DClip });
	}
	regroup(nested as DSeq, copies, parent, h, ['links', 'groups']);
	for (const t of movedTransitions) {
		const c = (t.outgoingClipId ?? t.incomingClipId)!;
		nested.transitions[t.id] = { ...plain(t), trackId: nested.clips[c]!.trackId } as Transition;
		delete seq.transitions[t.id];
	}
	for (const c of clips) removeClip(seq, c.id, h);
	const nid = nested.id;
	const nestedItem = newSequenceItem(doc, h, nested, name, binId, parentItem);
	// The nest clips: on the lowest track of each kind among the nested clips (or the next free one).
	const lowest = (kind: TrackKind) => {
		const idx = copies
			.map(({ clip }) => trackRange(nested as DSeq, clip.trackId))
			.filter((r) => r.kind === kind)
			.map((r) => r.index);
		return idx.length ? Math.min(...idx) : null;
	};
	const dur = stop - start;
	const created: string[] = [];
	const lv = lowest('video');
	const la = lowest('audio');
	if (lv !== null) {
		const t = freeTrack(seq, 'video', lv, start, stop, h);
		const id = h.ids.next('clp');
		const box = { width: nested.settings.width, height: nested.settings.height };
		seq.clips[id] = {
			...commonFields(id, t.id, start, dur, 0, name, 'forest'),
			kind: 'nest-video',
			sequenceId: nid,
			...visualFields(defaultTransform(box, frameBox(seq), 'none')),
		} as DClip;
		created.push(id);
	}
	if (la !== null) {
		const t = freeTrack(seq, 'audio', la, start, stop, h);
		const id = h.ids.next('clp');
		seq.clips[id] = {
			...commonFields(id, t.id, start, dur, 0, name, 'forest'),
			kind: 'nest-audio',
			sequenceId: nid,
			gainDb: 0,
			volumeDb: anim(0),
			pan: anim(0),
			effects: [],
		} as DClip;
		created.push(id);
	}
	if (created.length === 2) {
		const linkId = h.ids.next('lnk');
		seq.links[linkId] = { id: linkId, members: [...created] };
		for (const id of created) seq.clips[id]!.linkId = linkId;
	}
	dropForeignTracking(seq, h);
	dropForeignTracking(doc.sequences[nid]!, h);
	cleanupSequence(seq, h);
	cleanupSequence(doc.sequences[nid]!, h);
	h.defineRef(cmd.ref, nid);
	return { sequenceId: nid, itemId: nestedItem, clipIds: created };
}

// ---------------------------------------------------------------- clip.unnest

function isIdentityMotion(c: Clip, seq: DSeq, box: { width: number; height: number }): boolean {
	const t = (
		c as { transform?: Clip extends never ? never : Record<string, { value: unknown; keyframes: unknown[] }> }
	).transform as Record<string, { value: unknown; keyframes: unknown[] } | boolean> | undefined;
	if (!t) return true;
	const def = defaultTransform(box, frameBox(seq), 'none') as unknown as Record<
		string,
		{ value: unknown } | boolean
	>;
	for (const k of ['position', 'anchor', 'scale', 'scaleWidth', 'rotation'] as const) {
		const a = t[k] as { value: unknown; keyframes: unknown[] };
		if (
			a.keyframes.length > 0 ||
			JSON.stringify(a.value) !== JSON.stringify((def[k] as { value: unknown }).value)
		)
			return false;
	}
	return !t.flipH && !t.flipV;
}

function unnestHandler(doc: DDoc, cmd: CommandOf<'clip.unnest'>, h: HandlerContext) {
	const { seq, clips } = h.clipsOf(doc, idList(cmd.clipIds));
	const rate = seq.settings.frameRate as Rational;
	const F = flicksPerFrame(rate);
	const shared = new Map<string, string>();
	const created: string[] = [];
	for (const n of clips) {
		if (!isNestClip(n)) h.fail('E_INVALID_PARAM', `Clip ${n.id} is not a nested sequence clip`);
		const track = findTrackIn(seq, n.trackId)!;
		assertUnlocked(track.track, h);
		const sid = (n as { sequenceId: string }).sequenceId;
		const src = doc.sequences[sid] as Sequence | undefined;
		if (!src) h.fail('E_NOT_FOUND', `Nested sequence not found: ${sid}`);
		if (n.speed.rate !== 1 || n.speed.reverse || n.frameHold)
			h.fail(
				'E_INVALID_PARAM',
				`Clip ${n.id} has a speed change, reverse or frame hold: its clips cannot be placed exactly (remove it first)`,
			);
		const r = n as Record<string, unknown>;
		if (n.kind === 'nest-video') {
			const box = { width: src.settings.width, height: src.settings.height };
			const op = r.opacity as { value: number; keyframes: unknown[] };
			if (!isIdentityMotion(n as Clip, seq, box) || op.keyframes.length > 0 || op.value !== 100)
				h.fail(
					'E_INVALID_PARAM',
					`Clip ${n.id} has Motion or Opacity changes that cannot be moved onto its clips (reset them first)`,
				);
			if (r.blendMode !== 'normal')
				h.fail(
					'E_INVALID_PARAM',
					`Clip ${n.id} uses blend mode ${String(r.blendMode)}; set it to Normal first`,
				);
			if (src.settings.width !== seq.settings.width || src.settings.height !== seq.settings.height)
				h.fail(
					'E_INVALID_PARAM',
					`The nested sequence's frame size differs from this sequence; its clips cannot be placed exactly`,
				);
		} else {
			const vol = r.volumeDb as { value: number; keyframes: unknown[] };
			const pan = r.pan as { value: number; keyframes: unknown[] };
			if (vol.keyframes.length > 0)
				h.fail('E_INVALID_PARAM', `Clip ${n.id} has volume keyframes that cannot be moved onto its clips`);
			if (pan.keyframes.length > 0 || pan.value !== 0)
				h.fail('E_INVALID_PARAM', `Clip ${n.id} is panned; reset its pan first`);
		}
		const conformed = rationalEquals(src.settings.frameRate as Rational, rate)
			? src
			: conformSequenceRate(src, rate);
		if (conformed !== src)
			h.warn('W_CONFORMED', `Nested sequence ${sid} was conformed to this sequence's frame rate`);
		const s0 = Math.round(n.sourceIn / F);
		const s1 = s0 + n.duration;
		const kind: TrackKind = n.kind === 'nest-video' ? 'video' : 'audio';
		const srcTracks = kind === 'video' ? conformed.videoTracks : conformed.audioTracks;
		const extraFx = plain((r.effects as unknown[]) ?? []);
		if (extraFx.length)
			h.warn('W_EFFECTS_DISTRIBUTED', `The effects of ${n.id} now apply to each of its clips`);
		const gainAdd =
			n.kind === 'nest-audio' ? (r.gainDb as number) + (r.volumeDb as { value: number }).value : 0;
		const groupId = n.groupId;
		const linkKey = `${n.linkId ?? n.id}/`;
		removeClip(seq, n.id, h);
		const clipMap = new Map<string, string>();
		const placed: { oldId: string; clip: DClip }[] = [];
		let nextIndex = track.index;
		for (const st of srcTracks) {
			const pieces = Object.values(conformed.clips)
				.filter((c) => c.trackId === st.id && c.start < s1 && clipEnd(c) > s0)
				.sort((a, b) => a.start - b.start)
				.map((c) => ({ oldId: c.id, piece: clipToRange(c, s0, s1, rate)! }));
			if (pieces.length === 0) continue;
			const a = n.start + Math.min(...pieces.map((p) => p.piece.start - s0));
			const b = n.start + Math.max(...pieces.map((p) => clipEnd(p.piece) - s0));
			const dest = freeTrack(seq, kind, nextIndex, a, b, h);
			nextIndex = trackRange(seq, dest.id).index + 1;
			for (const { oldId, piece } of pieces) {
				const c = piece as Clip & Record<string, unknown>;
				reidentifyClipChildren(c, h);
				c.id = h.ids.next('clp');
				c.trackId = dest.id;
				c.start = n.start + (piece.start - s0);
				c.groupId = null;
				c.linkId = null;
				if (extraFx.length && Array.isArray(c.effects)) {
					const fx = plain(extraFx) as { id: string }[];
					for (const e of fx) e.id = h.ids.next('fx');
					c.effects = [...(c.effects as unknown[]), ...fx];
				}
				if (gainAdd !== 0 && typeof c.gainDb === 'number') c.gainDb = (c.gainDb as number) + gainAdd;
				seq.clips[c.id] = c as DClip;
				clipMap.set(oldId, c.id);
				placed.push({ oldId, clip: seq.clips[c.id]! });
				created.push(c.id);
			}
		}
		regroup(seq, placed, conformed, h, ['links'], linkKey, shared);
		for (const t of copyTransitions(conformed, clipMap, (id) => seq.clips[id]?.trackId, h, true))
			seq.transitions[t.id] = t as Draft<Transition>;
		// Trackers inside the nested sequence follow the copies.
		for (const { clip } of placed) {
			const tb = (clip as { trackedBy?: { clipId: string } }).trackedBy;
			if (tb) {
				const to = clipMap.get(tb.clipId);
				if (to) tb.clipId = to;
			}
		}
		if (groupId && seq.groups[groupId]) seq.groups[groupId]!.members.push(...placed.map((p) => p.clip.id));
		for (const { clip } of placed) if (groupId && seq.groups[groupId]) clip.groupId = groupId;
	}
	dropForeignTracking(seq, h);
	cleanupSequence(seq, h);
	return { clipIds: created };
}

// ---------------------------------------------------------------- placing a sequence

export type SequencePlaceOptions = {
	sequenceId: string;
	sourceRange?: { in: number; out: number };
	at: number;
	mode: 'overwrite' | 'insert';
	videoTrack?: string;
	audioTracks?: string[];
	video?: boolean;
	audio?: boolean;
	nest?: boolean;
	createTracks?: boolean;
	rippleMarkers?: boolean;
	ref?: string;
	name?: string;
	label?: Clip['label'];
};

/** The content range (flicks) of a sequence placement: the given range, else the sequence's In/Out, else all. */
function nestedRange(
	nested: Sequence,
	o: Pick<SequencePlaceOptions, 'sourceRange'>,
	h: HandlerContext,
): { in: number; out: number } {
	const Fn = flicksPerFrame(nested.settings.frameRate as Rational);
	let dur = 0;
	for (const c of Object.values(nested.clips)) dur = Math.max(dur, clipEnd(c));
	if (dur === 0) h.fail('E_INVALID_PARAM', 'The sequence is empty');
	const inF = o.sourceRange?.in ?? (nested.inPoint !== null ? nested.inPoint * Fn : 0);
	const outF = o.sourceRange?.out ?? (nested.outPoint !== null ? nested.outPoint * Fn : dur * Fn);
	if (inF < 0 || outF > dur * Fn + 1) h.fail('E_OUT_OF_MEDIA', 'Source range is outside the sequence');
	if (outF <= inF) h.fail('E_INVALID_PARAM', 'Source out must be after source in');
	return { in: inF, out: Math.min(outF, dur * Fn) };
}

/**
 * Places a sequence (Source monitor / bin drag): as nest clips (default; video and/or audio, linked) or, with
 * `nest: false`, as copies of its clips on the corresponding tracks ("individual clips").
 */
export function placeSequence(
	doc: DDoc,
	seq: DSeq,
	h: HandlerContext,
	o: SequencePlaceOptions,
): { clipIds: string[]; linkId: string | null } {
	const nested = doc.sequences[o.sequenceId] as Sequence | undefined;
	if (!nested) h.fail('E_NOT_FOUND', `Sequence not found: ${o.sequenceId}`);
	if (wouldCreateNestCycle(doc, seq.id, nested.id))
		h.fail('E_CYCLE', 'A sequence cannot contain itself (directly or through nested sequences)');
	if (o.at < 0) h.fail('E_INVALID_PARAM', 'Placement frame must be >= 0');
	const range = nestedRange(nested, o, h);
	const rate = seq.settings.frameRate as Rational;
	const F = flicksPerFrame(rate);
	const frames = Math.max(1, Math.floor((range.out - range.in) / F + 1e-6));
	const videoTracks = new Set(nested.videoTracks.map((t) => t.id));
	const audioTracks = new Set(nested.audioTracks.map((t) => t.id));
	const hasVideo = Object.values(nested.clips).some((c) => videoTracks.has(c.trackId));
	const hasAudio = Object.values(nested.clips).some((c) => audioTracks.has(c.trackId));
	const create = o.createTracks !== false;
	const name = o.name ?? sequenceName(doc, nested.id);
	if (o.nest === false) return placeIndividually(seq, h, o, nested, range, frames);
	const wantVideo = o.video !== false && (hasVideo || !hasAudio);
	const wantAudio = o.audio !== false && hasAudio;
	if (!wantVideo && !wantAudio) h.fail('E_INVALID_PARAM', 'Nothing to place from this sequence');
	const videoIndex = (() => {
		const ref = o.videoTrack ?? 'V1';
		const id = resolveTrackIn(seq, ref);
		if (id) return findTrackIn(seq, id)?.index ?? 0;
		const m = /^V(\d+)$/i.exec(ref);
		return m ? Number(m[1]) - 1 : 0;
	})();
	const dest: { kind: 'nest-video' | 'nest-audio'; track: DTrack }[] = [];
	const resolve = (ref: string, kind: TrackKind) => {
		const id = resolveTrackIn(seq, ref);
		const t = id
			? findTrackIn(seq, id)!.track
			: (() => {
					const m = /^([VA])(\d+)$/i.exec(ref);
					if (!m || !create) return h.fail('E_NOT_FOUND', `Track not found: ${ref}`);
					return ensureTrackAt(seq, kind, Number(m[2]) - 1, h);
				})();
		assertUnlocked(t, h);
		if (t.kind !== kind) h.fail('E_TRACK_KIND', `A nested ${kind} clip cannot go on a ${t.kind} track`);
		return t;
	};
	if (wantVideo) dest.push({ kind: 'nest-video', track: resolve(o.videoTrack ?? 'V1', 'video') });
	if (wantAudio)
		dest.push({ kind: 'nest-audio', track: resolve(o.audioTracks?.[0] ?? `A${videoIndex + 1}`, 'audio') });
	makeRoom(
		seq,
		h,
		dest.map((d) => d.track),
		o.at,
		frames,
		o.mode,
		o.rippleMarkers,
	);
	const clipIds: string[] = [];
	const label = o.label ?? 'forest';
	for (const d of dest) {
		const id = h.ids.next('clp');
		const common = commonFields(id, d.track.id, o.at, frames, Math.round(range.in), name, label);
		if (d.kind === 'nest-video') {
			const box = { width: nested.settings.width, height: nested.settings.height };
			seq.clips[id] = {
				...common,
				kind: 'nest-video',
				sequenceId: nested.id,
				...visualFields(defaultTransform(box, frameBox(seq), 'none')),
			} as DClip;
		} else
			seq.clips[id] = {
				...common,
				kind: 'nest-audio',
				sequenceId: nested.id,
				gainDb: 0,
				volumeDb: anim(0),
				pan: anim(0),
				effects: [],
			} as DClip;
		clipIds.push(id);
	}
	let linkId: string | null = null;
	if (clipIds.length === 2) {
		linkId = h.ids.next('lnk');
		seq.links[linkId] = { id: linkId, members: [...clipIds] };
		for (const id of clipIds) seq.clips[id]!.linkId = linkId;
	}
	cleanupSequence(seq, h);
	h.defineRef(o.ref, clipIds[0]!);
	return { clipIds, linkId };
}

function sequenceName(doc: DDoc, seqId: string): string {
	const it = Object.values(doc.items).find((i) => i.kind === 'sequence' && i.sequenceId === seqId);
	return it?.name ?? 'Sequence';
}

/** "Individual clips": copies of the nested sequence's clips in range, track for track from the targets. */
function placeIndividually(
	seq: DSeq,
	h: HandlerContext,
	o: SequencePlaceOptions,
	nestedIn: Sequence,
	range: { in: number; out: number },
	frames: number,
): { clipIds: string[]; linkId: string | null } {
	const rate = seq.settings.frameRate as Rational;
	const nested = rationalEquals(nestedIn.settings.frameRate as Rational, rate)
		? nestedIn
		: conformSequenceRate(nestedIn, rate);
	if (nested !== nestedIn) h.warn('W_CONFORMED', "The sequence was conformed to this sequence's frame rate");
	const F = flicksPerFrame(rate);
	const n0 = Math.round(range.in / F);
	const n1 = n0 + frames;
	const create = o.createTracks !== false;
	const base = (ref: string | undefined, kind: TrackKind, fallback: number) => {
		if (!ref) return fallback;
		const id = resolveTrackIn(seq, ref);
		if (id) return findTrackIn(seq, id)!.index;
		const m = /^[VA](\d+)$/i.exec(ref);
		if (m) return Number(m[1]) - 1;
		return h.fail('E_NOT_FOUND', `Track not found: ${ref} (${kind})`);
	};
	const vBase = base(o.videoTrack, 'video', 0);
	const aBase = base(o.audioTracks?.[0], 'audio', vBase);
	type Job = { dest: DTrack; pieces: { oldId: string; clip: Clip }[] };
	const jobs: Job[] = [];
	for (const [kind, tracks, b, wanted] of [
		['video', nested.videoTracks, vBase, o.video !== false],
		['audio', nested.audioTracks, aBase, o.audio !== false],
	] as const) {
		if (!wanted) continue;
		tracks.forEach((st, j) => {
			const pieces = Object.values(nested.clips)
				.filter((c) => c.trackId === st.id && c.start < n1 && clipEnd(c) > n0)
				.sort((a, b2) => a.start - b2.start)
				.map((c) => ({ oldId: c.id, clip: clipToRange(c, n0, n1, rate)! }));
			if (pieces.length === 0) return;
			const list = tracksOfKind(seq, kind);
			if (!list[b + j] && !create)
				h.fail('E_TRACK_KIND', `No ${kind} track ${b + j + 1} (pass createTracks)`);
			const dest = list[b + j] ?? ensureTrackAt(seq, kind, b + j, h);
			assertUnlocked(dest, h);
			jobs.push({ dest, pieces });
		});
	}
	if (jobs.length === 0) h.fail('E_INVALID_PARAM', 'Nothing to place from this sequence');
	makeRoom(
		seq,
		h,
		jobs.map((j) => j.dest),
		o.at,
		frames,
		o.mode,
		o.rippleMarkers,
	);
	const clipMap = new Map<string, string>();
	const placed: { oldId: string; clip: DClip }[] = [];
	for (const job of jobs)
		for (const { oldId, clip } of job.pieces) {
			const c = clip as Clip;
			reidentifyClipChildren(c, h);
			c.id = h.ids.next('clp');
			c.trackId = job.dest.id;
			c.start = o.at + (clip.start - n0);
			c.groupId = null;
			seq.clips[c.id] = c as DClip;
			clipMap.set(oldId, c.id);
			placed.push({ oldId, clip: seq.clips[c.id]! });
		}
	regroup(seq, placed, nested, h, ['links']);
	for (const t of copyTransitions(nested, clipMap, (id) => seq.clips[id]?.trackId, h, true))
		seq.transitions[t.id] = t as Draft<Transition>;
	for (const { clip } of placed) {
		const tb = (clip as { trackedBy?: { clipId: string } }).trackedBy;
		if (tb && clipMap.has(tb.clipId)) tb.clipId = clipMap.get(tb.clipId)!;
	}
	dropForeignTracking(seq, h);
	cleanupSequence(seq, h);
	const ids = placed.map((p) => p.clip.id);
	if (ids.length) h.defineRef(o.ref, ids[0]!);
	return { clipIds: ids, linkId: null };
}

// ---------------------------------------------------------------- frame holds

const VIDEO_TRACK_KINDS = (c: { kind: string }) =>
	kindCapabilities(c.kind)?.trackKind === 'video' && c.kind !== 'adjustment';

/** Content time of the frame a clip shows at `frame` ignoring any hold, snapped to whole flicks. */
const movingTime = (c: Clip, frame: number, rate: Rational) =>
	Math.max(0, Math.round(contentTimeAt(c, Math.min(clipEnd(c) - 1, Math.max(c.start, frame)), rate)));

function addFrameHold(doc: DDoc, cmd: CommandOf<'clip.addFrameHold'>, h: HandlerContext) {
	let seq: DSeq;
	let candidates: DClip[];
	if (cmd.clipIds !== undefined) {
		const r = h.clipsOf(doc, idList(cmd.clipIds));
		seq = r.seq;
		candidates = r.clips;
	} else {
		seq = h.sequence(doc, cmd.sequenceId);
		candidates = [];
	}
	const at = h.frame(seq, cmd.at);
	const spans = (c: DClip) => c.start <= at && at < end(c);
	let clips: DClip[];
	if (cmd.clipIds !== undefined) clips = candidates.filter((c) => VIDEO_TRACK_KINDS(c) && spans(c));
	else {
		const tracks = cmd.tracks
			? cmd.tracks.map((ref) => h.track(seq, ref))
			: [...seq.videoTracks].reverse().filter((t) => !t.locked);
		const hits = tracks.flatMap((t) => trackClips(seq, t.id).filter((c) => VIDEO_TRACK_KINDS(c) && spans(c)));
		clips = cmd.tracks ? hits : hits.slice(0, 1);
	}
	if (clips.length === 0) h.fail('E_INVALID_PARAM', `No video clip at frame ${at} to hold`);
	const rate = seq.settings.frameRate as Rational;
	const held: string[] = [];
	for (const c of clips) {
		assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
		const hold = c.frameHold ? c.frameHold.flicks : movingTime(c as Clip, at, rate);
		const target = c.start < at ? splitClipAt(seq, c, at, h) : c;
		target.frameHold = { flicks: hold, ...(c.frameHold?.holdFilters ? { holdFilters: true } : {}) };
		held.push(target.id);
	}
	cleanupSequence(seq, h);
	return { clipIds: held };
}

function insertFrameHoldSegment(doc: DDoc, cmd: CommandOf<'clip.insertFrameHoldSegment'>, h: HandlerContext) {
	const { seq, clip } = h.clip(doc, cmd.clipId);
	if (!VIDEO_TRACK_KINDS(clip)) h.fail('E_INVALID_PARAM', 'Frame holds apply to video-track clips');
	const track = findTrackIn(seq, clip.trackId)!.track;
	assertUnlocked(track, h);
	const at = h.frame(seq, cmd.at);
	if (!(clip.start <= at && at < end(clip)))
		h.fail('E_INVALID_PARAM', `Frame ${at} is not inside clip ${clip.id}`);
	const rate = seq.settings.frameRate as Rational;
	const n =
		cmd.duration === undefined ? Math.round((2 * rate.num) / rate.den) : h.durationFrames(seq, cmd.duration);
	if (n < 1) h.fail('E_INVALID_PARAM', 'The segment must be at least one frame long');
	const hold = clip.frameHold ? clip.frameHold.flicks : movingTime(clip as Clip, at, rate);
	const segment = plain(clip) as Clip;
	const edited = new Set([track.id]);
	const tracks = [track.id, ...syncFollowerTracks(seq, edited).map((t) => t.id)];
	relinkSplits(seq, insertShift(seq, tracks, at, n, h), h);
	if (cmd.rippleMarkers !== false) shiftMarkers(seq, at, n);
	reidentifyClipChildren(segment, h);
	segment.id = h.ids.next('clp');
	segment.start = at;
	segment.duration = n;
	segment.sourceIn = hold;
	segment.speed = { ...segment.speed, reverse: false };
	segment.linkId = null;
	segment.groupId = null;
	segment.markers = [];
	segment.frameHold = { flicks: hold, ...(clip.frameHold?.holdFilters ? { holdFilters: true } : {}) };
	seq.clips[segment.id] = segment as DClip;
	cleanupSequence(seq, h);
	return { clipId: segment.id, duration: n };
}

function frameHoldOptions(doc: DDoc, cmd: CommandOf<'clip.frameHoldOptions'>, h: HandlerContext) {
	const { seq, clips } = h.clipsOf(doc, idList(cmd.clipIds));
	const rate = seq.settings.frameRate as Rational;
	const out: { clipId: string; flicks: number | null }[] = [];
	for (const c of clips) {
		if (!VIDEO_TRACK_KINDS(c)) h.fail('E_INVALID_PARAM', `Clip ${c.id} is not a video-track clip`);
		assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
		if (cmd.enabled === false) {
			delete c.frameHold;
			out.push({ clipId: c.id, flicks: null });
			continue;
		}
		const mode = cmd.holdOn ?? 'in';
		let t: number;
		if (mode === 'in') t = movingTime(c as Clip, c.start, rate);
		else if (mode === 'out') t = movingTime(c as Clip, end(c) - 1, rate);
		else if (mode === 'source-time') {
			if (!cmd.sourceTime) h.fail('E_INVALID_PARAM', 'holdOn "source-time" needs sourceTime');
			const asset = (c as { mediaId?: string }).mediaId
				? doc.media[(c as { mediaId: string }).mediaId]
				: null;
			t = h.flicks(cmd.sourceTime, asset as MediaAsset | null, rate);
		} else {
			if (cmd.at === undefined) h.fail('E_INVALID_PARAM', `holdOn "${mode}" needs at (a sequence time)`);
			t = movingTime(c as Clip, h.frame(seq, cmd.at), rate);
		}
		if (isBoundedContent(c as Clip)) {
			const dur = contentDurationFlicks(doc as never, c as Clip);
			if (dur !== null && t >= dur) {
				h.warn('W_VALUE_CLAMPED', `Hold time of ${c.id} clamped to its last frame`);
				t = Math.max(0, Math.round(dur - flicksPerFrame(rate) * c.speed.rate));
			}
		}
		const holdFilters = cmd.holdFilters ?? c.frameHold?.holdFilters ?? false;
		c.frameHold = { flicks: t, ...(holdFilters ? { holdFilters: true } : {}) };
		out.push({ clipId: c.id, flicks: t });
	}
	return { clips: out };
}

// ---------------------------------------------------------------- through edits, subsequences

function joinThroughEdits(doc: DDoc, cmd: CommandOf<'sequence.joinThroughEdits'>, h: HandlerContext) {
	let seq: DSeq;
	let only: Set<string> | null = null;
	if (cmd.clipIds !== undefined) {
		const r = h.clipsOf(doc, idList(cmd.clipIds));
		seq = r.seq;
		only = new Set(r.clips.map((c) => c.id));
	} else seq = h.sequence(doc, cmd.sequenceId);
	const rate = seq.settings.frameRate as Rational;
	let joined = 0;
	for (const t of allTracksIn(seq)) {
		if (t.locked) continue;
		let list = trackClips(seq, t.id);
		let i = 0;
		while (i + 1 < list.length) {
			const a = list[i]!;
			const b = list[i + 1]!;
			const wanted = !only || only.has(a.id) || only.has(b.id);
			if (!(wanted && isThroughEdit(a as Clip, b as Clip, rate))) {
				i++;
				continue;
			}
			// The left piece absorbs the right one (FilmCraft join_through_edits): reversed pieces show earlier
			// content on the right, so the joined clip starts from the right piece's in-point.
			const reverse = a.speed.reverse;
			const bIn = b.sourceIn;
			for (const tr of Object.values(seq.transitions)) {
				if (tr.outgoingClipId === a.id && tr.incomingClipId === b.id) delete seq.transitions[tr.id];
				else if (tr.outgoingClipId === b.id) tr.outgoingClipId = a.id;
			}
			const markers = plain(b.markers);
			a.duration += b.duration;
			if (reverse) a.sourceIn = bIn;
			for (const m of markers) if (!a.markers.some((x) => x.id === m.id)) a.markers.push(m);
			a.markers.sort((x, y) => x.flicks - y.flicks);
			removeClip(seq, b.id, h);
			joined++;
			list = trackClips(seq, t.id);
		}
	}
	if (joined === 0) h.fail('E_INVALID_PARAM', 'There are no through edits to join');
	cleanupSequence(seq, h);
	return { joined };
}

function makeSubsequence(doc: DDoc, cmd: CommandOf<'sequence.makeSubsequence'>, h: HandlerContext) {
	let seq: DSeq;
	let picked: DClip[] | null = null;
	if (cmd.clipIds !== undefined) {
		const r = h.clipsOf(doc, idList(cmd.clipIds));
		seq = r.seq;
		picked = r.clips;
	} else seq = h.sequence(doc, cmd.sequenceId);
	const rate = seq.settings.frameRate as Rational;
	const from = cmd.from !== undefined ? h.frame(seq, cmd.from) : (seq.inPoint ?? null);
	const to = cmd.to !== undefined ? h.frame(seq, cmd.to) : (seq.outPoint ?? null);
	const ranged = from !== null || to !== null;
	const lo = from ?? 0;
	const hi = to ?? Number.POSITIVE_INFINITY;
	if (ranged && !(hi > lo)) h.fail('E_INVALID_PARAM', 'The range is empty');
	if (!picked && !ranged && !cmd.tracks)
		h.fail('E_INVALID_PARAM', 'Give clipIds, tracks or a range (or set In and Out first)');
	const trackSet = cmd.tracks ? new Set(cmd.tracks.map((ref) => h.track(seq, ref).id)) : null;
	const source = picked ?? Object.values(seq.clips).filter((c) => !trackSet || trackSet.has(c.trackId));
	const pieces = source
		.filter((c) => c.kind !== 'captions')
		.map((c) => ({ oldId: c.id, clip: clipToRange(plain(c) as Clip, lo, hi, rate) }))
		.filter((p): p is { oldId: string; clip: Clip } => !!p.clip);
	if (pieces.length === 0) h.fail('E_INVALID_PARAM', 'There are no clips in the range on those tracks');
	const offset = ranged ? lo : Math.min(...pieces.map((p) => p.clip.start));
	const parent = seq as Sequence;
	const sub = sequenceLike(h, parent);
	const clipMap = new Map<string, string>();
	const placed: { oldId: string; clip: DClip }[] = [];
	for (const { oldId, clip } of pieces) {
		const { kind, index } = trackRange(seq, clip.trackId);
		reidentifyClipChildren(clip, h);
		clip.id = h.ids.next('clp');
		clip.trackId = tracksOfKind(sub as DSeq, kind)[index]!.id;
		clip.start -= offset;
		clip.groupId = null;
		sub.clips[clip.id] = clip;
		clipMap.set(oldId, clip.id);
		placed.push({ oldId, clip: sub.clips[clip.id] as DClip });
	}
	regroup(sub as DSeq, placed, parent, h, ['links', 'groups']);
	for (const t of copyTransitions(parent, clipMap, (id) => sub.clips[id]?.trackId, h, true)) {
		// Transitions must lie inside the range (FilmCraft): a cut-off one is dropped.
		const o = t.outgoingClipId ? sub.clips[t.outgoingClipId] : null;
		const i = t.incomingClipId ? sub.clips[t.incomingClipId] : null;
		if (o && i && clipEnd(o) !== i.start) continue;
		sub.transitions[t.id] = t;
	}
	for (const { clip } of placed) {
		const tb = (clip as { trackedBy?: { clipId: string } }).trackedBy;
		if (tb && clipMap.has(tb.clipId)) tb.clipId = clipMap.get(tb.clipId)!;
	}
	const { itemId: parentItem, binId: parentBin } = sequenceItem(doc, seq.id);
	const binId = cmd.binId !== undefined ? cmd.binId : parentBin;
	if (binId && doc.items[binId]?.kind !== 'bin') h.fail('E_NOT_FOUND', `Bin not found: ${binId}`);
	const name = cmd.name ?? numberedName(doc, `${sequenceName(doc, seq.id)}_Sub`, '_');
	const itemId = newSequenceItem(doc, h, sub, name, binId, binId === parentBin ? parentItem : null);
	const created = doc.sequences[sub.id]!;
	dropForeignTracking(created, h);
	cleanupSequence(created, h);
	h.defineRef(cmd.ref, sub.id);
	return { sequenceId: sub.id, itemId, clipIds: placed.map((p) => p.clip.id) };
}

// ---------------------------------------------------------------- sequences, project items

/** A deep copy of a sequence in the same project: new ids for every entity inside, shared media (SEQ-011). */
function duplicateSequence(src: Sequence, h: HandlerContext): Sequence {
	const seq = plain(src);
	seq.id = h.ids.next('seq');
	const trackMap = new Map<string, string>();
	for (const t of [...seq.videoTracks, ...seq.audioTracks, ...seq.captionTracks]) {
		const id = h.ids.next('trk');
		trackMap.set(t.id, id);
		t.id = id;
		reidentifyClipChildren(t as never, h);
	}
	reidentifyClipChildren(seq.master as never, h);
	for (const m of seq.markers) m.id = h.ids.next('mrk');
	const clipMap = new Map<string, string>();
	const clips: Sequence['clips'] = {};
	const trackerMaps = new Map<string, Map<string, string>>();
	for (const c of Object.values(seq.clips)) {
		const before = ((c as { trackers?: { id: string }[] }).trackers ?? []).map((t) => t.id);
		reidentifyClipChildren(c, h);
		const after = ((c as { trackers?: { id: string }[] }).trackers ?? []).map((t) => t.id);
		const id = h.ids.next('clp');
		clipMap.set(c.id, id);
		trackerMaps.set(id, new Map(before.map((x, k) => [x, after[k]!])));
		clips[id] = { ...c, id, trackId: trackMap.get(c.trackId) ?? c.trackId } as Clip;
	}
	for (const c of Object.values(clips)) {
		const tb = (c as { trackedBy?: { clipId: string; trackerId: string } }).trackedBy;
		if (!tb) continue;
		const to = clipMap.get(tb.clipId);
		const tk = to ? trackerMaps.get(to)?.get(tb.trackerId) : undefined;
		if (to && tk) (c as { trackedBy?: unknown }).trackedBy = { ...tb, clipId: to, trackerId: tk };
		else delete (c as { trackedBy?: unknown }).trackedBy;
	}
	for (const kind of ['links', 'groups'] as const) {
		const field = kind === 'links' ? 'linkId' : 'groupId';
		const table: Sequence['links'] = {};
		for (const g of Object.values(seq[kind])) {
			const id = h.ids.next(kind === 'links' ? 'lnk' : 'grp');
			const members = g.members.map((m) => clipMap.get(m)).filter((m): m is string => !!m);
			table[id] = { id, members };
			for (const m of members) (clips[m] as Record<string, unknown>)[field] = id;
		}
		seq[kind] = table;
	}
	seq.clips = clips;
	const transitions: Sequence['transitions'] = {};
	for (const t of Object.values(seq.transitions)) {
		const id = h.ids.next('trn');
		transitions[id] = {
			...t,
			id,
			trackId: trackMap.get(t.trackId) ?? t.trackId,
			outgoingClipId: t.outgoingClipId ? (clipMap.get(t.outgoingClipId) ?? null) : null,
			incomingClipId: t.incomingClipId ? (clipMap.get(t.incomingClipId) ?? null) : null,
		};
	}
	seq.transitions = transitions;
	return seq;
}

/** Media ids anything still uses: clips (any `mediaId` inside them, incl. effect and transition params), derived
 * media sources, font assets, transcripts. */
function usedMediaIds(doc: DDoc): Set<string> {
	const used = new Set<string>();
	const walk = (v: unknown): void => {
		if (Array.isArray(v)) v.forEach(walk);
		else if (v && typeof v === 'object')
			for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
				if (k === 'mediaId' && typeof x === 'string') used.add(x);
				else walk(x);
			}
	};
	for (const seq of Object.values(doc.sequences)) {
		walk(seq.clips);
		walk(seq.transitions);
		walk(seq.master);
		for (const t of [...seq.videoTracks, ...seq.audioTracks, ...seq.captionTracks]) walk(t);
	}
	for (const m of Object.values(doc.media))
		if (m.derivation && used.has(m.id)) used.add(m.derivation.fromMediaId);
	for (const f of Object.values(doc.fonts)) if (f.source.type === 'asset') used.add(f.source.mediaId);
	for (const t of Object.values(doc.transcripts)) if (t.mediaId) used.add(t.mediaId);
	// Derived media of a used derivation chain keep their sources (several levels).
	let grew = true;
	while (grew) {
		grew = false;
		for (const m of Object.values(doc.media))
			if (m.derivation && used.has(m.id) && !used.has(m.derivation.fromMediaId)) {
				used.add(m.derivation.fromMediaId);
				grew = true;
			}
	}
	return used;
}

function removeUnused(doc: DDoc, cmd: CommandOf<'media.removeUnused'>, h: HandlerContext) {
	const kinds = cmd.kinds ? new Set<string>(cmd.kinds) : null;
	const usedSyn = new Set<string>();
	for (const seq of Object.values(doc.sequences))
		for (const c of Object.values(seq.clips)) {
			const s = (c as { syntheticId?: unknown }).syntheticId;
			if (typeof s === 'string') usedSyn.add(s);
		}
	const usedMedia = usedMediaIds(doc);
	const doomed: string[] = [];
	for (const it of Object.values(doc.items)) {
		if (it.kind === 'media') {
			const asset = doc.media[it.mediaId];
			if (kinds && (!asset || !kinds.has(asset.kind))) continue;
			// A derived version of this media that is used keeps it too (processed versions).
			if (!usedMedia.has(it.mediaId)) doomed.push(it.id);
		} else if (it.kind === 'synthetic' && !kinds && !usedSyn.has(it.syntheticId)) doomed.push(it.id);
	}
	if (doomed.length === 0) return { removed: [], itemIds: [] };
	(projectHandlers['item.delete'] as (d: DDoc, c: CommandOf<'item.delete'>, h: HandlerContext) => unknown)(
		doc,
		{ type: 'item.delete', itemIds: doomed, force: true } as CommandOf<'item.delete'>,
		h,
	);
	return { removed: doomed, itemIds: doomed };
}

// ---------------------------------------------------------------- handlers

export const structureHandlers: HandlerMap = {
	'clip.nest': nestHandler,
	'clip.unnest': unnestHandler,
	'clip.addAdjustment': (doc, cmd, h: HandlerContext) => {
		const { seq, track, at, duration, id } = newGeneratorClip(doc, cmd, h, 'adjustment');
		const synId = h.ids.next('syn');
		doc.synthetics[synId] = { id: synId, kind: 'adjustment' };
		seq.clips[id] = {
			...commonFields(id, track.id, at, duration, 0, cmd.name ?? 'Adjustment Layer', 'tan'),
			kind: 'adjustment',
			syntheticId: synId,
			opacity: anim(100),
			blendMode: 'normal',
			effects: [],
		} as DClip;
		cleanupSequence(seq, h);
		h.defineRef(cmd.ref, id);
		return { clipId: id, syntheticId: synId };
	},
	'clip.group': (doc, cmd, h: HandlerContext) => {
		const { seq, clips } = h.clipsOf(doc, idList(cmd.clipIds));
		if (clips.length < 2) h.fail('E_INVALID_PARAM', 'Select at least two clips to group');
		for (const c of clips) assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
		// Grouping grouped clips makes one group of everything (groups do not nest).
		const members = new Set<string>();
		for (const c of clips) {
			members.add(c.id);
			if (c.groupId) for (const m of seq.groups[c.groupId]?.members ?? []) members.add(m);
		}
		for (const m of members) {
			const g = seq.clips[m]?.groupId;
			if (g) delete seq.groups[g];
		}
		const id = h.ids.next('grp');
		seq.groups[id] = { id, members: [...members] };
		for (const m of members) seq.clips[m]!.groupId = id;
		h.defineRef(cmd.ref, id);
		cleanupSequence(seq, h);
		return { groupId: id, clipIds: [...members] };
	},
	'clip.ungroup': (doc, cmd, h: HandlerContext) => {
		const { seq, clips } = h.clipsOf(doc, idList(cmd.clipIds));
		const groups = new Set(clips.map((c) => c.groupId).filter((g): g is string => !!g));
		const released: string[] = [];
		for (const g of groups) {
			for (const m of seq.groups[g]?.members ?? []) {
				const c = seq.clips[m];
				if (c) {
					c.groupId = null;
					released.push(m);
				}
			}
			delete seq.groups[g];
		}
		return { groupIds: [...groups], clipIds: released };
	},
	'clip.addFrameHold': addFrameHold,
	'clip.insertFrameHoldSegment': insertFrameHoldSegment,
	'clip.frameHoldOptions': frameHoldOptions,
	'sequence.joinThroughEdits': joinThroughEdits,
	'sequence.makeSubsequence': makeSubsequence,
	'sequence.duplicate': (doc, cmd, h: HandlerContext) => {
		const src = doc.sequences[cmd.sequenceId] as Sequence | undefined;
		if (!src) h.fail('E_NOT_FOUND', `Sequence not found: ${cmd.sequenceId}`);
		const copy = duplicateSequence(src, h);
		const { itemId: srcItem, binId } = sequenceItem(doc, src.id);
		const name = cmd.name ?? `${sequenceName(doc, src.id)} Copy`;
		const itemId = newSequenceItem(doc, h, copy, name, binId, srcItem);
		h.defineRef(cmd.ref, copy.id);
		return { sequenceId: copy.id, itemId };
	},
	'sequence.delete': (doc, cmd, h: HandlerContext) => {
		if (!doc.sequences[cmd.sequenceId]) h.fail('E_NOT_FOUND', `Sequence not found: ${cmd.sequenceId}`);
		const { itemId } = sequenceItem(doc, cmd.sequenceId);
		if (!itemId) h.fail('E_NOT_FOUND', `Sequence ${cmd.sequenceId} has no project item`);
		(projectHandlers['item.delete'] as (d: DDoc, c: CommandOf<'item.delete'>, h: HandlerContext) => unknown)(
			doc,
			{
				type: 'item.delete',
				itemIds: [itemId],
				...(cmd.force ? { force: true } : {}),
			} as CommandOf<'item.delete'>,
			h,
		);
		return { sequenceId: cmd.sequenceId, itemId };
	},
	'media.removeUnused': removeUnused,
	'synthetic.create': (doc, cmd, h: HandlerContext) => {
		const id = h.ids.next('syn');
		const { source, issues } = syntheticFromParams(cmd.kind, id, cmd.params ?? {});
		if (!source)
			h.fail('E_INVALID_PARAM', issues.map((i) => i.message).join('; '), {
				path: ['params', issues[0]!.param],
			});
		if (cmd.binId) {
			const bin = doc.items[cmd.binId];
			if (bin?.kind !== 'bin') h.fail('E_NOT_FOUND', `Bin not found: ${cmd.binId}`);
		}
		doc.synthetics[id] = source as SyntheticSource;
		const itemId = h.ids.next('itm');
		doc.items[itemId] = {
			id: itemId,
			kind: 'synthetic',
			name: cmd.name ?? SYNTHETIC_INFO[cmd.kind].label,
			syntheticId: id,
			label: cmd.kind === 'adjustment' ? 'lavender' : 'tan',
			marks: { in: null, out: null },
		};
		insertItem(doc, itemId, cmd.binId ?? null);
		h.defineRef(cmd.ref, id);
		return { syntheticId: id, itemId };
	},
	'synthetic.update': (doc, cmd, h: HandlerContext) => {
		const base = doc.synthetics[cmd.syntheticId] as SyntheticSource | undefined;
		if (!base) h.fail('E_NOT_FOUND', `Synthetic source not found: ${cmd.syntheticId}`);
		const { source, issues } = syntheticFromParams(base.kind, base.id, cmd.params, base);
		if (!source)
			h.fail('E_INVALID_PARAM', issues.map((i) => i.message).join('; '), {
				path: ['params', issues[0]!.param],
			});
		doc.synthetics[base.id] = source as Draft<SyntheticSource>;
		return { syntheticId: base.id };
	},
};
