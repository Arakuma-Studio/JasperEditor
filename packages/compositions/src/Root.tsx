import { Composition } from 'remotion';
import { AssetComposition, calculateAssetMetadata } from './AssetComposition.tsx';
import { calculateSequenceMetadata } from './metadata.ts';
import { SequenceComposition } from './SequenceComposition.tsx';
import {
	ASSET_COMPOSITION_ID,
	type AssetCompositionProps,
	DEFAULT_RENDER_OPTIONS,
	EMPTY_RENDER_DOC,
	SEQUENCE_COMPOSITION_ID,
} from './types.ts';

const EMPTY_ASSET: AssetCompositionProps = {
	asset: {
		url: '',
		proxyUrl: null,
		kind: 'audio',
		width: null,
		height: null,
		durationFlicks: null,
		hasAudio: false,
		rotation: 0,
	},
	fps: 30,
};

/** Compositions registered for @remotion/bundler (engine renders) and the Remotion Studio. */
export function RemotionRoot() {
	return (
		<>
			<Composition
				id={SEQUENCE_COMPOSITION_ID}
				component={SequenceComposition}
				defaultProps={{ doc: EMPTY_RENDER_DOC, options: { ...DEFAULT_RENDER_OPTIONS, isPreview: false } }}
				calculateMetadata={calculateSequenceMetadata}
				durationInFrames={1}
				fps={30}
				width={1920}
				height={1080}
			/>
			<Composition
				id={ASSET_COMPOSITION_ID}
				component={AssetComposition}
				defaultProps={EMPTY_ASSET}
				calculateMetadata={calculateAssetMetadata}
				durationInFrames={1}
				fps={30}
				width={1280}
				height={720}
			/>
		</>
	);
}
