import { Composition } from 'remotion';
import { calculateSequenceMetadata } from './metadata.ts';
import { SequenceComposition } from './SequenceComposition.tsx';
import {
	DEFAULT_RENDER_OPTIONS,
	EMPTY_RENDER_DOC,
	SEQUENCE_COMPOSITION_ID,
	type SequenceCompositionProps,
} from './types.ts';

export function RemotionRoot() {
	return (
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
	);
}
