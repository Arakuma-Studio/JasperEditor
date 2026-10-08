// The flat compositor's planning (workstream compositor), pure. Chrome never paints an HTML-in-Canvas canvas that lies
// inside another one (color-mgmt, fx/canvas-scope.tsx), and every canvas scope of the stack (GL blend modes, linear
// light, adjustment layers drawn through the canvas chain, 3D runs, the Program monitor's display transform) captures
// everything below it. A stack whose scopes would nest is therefore drawn FLAT instead: no scope captures anything;
// every layer draws its own finished picture (media through `FxPicture`, DOM layers through their own HTML-in-Canvas,
// side by side, never nested) and hands it to one compositor, which builds the frame on the GPU in stack order. This
// module says when a stack must be flat (`flatStackReason`) and what the compositor does at a frame (`flatOpsAt`).
import {
	clipHasMasks,
	defaultEffectRegistry,
	isCssBlend,
	matteTrackIds,
	type RenderSnapshot,
	type RenderVisualClip,
	type RGBA,
} from '@jasper/project';
import type { CompositeItem, CompositeTrackInput } from './composite-plan.ts';
import { compositeItemsAt } from './composite-plan.ts';

/** One track of a flat stack (bottom → top). */
export type FlatTrackInput = {
	trackId: string;
	/** Index in the doc's video tracks (3D runs name their bottom track by index). */
	index: number;
	/** The track's layers the compositor composites: its 2D clips and its GPU transition stages. */
	layers: CompositeTrackInput;
	/** Transition mattes (the colour of a dip), under the track's clips. */
	mattes: readonly { id: string; start: number; duration: number; color: RGBA }[];
	/** Spans of the track's adjustment clips (they process the composite below them). */
	adjustments: readonly { start: number; duration: number }[];
};

/** A step of the compositor at a frame. */
export type FlatOp =
	/** Layers (and colour fills) composited onto the accumulated picture, in order, each with its blend mode. */
	| { kind: 'layers'; items: CompositeItem[] }
	/** The adjustment layer of a track: its canvas chain on the accumulated picture (padded layout). */
	| { kind: 'adjust'; trackId: string }
	/** The 3D run whose bottom is track `trackIndex`, drawn over the accumulated picture by the 3D renderer. */
	| { kind: 'run3d'; trackIndex: number };

/** Key of the background fill in the compositor's items. */
export const FLAT_BACKGROUND_KEY = 'background';

const spanAt = (s: { start: number; duration: number }, f: number) =>
	f >= s.start && f < s.start + s.duration;

/**
 * What the flat compositor does at sequence frame `f`, bottom to top — the order the scopes of the nested structure
 * apply in (SequenceComposition `VideoTracks`): the background; then per track its adjustment layer (on everything
 * below), its transition mattes, the 3D run whose bottom it is, and its layers (clips, then GPU transition stages).
 * Every drawn layer is an item (Normal ones too: nothing is drawn by the DOM in a flat stack); GPU transition sides are
 * left to their stage (`isGpuSide`).
 */
export function flatOpsAt(
	tracks: readonly FlatTrackInput[],
	f: number,
	opts: {
		background: RGBA | null;
		isGpuSide: (clipId: string, f: number) => boolean;
		/** True when a 3D run whose bottom is track `index` is drawn at `f`. */
		run3dAt?: (index: number, f: number) => boolean;
	},
): FlatOp[] {
	const ops: FlatOp[] = [];
	let layers: CompositeItem[] = [];
	const flush = () => {
		if (layers.length) ops.push({ kind: 'layers', items: layers });
		layers = [];
	};
	const bg = opts.background;
	if (bg && bg[3] > 0) layers.push({ kind: 'matte', key: FLAT_BACKGROUND_KEY, color: bg });
	for (const t of tracks) {
		if (t.adjustments.some((a) => spanAt(a, f))) {
			flush();
			ops.push({ kind: 'adjust', trackId: t.trackId });
		}
		for (const m of t.mattes)
			if (spanAt(m, f)) layers.push({ kind: 'matte', key: `matte:${m.id}`, color: m.color });
		if (opts.run3dAt?.(t.index, f)) {
			flush();
			ops.push({ kind: 'run3d', trackIndex: t.index });
		}
		layers.push(...(compositeItemsAt(t.layers, f, opts.isGpuSide, true) ?? []));
	}
	flush();
	return ops;
}

/** The layer items of a frame's ops (what the compositor's hub expects pictures for). */
export function flatLayerItems(ops: readonly FlatOp[]): CompositeItem[] {
	return ops.flatMap((op) => (op.kind === 'layers' ? op.items : []));
}

// ---------------------------------------------------------------- when a stack must be flat

type Clip = Pick<
	RenderVisualClip,
	'clipId' | 'kind' | 'source' | 'effects' | 'blendMode' | 'threeD' | 'masks'
> &
	Partial<Pick<RenderVisualClip, 'opacity'>>;
type MediaLike = { lottie?: unknown; vector?: unknown } | null | undefined;

/** Kinds `LayerBox` runs through the canvas chain for their colour effects (DOM pictures, see LayerBox). */
const CHAIN_KINDS: ReadonlySet<string> = new Set([
	'text',
	'shape',
	'motion-graphic',
	'nest-video',
	'captions',
]);
/** Kinds whose picture is a canvas (`FxPicture`): they never draw through HTML-in-Canvas. */
const PICTURE_KINDS: ReadonlySet<string> = new Set([
	'video',
	'still',
	'animated-image',
	'solid',
	'composition',
	'model',
	'adjustment',
]);
const MEDIA_KINDS: ReadonlySet<string> = new Set(['video', 'still', 'animated-image', 'model']);

/** The clip's picture is DOM content (LayerBox captures it through HTML-in-Canvas when it needs pixels). */
export function isDomPictureClip(clip: Pick<Clip, 'kind' | 'source'>, media: MediaLike): boolean {
	if (media?.lottie || media?.vector) return true;
	if ('generator' in clip.source) return false;
	// An offline media clip draws the Media Offline card (DOM).
	if (MEDIA_KINDS.has(clip.kind) && !media) return true;
	return !PICTURE_KINDS.has(clip.kind);
}

/**
 * The clip draws through its own HTML-in-Canvas (LayerBox `FxDomPicture`): a DOM picture with GPU shader effects,
 * masks or (for the chain kinds) colour effects, or one whose picture is captured for something else (`tapped`: a GPU
 * transition side, a track read as a Track Matte).
 */
export function clipDrawsThroughCanvas(clip: Clip, media: MediaLike, tapped = false): boolean {
	if (!isDomPictureClip(clip, media)) return false;
	if (tapped || clipHasMasks(clip as RenderVisualClip)) return true;
	for (const fx of clip.effects) {
		if (!fx.enabled) continue;
		const spec = defaultEffectRegistry.get(fx.effectId, fx.effectVersion);
		if (spec?.appliesTo !== 'video') continue;
		if (spec.gpu) return true;
		if (spec.color && CHAIN_KINDS.has(clip.kind)) return true;
	}
	return false;
}

/** A scope of the nested (non-flat) structure: it captures everything below `track` (index). */
export type StackScope = { track: number; kind: 'adjustment' | 'blend' | 'linear' | '3d' };

/**
 * Why a stack must be drawn flat (null: the nested structure draws it — the path every stack that worked before
 * keeps, pixel for pixel). Scopes capture everything below their track, so two scopes nest, and so does anything below
 * the topmost scope that draws through HTML-in-Canvas itself (`canvasTracks`: track indexes holding such layers; a
 * nested sequence that contains a scope or such a layer counts).
 */
export function flatStackReason(
	scopes: readonly StackScope[],
	canvasTracks: readonly number[],
): string | null {
	if (scopes.length >= 2) {
		const names = [...new Set(scopes.map((s) => SCOPE_NAMES[s.kind]))].join(', ');
		return `${scopes.length} canvas scopes (${names})`;
	}
	if (scopes.length === 1) {
		const top = scopes[0]!.track;
		const below = canvasTracks.find((t) => t < top);
		if (below !== undefined)
			return `a layer drawn through HTML-in-Canvas below ${SCOPE_NAMES[scopes[0]!.kind]}`;
	}
	return null;
}

const SCOPE_NAMES: Record<StackScope['kind'], string> = {
	adjustment: 'an adjustment layer',
	blend: 'blend modes',
	linear: 'linear-light blending',
	'3d': '3D layers',
};

/**
 * Whether drawing `doc` (a nested sequence, or the sequence under the display transform) puts any HTML-in-Canvas
 * element in the page: a canvas scope (GL blend modes, linear light, an adjustment layer the CSS cannot draw, 3D
 * layers) or a layer drawing through its own. `cssExact`: adjustment clips a CSS filter draws (AdjustmentScope).
 */
export function docUsesCanvas(
	doc: Pick<RenderSnapshot, 'videoTracks' | 'media'> & {
		settings: { color?: { blendLinear?: boolean } | undefined };
		matteTracks?: RenderSnapshot['matteTracks'];
	},
	cssExact: (clip: RenderVisualClip) => boolean,
	depth = 0,
): boolean {
	if (depth > 16) return true;
	const linear = !!doc.settings.color?.blendLinear;
	const matteRead = matteTrackIds({ videoTracks: [...doc.videoTracks, ...(doc.matteTracks ?? [])] });
	for (const t of [...doc.videoTracks, ...(doc.matteTracks ?? [])]) {
		// GPU transitions capture their sides' pictures (DOM sides through HTML-in-Canvas).
		const sides = new Set(
			(t.transitions ?? []).flatMap((tr) => [tr.outgoingClipId, tr.incomingClipId]).filter((x) => !!x),
		);
		for (const c of t.clips) {
			if (c.kind === 'adjustment') {
				if (!cssExact(c)) return true;
				continue;
			}
			if (c.threeD) return true;
			if (linear || !isCssBlend(c.blendMode)) return true;
			const media = 'mediaId' in c.source ? doc.media[c.source.mediaId] : null;
			if (clipDrawsThroughCanvas(c, media, sides.has(c.clipId) || matteRead.has(t.trackId))) return true;
			if ('nest' in c.source && docUsesCanvas(c.source.nest.snapshot, cssExact, depth + 1)) return true;
		}
	}
	return false;
}
