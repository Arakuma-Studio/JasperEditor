// Composition contract (ARCHITECTURE §8, S03:ARC-003): inputProps = {doc: RenderDoc, options: RenderOptions}.
import type { MediaHandle, RenderSnapshot, RenderVisualClip, ResolvedLayerProps } from '@jasper/project';

export const SEQUENCE_COMPOSITION_ID = 'JasperSequence';
/** Source monitor / asset preview composition (S03:SRC-002). */
export const ASSET_COMPOSITION_ID = 'JasperAsset';

/** A RenderSnapshot whose media and font URLs are already resolved for the consumer (Player or engine). */
export type RenderDoc = RenderSnapshot;

export type RenderOptions = {
	isPreview: boolean;
	useProxies: boolean;
	transparentBackground: boolean;
	/** clipIds to render (M2 hybrid alpha intermediates); undefined = all. */
	layerFilter?: string[];
	/**
	 * M2 (S06:CGU-005, preview only): clips whose colour effects are bypassed ("before" of the before/after
	 * toggle). Ignored in renders.
	 */
	colorBypassClipIds?: readonly string[];
	/**
	 * fx framework (preview only): resolution of GPU shader-effect canvases relative to full size, (0, 1] — the
	 * Program monitor's playback resolution (1/2 → 0.5, 1/4 → 0.25). px-based params scale with it (`u_pxScale`).
	 * Ignored in renders. Absent = 1.
	 */
	fxPreviewScale?: number;
};

export type SequenceCompositionProps = { doc: RenderDoc; options: RenderOptions };

/** Props every visual layer component receives. */
export type LayerProps = {
	clip: RenderVisualClip;
	/** Evaluated values and the layer matrix at the current frame. */
	props: ResolvedLayerProps;
	/** Frame inside the clip (0-based). */
	localFrame: number;
	/** Content time in flicks (S01:CLP-004). */
	contentTime: number;
	fps: number;
	media: MediaHandle | null;
	options: RenderOptions;
	/** Font faces of the document (text layers resolve their family from `style.fontId`). */
	fonts?: RenderDoc['fonts'];
	/**
	 * fx framework (time remap): the real clip-local frame when `localFrame`/`contentTime` were remapped by a time
	 * effect (`gpu.time.remap`); absent = `localFrame` is the real frame.
	 */
	realFrame?: number;
	/**
	 * Transition framework (wave 2): the GPU transition this layer is a side of at this frame, fed to its GPU effects
	 * as `u_progress` (0..1) and `u_side` (1 = outgoing, 2 = incoming). `tap` (set when the transition runs on the
	 * GPU): the layer's picture goes to the transition stage instead of the screen (fx/transition.tsx).
	 */
	transition?: { progress: number; side: 'out' | 'in'; tap?: TransitionTap };
	/**
	 * keyframes-blend: the layer is part of the GL compositor's group at this frame (a blend mode CSS cannot draw
	 * exactly sits on or above it): its picture goes to the compositor stage (fx/composite.tsx) instead of the
	 * screen, like a transition side's.
	 */
	composite?: { tap: LayerTap };
};

/** Where a captured layer delivers its picture (the layer's fx canvas) and its placement. */
export type LayerTap = {
	/** Identity of the capture (`out` / `in` for transition sides, the clip id for the compositor). */
	readonly side: string;
	deliver(
		picture: CanvasImageSource,
		width: number,
		height: number,
		meta: { compToCanvas: readonly number[] | null; opacity: number },
	): void;
};

/** Where a side of a GPU transition delivers its picture (the layer's fx canvas) and its placement. */
export type TransitionTap = LayerTap & {
	readonly side: 'out' | 'in';
	deliver(
		picture: CanvasImageSource,
		width: number,
		height: number,
		meta: { compToCanvas: readonly number[] | null; opacity: number },
	): void;
};

/** Props of the Source monitor composition (ARCHITECTURE §8). */
export type AssetCompositionProps = {
	asset: MediaHandle;
	/** Frame rate of the asset (sequence fps for stills). */
	fps: number;
	/** Display name (audio card, offline card). */
	name?: string;
	/** Use the proxy URL when present. */
	useProxies?: boolean;
	/** Duration used for stills and unknown durations, in frames (default 5 s). */
	stillDurationFrames?: number;
};

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
	isPreview: true,
	useProxies: false,
	transparentBackground: false,
};

/** An empty 1080p30 document (default props for the Remotion Studio and tests). */
export const EMPTY_RENDER_DOC: RenderDoc = {
	version: 1,
	sequenceId: 'seq_EMPTY00000000000',
	settings: {
		width: 1920,
		height: 1080,
		fps: { num: 30, den: 1 },
		backgroundColor: [0, 0, 0, 1],
		sampleRate: 48000,
	},
	range: { start: 0, end: 0 },
	durationFrames: 0,
	videoTracks: [],
	audioClips: [],
	media: {},
	fonts: [],
	master: { volumeDb: { value: 0, keyframes: [] } },
	warnings: [],
};
