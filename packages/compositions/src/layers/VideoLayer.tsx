// Video layer (S03:KND-010/013, RND-020/021). The picture plays through @remotion/media <Video> in the
// Player and in renders (it falls back to <OffthreadVideo> by itself where WebCodecs cannot decode;
// see docs/research/remotion-4.0.499-notes.md). The element is muted: in the S01 model a clip's sound
// is its linked audio clip, played by AudioLayer with the volume callback.
import { Video } from '@remotion/media';
import { mediaSrc, trimBeforeFrames } from '../pipeline.ts';
import type { LayerProps } from '../types.ts';
import { LayerBox } from './LayerBox.tsx';

const MEDIA_STYLE = { width: '100%', height: '100%', display: 'block' } as const;

export function VideoLayer(layer: LayerProps) {
	const { clip, media, options, fps } = layer;
	if (!media) return null;
	return (
		<LayerBox layer={layer}>
			<Video
				src={mediaSrc(media, options)}
				trimBefore={trimBeforeFrames(clip.sourceIn, fps)}
				// Reverse playback needs a native retime proxy (S03:KND-015, M2); preview plays forward.
				playbackRate={clip.speed.rate}
				muted
				objectFit="fill"
				style={MEDIA_STYLE}
				showInTimeline={false}
			/>
		</LayerBox>
	);
}
