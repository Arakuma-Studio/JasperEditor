// Visual data of a library sound (spec 12 §1 "Agents can't hear", §2.6; wp-note "WP1.2"): waveform peaks at 100/s and
// a 64-band log-frequency spectrogram, both u8, computed from the decoded analysis window and cached per content
// fingerprint in `<appdir>/sounds/cache/<fingerprintHex>/visual-v<n>.json`. The web panel and MCP contact sheets draw
// the same data.
import { join } from 'node:path';
import {
	SOUND_PEAKS_PER_SECOND,
	SOUND_SPECTROGRAM_BINS,
	SOUND_SPECTROGRAM_FLOOR_DB,
	SOUND_VISUAL_VERSION,
	type SoundVisual,
	SoundVisualSchema,
} from '@jasper/api';
import { Fft } from '@jasper/audio-dsp';
import { atomicWriteJson, readJsonOrNull } from '../tools/fs.ts';

export const SPECTROGRAM_MIN_HZ = 20;
export const SPECTROGRAM_MAX_HZ = 20_000;
/** At most this many spectrogram frames (longer windows use a longer hop). */
export const MAX_SPECTROGRAM_FRAMES = 3000;
const SPECTROGRAM_FPS = 100;

/** Path of the cached visual data of a fingerprint (hex part). */
export function visualCacheFile(cacheDir: string, fingerprintHex: string): string {
	return join(cacheDir, fingerprintHex, `visual-v${SOUND_VISUAL_VERSION}.json`);
}

const b64 = (u8: Uint8Array) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');

/** Max |sample| over channels per 1/perSecond s, as u8 (255 = full scale). NaN and ±Inf count as silence / full. */
export function computePeaks(channels: readonly Float32Array[], rate: number, perSecond: number): Uint8Array {
	const frames = channels.reduce((m, c) => Math.max(m, c.length), 0);
	if (frames === 0 || !(rate > 0)) return new Uint8Array(0);
	const hop = rate / perSecond;
	const count = Math.ceil(frames / hop);
	const out = new Uint8Array(count);
	for (let i = 0; i < count; i++) {
		const a = Math.floor(i * hop);
		const b = Math.min(frames, Math.floor((i + 1) * hop));
		let m = 0;
		for (const ch of channels) {
			const end = Math.min(b, ch.length);
			for (let j = a; j < end; j++) {
				const v = Math.abs(ch[j]!);
				if (v > m) m = v;
			}
		}
		out[i] = Number.isNaN(m) ? 0 : Math.round(Math.min(1, m) * 255);
	}
	return out;
}

type Spectrogram = { data: Uint8Array; frames: number; framesPerSecond: number; minHz: number; maxHz: number };

/**
 * Mono-mix power spectrogram: Hann frames of 2^k ≥ 40 ms, hop 10 ms (longer when the window would exceed
 * MAX_SPECTROGRAM_FRAMES), power summed over FFT bins inside each of `bins` log-spaced bands (a band narrower than a
 * bin takes the bin holding its centre), in dB re a full-scale sine (0 dB), mapped linearly from `floorDb` → 0 to
 * 0 dB → 255.
 */
export function computeSpectrogram(
	channels: readonly Float32Array[],
	rate: number,
	bins = SOUND_SPECTROGRAM_BINS,
	floorDb = SOUND_SPECTROGRAM_FLOOR_DB,
): Spectrogram {
	const frames0 = channels.reduce((m, c) => Math.max(m, c.length), 0);
	const maxHz = Math.max(SPECTROGRAM_MIN_HZ * 2, Math.min(SPECTROGRAM_MAX_HZ, rate / 2));
	const empty = { data: new Uint8Array(0), frames: 0, framesPerSecond: SPECTROGRAM_FPS, minHz: SPECTROGRAM_MIN_HZ, maxHz };
	if (frames0 === 0 || !(rate > 0) || channels.length === 0) return empty;
	// Mono mix (sanitised).
	const mono = new Float64Array(frames0);
	for (const ch of channels)
		for (let i = 0; i < ch.length; i++) {
			const v = ch[i]!;
			if (Number.isFinite(v)) mono[i] = mono[i]! + v / channels.length;
		}
	let n = 2;
	while (n < 0.04 * rate && n < 1 << 16) n *= 2;
	let hop = rate / SPECTROGRAM_FPS;
	let count = Math.max(1, Math.ceil(frames0 / hop));
	if (count > MAX_SPECTROGRAM_FRAMES) {
		count = MAX_SPECTROGRAM_FRAMES;
		hop = frames0 / count;
	}
	const fft = new Fft(n);
	const win = new Float64Array(n);
	let wsum = 0;
	for (let i = 0; i < n; i++) {
		win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
		wsum += win[i]!;
	}
	// A full-scale sine gives |X| = wsum / 2 at its bin: that is 0 dB.
	const ref = (wsum / 2) ** 2;
	const binHz = rate / n;
	const minHz = SPECTROGRAM_MIN_HZ;
	const ratio = maxHz / minHz;
	const lo = new Int32Array(bins);
	const hi = new Int32Array(bins);
	for (let b = 0; b < bins; b++) {
		const f0 = minHz * ratio ** (b / bins);
		const f1 = minHz * ratio ** ((b + 1) / bins);
		let k0 = Math.ceil(f0 / binHz);
		let k1 = Math.floor(f1 / binHz);
		if (k1 < k0) {
			const centre = Math.round(Math.sqrt(f0 * f1) / binHz);
			k0 = centre;
			k1 = centre;
		}
		lo[b] = Math.max(1, Math.min(n / 2, k0));
		hi[b] = Math.max(lo[b]!, Math.min(n / 2, k1));
	}
	const re = new Float64Array(n);
	const im = new Float64Array(n);
	const data = new Uint8Array(count * bins);
	const span = -floorDb;
	for (let f = 0; f < count; f++) {
		const centre = Math.round(f * hop + hop / 2);
		const start = centre - n / 2;
		for (let i = 0; i < n; i++) {
			const j = start + i;
			re[i] = j >= 0 && j < frames0 ? mono[j]! * win[i]! : 0;
			im[i] = 0;
		}
		fft.forward(re, im);
		for (let b = 0; b < bins; b++) {
			let p = 0;
			for (let k = lo[b]!; k <= hi[b]!; k++) p += re[k]! * re[k]! + im[k]! * im[k]!;
			const db = p > 0 ? 10 * Math.log10(p / ref) : -Infinity;
			const v = db <= floorDb ? 0 : db >= 0 ? 255 : Math.round(((db - floorDb) / span) * 255);
			data[f * bins + b] = Number.isFinite(v) ? v : 0;
		}
	}
	return { data, frames: count, framesPerSecond: Math.round((rate / hop) * 1000) / 1000, minHz, maxHz };
}

/** The visual data of decoded sound samples. */
export function computeVisual(o: {
	soundId: string;
	fingerprint: string;
	durationSec: number;
	peakSec: number;
	channels: readonly Float32Array[];
	rate: number;
}): SoundVisual {
	const frames = o.channels.reduce((m, c) => Math.max(m, c.length), 0);
	const peaks = computePeaks(o.channels, o.rate, SOUND_PEAKS_PER_SECOND);
	const spec = computeSpectrogram(o.channels, o.rate);
	return {
		version: SOUND_VISUAL_VERSION,
		soundId: o.soundId,
		fingerprint: o.fingerprint,
		durationSec: o.durationSec,
		coveredSec: o.rate > 0 ? Math.round((frames / o.rate) * 10_000) / 10_000 : 0,
		peakSec: o.peakSec,
		peaks: { perSecond: SOUND_PEAKS_PER_SECOND, count: peaks.length, data: b64(peaks) },
		spectrogram: {
			bins: SOUND_SPECTROGRAM_BINS,
			frames: spec.frames,
			framesPerSecond: spec.framesPerSecond,
			minHz: spec.minHz,
			maxHz: spec.maxHz,
			floorDb: SOUND_SPECTROGRAM_FLOOR_DB,
			data: b64(spec.data),
		},
	};
}

/** The cached visual data of a fingerprint, or null (missing, unreadable, another version or fingerprint). */
export async function readVisual(file: string, fingerprint: string): Promise<SoundVisual | null> {
	let raw: unknown;
	try {
		raw = await readJsonOrNull(file);
	} catch {
		return null;
	}
	const r = SoundVisualSchema.safeParse(raw);
	if (!r.success || r.data.version !== SOUND_VISUAL_VERSION || r.data.fingerprint !== fingerprint) return null;
	return r.data;
}

export async function writeVisual(file: string, visual: SoundVisual): Promise<void> {
	await atomicWriteJson(file, visual);
}
