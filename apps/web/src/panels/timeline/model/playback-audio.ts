// pp-wma-preview: the timeline badge of an audio clip whose media the browser cannot decode (WMA, AC-3, ALAC…) while
// the engine makes its playback audio, or when that failed. The waveform comes from the engine's peaks either way;
// the badge says why the preview is silent. Null when nothing needs saying (the original plays, or the copy is ready).
import { type MediaAsset, needsPlaybackAudio } from '@jasper/project';
import type { MediaRuntime } from '@jasper/session';

export type PlaybackAudioBadge = { label: string; title: string; tone: 'busy' | 'failed' };

export function playbackAudioBadge(
	asset: MediaAsset | undefined,
	runtime: Pick<MediaRuntime, 'availability' | 'playbackAudio'> | undefined,
): PlaybackAudioBadge | null {
	if (!asset || !runtime || runtime.availability !== 'online' || !needsPlaybackAudio(asset)) return null;
	const st = runtime.playbackAudio;
	if (!st || st.state === 'ready') return null;
	if (st.state === 'failed')
		return {
			label: 'No playback audio',
			title: st.error
				? `The preview cannot play this clip's audio: making its playback copy failed (${st.error}). Exports are not affected.`
				: "The preview cannot play this clip's audio: making its playback copy failed. Exports are not affected.",
			tone: 'failed',
		};
	if (st.state === 'running') {
		const pct = Math.round(Math.min(1, Math.max(0, Number.isFinite(st.progress) ? st.progress : 0)) * 100);
		return {
			label: `Audio ${pct}%`,
			title:
				'Preparing audio the browser cannot decode for playback; the clip is silent in the preview until then',
			tone: 'busy',
		};
	}
	return {
		label: 'Audio queued',
		title:
			'Preparing audio the browser cannot decode for playback; the clip is silent in the preview until then',
		tone: 'busy',
	};
}
