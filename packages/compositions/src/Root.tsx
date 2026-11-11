import { Composition } from 'remotion';
import { AssetComposition, calculateAssetMetadata } from './AssetComposition.tsx';
import { calculateSequenceMetadata } from './metadata.ts';
import { SequenceComposition } from './SequenceComposition.tsx';
import {
	ASSET_COMPOSITION_ID,
	type AssetCompositionProps,
	SEQUENCE_COMPOSITION_ID,
	SEQUENCE_DEFAULT_PROPS,
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
				defaultProps={SEQUENCE_DEFAULT_PROPS}
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
