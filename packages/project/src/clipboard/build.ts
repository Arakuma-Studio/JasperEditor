// Building clipboard payloads from the committed document (S01:CLB-001, SES-007): clips with their linked
// partners and the transitions between them, effects, keyframes, or project items, plus every entity they
// reference (media closed over derivation sources and font files, synthetics, transcripts, fonts).
// Pure: callers pass the committed document; nothing here reads session state.

import { PROPERTY_SPECS } from '../registry/properties.ts';
import type { Animatable, Keyframe } from '../schema/common.ts';
import type { ProjectDocument, ProjectItem } from '../schema/document.ts';
import type { FontRef, MediaAsset, SyntheticSource, Transcript } from '../schema/media.ts';
import type { Clip, EffectInstance, Sequence, TrackKind } from '../schema/sequence.ts';
import { isKnownClipKind } from '../schema/sequence.ts';
import {
	CLIPBOARD_FORMAT,
	CLIPBOARD_VERSION,
	type ClipboardPayload,
	type IntrinsicAttributes,
	type KeyframeAddress,
	type KeyframeTrack,
} from './payload.ts';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function getAt(obj: unknown, path: readonly string[]): unknown {
	let cur = obj;
	for (const k of path) {
		if (!cur || typeof cur !== 'object') return undefined;
		cur = (cur as Record<string, unknown>)[k];
	}
	return cur;
}

export type References = {
	media: Set<string>;
	synthetics: Set<string>;
	transcripts: Set<string>;
	fonts: Set<string>;
	/** Sequences referenced by nest clips. */
	sequences: Set<string>;
};

export const emptyReferences = (): References => ({
	media: new Set(),
	synthetics: new Set(),
	transcripts: new Set(),
	fonts: new Set(),
	sequences: new Set(),
});

/** `{mediaId}` param values (LUTs, image refs; `''` = None) of an effect stack, keyframes included. */
export function effectMediaIds(effects: readonly EffectInstance[] | undefined): string[] {
	const out: string[] = [];
	const visit = (v: unknown) => {
		const m = (v as { mediaId?: unknown } | null)?.mediaId;
		if (v && typeof v === 'object' && !Array.isArray(v) && typeof m === 'string' && m) out.push(m);
	};
	for (const fx of effects ?? [])
		for (const a of Object.values(fx.params)) {
			visit(a.value);
			for (const k of a.keyframes) visit(k.value);
		}
	return out;
}

/** Font ids of a text style (and its runs) or a caption style. */
function styleFonts(r: Record<string, unknown>): string[] {
	const out: string[] = [];
	const content = r.content as
		| { style?: { fontId?: string }; runs?: { style?: { fontId?: string } }[] }
		| undefined;
	if (content?.style?.fontId) out.push(content.style.fontId);
	for (const run of content?.runs ?? []) if (run.style?.fontId) out.push(run.style.fontId);
	const style = r.style as { fontId?: string } | undefined;
	if (style?.fontId) out.push(style.fontId);
	return out;
}

/** Records the entities one clip references. */
export function collectClipReferences(clip: Clip, refs: References): void {
	const r = clip as Record<string, unknown>;
	if (typeof r.mediaId === 'string') refs.media.add(r.mediaId);
	const comp = r.composition as { mediaId?: unknown } | undefined;
	if (typeof comp?.mediaId === 'string') refs.media.add(comp.mediaId);
	if (typeof r.syntheticId === 'string') refs.synthetics.add(r.syntheticId);
	if (typeof r.transcriptId === 'string') refs.transcripts.add(r.transcriptId);
	if (typeof r.sequenceId === 'string' && isKnownClipKind(clip.kind)) refs.sequences.add(r.sequenceId);
	for (const f of styleFonts(r)) refs.fonts.add(f);
	for (const m of effectMediaIds(r.effects as EffectInstance[] | undefined)) refs.media.add(m);
}

function collectSequenceReferences(seq: Sequence, refs: References): void {
	for (const c of Object.values(seq.clips)) collectClipReferences(c, refs);
	for (const t of [...seq.videoTracks, ...seq.audioTracks, ...seq.captionTracks]) {
		for (const m of effectMediaIds(t.effects)) refs.media.add(m);
		if (t.styleDefaults?.fontId) refs.fonts.add(t.styleDefaults.fontId);
	}
	for (const m of effectMediaIds(seq.master.effects)) refs.media.add(m);
}

/**
 * The entities to ship for `refs`: media closed over derivation sources and font files (sources first, so a paste
 * can add them in order), and the referenced synthetics, transcripts and fonts that exist in `doc`.
 */
export function packReferences(
	doc: ProjectDocument,
	refs: References,
): Pick<ClipboardPayload, 'media' | 'synthetics' | 'transcripts' | 'fonts' | 'mediaItems'> {
	const fonts: FontRef[] = [];
	for (const id of refs.fonts) {
		const f = doc.fonts[id];
		if (!f) continue;
		fonts.push(clone(f));
		if (f.source.type === 'asset') refs.media.add(f.source.mediaId);
	}
	const transcripts: Transcript[] = [];
	for (const id of refs.transcripts) {
		const t = doc.transcripts[id];
		if (t) transcripts.push(clone(t));
	}
	const synthetics: SyntheticSource[] = [];
	for (const id of refs.synthetics) {
		const s = doc.synthetics[id];
		if (s) synthetics.push(clone(s));
	}
	const media: MediaAsset[] = [];
	const done = new Set<string>();
	const add = (id: string, stack: Set<string>) => {
		const m = doc.media[id];
		if (!m || done.has(id) || stack.has(id)) return;
		stack.add(id);
		if (m.derivation) add(m.derivation.fromMediaId, stack);
		stack.delete(id);
		done.add(id);
		media.push(clone(m));
	};
	for (const id of refs.media) add(id, new Set());
	const mediaItems: NonNullable<ClipboardPayload['mediaItems']> = {};
	for (const it of Object.values(doc.items))
		if (it.kind === 'media' && done.has(it.mediaId) && !mediaItems[it.mediaId])
			mediaItems[it.mediaId] = { name: it.name, label: it.label };
	return { media, synthetics, transcripts, fonts, ...(Object.keys(mediaItems).length ? { mediaItems } : {}) };
}

function header(
	doc: ProjectDocument,
	kind: ClipboardPayload['kind'],
	sequenceId: string | null,
	now?: string,
) {
	return {
		format: CLIPBOARD_FORMAT,
		version: CLIPBOARD_VERSION,
		sourceProjectId: doc.projectId,
		sourceSequenceId: sequenceId,
		kind,
		...(now ? { createdAt: now } : {}),
	} as const;
}

function trackIndex(seq: Sequence, trackId: string): { kind: TrackKind; index: number } | null {
	for (const [kind, list] of [
		['video', seq.videoTracks],
		['audio', seq.audioTracks],
		['caption', seq.captionTracks],
	] as const) {
		const index = list.findIndex((t) => t.id === trackId);
		if (index >= 0) return { kind, index };
	}
	return null;
}

// ---------------------------------------------------------------- clips (CLB-001)

/**
 * Copies clips of one sequence with their linked partners (unless `linked: false`), the transitions whose clips
 * are all copied (fades of a copied clip included), and the layout relative to the earliest clip and the lowest
 * copied track of each kind.
 */
export function buildClipsPayload(
	doc: ProjectDocument,
	sequenceId: string,
	clipIds: readonly string[],
	opts: { linked?: boolean; primaryClipId?: string | null; now?: string } = {},
): ClipboardPayload {
	const seq = doc.sequences[sequenceId];
	if (!seq) throw new Error(`Sequence not found: ${sequenceId}`);
	const set = new Set(clipIds.filter((id) => seq.clips[id]));
	if (opts.linked !== false)
		for (const id of [...set]) {
			const l = seq.clips[id]!.linkId;
			for (const m of (l && seq.links[l]?.members) || []) if (seq.clips[m]) set.add(m);
		}
	if (set.size === 0) throw new Error('No clips to copy');
	const clips = [...set].map((id) => clone(seq.clips[id]!)).sort((a, b) => a.start - b.start);
	const transitions = Object.values(seq.transitions)
		.filter(
			(t) =>
				(t.outgoingClipId || t.incomingClipId) &&
				(!t.outgoingClipId || set.has(t.outgoingClipId)) &&
				(!t.incomingClipId || set.has(t.incomingClipId)),
		)
		.map(clone);
	const trackKinds: Record<string, TrackKind> = {};
	const indices: Record<string, number> = {};
	const lowest: Partial<Record<TrackKind, number>> = {};
	for (const c of clips) {
		const t = trackIndex(seq, c.trackId);
		if (!t) continue;
		trackKinds[c.trackId] = t.kind;
		indices[c.trackId] = t.index;
		lowest[t.kind] = Math.min(lowest[t.kind] ?? t.index, t.index);
	}
	const trackOffsets: Record<string, number> = {};
	for (const [id, kind] of Object.entries(trackKinds)) trackOffsets[id] = indices[id]! - lowest[kind]!;
	const refs = emptyReferences();
	for (const c of clips) collectClipReferences(c, refs);
	const primary = opts.primaryClipId && set.has(opts.primaryClipId) ? opts.primaryClipId : null;
	return {
		...header(doc, 'clips', seq.id, opts.now),
		clips: {
			clips,
			transitions,
			originFrame: Math.min(...clips.map((c) => c.start)),
			trackOffsets,
			trackKinds,
			frameRate: { ...seq.settings.frameRate },
			primaryClipId: primary,
		},
		...packReferences(doc, refs),
	};
}

// ---------------------------------------------------------------- effects (CLB-006, S03:EC-032)

function findClip(doc: ProjectDocument, clipId: string): { seq: Sequence; clip: Clip } {
	for (const seq of Object.values(doc.sequences)) {
		const clip = seq.clips[clipId];
		if (clip) return { seq, clip };
	}
	throw new Error(`Clip not found: ${clipId}`);
}

/** The intrinsic attributes a clip has (Motion, Opacity + blend mode, Volume, Panner). */
export function intrinsicOf(clip: Clip): IntrinsicAttributes {
	const r = clip as Record<string, unknown>;
	const out: IntrinsicAttributes = {};
	if (r.transform) out.transform = clone(r.transform as IntrinsicAttributes['transform'])!;
	if (r.opacity) out.opacity = clone(r.opacity as Animatable<number>);
	if (typeof r.blendMode === 'string') out.blendMode = r.blendMode as IntrinsicAttributes['blendMode'];
	if (r.volumeDb) out.volumeDb = clone(r.volumeDb as Animatable<number>);
	if (r.pan) out.pan = clone(r.pan as Animatable<number>);
	return out;
}

/**
 * Copies effects of one clip: `effectIds` (in stack order; default every applied effect) and, with
 * `intrinsic`, its Motion / Opacity / Volume / Panner values.
 */
export function buildEffectsPayload(
	doc: ProjectDocument,
	clipId: string,
	opts: { effectIds?: readonly string[]; intrinsic?: boolean; now?: string } = {},
): ClipboardPayload {
	const { seq, clip } = findClip(doc, clipId);
	const all = ((clip as { effects?: EffectInstance[] }).effects ?? []) as EffectInstance[];
	const effects = (opts.effectIds ? all.filter((fx) => opts.effectIds!.includes(fx.id)) : all).map(clone);
	const refs = emptyReferences();
	for (const m of effectMediaIds(effects)) refs.media.add(m);
	return {
		...header(doc, 'effects', seq.id, opts.now),
		effects: {
			effects,
			...(opts.intrinsic ? { intrinsic: intrinsicOf(clip) } : {}),
			source: {
				clipKind: clip.kind,
				timing: {
					start: clip.start,
					duration: clip.duration,
					sourceIn: clip.sourceIn,
					speed: { rate: clip.speed.rate, reverse: clip.speed.reverse },
				},
				frameRate: { ...seq.settings.frameRate },
			},
		},
		...packReferences(doc, refs),
	};
}

// ---------------------------------------------------------------- keyframes (S03:EC-023)

/** Value kind of a parameter value, as keyframe pastes compare it (`enum` and `string` are both `string`). */
function valueKindOf(v: unknown): string {
	if (typeof v === 'number') return 'number';
	if (typeof v === 'boolean') return 'boolean';
	if (typeof v === 'string') return 'string';
	if (Array.isArray(v)) return v.length === 2 ? 'vec2' : v.length === 4 ? 'color' : 'json';
	if (v && typeof v === 'object') {
		if (Array.isArray((v as { curve?: unknown }).curve)) return 'curve';
		if (typeof (v as { mediaId?: unknown }).mediaId === 'string') return 'media';
	}
	return 'json';
}

/** Every keyframed parameter of a clip with its clipboard address. */
function clipKeyframeTracks(clip: Clip): { address: KeyframeAddress; anim: Animatable<unknown> }[] {
	const out: { address: KeyframeAddress; anim: Animatable<unknown> }[] = [];
	const isAnim = (v: unknown): v is Animatable<unknown> =>
		!!v && typeof v === 'object' && 'value' in v && Array.isArray((v as { keyframes?: unknown }).keyframes);
	if (isKnownClipKind(clip.kind)) {
		for (const s of PROPERTY_SPECS) {
			if (s.animatable === 'no' || s.storagePath[0]!.startsWith('$') || !s.appliesTo(clip)) continue;
			const a = getAt(clip, s.storagePath);
			if (isAnim(a) && a.keyframes.length) out.push({ address: { property: s.key }, anim: a });
		}
	}
	const seen = new Map<string, number>();
	for (const fx of (clip as { effects?: EffectInstance[] }).effects ?? []) {
		const occurrence = seen.get(fx.effectId) ?? 0;
		seen.set(fx.effectId, occurrence + 1);
		for (const [param, a] of Object.entries(fx.params))
			if (a.keyframes.length)
				out.push({ address: { effectId: fx.effectId, occurrence, param }, anim: a as Animatable<unknown> });
	}
	if (clip.kind === 'motion-graphic') {
		const mg = clip as {
			params: Record<string, unknown>;
			paramKeyframes?: Record<string, Keyframe<unknown>[]>;
		};
		for (const [name, keyframes] of Object.entries(mg.paramKeyframes ?? {}))
			if (keyframes.length)
				out.push({ address: { property: `params.${name}` }, anim: { value: mg.params[name], keyframes } });
	}
	return out;
}

/** Copies keyframes of one clip by id; the earliest copied key is the origin pasted at the playhead. */
export function buildKeyframesPayload(
	doc: ProjectDocument,
	clipId: string,
	keyframeIds: readonly string[],
	opts: { now?: string } = {},
): ClipboardPayload {
	const { seq, clip } = findClip(doc, clipId);
	const want = new Set(keyframeIds);
	const tracks: KeyframeTrack[] = [];
	for (const { address, anim } of clipKeyframeTracks(clip)) {
		const keys = anim.keyframes.filter((k) => want.has(k.id)).map(clone);
		if (keys.length) tracks.push({ address, paramType: valueKindOf(anim.value), keyframes: keys });
	}
	if (tracks.length === 0) throw new Error('No keyframes to copy');
	const refs = emptyReferences();
	for (const t of tracks)
		for (const k of t.keyframes) {
			const m = (k.value as { mediaId?: unknown } | null)?.mediaId;
			if (typeof m === 'string' && m) refs.media.add(m);
		}
	return {
		...header(doc, 'keyframes', seq.id, opts.now),
		keyframes: {
			paramType: tracks[0]!.paramType,
			keyframes: tracks[0]!.keyframes,
			originFlicks: Math.min(...tracks.flatMap((t) => t.keyframes.map((k) => k.time))),
			tracks,
			speed: { rate: clip.speed.rate, reverse: clip.speed.reverse },
		},
		...packReferences(doc, refs),
	};
}

// ---------------------------------------------------------------- project items (CLB-007)

/**
 * Copies project items: bins with all their descendants, the sequences of sequence items (and the sequences
 * nested in them, whose items come along as extra top-level items), and everything those reference.
 */
export function buildItemsPayload(
	doc: ProjectDocument,
	itemIds: readonly string[],
	opts: { now?: string } = {},
): ClipboardPayload {
	const selected = itemIds.filter((id) => doc.items[id]);
	const inside = new Set<string>();
	const descend = (id: string) => {
		const it = doc.items[id];
		if (it?.kind !== 'bin') return;
		for (const c of it.children) {
			inside.add(c);
			descend(c);
		}
	};
	for (const id of selected) descend(id);
	const rootItems = selected.filter((id, i) => !inside.has(id) && selected.indexOf(id) === i);
	if (rootItems.length === 0) throw new Error('No project items to copy');
	const items = new Map<string, ProjectItem>();
	const addTree = (id: string) => {
		const it = doc.items[id];
		if (!it || items.has(id)) return;
		items.set(id, clone(it));
		if (it.kind === 'bin') for (const c of it.children) addTree(c);
	};
	for (const id of rootItems) addTree(id);
	const refs = emptyReferences();
	const sequences = new Map<string, Sequence>();
	const addSequence = (seqId: string) => {
		const seq = doc.sequences[seqId];
		if (!seq || sequences.has(seqId)) return;
		sequences.set(seqId, clone(seq));
		const nested = emptyReferences();
		collectSequenceReferences(seq, nested);
		for (const k of ['media', 'synthetics', 'transcripts', 'fonts'] as const)
			for (const id of nested[k]) refs[k].add(id);
		for (const s of nested.sequences) {
			// A nested sequence travels with its project item (INV-008: one item per sequence).
			if (![...items.values()].some((it) => it.kind === 'sequence' && it.sequenceId === s)) {
				const item = Object.values(doc.items).find((it) => it.kind === 'sequence' && it.sequenceId === s);
				if (item) {
					items.set(item.id, clone(item));
					rootItems.push(item.id);
				}
			}
			addSequence(s);
		}
	};
	for (const it of [...items.values()]) {
		if (it.kind === 'media') refs.media.add(it.mediaId);
		else if (it.kind === 'synthetic') refs.synthetics.add(it.syntheticId);
		else if (it.kind === 'sequence') addSequence(it.sequenceId);
	}
	return {
		...header(doc, 'project-items', null, opts.now),
		items: { items: [...items.values()], sequences: [...sequences.values()], rootItems },
		...packReferences(doc, refs),
	};
}
