// Clip audio decoded in the browser for the offline mixer (audio scrubbing): mediabunny (WebCodecs) reads the media
// URL, the content range of the clip span is decoded, mapped to the clip's channels, rate-changed by its speed and
// resampled to the mix rate with @jasper/audio-dsp's windowed-sinc resampler — the same clip chain the engine builds
// with ffmpeg for exports. pp-wma-preview: media whose audio the browser cannot decode are read from the engine's
// playback audio (one WAV per stream, `MediaHandle.playbackAudio`), silent while it is being made.
import { resample } from '@jasper/audio-dsp';
import {
	type ClipReader,
	FLICKS_PER_SECOND,
	filePieces,
	flicksPerFrame,
	frameToSample,
	type MediaHandle,
	type MediaTimeMap,
	type Rational,
	type RenderAudioClip,
} from '@jasper/project';
import { ALL_FORMATS, AudioBufferSink, Input, type InputAudioTrack, UrlSource } from 'mediabunny';

type Opened = { input: Input; tracks: InputAudioTrack[]; byIndex: Map<number, InputAudioTrack> };
const inputs = new Map<string, Promise<Opened | null>>();

async function openUrl(url: string): Promise<Opened | null> {
	try {
		const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url) });
		const all = await input.getTracks();
		const tracks: InputAudioTrack[] = [];
		const byIndex = new Map<number, InputAudioTrack>();
		all.forEach((t, i) => {
			if (t.isAudioTrack()) {
				tracks.push(t);
				byIndex.set(i, t);
			}
		});
		return tracks.length ? { input, tracks, byIndex } : null;
	} catch {
		return null;
	}
}

function opened(url: string): Promise<Opened | null> {
	let p = inputs.get(url);
	if (!p) {
		p = openUrl(url);
		inputs.set(url, p);
		// keep a bounded cache of open inputs
		if (inputs.size > 24) {
			const first = inputs.keys().next().value as string;
			const old = inputs.get(first);
			inputs.delete(first);
			void old?.then((o) => o?.input.dispose());
		}
	}
	return p;
}

/** Decoded planar samples of `[t0, t1)` seconds of a track at its own rate (silence where nothing decodes). */
async function decodeRange(
	track: InputAudioTrack,
	t0: number,
	t1: number,
): Promise<{ rate: number; data: Float32Array[] }> {
	const sink = new AudioBufferSink(track);
	const rate = track.sampleRate;
	const nch = track.numberOfChannels;
	const n = Math.max(0, Math.ceil((t1 - t0) * rate));
	const data = Array.from({ length: nch }, () => new Float32Array(n));
	if (n === 0) return { rate, data };
	for await (const wb of sink.buffers(Math.max(0, t0 - 0.05), t1)) {
		const b = wb.buffer;
		const off = Math.round((wb.timestamp - t0) * rate);
		for (let c = 0; c < Math.min(nch, b.numberOfChannels); c++) {
			const src = b.getChannelData(c);
			const from = Math.max(0, -off);
			const to = Math.min(src.length, n - off);
			if (to > from) data[c]!.set(src.subarray(from, to), off + from);
		}
	}
	return { rate, data };
}

/**
 * Decoded planar samples of interpreted media time [c0, c1) (flicks) at the track's rate: the file pieces
 * (`filePieces`) decoded one by one, each resampled from `scale` × the rate so that it spans its interpreted length.
 */
async function decodeMapped(
	track: InputAudioTrack,
	map: MediaTimeMap | undefined,
	c0: number,
	c1: number,
): Promise<{ rate: number; data: Float32Array[] }> {
	if (!map) return decodeRange(track, c0 / FLICKS_PER_SECOND, c1 / FLICKS_PER_SECOND);
	const rate = track.sampleRate;
	const nch = track.numberOfChannels;
	const total = Math.max(0, Math.ceil(((c1 - c0) / FLICKS_PER_SECOND) * rate));
	const data = Array.from({ length: nch }, () => new Float32Array(total));
	for (const piece of filePieces(map, c0, c1)) {
		const part = await decodeRange(
			track,
			piece.fileFrom / FLICKS_PER_SECOND,
			piece.fileTo / FLICKS_PER_SECOND,
		);
		const scaled =
			Math.abs(map.scale - 1) > 1e-9 ? resample(part.data, rate * map.scale, rate, 'fast') : part.data;
		const at = Math.round(((piece.from - c0) / FLICKS_PER_SECOND) * rate);
		for (let c = 0; c < nch; c++) {
			const src = scaled[c] ?? scaled[0];
			if (!src) continue;
			const n = Math.min(src.length, total - at);
			if (n > 0) data[c]!.set(src.subarray(0, n), at);
		}
	}
	return { rate, data };
}

/**
 * Where the browser reads stream `streamIndex` of a media from: the playback audio's WAV of that stream (its only
 * track), else the original (or the mandatory proxy) and the stream's track; null while the playback audio is not
 * ready (nothing the browser could decode).
 */
export function browserAudioSource(
	h: Pick<MediaHandle, 'url' | 'proxyUrl' | 'browserDecodable' | 'playbackAudio'>,
	streamIndex: number,
): { url: string; streamIndex: number } | null {
	if (h.playbackAudio === null) return null;
	if (h.playbackAudio) {
		const url = h.playbackAudio[String(streamIndex)] ?? Object.values(h.playbackAudio)[0];
		return url ? { url, streamIndex: 0 } : null;
	}
	return { url: h.proxyUrl && h.browserDecodable === false ? h.proxyUrl : h.url, streamIndex };
}

/**
 * An `OpenClip` for the offline mixer reading media from the browser. `media(mediaId)` returns the clip's media
 * handle (the Program doc's URL).
 */
export function browserOpenClip(media: (mediaId: string) => MediaHandle | null, fps: Rational) {
	return async (
		clip: RenderAudioClip,
		at: { offset: number; length: number; sampleRate: number },
	): Promise<ClipReader | null> => {
		const h = media(clip.mediaId);
		if (!h) return null;
		const at0 = browserAudioSource(h, clip.channels.streamIndex);
		if (!at0) return null;
		const o = await opened(at0.url);
		if (!o) return null;
		const track = o.byIndex.get(at0.streamIndex) ?? o.tracks[0]!;
		const sr = at.sampleRate;
		const F = flicksPerFrame(fps);
		const spf = (sr * fps.den) / fps.num;
		const s0 = frameToSample(clip.start - (clip.headHandle ?? 0), fps, sr);
		const u0 = (s0 + at.offset) / spf - clip.start;
		const u1 = (s0 + at.offset + at.length) / spf - clip.start;
		const rate = clip.speed.rate;
		const c0 = clip.speed.reverse
			? clip.sourceIn + (clip.duration - u1) * F * rate
			: clip.sourceIn + u0 * F * rate;
		const c1 = clip.speed.reverse
			? clip.sourceIn + (clip.duration - u0) * F * rate
			: clip.sourceIn + u1 * F * rate;
		const t0 = c0 / FLICKS_PER_SECOND;
		// imports (Interpret Footage): the file pieces of the interpreted range (assumed frame rate, loop), each
		// decoded and laid end to end in interpreted time (the sound follows the scale, pitch with it).
		const dec = await decodeMapped(track, clip.mediaTime, Math.max(0, c0), Math.max(0, c1));
		const lead = t0 < 0 ? Math.round((-t0 / rate) * sr) : 0;
		const map = clip.channels.map.length ? clip.channels.map : dec.data.map((_, i) => i);
		// gaps (Modify ▸ Audio Channels): muted clip channels are silent.
		const mute = clip.channels.mute ?? [];
		const chosen = map.map((i, o) => {
			const src = dec.data[i] ?? dec.data[0] ?? new Float32Array(0);
			return mute.includes(o) ? new Float32Array(src.length) : src;
		});
		// speed: the content plays `rate` times faster (pitch follows, like the preview); then the mix rate
		let out = resample(chosen, dec.rate * rate, sr, 'fast');
		if (clip.speed.reverse) out = out.map((c) => c.slice().reverse());
		const ch = Math.max(1, Math.min(6, out.length));
		let pos = 0;
		return {
			channels: ch,
			read(dst: Float32Array[], frames: number): number {
				const n = Math.min(frames, at.length - pos);
				if (n <= 0) return 0;
				for (let c = 0; c < ch; c++) {
					const src = out[c] ?? out[0]!;
					const d = dst[c]!;
					for (let i = 0; i < n; i++) {
						const k = pos + i - lead;
						d[i] = k >= 0 && k < src.length ? src[k]! : 0;
					}
				}
				pos += n;
				return n;
			},
			close() {},
		};
	};
}

/**
 * Decoded planar samples of a media file's audio stream over content time [c0, c1) flicks (interpreted media through
 * its time map), at the track's own rate; null when the browser cannot open it. Used by Detect Peak (sound design).
 */
export async function decodeMediaRange(
	url: string,
	streamIndex: number,
	c0: number,
	c1: number,
	map?: MediaTimeMap,
): Promise<{ rate: number; data: Float32Array[] } | null> {
	const o = await opened(url);
	if (!o) return null;
	const track = o.byIndex.get(streamIndex) ?? o.tracks[0]!;
	return decodeMapped(track, map, Math.max(0, c0), Math.max(0, c1));
}
