// Composition contract (ARCHITECTURE §8, S03:ARC-003): inputProps = {doc: RenderDoc, options: RenderOptions}.
import type { MediaHandle, RenderSnapshot, RenderVisualClip, ResolvedLayerProps } from '@jasper/project';

export const SEQUENCE_COMPOSITION_ID = 'JasperSequence';

/** A RenderSnapshot whose media and font URLs are already resolved for the consumer (Player or engine). */
export type RenderDoc = RenderSnapshot;

export type RenderOptions = {
	isPreview: boolean;
	useProxies: boolean;
	transparentBackground: boolean;
	/** clipIds to render (M2 hybrid alpha intermediates); undefined = all. */
	layerFilter?: string[];
	showOffline: boolean;
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
