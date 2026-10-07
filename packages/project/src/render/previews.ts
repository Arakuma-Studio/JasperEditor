// Render previews (workstream `previews`): render-bar segments, their content hashes and the playback cost estimate.
//
// # Segments
// A sequence's picture is cut at every edge of everything drawn on a shown track: clips (and their transition
// handles), dip mattes, GPU transition spans, the clips of hidden Track Matte tracks, cameras and lights. Between two
// cuts the set of visible layers is constant. Each such stretch with at least one layer is a `RenderPreviewSegment`; gaps
// give no segment. Audio is cut the same way at audio clip and crossfade edges (`audioPreviewSegments`).
//
// # The invalidation contract (what the content hash covers)
// The hash is a pure function of the **render snapshot** (`buildRenderSnapshot`) restricted to the segment, normalised:
// the snapshot is exactly what every renderer consumes (Program monitor, stills, native / hybrid / Remotion exports),
// so every feature that changes pixels is covered without being listed here — nests and multicam (the nested
// snapshot), masks and Track Matte Keys (matte tracks are in the snapshot), adjustment layers (every lower track of the
// segment is in it), time remapping and retiming, 3D layers, cameras and lights (`scene3d`), roto mattes (by their
// cache key), captions (caption tracks with clip-relative pages), Lottie / vector / interpreted media (the media
// handle), LUT and image params (media handles), fonts, motion-graphic templates and bundles.
//
// Normalisation, and why each step is safe:
//  1. **Times relative to the segment start.** Every field that holds an absolute sequence frame (clip `start`,
//     fades, mattes, transition spans, rigs) is rebased to the segment's first frame, so a ripple that moves a stretch
//     of the timeline keeps its hashes — and its previews. Keyframes are in clip content time already. Fields whose
//     time base is not known to be relative are hashed verbatim: a new absolute field can only cause extra
//     invalidation, never a stale preview. (Audio: sequence-time automation — track faders, the Mix, bus strips — is
//     rebased the same way.)
//  2. **Identifiers.** Clip, track, transition and matte ids are replaced by their order of appearance in the segment
//     (references to them — transition sides, Track Matte params, Layer Controls — follow), so razoring a plain clip
//     (the right piece gets a new id) or a through edit keeps the preview. **Except where an id seeds pixels:** fx
//     random seeds (`fxSeed(clipId, fxId)`), Dissolve blending, text animators, shapes and templates hash their clip
//     and effect ids (`§seed`), because the renderers derive noise from them.
//  3. **Names, labels, markers, link and group membership** never reach the snapshot, except the clip name, which
//     effects may print (Clip Name burn-ins): it is kept for clips with effects.
//  4. **Media by content**: engine key, fingerprint, probe size / duration / rate, source range and interpretation —
//     never a URL. A relinked file with another fingerprint invalidates; proxies never do (previews are full size).
//  5. **Expressions.** A segment with an active expression anywhere in its layers (nested ones included) also hashes
//     the whole expression world (every sequence, every name, the solids), its own raw ids and names, and its
//     absolute start frame: an expression may read any layer, marker or name and `time` is sequence time, so a
//     ripple or an edit anywhere invalidates exactly those segments. Segments without expressions are not affected
//     by expressions elsewhere.
//  6. **Things outside the document** — the renderer build, the effect shaders — are not in the hash: the engine
//     keeps preview files per renderer version (`previews/<rendererKey>/<hash>.*`), so an update never shows stale
//     files.
//
// # Cost estimate (yellow vs red, estimated ≈)
// `costMs` estimates what one frame costs the Program monitor's browser path at sequence size: decode by codec and
// pixel count, the layer path (DOM/CSS vs canvas/WebGL), per-effect tiers (`EffectSpec.capabilities`, `expensive`),
// masks, GL blend scopes, adjustment captures, 3D runs, retiming and transitions. A segment is **red** above the
// frame duration × `REALTIME_BUDGET`, has **no bar** when it is one untouched clip of browser-decodable media at the
// sequence's size and rate, and is **yellow** otherwise. Green (a preview exists) is the engine's answer.
//
// Port: the segment cuts, the relative content hash and the cost-model structure follow FilmCraft
// `crates/render/src/preview.rs` (MIT OR Apache-2.0, see licenses/ported/previews.md).

import { isCssBlend } from '../blend-modes.ts';
import { canonicalJson } from '../color/runs.ts';
import { defaultEffectRegistry, type EffectRegistry } from '../registry/effects.ts';
import type { Animatable, RGBA } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { FontRef, MediaAsset } from '../schema/media.ts';
import { flicksPerFrame, type Rational } from '../time.ts';
import {
	buildRenderSnapshot,
	type MediaHandle,
	type RenderAudioClip,
	type RenderSnapshot,
	type RenderVisualClip,
} from './snapshot.ts';

/** Bump when the hash layout changes (every preview becomes invalid). */
export const PREVIEW_HASH_VERSION = 'jasper-preview-v1';

/**
 * Multiple of the frame duration one frame may cost before a segment is red. The browser Player renders a frame on
 * the main thread and its decoders run ahead in parallel, so the budget is one frame period.
 */
export const REALTIME_BUDGET = 1;

const HD_PIXELS = 1920 * 1080;

/** How a segment plays without a preview. */
export type PreviewNeed = 'none' | 'realtime' | 'render';

export type RenderPreviewSegment = {
	/** First sequence frame and length in frames. */
	startFrame: number;
	frames: number;
	/** Content hash (32 hex digits): the preview file's name. */
	hash: string;
	need: PreviewNeed;
	/** Estimated per-frame cost of live playback (ms, ≈). */
	costMs: number;
	/** The red threshold for this sequence's rate (ms). */
	budgetMs: number;
	/** Clips drawn in the segment (both sides of transitions; nested clips are not listed). */
	clipIds: string[];
	/** The hash includes the absolute position (expressions): moving the segment invalidates it. */
	absolute: boolean;
	/** Why the segment is not 'none' (the largest cost contributors first), for tooltips and agents. */
	reasons: string[];
};

export type RenderAudioPreviewSegment = {
	startFrame: number;
	frames: number;
	hash: string;
	clipIds: string[];
};

// ---------------------------------------------------------------- hashing

/**
 * A 128-bit non-cryptographic hash of a string as 32 hex digits: four 32-bit multiply-xorshift lanes with a final
 * avalanche (the `cyrb128` construction, public domain). Deterministic across runtimes (integer maths only).
 */
export function hash128(text: string): string {
	let h1 = 1779033703;
	let h2 = 3144134277;
	let h3 = 1013904242;
	let h4 = 2773480762;
	for (let i = 0; i < text.length; i++) {
		const k = text.charCodeAt(i);
		h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
		h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
		h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
		h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
	}
	h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
	h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
	h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
	h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
	h1 ^= h2 ^ h3 ^ h4;
	h2 ^= h1;
	h3 ^= h1;
	h4 ^= h1;
	const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
	return hex(h1) + hex(h2) + hex(h3) + hex(h4);
}

/** Whether `s` is a preview hash (file names are validated with it). */
export function isPreviewHash(s: string): boolean {
	return /^[0-9a-f]{32}$/.test(s);
}

// ---------------------------------------------------------------- the snapshot the hashes are computed from

/** The content identity of a media asset (what the preview hash sees instead of a URL). */
export function previewMediaIdentity(asset: MediaAsset): string {
	const key = asset.locators.find((l) => l.type === 'engine-store') as { key?: string } | undefined;
	const v = asset.probe.streams.find((s) => s.type === 'video');
	return canonicalJson([
		key?.key ?? null,
		asset.fingerprint ?? null,
		asset.probe.durationFlicks ?? null,
		asset.sourceRange ?? null,
		v && v.type === 'video' ? [v.codec, v.width, v.height, v.frameRate] : null,
	]);
}

function hashMediaHandle(asset: MediaAsset): MediaHandle {
	const v = asset.probe.streams.find((s) => s.type === 'video');
	return {
		url: `content:${hash128(previewMediaIdentity(asset))}`,
		proxyUrl: null,
		kind: asset.kind,
		width: v?.type === 'video' ? v.width : null,
		height: v?.type === 'video' ? v.height : null,
		durationFlicks: asset.probe.durationFlicks ?? null,
		hasAudio: asset.probe.streams.some((s) => s.type === 'audio'),
		rotation: ((v?.type === 'video' ? (v as { rotation?: number }).rotation : 0) ??
			0) as MediaHandle['rotation'],
		...(asset.probe.hasAlpha ? { alpha: true } : {}),
	};
}

function hashFontUrl(font: FontRef, weight: number, italic: boolean): string {
	return `font:${hash128(canonicalJson([font.family, font.source, weight, italic]))}`;
}

const snapshotMemo = new WeakMap<object, Map<string, RenderSnapshot>>();

/**
 * The whole-sequence render snapshot the hashes are computed from: media and fonts resolve to content identities,
 * roto mattes to their cache keys, burned-in caption tracks as the Program monitor shows them. Memoized per
 * document object.
 */
export function previewSnapshot(doc: ProjectDocument, sequenceId: string): RenderSnapshot {
	let bySeq = snapshotMemo.get(doc);
	if (!bySeq) {
		bySeq = new Map();
		snapshotMemo.set(doc, bySeq);
	}
	const hit = bySeq.get(sequenceId);
	if (hit) return hit;
	const snap = buildRenderSnapshot(doc, sequenceId, {
		resolveMedia: hashMediaHandle,
		resolveFont: hashFontUrl,
		resolveRoto: (key) => `roto:${key}`,
	});
	bySeq.set(sequenceId, snap);
	return snap;
}

// ---------------------------------------------------------------- segments

type Span = { start: number; end: number };

const clipSpan = (c: RenderVisualClip): Span => ({
	start: c.start - (c.headHandle ?? 0),
	end: c.start + c.duration + (c.tailHandle ?? 0),
});
const overlaps = (s: Span, a: number, b: number) => s.start < b && s.end > a;

type Matte = NonNullable<RenderSnapshot['videoTracks'][number]['mattes']>[number];
type Stage = NonNullable<RenderSnapshot['videoTracks'][number]['transitions']>[number];
type Rig =
	| NonNullable<RenderSnapshot['scene3d']>['cameras'][number]
	| NonNullable<RenderSnapshot['scene3d']>['lights'][number];

/** Something drawn over a span of frames; `order` = drawing order (track, then kind, then start). */
type Item =
	| { kind: 'clip'; span: Span; track: number; order: number; clip: RenderVisualClip; matteTrack: boolean }
	| { kind: 'matte'; span: Span; track: number; order: number; matte: Matte }
	| { kind: 'stage'; span: Span; track: number; order: number; stage: Stage; matteTrack: boolean }
	| { kind: 'rig'; span: Span; track: number; order: number; rig: Rig; light: boolean };

/** The drawn items of a snapshot sorted by start, and every frame where what is drawn changes. */
function indexSnapshot(snap: RenderSnapshot): { items: Item[]; cuts: number[] } {
	const items: Item[] = [];
	const tracks: { t: RenderSnapshot['videoTracks'][number]; matteTrack: boolean }[] = [
		...snap.videoTracks.map((t) => ({ t, matteTrack: false })),
		...(snap.matteTracks ?? []).map((t) => ({
			t: t as RenderSnapshot['videoTracks'][number],
			matteTrack: true,
		})),
	];
	let order = 0;
	tracks.forEach(({ t, matteTrack }, ti) => {
		for (const m of t.mattes ?? [])
			items.push({
				kind: 'matte',
				span: { start: m.start, end: m.start + m.duration },
				track: ti,
				order: order++,
				matte: m,
			});
		for (const c of t.clips)
			items.push({ kind: 'clip', span: clipSpan(c), track: ti, order: order++, clip: c, matteTrack });
		for (const x of t.transitions ?? [])
			items.push({
				kind: 'stage',
				span: { start: x.start, end: x.start + x.duration },
				track: ti,
				order: order++,
				stage: x,
				matteTrack,
			});
	});
	for (const [light, list] of [
		[false, snap.scene3d?.cameras ?? []],
		[true, snap.scene3d?.lights ?? []],
	] as const)
		for (const r of list)
			items.push({
				kind: 'rig',
				span: { start: r.start, end: r.start + r.duration },
				track: tracks.length,
				order: order++,
				rig: r,
				light,
			});
	const cuts = new Set<number>();
	const add = (a: number, b: number) => {
		if (b <= a) return;
		cuts.add(Math.max(0, a));
		cuts.add(Math.max(0, b));
	};
	for (const it of items) {
		add(it.span.start, it.span.end);
		// a clip's own edges too: its handles are drawn only under a transition
		if (it.kind === 'clip') add(it.clip.start, it.clip.start + it.clip.duration);
	}
	items.sort((x, y) => x.span.start - y.span.start || x.order - y.order);
	return { items, cuts: [...cuts].sort((x, y) => x - y) };
}

/**
 * Walks increasing, disjoint ranges [a, b) over the sorted items: `take(a, b)` returns the items overlapping the
 * range in drawing order. O(items + output) over a whole sweep.
 */
function sweep(items: readonly Item[]) {
	let next = 0;
	let active: Item[] = [];
	return (a: number, b: number): Item[] => {
		while (next < items.length && items[next]!.span.start < b) active.push(items[next++]!);
		active = active.filter((it) => it.span.end > a);
		return active.filter((it) => overlaps(it.span, a, b)).sort((x, y) => x.order - y.order);
	};
}

// ---------------------------------------------------------------- normalisation

/** Kinds whose pixels never depend on their clip id (no seeded noise) when they have no effects and no Dissolve. */
const ID_FREE_KINDS = new Set([
	'video',
	'still',
	'solid',
	'animated-image',
	'nest-video',
	'adjustment',
	'model',
	'captions',
]);

function seedSensitive(c: RenderVisualClip): boolean {
	if (!ID_FREE_KINDS.has(c.kind)) return true;
	if (c.effects.length > 0) return true;
	return c.blendMode.includes('dissolve');
}

/** Any active expression in a value (Animatables and Source Text carry `expression: {text, enabled}`). */
export function containsActiveExpression(v: unknown, depth = 0): boolean {
	if (depth > 64 || v === null || typeof v !== 'object') return false;
	if (Array.isArray(v)) return v.some((x) => containsActiveExpression(x, depth + 1));
	const o = v as Record<string, unknown>;
	const e = o.expression as { enabled?: unknown; text?: unknown } | undefined;
	if (e && typeof e === 'object' && e.enabled === true && typeof e.text === 'string' && e.text.trim() !== '')
		return true;
	for (const k in o) if (k !== 'expression' && containsActiveExpression(o[k], depth + 1)) return true;
	return false;
}

/** A copy of an Animatable whose keyframes are in sequence flicks, rebased by `originFlicks`. */
function rebaseAnimatable<T>(a: Animatable<T> | undefined, originFlicks: number): unknown {
	if (!a || typeof a !== 'object' || !Array.isArray(a.keyframes) || a.keyframes.length === 0) return a;
	return { ...a, keyframes: a.keyframes.map((k) => ({ ...k, time: k.time - originFlicks })) };
}

/** Rebases every Animatable found in `v` (sequence-time automation). */
function rebaseAnimatables(v: unknown, originFlicks: number, depth = 0): unknown {
	if (depth > 32 || v === null || typeof v !== 'object' || originFlicks === 0) return v;
	if (Array.isArray(v)) return v.map((x) => rebaseAnimatables(x, originFlicks, depth + 1));
	const o = v as Record<string, unknown>;
	if (Array.isArray(o.keyframes) && 'value' in o)
		return rebaseAnimatable(o as Animatable<unknown>, originFlicks);
	const out: Record<string, unknown> = {};
	for (const k in o) out[k] = rebaseAnimatables(o[k], originFlicks, depth + 1);
	return out;
}

/** Collects the string values of `keys` anywhere in `v` (depth-first, document order). */
function collect(v: unknown, keys: ReadonlySet<string>, out: string[], depth = 0): void {
	if (depth > 64 || v === null || typeof v !== 'object') return;
	if (Array.isArray(v)) {
		for (const x of v) collect(x, keys, out, depth + 1);
		return;
	}
	for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
		if (keys.has(k) && typeof x === 'string') out.push(x);
		else collect(x, keys, out, depth + 1);
	}
}

const ID_KEYS = new Set(['clipId', 'trackId', 'id', 'outgoingClipId', 'incomingClipId']);
const MEDIA_KEYS = new Set(['mediaId', 'environmentMediaId']);
const FONT_KEYS = new Set(['fontId']);

/** Replaces every string equal to a collected id by its ordinal (`#n`), recursively. */
function canonicalIds(v: unknown, map: ReadonlyMap<string, string>, depth = 0): unknown {
	if (typeof v === 'string') return map.get(v) ?? v;
	if (depth > 64 || v === null || typeof v !== 'object') return v;
	if (Array.isArray(v)) return v.map((x) => canonicalIds(x, map, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = canonicalIds(x, map, depth + 1);
	return out;
}

function idOrdinals(body: unknown): Map<string, string> {
	const ids: string[] = [];
	collect(body, ID_KEYS, ids);
	const map = new Map<string, string>();
	for (const id of ids) if (!map.has(id)) map.set(id, `#${map.size}`);
	return map;
}

/**
 * A clip's own normalised form: everything but its position (`start`, hashed by the segment relative to its first
 * frame) and — unless `identity` — its ids and name (see the contract). Fades are relative to the clip's start.
 */
function normClip(c: RenderVisualClip, identity: boolean): Record<string, unknown> {
	const out: Record<string, unknown> = { ...c };
	delete out.start;
	if (c.fades) out.fades = c.fades.map((f) => ({ ...f, start: f.start - c.start }));
	if (!identity) {
		delete out.clipId;
		delete out.trackId;
		// Effects may print the clip name (FxClipInfo.clipName); nothing else draws it.
		if (c.effects.length === 0) delete out.name;
		if (seedSensitive(c)) out.seed = `§${c.clipId}|${c.effects.map((e) => e.id).join(',')}`;
	}
	if ('nest' in c.source) {
		const n = c.source.nest;
		out.source = {
			nest: {
				sequenceId: n.sequenceId,
				nestedFps: n.nestedFps,
				// The nested snapshot itself is hashed (only the frames the clip shows), not its whole-sequence key.
				snapshot: normNestedSnapshot(n.snapshot, identity),
			},
		};
	}
	return out;
}

/** A nested snapshot keeps its own (content-relative) frame numbering; ids are numbered inside it. */
function normNestedSnapshot(snap: RenderSnapshot, identity: boolean): unknown {
	const clip = (c: RenderVisualClip) => ({
		...normClip(c, identity),
		start: c.start,
		...(identity ? {} : { clipId: c.clipId, trackId: c.trackId }),
	});
	const body = {
		settings: snap.settings,
		range: snap.range,
		tracks: snap.videoTracks
			.filter((t) => t.clips.length || t.mattes?.length || t.transitions?.length)
			.map((t) => ({
				trackId: t.trackId,
				...(t.caption ? { caption: true } : {}),
				clips: t.clips.map(clip),
				mattes: t.mattes ?? [],
				stages: t.transitions ?? [],
			})),
		matteTracks: (snap.matteTracks ?? []).map((t) => ({
			trackId: t.trackId,
			clips: t.clips.map(clip),
			stages: t.transitions ?? [],
		})),
		scene3d: snap.scene3d ?? null,
	};
	return identity ? body : canonicalIds(body, idOrdinals(body));
}

type ClipDigest = { hash: string; media: string[]; fonts: string[]; expressive: boolean };
const digestMemo = new WeakMap<RenderVisualClip, { plain?: ClipDigest; identity?: ClipDigest }>();

function clipDigest(c: RenderVisualClip, identity: boolean): ClipDigest {
	let m = digestMemo.get(c);
	if (!m) {
		m = {};
		digestMemo.set(c, m);
	}
	const hit = identity ? m.identity : m.plain;
	if (hit) return hit;
	const body = normClip(c, identity);
	const media: string[] = [];
	collect(c, MEDIA_KEYS, media);
	const fonts: string[] = [];
	collect(c, FONT_KEYS, fonts);
	const d: ClipDigest = {
		hash: hash128(canonicalJson(body)),
		media: [...new Set(media)],
		fonts: [...new Set(fonts)],
		expressive: containsActiveExpression(c),
	};
	if (identity) m.identity = d;
	else m.plain = d;
	return d;
}

const worldHashes = new WeakMap<object, string>();
function worldHash(world: unknown): string {
	if (!world || typeof world !== 'object') return 'none';
	const hit = worldHashes.get(world);
	if (hit) return hit;
	const h = hash128(canonicalJson(world));
	worldHashes.set(world, h);
	return h;
}

/** The content hash of the video segment [a, b) given the items drawn in it (see the contract at the top). */
function hashItems(
	snap: RenderSnapshot,
	items: readonly Item[],
	a: number,
	b: number,
): { hash: string; absolute: boolean } {
	const expressive =
		!!snap.expressions &&
		items.some((it) =>
			it.kind === 'clip'
				? clipDigest(it.clip, false).expressive
				: it.kind === 'stage'
					? containsActiveExpression(it.stage.params)
					: it.kind === 'rig' && containsActiveExpression(it.rig),
		);
	const identity = expressive;
	// Clip ordinals within the segment (transition sides refer to them).
	const clipIndex = new Map<string, number>();
	for (const it of items) if (it.kind === 'clip') clipIndex.set(it.clip.clipId, clipIndex.size);
	const ref = (id: string | null) =>
		id === null ? null : identity ? id : (clipIndex.get(id) ?? `out:${id}`);
	// Track ordinals: only tracks with something drawn count (an empty track changes nothing).
	const trackIndex = new Map<number, number>();
	const media = new Set<string>();
	const fonts = new Set<string>();
	const body = items.map((it) => {
		if (!trackIndex.has(it.track)) trackIndex.set(it.track, trackIndex.size);
		const t = trackIndex.get(it.track)!;
		switch (it.kind) {
			case 'clip': {
				const d = clipDigest(it.clip, identity);
				for (const m of d.media) media.add(m);
				for (const f of d.fonts) fonts.add(f);
				return ['c', t, it.matteTrack ? 1 : 0, it.clip.start - a, d.hash];
			}
			case 'matte':
				return ['m', t, it.matte.start - a, it.matte.duration, it.matte.color];
			case 'stage': {
				const { id, start, outgoingClipId, incomingClipId, ...rest } = it.stage;
				const m: string[] = [];
				collect(rest, MEDIA_KEYS, m);
				for (const x of m) media.add(x);
				return [
					's',
					t,
					it.matteTrack ? 1 : 0,
					start - a,
					ref(outgoingClipId),
					ref(incomingClipId),
					identity ? id : null,
					rest,
				];
			}
			default: {
				const { start, name, clipId, ...rest } = it.rig;
				const m: string[] = [];
				collect(rest, MEDIA_KEYS, m);
				for (const x of m) media.add(x);
				return ['r', it.light ? 1 : 0, start - a, identity ? [clipId, name] : null, rest];
			}
		}
	});
	const s3 = snap.scene3d;
	const text = canonicalJson({
		v: PREVIEW_HASH_VERSION,
		kind: 'video',
		settings: {
			width: snap.settings.width,
			height: snap.settings.height,
			fps: snap.settings.fps,
			backgroundColor: snap.settings.backgroundColor as RGBA,
		},
		frames: b - a,
		body,
		scene3d: s3 ? [s3.renderer, s3.draft ?? false, s3.shadowMapSize ?? null, s3.supersampling ?? null] : null,
		media: [...media].sort().map((id) => [id, snap.media[id] ?? null]),
		fonts: snap.fonts
			.filter((f) => fonts.has(f.fontId))
			.map((f) => [f.fontId, f.family, f.weight, f.style, f.url])
			.sort((x, y) => canonicalJson(x).localeCompare(canonicalJson(y))),
		...(expressive ? { absoluteStart: a, world: worldHash(snap.expressions) } : {}),
	});
	return { hash: hash128(text), absolute: expressive };
}

/** The content hash of the video segment [a, b) of a preview snapshot (see the contract at the top). */
export function videoSegmentHash(
	snap: RenderSnapshot,
	a: number,
	b: number,
): { hash: string; absolute: boolean } {
	const { items } = indexSnapshot(snap);
	return hashItems(snap, sweep(items)(a, b), a, b);
}

// ---------------------------------------------------------------- cost model (≈)

/** Decode cost of one 1080p frame by codec in the browser (ms, ≈; WebCodecs / `<video>` on a CPU-only box). */
function decodeMs(codec: string): number {
	const c = codec.toLowerCase();
	if (c.includes('264') || c.includes('avc')) return 3;
	if (c.includes('hevc') || c.includes('265')) return 6;
	if (c.includes('vp9')) return 5;
	if (c.includes('av1')) return 6;
	if (c.includes('vp8')) return 3;
	if (c.includes('prores') || c.includes('dnx')) return 4; // played from the 720p proxy
	return 4;
}

type CostCtx = { doc: ProjectDocument; px: number; registry: EffectRegistry; reasons: Map<string, number> };

const note = (ctx: CostCtx, why: string, ms: number) => {
	if (ms <= 0) return;
	ctx.reasons.set(why, (ctx.reasons.get(why) ?? 0) + ms);
};

function mediaDecodeCost(ctx: CostCtx, mediaId: string): number {
	const asset = ctx.doc.media[mediaId];
	if (!asset) return 0;
	const v = asset.probe.streams.find((s) => s.type === 'video');
	if (asset.kind === 'image' || !v || v.type !== 'video') return 0.5;
	const px = (v.width * v.height) / HD_PIXELS;
	const browser = (v as { browserDecodable?: boolean }).browserDecodable !== false;
	// originals the browser cannot decode play from the 720p proxy
	const scale = browser ? px : Math.min(px, (1280 * 720) / HD_PIXELS);
	return decodeMs(v.codec) * scale;
}

function effectCost(ctx: CostCtx, effectId: string, effectVersion?: number): { ms: number; label: string } {
	const spec = ctx.registry.get(effectId, effectVersion);
	if (!spec) return { ms: 6 * ctx.px, label: effectId };
	if (spec.passthrough) return { ms: 0, label: spec.label };
	if (spec.color) return { ms: 1.5 * ctx.px, label: spec.label };
	const base = spec.expensive ? 25 : spec.capabilities.preview === 'webgl' || spec.gpu ? 6 : 2;
	return { ms: base * ctx.px, label: spec.label };
}

function clipCost(ctx: CostCtx, c: RenderVisualClip, depth: number): number {
	const px = ctx.px;
	let ms = 0;
	const src = c.source;
	if ('mediaId' in src) {
		const d = mediaDecodeCost(ctx, src.mediaId);
		ms += d;
		note(ctx, 'decoding', d);
		const h = ctx.doc.media[src.mediaId];
		if (h?.lottie) {
			ms += 6 * px;
			note(ctx, 'Lottie animation', 6 * px);
		}
	} else if ('nest' in src) {
		ms += 2 * px;
		if (depth < 8)
			for (const t of src.nest.snapshot.videoTracks)
				for (const n of t.clips) ms += clipCost(ctx, n, depth + 1);
	} else if ('composition' in src) {
		const k = src.composition.prerender?.previewUrl ? 3 : 20;
		ms += k * px;
		note(ctx, 'Remotion composition', k * px);
	} else if ('mg' in src) {
		ms += 3 * px;
		note(ctx, 'motion graphic', 3 * px);
	} else if ('adjustment' in src) {
		ms += 12 * px;
		note(ctx, 'adjustment layer', 12 * px);
	} else if ('text' in src) {
		const k = src.animators?.length ? 4 : 1;
		ms += k * px;
	} else ms += 0.5 * px;
	// the layer path: the browser draws DOM layers on the compositor; canvas paths copy the picture
	ms += 0.5;
	for (const fx of c.effects) {
		if (!fx.enabled) continue;
		const e = effectCost(ctx, fx.effectId, fx.effectVersion);
		ms += e.ms;
		note(ctx, e.label, e.ms);
	}
	if (c.masks?.length) {
		ms += 3 * px;
		note(ctx, 'masks', 3 * px);
	}
	if (c.blendMode !== 'normal' && !isCssBlend(c.blendMode)) {
		ms += 8 * px;
		note(ctx, `${c.blendMode} blending`, 8 * px);
	}
	if (c.retime) {
		const k =
			c.retime.interpolation === 'optical-flow' ? 60 : c.retime.interpolation === 'frame-blending' ? 8 : 5;
		ms += k * px;
		note(ctx, c.retime.interpolation === 'optical-flow' ? 'optical flow' : 'retimed frames', k * px);
	}
	if (c.threeD) {
		ms += 4 * px;
		note(ctx, '3D layer', 4 * px);
	}
	return ms;
}

function untouched(doc: ProjectDocument, snap: RenderSnapshot, c: RenderVisualClip): boolean {
	if (c.kind !== 'video' || !('mediaId' in c.source)) return false;
	if (c.effects.length || c.masks?.length || c.blendMode !== 'normal' || c.retime || c.timeRemap || c.threeD)
		return false;
	if (c.speed.rate !== 1 || c.speed.reverse || c.frameHold || c.fades?.length || c.rotos) return false;
	const asset = doc.media[c.source.mediaId];
	const v = asset?.probe.streams.find((s) => s.type === 'video');
	if (!asset || !v || v.type !== 'video') return false;
	if ((v as { browserDecodable?: boolean }).browserDecodable === false) return false;
	const { width, height, fps } = snap.settings;
	if (v.width !== width || v.height !== height) return false;
	if (v.frameRate.num * fps.den !== fps.num * v.frameRate.den) return false;
	const o = c.opacity;
	if (o.keyframes.length || o.value !== 100 || o.expression) return false;
	const t = c.transform;
	if (!t) return true;
	const still = (a: Animatable<unknown>) => a.keyframes.length === 0 && !a.expression;
	if (![t.position, t.anchor, t.scale, t.scaleWidth, t.rotation].every(still)) return false;
	const [px, py] = t.position.value as [number, number];
	const [ax, ay] = t.anchor.value as [number, number];
	return (
		px === width / 2 &&
		py === height / 2 &&
		ax === c.intrinsicBox.width / 2 &&
		ay === c.intrinsicBox.height / 2 &&
		t.scale.value === 100 &&
		(t.uniformScale || t.scaleWidth.value === 100) &&
		t.rotation.value === 0 &&
		!t.flipH &&
		!t.flipV
	);
}

function segmentCost(
	doc: ProjectDocument,
	snap: RenderSnapshot,
	items: readonly Item[],
	registry: EffectRegistry,
): { costMs: number; reasons: string[]; layers: RenderVisualClip[]; stages: Stage[]; mattes: number } {
	const px = (snap.settings.width * snap.settings.height) / HD_PIXELS;
	const ctx: CostCtx = { doc, px, registry, reasons: new Map() };
	let ms = 0;
	const layers: RenderVisualClip[] = [];
	const stages: Stage[] = [];
	let mattes = 0;
	const glTracks = new Set<number>();
	for (const it of items) {
		if (it.kind === 'clip') {
			if (it.matteTrack) {
				ms += clipCost(ctx, it.clip, 0) + 4 * px;
				note(ctx, 'track matte', 4 * px);
				continue;
			}
			layers.push(it.clip);
			ms += clipCost(ctx, it.clip, 0);
			// a track with a GL blend mode captures everything below it (HTML-in-Canvas)
			if (it.clip.blendMode !== 'normal' && !isCssBlend(it.clip.blendMode) && !glTracks.has(it.track)) {
				glTracks.add(it.track);
				ms += 6 * px;
				note(ctx, 'blend capture', 6 * px);
			}
		} else if (it.kind === 'stage' && !it.matteTrack) {
			stages.push(it.stage);
			ms += 8 * px;
			note(ctx, 'GPU transition', 8 * px);
		} else if (it.kind === 'matte') mattes++;
	}
	if (layers.some((c) => c.threeD)) {
		ms += 15 * px;
		note(ctx, '3D renderer', 15 * px);
	}
	const reasons = [...ctx.reasons.entries()]
		.sort((x, y) => y[1] - x[1])
		.slice(0, 4)
		.map(([k, v]) => `${k} ≈${Math.round(v * 10) / 10} ms`);
	return { costMs: Math.round(ms * 10) / 10, reasons, layers, stages, mattes };
}

// ---------------------------------------------------------------- public API

export type PreviewSegmentOptions = { registry?: EffectRegistry; snapshot?: RenderSnapshot };

const segmentMemo = new WeakMap<object, Map<string, RenderPreviewSegment[]>>();

/** The render-bar segments of a sequence (memoized per document object). */
export function previewSegments(
	doc: ProjectDocument,
	sequenceId: string,
	opts: PreviewSegmentOptions = {},
): RenderPreviewSegment[] {
	const memo = !opts.snapshot && !opts.registry;
	if (memo) {
		const hit = segmentMemo.get(doc)?.get(sequenceId);
		if (hit) return hit;
	}
	const seq = doc.sequences[sequenceId];
	if (!seq) return [];
	const snap = opts.snapshot ?? previewSnapshot(doc, sequenceId);
	const registry = opts.registry ?? defaultEffectRegistry;
	const fps = snap.settings.fps as Rational;
	const frameMs = (1000 * fps.den) / Math.max(1e-9, fps.num);
	const budgetMs = Math.round(frameMs * REALTIME_BUDGET * 10) / 10;
	const { items, cuts } = indexSnapshot(snap);
	const take = sweep(items);
	const out: RenderPreviewSegment[] = [];
	for (let i = 0; i + 1 < cuts.length; i++) {
		const a = cuts[i]!;
		const b = cuts[i + 1]!;
		const at = take(a, b);
		const cost = segmentCost(doc, snap, at, registry);
		if (cost.layers.length === 0 && cost.stages.length === 0 && cost.mattes === 0) continue;
		const { hash, absolute } = hashItems(snap, at, a, b);
		const only =
			cost.layers.length === 1 && cost.stages.length === 0 && cost.mattes === 0 ? cost.layers[0]! : null;
		const need: PreviewNeed =
			cost.costMs > budgetMs ? 'render' : only && untouched(doc, snap, only) ? 'none' : 'realtime';
		const ids = new Set<string>();
		for (const c of cost.layers) ids.add(c.clipId);
		for (const x of cost.stages) for (const id of [x.outgoingClipId, x.incomingClipId]) if (id) ids.add(id);
		out.push({
			startFrame: a,
			frames: b - a,
			hash,
			need,
			costMs: cost.costMs,
			budgetMs,
			clipIds: [...ids],
			absolute,
			reasons: need === 'none' ? [] : cost.reasons,
		});
	}
	if (memo) {
		let m = segmentMemo.get(doc);
		if (!m) {
			m = new Map();
			segmentMemo.set(doc, m);
		}
		m.set(sequenceId, out);
	}
	return out;
}

/** The segment containing `frame` (segments are sorted and disjoint). */
export function previewSegmentAt<T extends { startFrame: number; frames: number }>(
	segments: readonly T[],
	frame: number,
): T | null {
	let lo = 0;
	let hi = segments.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const s = segments[mid]!;
		if (frame < s.startFrame) hi = mid - 1;
		else if (frame >= s.startFrame + s.frames) lo = mid + 1;
		else return s;
	}
	return null;
}

// ---------------------------------------------------------------- audio (Render Audio)

const audioSpan = (c: RenderAudioClip): Span => ({
	start: c.start - (c.headHandle ?? 0),
	end: c.start + c.duration + (c.tailHandle ?? 0),
});

const audioMemo = new WeakMap<object, Map<string, RenderAudioPreviewSegment[]>>();

/** Whether an Animatable anywhere in `v` has keyframes (sequence-time automation to rebase per segment). */
function hasKeyframes(v: unknown, depth = 0): boolean {
	if (depth > 32 || v === null || typeof v !== 'object') return false;
	if (Array.isArray(v)) return v.some((x) => hasKeyframes(x, depth + 1));
	const o = v as Record<string, unknown>;
	if (Array.isArray(o.keyframes) && o.keyframes.length > 0) return true;
	for (const k in o) if (hasKeyframes(o[k], depth + 1)) return true;
	return false;
}

/** Hash of sequence-time automation rebased to `originFlicks` (constant when nothing is keyframed). */
function automationHasher(v: unknown): (originFlicks: number) => string {
	if (!hasKeyframes(v)) {
		const h = hash128(canonicalJson(v ?? null));
		return () => h;
	}
	const memo = new Map<number, string>();
	return (o) => {
		let h = memo.get(o);
		if (!h) {
			h = hash128(canonicalJson(rebaseAnimatables(v, o)));
			memo.set(o, h);
		}
		return h;
	};
}

type AudioDigest = { hash: string; media: string[]; expressive: boolean };
const audioDigestMemo = new WeakMap<RenderAudioClip, { plain?: AudioDigest; identity?: AudioDigest }>();

function audioDigest(c: RenderAudioClip, identity: boolean): AudioDigest {
	let m = audioDigestMemo.get(c);
	if (!m) {
		m = {};
		audioDigestMemo.set(c, m);
	}
	const hit = identity ? m.identity : m.plain;
	if (hit) return hit;
	const { start, track: _track, ...rest } = c;
	const o: Record<string, unknown> = { ...rest };
	if (c.fades) o.fades = c.fades.map((f) => ({ ...f, start: f.start - start }));
	if (c.nestGain) o.nestGain = c.nestGain.map((r) => ({ ...r, start: r.start - start, end: r.end - start }));
	if (!identity) delete o.clipId;
	const media: string[] = [];
	collect(c, MEDIA_KEYS, media);
	const d: AudioDigest = {
		hash: hash128(canonicalJson(o)),
		media: [...new Set(media)],
		expressive: containsActiveExpression(c),
	};
	if (identity) m.identity = d;
	else m.plain = d;
	return d;
}

/**
 * Audio segments of a sequence: cut at every audio clip and crossfade edge (in frames). The hash covers the mix-wide
 * state (strips, buses, sends, automation and the Mix, rebased to the segment start), and the clips heard in the
 * segment relative to its start. Effect tails (delay, reverb) carried across a cut from the previous segment are
 * not part of the hash (FilmCraft makes the same choice). Memoized per document object.
 */
export function audioPreviewSegments(doc: ProjectDocument, sequenceId: string): RenderAudioPreviewSegment[] {
	const hit = audioMemo.get(doc)?.get(sequenceId);
	if (hit) return hit;
	const seq = doc.sequences[sequenceId];
	if (!seq) return [];
	const snap = previewSnapshot(doc, sequenceId);
	const F = flicksPerFrame(snap.settings.fps as Rational);
	const cuts = new Set<number>();
	for (const c of snap.audioClips) {
		const sp = audioSpan(c);
		for (const x of [sp.start, sp.end, c.start, c.start + c.duration]) cuts.add(Math.max(0, x));
	}
	const sorted = [...cuts].sort((x, y) => x - y);
	const clips = [...snap.audioClips].sort((x, y) => audioSpan(x).start - audioSpan(y).start);
	const mix = automationHasher({ mix: snap.audioMix ?? null, master: snap.master });
	const trackAutomation = new Map<string, (o: number) => string>();
	const trackHash = (c: RenderAudioClip, o: number) => {
		let f = trackAutomation.get(c.trackId);
		if (!f) {
			f = automationHasher(c.track);
			trackAutomation.set(c.trackId, f);
		}
		return f(o);
	};
	const out: RenderAudioPreviewSegment[] = [];
	let next = 0;
	let active: RenderAudioClip[] = [];
	for (let i = 0; i + 1 < sorted.length; i++) {
		const a = sorted[i]!;
		const b = sorted[i + 1]!;
		while (next < clips.length && audioSpan(clips[next]!).start < b) active.push(clips[next++]!);
		active = active.filter((c) => audioSpan(c).end > a);
		const heard = active.filter((c) => overlaps(audioSpan(c), a, b));
		if (heard.length === 0) continue;
		heard.sort(
			(x, y) => x.start - y.start || x.trackId.localeCompare(y.trackId) || x.clipId.localeCompare(y.clipId),
		);
		const absolute = !!snap.expressions && heard.some((c) => audioDigest(c, false).expressive);
		const media = new Set<string>();
		const body = heard.map((c) => {
			const d = audioDigest(c, absolute);
			for (const m of d.media) media.add(m);
			return [c.trackId, c.start - a, d.hash, trackHash(c, a * F)];
		});
		const text = canonicalJson({
			v: PREVIEW_HASH_VERSION,
			kind: 'audio',
			sampleRate: snap.settings.sampleRate,
			fps: snap.settings.fps,
			frames: b - a,
			body,
			mix: mix(a * F),
			media: [...media].sort().map((id) => [id, snap.media[id] ?? null]),
			...(absolute ? { absoluteStart: a, world: worldHash(snap.expressions) } : {}),
		});
		out.push({
			startFrame: a,
			frames: b - a,
			hash: hash128(text),
			clipIds: [...new Set(heard.map((c) => c.clipId))],
		});
	}
	let m = audioMemo.get(doc);
	if (!m) {
		m = new Map();
		audioMemo.set(doc, m);
	}
	m.set(sequenceId, out);
	return out;
}
