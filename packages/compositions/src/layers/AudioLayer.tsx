// Audio layer — stub from WP-00 (renders nothing); WP-2C plays the clip with @remotion/media and a
// volume callback from the evaluated volumeDb/pan (S03:KND-010/011).
import type { MediaHandle, RenderAudioClip } from '@jasper/project';
import type { RenderOptions } from '../types.ts';

export type AudioLayerProps = {
	clip: RenderAudioClip;
	media: MediaHandle | null;
	fps: number;
	options: RenderOptions;
};

export function AudioLayer(_props: AudioLayerProps) {
	return null;
}
