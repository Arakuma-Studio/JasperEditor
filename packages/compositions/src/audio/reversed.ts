// Reversed audio for the preview and Remotion renders (workstream `time`): Remotion's <Audio> cannot play backwards,
// so a reversed clip plays a WAV of its media range decoded in the page (mediabunny, the decoder @remotion/media uses)
// and reversed sample by sample — the native export does the same with `areverse` (engine audio/decode.ts). The WAV
// keeps the source's channels and rate; the clip's channel map, levels, effects and the mix apply as for any clip.
import { ALL_FORMATS, AudioBufferSink, Input, UrlSource } from 'mediabunny';

const urls = new Map<string, Promise<string>>();

/** 16-bit PCM WAV of planar float channels (interleaved on write). */
export function encodeWav16(channels: Float32Array[], sampleRate: number): Uint8Array {
	const nc = Math.max(1, channels.length);
	const frames = channels[0]?.length ?? 0;
	const data = frames * nc * 2;
	const buf = new ArrayBuffer(44 + data);
	const v = new DataView(buf);
	const str = (o: number, s: string) => {
		for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
	};
	str(0, 'RIFF');
	v.setUint32(4, 36 + data, true);
	str(8, 'WAVE');
	str(12, 'fmt ');
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true);
	v.setUint16(22, nc, true);
	v.setUint32(24, sampleRate, true);
	v.setUint32(28, sampleRate * nc * 2, true);
	v.setUint16(32, nc * 2, true);
	v.setUint16(34, 16, true);
	str(36, 'data');
	v.setUint32(40, data, true);
	let o = 44;
	for (let i = 0; i < frames; i++)
		for (let c = 0; c < nc; c++) {
			const s = Math.max(-1, Math.min(1, channels[c]?.[i] ?? 0));
			v.setInt16(o, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
			o += 2;
		}
	return new Uint8Array(buf);
}

/** Reverses planar channels in place. */
export function reverseChannels(channels: Float32Array[]): Float32Array[] {
	for (const ch of channels) ch.reverse();
	return channels;
}

/**
 * Blob URL of the media's audio between `loSec` and `hiSec` (seconds from the start of the file), reversed: WAV time
 * 0 is media time `hiSec`. Cached per (src, range) for the page's life.
 */
export function reversedAudioUrl(src: string, loSec: number, hiSec: number): Promise<string> {
	const key = `${src}|${loSec.toFixed(6)}|${hiSec.toFixed(6)}`;
	const hit = urls.get(key);
	if (hit) return hit;
	const p = (async () => {
		const input = new Input({ source: new UrlSource(src), formats: ALL_FORMATS });
		try {
			const track = await input.getPrimaryAudioTrack();
			if (!track) throw new Error(`No audio track in ${src}`);
			const origin = await input.getFirstTimestamp();
			const rate = track.sampleRate;
			const nc = track.numberOfChannels;
			const n = Math.max(1, Math.round((hiSec - loSec) * rate));
			const out = Array.from({ length: nc }, () => new Float32Array(n));
			const sink = new AudioBufferSink(track);
			for await (const w of sink.buffers(origin + loSec, origin + hiSec)) {
				const b = w.buffer;
				const at = Math.round((w.timestamp - origin - loSec) * rate);
				for (let c = 0; c < nc; c++) {
					const ch = b.getChannelData(Math.min(c, b.numberOfChannels - 1));
					const from = Math.max(0, -at);
					const to = Math.min(ch.length, n - at);
					if (to > from) out[c]!.set(ch.subarray(from, to), at + from);
				}
			}
			const wav = encodeWav16(reverseChannels(out), rate);
			return URL.createObjectURL(new Blob([wav as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }));
		} finally {
			input.dispose();
		}
	})();
	urls.set(key, p);
	p.catch(() => urls.delete(key));
	return p;
}
