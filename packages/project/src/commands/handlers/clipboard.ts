// Clipboard command handlers (wp-clipboard; S01 §20 CLB-003…008, ID-005; S03:FX-011/012, EC-023/032, KF table
// "duplicate, copy/paste, paste attributes"). Every paste validates its payload first (CLB-009), gives every
// pasted entity a new id and remaps the references inside the pasted set (ID-005), and resolves the entities the
// payload references in the target project (CLB-008):
// - media: same fingerprint in the target → reused; else the record is added under a new id (with a project item
//   when it is used directly, so it shows in the Project panel and stays referenced); its locators are resolved
//   by the runtime like any new asset (LIFE-030), else the clips are offline until relinked;
// - synthetics, transcripts, fonts: same project and same id → reused; else copied under new ids (a font with the
//   same family and source already in the target is reused instead of duplicated).
// Resolution is lazy: only the entities the pasted content actually uses are added.
import { current, type Draft, isDraft } from 'immer';
import { intrinsicOf } from '../../clipboard/build.ts';
import {
	type ClipboardKind,
	type ClipboardPayload,
	type IntrinsicAttributes,
	type KeyframeAddress,
	parseClipboardPayload,
} from '../../clipboard/payload.ts';
import type { ClipTiming } from '../../color/retime.ts';
import { anim, defaultTransform } from '../../factories.ts';
import { isHoldOnlyValue, retimeRoving, reversedKeyTiming } from '../../keyframes.ts';
import { isVec2Value, refreshAutoTangents, reversedSpatial } from '../../keyframes-spatial.ts';
import { defaultLabelForMedia, kindCapabilities, trackKindFor } from '../../registry/kinds.ts';
import { intrinsicBoxOf } from '../../registry/properties.ts';
import { dropForeignRotoRefs } from '../../roto/index.ts';
import type { Keyframe } from '../../schema/common.ts';
import type { ProjectItem } from '../../schema/document.ts';
import type { FontRef, MediaAsset } from '../../schema/media.ts';
import {
	type Clip,
	type EffectInstance,
	isKnownClipKind,
	type Sequence,
	type TextAnimator,
	type TrackKind,
} from '../../schema/sequence.ts';
import { scaleAnimationFrames } from '../../text-animations.ts';
import { flicksPerFrame, fpsOf, type Rational } from '../../time.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import {
	assertKindFits,
	assertUnlocked,
	cleanupSequence,
	clearRange,
	ensureTrackAt,
	findTrackIn,
	insertShift,
	reidentifyClipChildren,
	relinkSplits,
	resolveOrCreateTrack,
	type SplitRecord,
	shiftMarkers,
	syncFollowerTracks,
} from '../placement.ts';
import type { CommandOf, PasteAttributes } from '../schemas/index.ts';
import { applyClipPatch } from './clip-core.ts';
import { buildParams } from './effect.ts';
import { refreshAutoBezier } from './keyframe.ts';
import { PRUNE_EMPTY_KEYFRAMES } from './mg-template.ts';
import { resolveTarget, validateValue } from './param.ts';
import { assertBin, insertItem } from './project.ts';
import { type HandlerMap, idList } from './util.ts';

export const CLIPBOARD_OWNER = 'wp-clipboard';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(isDraft(v) ? current(v as Draft<T>) : v)) as T;

function payloadOf(raw: unknown, h: HandlerContext, kinds: readonly ClipboardKind[]): ClipboardPayload {
	const r = parseClipboardPayload(raw);
	if (!r.ok) return h.fail(r.code, r.message, { path: ['payload'] });
	if (!kinds.includes(r.payload.kind))
		h.fail('E_INVALID_PARAM', `This command pastes ${kinds.join(' or ')}, not ${r.payload.kind}`, {
			path: ['payload', 'kind'],
		});
	return r.payload;
}

// ---------------------------------------------------------------- reference resolution (CLB-008)

/** Maps the payload's entity ids to target ids, adding records on first use. */
class Resolver {
	private readonly media = new Map<string, string>();
	private readonly synthetics = new Map<string, string>();
	private readonly transcripts = new Map<string, string>();
	private readonly fonts = new Map<string, string>();
	readonly createdMedia: string[] = [];
	readonly reusedMedia: string[] = [];
	private readonly same: boolean;
	/** Payload media used only as a derivation source or a font file: added without a project item. */
	private readonly indirect = new Set<string>();

	constructor(
		private readonly doc: DDoc,
		private readonly p: ClipboardPayload,
		private readonly h: HandlerContext,
		private readonly opts: { binId: string | null; noItemFor?: ReadonlySet<string> } = { binId: null },
	) {
		this.same = p.sourceProjectId === doc.projectId;
		for (const m of p.media) if (m.derivation) this.indirect.add(m.derivation.fromMediaId);
		for (const f of p.fonts) if (f.source.type === 'asset') this.indirect.add(f.source.mediaId);
	}

	private missing(what: string, id: string): never {
		return this.h.fail('E_SCHEMA', `The clipboard data does not include ${what} ${id}`, {
			path: ['payload'],
		});
	}

	mediaId(id: string, direct = true): string {
		const known = this.media.get(id);
		if (known) return known;
		const m = this.p.media.find((x) => x.id === id);
		if (!m) {
			if (this.same && this.doc.media[id]) return id;
			return this.missing('media', id);
		}
		const live = (x: MediaAsset | undefined) =>
			!!x && x.fingerprint === m.fingerprint && !x.fingerprint.startsWith('pending:');
		const existing =
			(this.same && live(this.doc.media[id] as MediaAsset | undefined) ? this.doc.media[id] : undefined) ??
			Object.values(this.doc.media).find((x) => live(x as MediaAsset));
		if (existing) {
			this.media.set(id, existing.id);
			this.reusedMedia.push(existing.id);
			return existing.id;
		}
		const newId = this.h.ids.next('med');
		this.media.set(id, newId);
		const from = m.derivation ? this.mediaId(m.derivation.fromMediaId, false) : null;
		this.doc.media[newId] = {
			...clone(m),
			id: newId,
			derivation: m.derivation && from ? { ...clone(m.derivation), fromMediaId: from } : null,
		} as Draft<MediaAsset>;
		this.createdMedia.push(newId);
		const wantsItem = direct || !this.indirect.has(id);
		if (wantsItem && !this.opts.noItemFor?.has(id)) {
			const itemId = this.h.ids.next('itm');
			const meta = this.p.mediaItems?.[id];
			this.doc.items[itemId] = {
				id: itemId,
				kind: 'media',
				name: meta?.name ?? m.originalName,
				mediaId: newId,
				label: meta?.label ?? defaultLabelForMedia(m),
				marks: { in: null, out: null },
			};
			insertItem(this.doc, itemId, this.opts.binId);
		}
		return newId;
	}

	syntheticId(id: string): string {
		const known = this.synthetics.get(id);
		if (known) return known;
		const s = this.p.synthetics.find((x) => x.id === id);
		if (this.same && this.doc.synthetics[id]) {
			this.synthetics.set(id, id);
			return id;
		}
		if (!s) return this.missing('synthetic source', id);
		const newId = this.h.ids.next('syn');
		this.doc.synthetics[newId] = { ...clone(s), id: newId } as never;
		this.synthetics.set(id, newId);
		return newId;
	}

	transcriptId(id: string): string {
		const known = this.transcripts.get(id);
		if (known) return known;
		if (this.same && this.doc.transcripts[id]) {
			this.transcripts.set(id, id);
			return id;
		}
		const t = this.p.transcripts.find((x) => x.id === id);
		if (!t) return this.missing('transcript', id);
		const newId = this.h.ids.next('trs');
		const mediaId =
			t.mediaId && this.p.media.some((m) => m.id === t.mediaId) ? this.mediaId(t.mediaId) : null;
		this.doc.transcripts[newId] = { ...clone(t), id: newId, mediaId } as never;
		this.transcripts.set(id, newId);
		return newId;
	}

	fontId(id: string): string {
		const known = this.fonts.get(id);
		if (known) return known;
		if (this.same && this.doc.fonts[id]) {
			this.fonts.set(id, id);
			return id;
		}
		const f = this.p.fonts.find((x) => x.id === id);
		if (!f) return this.missing('font', id);
		const source: FontRef['source'] =
			f.source.type === 'asset' ? { ...f.source, mediaId: this.mediaId(f.source.mediaId, false) } : f.source;
		// A font with the same family and source is the same font: reuse it rather than duplicate the record.
		const twin = Object.values(this.doc.fonts).find(
			(x) => x.family === f.family && JSON.stringify(x.source) === JSON.stringify(source),
		);
		const newId = twin?.id ?? this.h.ids.next('fnt');
		if (!twin) this.doc.fonts[newId] = { ...clone(f), id: newId, source: clone(source) } as never;
		this.fonts.set(id, newId);
		return newId;
	}

	/** `{mediaId}` param values (LUTs) of effects, keyframes included. */
	remapEffectMedia(effects: Draft<EffectInstance>[] | EffectInstance[] | undefined): void {
		const fix = (v: unknown) => {
			const o = v as { mediaId?: unknown } | null;
			if (o && typeof o === 'object' && !Array.isArray(o) && typeof o.mediaId === 'string' && o.mediaId)
				(o as { mediaId: string }).mediaId = this.mediaId(o.mediaId);
		};
		for (const fx of effects ?? [])
			for (const a of Object.values(fx.params)) {
				fix(a.value);
				for (const k of a.keyframes) fix(k.value);
			}
	}

	/** Remaps every entity reference of a copied clip; false when its nested sequence cannot be resolved. */
	remapClip(c: Record<string, unknown>, nestMap?: ReadonlyMap<string, string>): boolean {
		if (typeof c.sequenceId === 'string' && isKnownClipKind(c.kind as string)) {
			const s = nestMap?.get(c.sequenceId) ?? (this.doc.sequences[c.sequenceId] ? c.sequenceId : null);
			if (!s) return false;
			c.sequenceId = s;
		}
		if (typeof c.mediaId === 'string') c.mediaId = this.mediaId(c.mediaId);
		const comp = c.composition as { mediaId?: unknown } | undefined;
		if (comp && typeof comp.mediaId === 'string') comp.mediaId = this.mediaId(comp.mediaId);
		if (typeof c.syntheticId === 'string') c.syntheticId = this.syntheticId(c.syntheticId);
		if (typeof c.transcriptId === 'string') c.transcriptId = this.transcriptId(c.transcriptId);
		const content = c.content as
			| { style?: { fontId?: string }; runs?: { style?: { fontId?: string } }[] }
			| undefined;
		if (content?.style?.fontId) content.style.fontId = this.fontId(content.style.fontId);
		for (const run of content?.runs ?? [])
			if (run.style?.fontId) run.style.fontId = this.fontId(run.style.fontId);
		const style = c.style as { fontId?: string } | undefined;
		if (c.kind === 'captions' && style?.fontId) style.fontId = this.fontId(style.fontId);
		this.remapEffectMedia(c.effects as EffectInstance[] | undefined);
		return true;
	}
}

// ---------------------------------------------------------------- re-timing (S03 KF table)

/**
 * Content-time keys of `from` re-timed onto `to` keeping their offset from the clip's first frame in sequence
 * time (or stretched to the target's duration with `scale`), with new ids. Times are rounded, clamped to ≥ 0 and
 * deduplicated (the later key wins).
 */
function retimeKeys<T>(
	keys: readonly Keyframe<T>[],
	from: { timing: ClipTiming; rate: Rational },
	to: { timing: ClipTiming; rate: Rational },
	h: HandlerContext,
	scale = false,
): Keyframe<T>[] {
	// keyframes-blend: sequence offsets run from the first to the LAST frame of the clip, (duration − 1) frames,
	// exactly as `contentTimeAt` maps a reversed clip (a full `duration` span landed reversed pastes one frame off).
	const fromSpan = Math.max(0, from.timing.duration - 1) * flicksPerFrame(from.rate);
	const toSpan = Math.max(0, to.timing.duration - 1) * flicksPerFrame(to.rate);
	const k = scale && fromSpan > 0 ? toSpan / fromSpan : 1;
	// Onto a clip running the other way the path is traversed backwards: spatial in/out tangents swap and every
	// segment's temporal ease is mirrored (`reversedKeyTiming`).
	const flip = from.timing.speed.reverse !== to.timing.speed.reverse;
	const byTime = new Map<number, Keyframe<T>>();
	keys.forEach((key, i) => {
		const c = (key.time - from.timing.sourceIn) / from.timing.speed.rate;
		const seqOffset = (from.timing.speed.reverse ? fromSpan - c : c) * k;
		const content = to.timing.speed.reverse
			? to.timing.sourceIn + (toSpan - seqOffset) * to.timing.speed.rate
			: to.timing.sourceIn + seqOffset * to.timing.speed.rate;
		const time = Math.max(0, Math.round(content));
		const copy: Keyframe<T> = { ...clone(key), id: h.ids.next('kf'), time };
		if (flip) {
			Object.assign(copy, clone(reversedKeyTiming(keys as readonly Keyframe<unknown>[], i)));
			if (copy.spatial) copy.spatial = reversedSpatial(copy.spatial);
			// A roving key stays roving (its run reverses with it).
		}
		byTime.set(time, copy);
	});
	return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Every Animatable inside `obj` (a transform, a shape paint) re-timed in place. */
function retimeAll(
	obj: unknown,
	from: { timing: ClipTiming; rate: Rational },
	to: { timing: ClipTiming; rate: Rational },
	h: HandlerContext,
	scale: boolean,
): void {
	if (!obj || typeof obj !== 'object') return;
	if (Array.isArray(obj)) {
		for (const x of obj) retimeAll(x, from, to, h, scale);
		return;
	}
	const o = obj as Record<string, unknown>;
	if ('value' in o && Array.isArray(o.keyframes)) {
		o.keyframes = retimeKeys(o.keyframes as Keyframe<unknown>[], from, to, h, scale);
		return;
	}
	for (const v of Object.values(o)) retimeAll(v, from, to, h, scale);
}

const timingOf = (c: Pick<Clip, 'start' | 'duration' | 'sourceIn' | 'speed'>): ClipTiming => ({
	start: c.start,
	duration: c.duration,
	sourceIn: c.sourceIn,
	speed: { rate: c.speed.rate, reverse: c.speed.reverse },
});

// ---------------------------------------------------------------- clip.paste (CLB-003/004)

/** Sequence-frame converter between the source and target frame rates (identity when equal). */
function frameConverter(from: Rational, to: Rational): (n: number) => number {
	if (from.num * to.den === to.num * from.den) return (n) => n;
	return (n) => Math.round((n * fpsOf(to)) / fpsOf(from));
}

function convertTextAnimation(c: Record<string, unknown>, from: Rational, to: Rational): void {
	const ta = c.textAnimation as Record<string, TextAnimator | null | undefined> | undefined;
	if (!ta || fpsOf(from) === fpsOf(to)) return;
	for (const side of ['in', 'out'] as const) {
		const a = ta[side];
		if (a) a.durationFrames = scaleAnimationFrames(a.durationFrames, to, from);
	}
}

/** Destination index of the lowest pasted track of a kind (the lowest targeted track, CLB-003). */
function baseIndex(seq: DSeq, ref: string, kind: TrackKind, h: HandlerContext): number {
	const t = resolveOrCreateTrack(seq, ref, h, true);
	const found = findTrackIn(seq, t.id)!;
	if (found.kind !== kind) h.fail('E_TRACK_KIND', `${ref} is not a ${kind} track`, { blocking: [t.id] });
	return found.index;
}

function pasteClips(doc: DDoc, cmd: CommandOf<'clip.paste'>, h: HandlerContext): unknown {
	const p = payloadOf(cmd.payload, h, ['clips']);
	const sec = p.clips!;
	const seq = h.sequence(doc, cmd.sequenceId);
	const at = h.frame(seq, cmd.at);
	if (at < 0) h.fail('E_INVALID_PARAM', 'Paste position must be >= 0');
	const target = seq.settings.frameRate as Rational;
	const conv = frameConverter(sec.frameRate, target);
	const resolver = new Resolver(doc, p, h);

	const defaults: Record<TrackKind, string> = { video: 'V1', audio: 'A1', caption: 'C1' };
	const bases: Partial<Record<TrackKind, number>> = {};
	const skipped: string[] = [];
	const plans = sec.clips.flatMap((c) => {
		const kind = sec.trackKinds[c.trackId] ?? trackKindFor(c.kind);
		if (!kind) return h.fail('E_SCHEMA', `Unknown track kind for copied clip ${c.id}`, { path: ['payload'] });
		const nested = (c as { sequenceId?: unknown }).sequenceId;
		if (typeof nested === 'string' && isKnownClipKind(c.kind) && !doc.sequences[nested]) {
			skipped.push(c.id);
			h.warn(
				'W_CLIP_SKIPPED',
				`Nested sequence clip ${c.id} was skipped: its sequence is not in this project`,
			);
			return [];
		}
		bases[kind] ??= baseIndex(seq, cmd.tracks?.[kind] ?? defaults[kind], kind, h);
		const index = bases[kind]! + (sec.trackOffsets[c.trackId] ?? 0);
		const start = at + conv(c.start - sec.originFrame);
		const end = Math.max(start + 1, at + conv(c.start + c.duration - sec.originFrame));
		return [{ src: c, kind, index, start, end }];
	});
	if (plans.length === 0) h.fail('E_INVALID_PARAM', 'Nothing in the clipboard can be pasted here');
	const dest = plans.map((pl) => {
		const t = ensureTrackAt(seq, pl.kind, pl.index, h);
		assertUnlocked(t, h);
		assertKindFits(pl.src.kind, t, h);
		return t;
	});
	const end = Math.max(...plans.map((pl) => pl.end));
	const span = end - at;
	if ((cmd.mode ?? 'overwrite') === 'overwrite') {
		const splits: SplitRecord[] = [];
		plans.forEach((pl, i) => {
			splits.push(...clearRange(seq, dest[i]!.id, pl.start, pl.end, h));
		});
		relinkSplits(seq, splits, h);
	} else {
		const edited = new Set(dest.map((t) => t.id));
		const tracks = [...edited, ...syncFollowerTracks(seq, edited).map((t) => t.id)];
		relinkSplits(seq, insertShift(seq, tracks, at, span, h), h);
		if (cmd.rippleMarkers !== false) shiftMarkers(seq, at, span);
	}

	const map: Record<string, string> = {};
	const trackerMaps = new Map<string, Map<string, string>>();
	const links = new Map<string, string[]>();
	const groups = new Map<string, string[]>();
	plans.forEach((pl, i) => {
		const copy = clone(pl.src) as Clip & Record<string, unknown>;
		const before = ((copy.trackers as { id: string }[] | undefined) ?? []).map((t) => t.id);
		reidentifyClipChildren(copy, h);
		const after = ((copy.trackers as { id: string }[] | undefined) ?? []).map((t) => t.id);
		trackerMaps.set(pl.src.id, new Map(before.map((id, k) => [id, after[k]!])));
		const id = h.ids.next('clp');
		map[pl.src.id] = id;
		if (pl.src.linkId) links.set(pl.src.linkId, [...(links.get(pl.src.linkId) ?? []), id]);
		if (pl.src.groupId) groups.set(pl.src.groupId, [...(groups.get(pl.src.groupId) ?? []), id]);
		resolver.remapClip(copy);
		convertTextAnimation(copy, sec.frameRate, target);
		seq.clips[id] = {
			...copy,
			id,
			trackId: dest[i]!.id,
			start: pl.start,
			duration: pl.end - pl.start,
			linkId: null,
			groupId: null,
		} as DClip;
	});
	// Link and group membership is recreated inside the pasted set only (CLB-008).
	for (const [kind, table] of [
		['lnk', links],
		['grp', groups],
	] as const) {
		for (const members of table.values()) {
			if (members.length < 2) continue;
			const gid = h.ids.next(kind);
			if (kind === 'lnk') seq.links[gid] = { id: gid, members };
			else seq.groups[gid] = { id: gid, members };
			for (const m of members) seq.clips[m]![kind === 'lnk' ? 'linkId' : 'groupId'] = gid;
		}
	}
	// Trackers (S09): a target follows the copy of its tracked clip; otherwise it keeps following the original
	// when that clip is in this sequence, else it loses the link (its baked values stay).
	for (const newId of Object.values(map)) {
		const c = seq.clips[newId] as DClip & { trackedBy?: { clipId: string; trackerId: string } };
		if (!c.trackedBy) continue;
		const src = map[c.trackedBy.clipId];
		const tracker = src ? trackerMaps.get(c.trackedBy.clipId)?.get(c.trackedBy.trackerId) : undefined;
		if (src && tracker) {
			c.trackedBy.clipId = src;
			c.trackedBy.trackerId = tracker;
		} else {
			const orig = seq.clips[c.trackedBy.clipId] as { trackers?: { id: string }[] } | undefined;
			if (!orig?.trackers?.some((t) => t.id === c.trackedBy!.trackerId)) delete c.trackedBy;
		}
	}
	// Transitions between pasted clips (and fades of a pasted clip).
	for (const t of sec.transitions) {
		const out = t.outgoingClipId ? map[t.outgoingClipId] : null;
		const inc = t.incomingClipId ? map[t.incomingClipId] : null;
		if ((t.outgoingClipId && !out) || (t.incomingClipId && !inc) || (!out && !inc)) continue;
		const id = h.ids.next('trn');
		seq.transitions[id] = {
			...clone(t),
			id,
			trackId: seq.clips[(out ?? inc)!]!.trackId,
			outgoingClipId: out ?? null,
			incomingClipId: inc ?? null,
			duration: Math.max(1, conv(t.duration)),
		} as never;
	}
	cleanupSequence(seq, h);
	const clipIds = plans.map((pl) => map[pl.src.id]!);
	h.defineRef(cmd.ref, clipIds[0]!);
	return {
		clipIds,
		map,
		sequenceId: seq.id,
		start: at,
		end,
		createdMedia: resolver.createdMedia,
		reusedMedia: [...new Set(resolver.reusedMedia)],
		...(skipped.length ? { skipped } : {}),
	};
}

// ---------------------------------------------------------------- attributes (CLB-005/006, FX-011/012, EC-032)

/** One clip's worth of copyable attributes. */
type AttributeSource = {
	clipId: string | null;
	kind: string;
	timing: ClipTiming;
	rate: Rational;
	intrinsic: IntrinsicAttributes;
	effects: EffectInstance[];
	textAnimation?: { in?: TextAnimator | null; out?: TextAnimator | null };
	textStyle?: Record<string, unknown>;
	shape?: Record<string, unknown>;
};

/** Attribute sources of a payload: the copied effects, or the copied clips with the primary one first. */
function attributeSources(p: ClipboardPayload): AttributeSource[] {
	if (p.kind === 'effects' && p.effects) {
		const e = p.effects;
		return [
			{
				clipId: null,
				kind: e.source.clipKind,
				timing: e.source.timing,
				rate: e.source.frameRate,
				intrinsic: e.intrinsic ?? {},
				effects: e.effects,
			},
		];
	}
	const sec = p.clips;
	if (!sec) return [];
	const clips = [...sec.clips].sort(
		(a, b) => Number(b.id === sec.primaryClipId) - Number(a.id === sec.primaryClipId),
	);
	return clips.map((c) => {
		const r = c as Record<string, unknown>;
		return {
			clipId: c.id,
			kind: c.kind,
			timing: timingOf(c),
			rate: sec.frameRate,
			intrinsic: intrinsicOf(c),
			effects: (r.effects as EffectInstance[] | undefined) ?? [],
			...(r.textAnimation ? { textAnimation: r.textAnimation as AttributeSource['textAnimation'] } : {}),
			...(c.kind === 'text' ? { textStyle: (r.content as { style: Record<string, unknown> }).style } : {}),
			...(c.kind === 'shape' ? { shape: r.shape as Record<string, unknown> } : {}),
		};
	});
}

type DRec = Draft<Record<string, unknown>>;

function applyAttributes(
	doc: DDoc,
	p: ClipboardPayload,
	clipIds: readonly string[],
	attrs: PasteAttributes,
	h: HandlerContext,
	opts: { scale?: boolean; index?: number } = {},
): { clipIds: string[]; applied: Record<string, string[]> } {
	const sources = attributeSources(p);
	if (sources.length === 0) h.fail('E_INVALID_PARAM', 'The clipboard holds no attributes');
	const { seq, clips: targets } = h.clipsOf(doc, clipIds);
	const resolver = new Resolver(doc, p, h);
	const rate = seq.settings.frameRate as Rational;
	const first = <K extends keyof AttributeSource>(pick: (s: AttributeSource) => unknown) =>
		sources.find((s) => pick(s) !== undefined) as (AttributeSource & Record<K, unknown>) | undefined;
	const wantedFx =
		attrs.effects === undefined
			? []
			: sources.flatMap((s) =>
					s.effects
						.filter((fx) => attrs.effects === 'all' || attrs.effects!.includes(fx.id))
						.map((fx) => ({ fx, src: s })),
				);
	if (Array.isArray(attrs.effects))
		for (const id of attrs.effects)
			if (!wantedFx.some((w) => w.fx.id === id))
				h.fail('E_INVALID_PARAM', `The clipboard has no effect ${id}`, { path: ['attributes', 'effects'] });
	const applied: Record<string, string[]> = {};
	for (const t of targets) {
		assertUnlocked(findTrackIn(seq, t.trackId)!.track, h);
		const c = t as DRec & DClip;
		const caps = kindCapabilities(t.kind);
		const to = { timing: timingOf(t), rate };
		const done: string[] = [];
		const from = (s: AttributeSource) => ({ timing: s.timing, rate: s.rate });
		const retimed = <T>(v: T, s: AttributeSource): T => {
			const copy = clone(v);
			retimeAll(copy, from(s), to, h, !!opts.scale);
			return copy;
		};
		const motion = first((s) => s.intrinsic.transform);
		if (attrs.motion && motion && caps?.hasTransform && 'transform' in c) {
			c.transform = retimed(motion.intrinsic.transform, motion) as never;
			done.push('motion');
		}
		const opacity = first((s) => s.intrinsic.opacity);
		if (attrs.opacity && opacity && 'opacity' in c) {
			c.opacity = retimed(opacity.intrinsic.opacity, opacity) as never;
			if ('blendMode' in c && opacity.intrinsic.blendMode) c.blendMode = opacity.intrinsic.blendMode;
			done.push('opacity');
		}
		const volume = first((s) => s.intrinsic.volumeDb);
		if (attrs.volume && volume && 'volumeDb' in c) {
			c.volumeDb = retimed(volume.intrinsic.volumeDb, volume) as never;
			done.push('volume');
		}
		const pan = first((s) => s.intrinsic.pan);
		if (attrs.panner && pan && 'pan' in c) {
			c.pan = retimed(pan.intrinsic.pan, pan) as never;
			done.push('panner');
		}
		if (wantedFx.length && caps?.supportsEffects) {
			const list = ((c.effects as Draft<EffectInstance>[] | undefined) ??=
				[] as never) as Draft<EffectInstance>[];
			let at = Math.min(opts.index ?? list.length, list.length);
			for (const { fx, src } of wantedFx) {
				const spec =
					h.registries.effects.get(fx.effectId, fx.effectVersion) ?? h.registries.effects.get(fx.effectId);
				const medium =
					spec?.appliesTo ??
					(src.kind === 'audio' || src.kind === 'nest-audio' || src.kind === 'synthetic-audio'
						? 'audio'
						: 'video');
				if ((medium === 'audio' && !caps.audio) || (medium === 'video' && !caps.visual)) continue;
				const copy = clone(fx);
				resolver.remapEffectMedia([copy]);
				for (const a of Object.values(copy.params))
					a.keyframes = retimeKeys(a.keyframes, from(src), to, h, !!opts.scale);
				const instance: EffectInstance = spec
					? {
							id: h.ids.next('fx'),
							effectId: spec.id,
							effectVersion: spec.version,
							enabled: copy.enabled,
							params: buildParams(spec, copy.params, h),
						}
					: { ...copy, id: h.ids.next('fx') };
				dropForeignRotoRefs(c as { rotos?: { id: string }[] }, instance as never);
				list.splice(at++, 0, instance as Draft<EffectInstance>);
				done.push(`effect:${fx.id}`);
			}
		}
		for (const [flag, side] of [
			[attrs.textAnimationIn, 'in'],
			[attrs.textAnimationOut, 'out'],
		] as const) {
			const src = sources.find((s) => s.textAnimation?.[side]);
			if (!flag || !src || t.kind !== 'text') continue;
			const a = clone(src.textAnimation![side]!);
			if (fpsOf(src.rate) !== fpsOf(rate))
				a.durationFrames = scaleAnimationFrames(a.durationFrames, rate, src.rate);
			c.textAnimation = { ...((c.textAnimation as object | undefined) ?? {}), [side]: a } as never;
			done.push(`textAnimation.${side}`);
		}
		const style = first((s) => s.textStyle);
		if (attrs.textStyle && style && t.kind === 'text') {
			const s = clone(style.textStyle!) as { fontId?: string };
			if (s.fontId) s.fontId = resolver.fontId(s.fontId);
			applyClipPatch(doc, seq, t, { content: { style: s } } as never, h);
			done.push('textStyle');
		}
		const shape = first((s) => s.shape);
		if (attrs.shapeStyle && shape && t.kind === 'shape') {
			const tgt = c.shape as DRec;
			const srcShape = shape.shape!;
			tgt.fill = retimed(srcShape.fill ?? null, shape) as never;
			tgt.stroke = retimed(srcShape.stroke ?? null, shape) as never;
			if (srcShape.cornerRadius) tgt.cornerRadius = retimed(srcShape.cornerRadius, shape) as never;
			done.push('shapeStyle');
		}
		if (done.length) applied[t.id] = done;
	}
	if (Object.keys(applied).length === 0)
		h.fail('E_INVALID_PARAM', 'None of the chosen attributes applies to the target clips');
	cleanupSequence(seq, h);
	return { clipIds: Object.keys(applied), applied };
}

function pasteAttributes(doc: DDoc, cmd: CommandOf<'clip.pasteAttributes'>, h: HandlerContext): unknown {
	const p = payloadOf(cmd.payload, h, ['clips', 'effects']);
	return applyAttributes(doc, p, idList(cmd.clipIds), cmd.attributes, h, { scale: cmd.scaleTimes === true });
}

function pasteEffects(doc: DDoc, cmd: CommandOf<'effect.paste'>, h: HandlerContext): unknown {
	const p = payloadOf(cmd.payload, h, ['effects', 'clips']);
	const intrinsic = p.kind === 'effects' ? (p.effects!.intrinsic ?? {}) : {};
	return applyAttributes(
		doc,
		p,
		idList(cmd.clipIds),
		{
			effects: 'all',
			motion: !!intrinsic.transform,
			opacity: !!intrinsic.opacity,
			volume: !!intrinsic.volumeDb,
			panner: !!intrinsic.pan,
		},
		h,
		{ index: cmd.index },
	);
}

function removeAttributes(doc: DDoc, cmd: CommandOf<'clip.removeAttributes'>, h: HandlerContext): unknown {
	const { seq, clips } = h.clipsOf(doc, idList(cmd.clipIds));
	const a = cmd.attributes;
	const frame = { width: seq.settings.width, height: seq.settings.height };
	const removed: Record<string, string[]> = {};
	for (const t of clips) {
		assertUnlocked(findTrackIn(seq, t.trackId)!.track, h);
		const c = t as DRec & DClip;
		const done: string[] = [];
		if (a.motion && 'transform' in c && kindCapabilities(t.kind)?.hasTransform) {
			const box = intrinsicBoxOf({ doc: doc as never, seq: seq as never, clip: t as Clip });
			c.transform = defaultTransform(box, frame, 'none') as never;
			done.push('motion');
		}
		if (a.opacity && 'opacity' in c) {
			c.opacity = anim(100) as never;
			if ('blendMode' in c) c.blendMode = 'normal';
			done.push('opacity');
		}
		if (a.volume && 'volumeDb' in c) {
			c.volumeDb = anim(0) as never;
			done.push('volume');
		}
		if (a.panner && 'pan' in c) {
			c.pan = anim(0) as never;
			done.push('panner');
		}
		const fx = c.effects as Draft<EffectInstance>[] | undefined;
		if (a.effects?.length && fx?.some((e) => a.effects!.includes(e.effectId))) {
			c.effects = fx.filter((e) => !a.effects!.includes(e.effectId)) as never;
			done.push('effects');
		}
		const ta = c.textAnimation as Record<string, unknown> | undefined;
		for (const [flag, side] of [
			[a.textAnimationIn, 'in'],
			[a.textAnimationOut, 'out'],
		] as const) {
			if (flag && ta?.[side]) {
				ta[side] = null;
				done.push(`textAnimation.${side}`);
			}
		}
		if (done.length) removed[t.id] = done;
	}
	if (Object.keys(removed).length === 0) h.fail('E_INVALID_PARAM', 'The clips have none of these attributes');
	return { clipIds: Object.keys(removed), removed };
}

// ---------------------------------------------------------------- keyframe.paste (EC-023)

/** Parameter path of a copied keyframe track on a target clip, or null when the clip has no such parameter. */
function pathOn(clip: Clip, address: KeyframeAddress): string[] | null {
	if ('property' in address) return ['clip', clip.id, ...address.property.split('.')];
	const same = ((clip as { effects?: EffectInstance[] }).effects ?? []).filter(
		(fx) => fx.effectId === address.effectId,
	);
	const fx = same[address.occurrence] ?? same[0];
	return fx ? ['effect', fx.id, address.param] : null;
}

const normKind = (k: string) => (k === 'enum' ? 'string' : k);

function pasteKeyframes(doc: DDoc, cmd: CommandOf<'keyframe.paste'>, h: HandlerContext): unknown {
	const p = payloadOf(cmd.payload, h, ['keyframes']);
	const sec = p.keyframes!;
	const { seq, clip } = h.clip(doc, cmd.clipId);
	const resolver = new Resolver(doc, p, h);
	const pasted: string[] = [];
	const paths: string[][] = [];
	for (const track of sec.tracks) {
		const own = pathOn(clip as Clip, track.address);
		const candidates = [own, sec.tracks.length === 1 ? (cmd.target ?? null) : null].filter(
			(x): x is string[] => !!x,
		);
		let target: ReturnType<typeof resolveTarget> | null = null;
		let path: string[] | null = null;
		for (const cand of candidates) {
			// The path must name a parameter of this clip (or one of its effects) with the copied value kind.
			if (cand[0] === 'clip' && cand[1] !== clip.id) continue;
			if (
				cand[0] === 'effect' &&
				!((clip as { effects?: EffectInstance[] }).effects ?? []).some((f) => f.id === cand[1])
			)
				continue;
			let t: ReturnType<typeof resolveTarget>;
			try {
				t = resolveTarget(doc, { target: cand, sequenceId: seq.id }, h, { create: true });
			} catch {
				continue;
			}
			if (t.type !== 'anim' || normKind(t.rule.kind) !== normKind(track.paramType)) continue;
			target = t;
			path = cand;
			break;
		}
		if (target?.type !== 'anim' || !path) {
			h.warn('W_CLIP_SKIPPED', `No matching property for the copied ${track.paramType} keyframes`);
			continue;
		}
		const t0 = target.time(cmd.at);
		const dir = (clip.speed.reverse ? -1 : 1) * (sec.speed.reverse ? -1 : 1);
		const incoming = new Map<number, Keyframe<unknown>>();
		for (const k of track.keyframes) {
			const time = Math.round(t0 + ((k.time - sec.originFlicks) / sec.speed.rate) * clip.speed.rate * dir);
			if (time < 0) {
				h.warn('W_VALUE_CLAMPED', 'A pasted keyframe would fall before content time 0 and was dropped');
				continue;
			}
			let value = clone(k.value);
			const m = (value as { mediaId?: unknown } | null)?.mediaId;
			if (typeof m === 'string' && m) value = { ...(value as object), mediaId: resolver.mediaId(m) };
			const v = validateValue(value, target.rule, h, target.label);
			if (v.clamped) h.warn('W_VALUE_CLAMPED', `${target.label} clamped to ${JSON.stringify(v.value)}`);
			const hold = target.rule.holdOnly || isHoldOnlyValue(v.value);
			// Spatial paths travel with the keys onto point properties (S03 §12.5 copy/paste row).
			const spatial =
				!hold && target.rule.spatial && k.spatial && isVec2Value(v.value)
					? dir < 0
						? reversedSpatial(k.spatial)
						: clone(k.spatial)
					: undefined;
			// keyframes-blend: pasted the other way round, each segment's temporal ease is mirrored too.
			const timing =
				dir < 0
					? reversedKeyTiming(track.keyframes as readonly Keyframe<unknown>[], track.keyframes.indexOf(k))
					: k;
			incoming.set(time, {
				id: h.ids.next('kf'),
				time,
				value: v.value,
				interpolation: hold ? 'hold' : timing.interpolation,
				easeIn: { influence: timing.easeIn.influence, slope: timing.easeIn.slope },
				easeOut: { influence: timing.easeOut.influence, slope: timing.easeOut.slope },
				...(spatial ? { spatial } : {}),
				...(k.roving ? { roving: true } : {}),
			});
		}
		if (incoming.size === 0) continue;
		// A pasted key replaces a key at the same time (S01:KF-002).
		const merged = [
			...(target.anim.keyframes as Keyframe<unknown>[]).filter((k) => !incoming.has(k.time)).map(clone),
			...incoming.values(),
		].sort((a, b) => a.time - b.time);
		target.anim.keyframes = merged as never;
		refreshAutoTangents(target.anim.keyframes as Keyframe<unknown>[]);
		// keyframes-blend: roving keys sit where the motion passes them.
		retimeRoving(target.anim.keyframes as Keyframe<unknown>[]);
		refreshAutoBezier(target.anim);
		(target.anim as { [PRUNE_EMPTY_KEYFRAMES]?: () => void })[PRUNE_EMPTY_KEYFRAMES]?.();
		pasted.push(...[...incoming.values()].map((k) => k.id));
		paths.push(path);
	}
	if (pasted.length === 0)
		h.fail('E_INVALID_PARAM', 'The clip has no property matching the copied keyframes', { path: ['target'] });
	return { keyframeIds: pasted, paths };
}

// ---------------------------------------------------------------- project.pasteItems (CLB-007)

/** A deep copy of a sequence under `newId`: every entity gets a new id, references inside it are remapped. */
function copySequence(
	src: Sequence,
	newId: string,
	resolver: Resolver,
	nestMap: ReadonlyMap<string, string>,
	h: HandlerContext,
): Sequence {
	const seq = clone(src) as Sequence & Record<string, unknown>;
	seq.id = newId;
	const trackMap = new Map<string, string>();
	for (const t of [...seq.videoTracks, ...seq.audioTracks, ...seq.captionTracks]) {
		const id = h.ids.next('trk');
		trackMap.set(t.id, id);
		t.id = id;
		reidentifyClipChildren(t as never, h);
		resolver.remapEffectMedia(t.effects);
		if (t.styleDefaults?.fontId) t.styleDefaults.fontId = resolver.fontId(t.styleDefaults.fontId);
	}
	reidentifyClipChildren(seq.master as never, h);
	resolver.remapEffectMedia(seq.master.effects);
	// wp-multicam: a multi-camera source's angles name its tracks (angle ids stay: clips select them).
	const mc = seq.multicam;
	if (mc)
		for (const a of mc.angles) {
			if (a.videoTrackId !== null) a.videoTrackId = trackMap.get(a.videoTrackId) ?? a.videoTrackId;
			a.audioTrackIds = a.audioTrackIds.map((id) => trackMap.get(id) ?? id);
		}
	for (const m of seq.markers) m.id = h.ids.next('mrk');
	const clipMap = new Map<string, string>();
	const trackerMaps = new Map<string, Map<string, string>>();
	const clips: Record<string, Clip> = {};
	for (const c of Object.values(seq.clips)) {
		const copy = c as Clip & Record<string, unknown>;
		const before = ((copy.trackers as { id: string }[] | undefined) ?? []).map((t) => t.id);
		reidentifyClipChildren(copy, h);
		const after = ((copy.trackers as { id: string }[] | undefined) ?? []).map((t) => t.id);
		const id = h.ids.next('clp');
		clipMap.set(c.id, id);
		trackerMaps.set(id, new Map(before.map((x, k) => [x, after[k]!])));
		if (!resolver.remapClip(copy, nestMap)) {
			h.warn('W_CLIP_SKIPPED', `Nested sequence clip ${c.id} was skipped: its sequence is not available`);
			clipMap.delete(c.id);
			continue;
		}
		clips[id] = { ...copy, id, trackId: trackMap.get(c.trackId) ?? c.trackId } as Clip;
	}
	for (const c of Object.values(clips)) {
		const r = c as Clip & { trackedBy?: { clipId: string; trackerId: string } };
		if (!r.trackedBy) continue;
		const target = clipMap.get(r.trackedBy.clipId);
		const tracker = target ? trackerMaps.get(target)?.get(r.trackedBy.trackerId) : undefined;
		if (target && tracker) r.trackedBy = { ...r.trackedBy, clipId: target, trackerId: tracker };
		else delete r.trackedBy;
	}
	seq.clips = clips;
	const regroup = (table: Record<string, { id: string; members: string[] }>, prefix: 'lnk' | 'grp') => {
		const out: Record<string, { id: string; members: string[] }> = {};
		const field = prefix === 'lnk' ? 'linkId' : 'groupId';
		for (const g of Object.values(table)) {
			const members = g.members.map((m) => clipMap.get(m)).filter((m): m is string => !!m && !!clips[m]);
			if (members.length < 2) continue;
			const id = h.ids.next(prefix);
			for (const m of members) (clips[m] as Record<string, unknown>)[field] = id;
			out[id] = { id, members };
		}
		for (const c of Object.values(clips)) {
			const v = (c as Record<string, unknown>)[field] as string | null;
			if (v && !Object.values(out).some((g) => g.members.includes(c.id)))
				(c as Record<string, unknown>)[field] = null;
		}
		return out;
	};
	seq.links = regroup(seq.links, 'lnk');
	seq.groups = regroup(seq.groups, 'grp');
	const transitions: Sequence['transitions'] = {};
	for (const t of Object.values(seq.transitions)) {
		const out = t.outgoingClipId ? clipMap.get(t.outgoingClipId) : null;
		const inc = t.incomingClipId ? clipMap.get(t.incomingClipId) : null;
		if ((t.outgoingClipId && !out) || (t.incomingClipId && !inc)) continue;
		const id = h.ids.next('trn');
		transitions[id] = {
			...t,
			id,
			trackId: trackMap.get(t.trackId) ?? t.trackId,
			outgoingClipId: out ?? null,
			incomingClipId: inc ?? null,
		};
	}
	seq.transitions = transitions;
	return seq;
}

function pasteItems(doc: DDoc, cmd: CommandOf<'project.pasteItems'>, h: HandlerContext): unknown {
	const p = payloadOf(cmd.payload, h, ['project-items']);
	return insertProjectItems(doc, p, cmd.binId, cmd.index, h);
}

/**
 * Adds a validated `project-items` payload to the project (CLB-007): bins, items, deep-copied sequences and every
 * referenced entity, all with new ids. Shared by Paste and the interchange import (`project.importTimeline`).
 */
export function insertProjectItems(
	doc: DDoc,
	p: ClipboardPayload,
	targetBin: string | null | undefined,
	targetIndex: number | undefined,
	h: HandlerContext,
): {
	itemIds: string[];
	map: Record<string, string>;
	sequenceIds: string[];
	sequenceMap: Record<string, string>;
	createdMedia: string[];
	reusedMedia: string[];
} {
	const cmd = { binId: targetBin, index: targetIndex };
	const sec = p.items!;
	assertBin(doc, cmd.binId, h);
	const binId = cmd.binId ?? null;
	const byId = new Map(sec.items.map((it) => [it.id, it]));
	const itemMedia = new Set(
		sec.items.filter((it) => it.kind === 'media').map((it) => (it as { mediaId: string }).mediaId),
	);
	const resolver = new Resolver(doc, p, h, { binId, noItemFor: itemMedia });
	// Sequences first get their new ids, so nest clips inside them can point at the copies.
	const nestMap = new Map<string, string>();
	for (const s of sec.sequences) nestMap.set(s.id, h.ids.next('seq'));
	const sequenceIds: string[] = [];
	for (const s of sec.sequences) {
		const id = nestMap.get(s.id)!;
		doc.sequences[id] = copySequence(s, id, resolver, nestMap, h) as never;
		sequenceIds.push(id);
	}
	const itemMap: Record<string, string> = {};
	const copyItem = (srcId: string): string | null => {
		const it = byId.get(srcId);
		if (!it) return null;
		const base = clone(it) as ProjectItem & Record<string, unknown>;
		let item: ProjectItem;
		if (it.kind === 'bin') {
			const id = h.ids.next('bin');
			itemMap[srcId] = id;
			const children = it.children.map(copyItem).filter((c): c is string => !!c);
			item = { ...base, id, children } as ProjectItem;
		} else {
			const id = h.ids.next('itm');
			itemMap[srcId] = id;
			if (it.kind === 'media') item = { ...base, id, mediaId: resolver.mediaId(it.mediaId) } as ProjectItem;
			else if (it.kind === 'synthetic')
				item = { ...base, id, syntheticId: resolver.syntheticId(it.syntheticId) } as ProjectItem;
			else if (it.kind === 'sequence') {
				const s = nestMap.get(it.sequenceId);
				if (!s) {
					h.warn(
						'W_CLIP_SKIPPED',
						`Sequence item ${it.name} was skipped: its sequence is not in the clipboard`,
					);
					delete itemMap[srcId];
					return null;
				}
				item = { ...base, id, sequenceId: s } as ProjectItem;
			} else item = { ...base, id } as ProjectItem;
		}
		doc.items[item.id] = item as never;
		return item.id;
	};
	const roots = sec.rootItems.map(copyItem).filter((id): id is string => !!id);
	let index = cmd.index;
	for (const id of roots) {
		insertItem(doc, id, binId, index);
		if (index !== undefined) index++;
	}
	// Every pasted sequence needs exactly one item (INV-008); one without (malformed payload) gets one.
	for (const [src, id] of nestMap) {
		if (Object.values(doc.items).some((it) => it.kind === 'sequence' && it.sequenceId === id)) continue;
		const itemId = h.ids.next('itm');
		doc.items[itemId] = {
			id: itemId,
			kind: 'sequence',
			name: `Sequence ${src.slice(-4)}`,
			sequenceId: id,
			label: 'forest',
		};
		insertItem(doc, itemId, binId);
		roots.push(itemId);
	}
	if (roots.length === 0)
		h.fail('E_INVALID_PARAM', 'Nothing in the clipboard can be pasted into the project');
	return {
		itemIds: roots,
		map: itemMap,
		sequenceIds,
		sequenceMap: Object.fromEntries(nestMap),
		createdMedia: resolver.createdMedia,
		reusedMedia: [...new Set(resolver.reusedMedia)],
	};
}

export const clipboardHandlers: HandlerMap = {
	'clip.paste': pasteClips,
	'clip.pasteAttributes': pasteAttributes,
	'clip.removeAttributes': removeAttributes,
	'effect.paste': pasteEffects,
	'keyframe.paste': pasteKeyframes,
	'project.pasteItems': pasteItems,
};
