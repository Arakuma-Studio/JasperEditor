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
	showOffline: boolean;
	/**
	 * M2 (S06:CGU-005, preview only): clips whose colour effects are bypassed ("before" of the before/after
	 * toggle). Ignored in renders.
	 */
	colorBypassClipIds?: readonly string[];
};

export type SequenceCompositionProps = { doc: RenderDoc; options: RenderOptions };

/** Props every visual layer component receives (WP-2C/WP-2G implement the real layers). */
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
	showOffline: true,
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
