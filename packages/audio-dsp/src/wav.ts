/**
 * RIFF/WAVE encoding and decoding on plain `Uint8Array` / `DataView` (no Node or DOM APIs).
 */

/** Sample formats written by {@link encodeWav}. */
export type WavFormat = 'f32' | 's16' | 's24';

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/** Default WAVE channel masks (speaker positions) by channel count; 0 = unspecified. */
export function wavChannelMask(channels: number): number {
	switch (channels) {
		case 1:
			return 0x4; // FC
		case 2:
			return 0x3; // FL FR
		case 3:
			return 0x7; // FL FR FC
		case 4:
			return 0x33; // FL FR BL BR
		case 5:
			return 0x37; // FL FR FC BL BR
		case 6:
			return 0x3f; // FL FR FC LFE BL BR (5.1)
		case 8:
			return 0x63f; // FL FR FC LFE BL BR SL SR (7.1)
		default:
			return 0;
	}
}

// KSDATAFORMAT_SUBTYPE_{PCM,IEEE_FLOAT} GUID tail: xxxxxxxx-0000-0010-8000-00aa00389b71
const GUID_TAIL = [0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

function writeAscii(v: DataView, at: number, s: string): void {
	for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
}

/** Round half away from zero and clip to `[lo, hi]`. */
function quantize(x: number, scale: number, lo: number, hi: number): number {
	if (Number.isNaN(x)) return 0;
	const v = x * scale;
	const r = v < 0 ? -Math.floor(-v + 0.5) : Math.floor(v + 0.5);
	return r < lo ? lo : r > hi ? hi : r;
}

/**
 * Encode planar audio as a little-endian RIFF/WAVE file. `f32` is IEEE float; `s16` / `s24` are integer PCM
 * with plain rounding (no dither) and clipping (full scale = ±1.0 ↦ −2^(n−1) … 2^(n−1) − 1). More than two
 * channels (or 24-bit PCM) use WAVE_FORMAT_EXTENSIBLE with the channel mask of {@link wavChannelMask} (5.1 →
 * 0x3F, L R C LFE Ls Rs). Float files carry a `fact` chunk. All channels are truncated to the shortest one.
 */
export function encodeWav(planar: Float32Array[], sampleRate: number, format: WavFormat): Uint8Array {
	const nch = planar.length;
	if (nch === 0) throw new Error('encodeWav: no channels');
	const frames = Math.min(...planar.map((c) => c.length));
	const bits = format === 's16' ? 16 : format === 's24' ? 24 : 32;
	const bps = bits / 8;
	const isFloat = format === 'f32';
	// WAVE_FORMAT_EXTENSIBLE for > 2 channels (channel mask) and for 24-bit PCM; f32 mono/stereo stay format 3
	const extensible = nch > 2 || format === 's24';
	const fmtSize = extensible ? 40 : isFloat ? 18 : 16;
	const dataSize = frames * nch * bps;
	const factSize = isFloat ? 12 : 0;
	const pad = dataSize & 1;
	const total = 12 + 8 + fmtSize + factSize + 8 + dataSize + pad;
	const bytes = new Uint8Array(total);
	const v = new DataView(bytes.buffer);
	writeAscii(v, 0, 'RIFF');
	v.setUint32(4, total - 8, true);
	writeAscii(v, 8, 'WAVE');
	let p = 12;
	writeAscii(v, p, 'fmt ');
	v.setUint32(p + 4, fmtSize, true);
	p += 8;
	const tag = extensible ? WAVE_FORMAT_EXTENSIBLE : isFloat ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM;
	v.setUint16(p, tag, true);
	v.setUint16(p + 2, nch, true);
	v.setUint32(p + 4, Math.round(sampleRate), true);
	v.setUint32(p + 8, Math.round(sampleRate) * nch * bps, true);
	v.setUint16(p + 12, nch * bps, true);
	v.setUint16(p + 14, bits, true);
	if (extensible) {
		v.setUint16(p + 16, 22, true);
		v.setUint16(p + 18, bits, true);
		v.setUint32(p + 20, wavChannelMask(nch), true);
		v.setUint16(p + 24, isFloat ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM, true);
		v.setUint16(p + 26, 0, true);
		for (let i = 0; i < 12; i++) v.setUint8(p + 28 + i, GUID_TAIL[i]);
	} else if (isFloat) v.setUint16(p + 16, 0, true);
	p += fmtSize;
	if (isFloat) {
		writeAscii(v, p, 'fact');
		v.setUint32(p + 4, 4, true);
		v.setUint32(p + 8, frames, true);
		p += 12;
	}
	writeAscii(v, p, 'data');
	v.setUint32(p + 4, dataSize, true);
	p += 8;
	for (let i = 0; i < frames; i++) {
		for (let c = 0; c < nch; c++) {
			const x = planar[c][i];
			if (format === 'f32') v.setFloat32(p, x, true);
			else if (format === 's16') v.setInt16(p, quantize(x, 32768, -32768, 32767), true);
			else {
				const q = quantize(x, 8388608, -8388608, 8388607);
				v.setUint8(p, q & 0xff);
				v.setUint8(p + 1, (q >> 8) & 0xff);
				v.setUint8(p + 2, (q >> 16) & 0xff);
			}
			p += bps;
		}
	}
	return bytes;
}

/** Decoded WAVE audio. */
export type DecodedWav = {
	sampleRate: number;
	/** Planar samples, integers scaled to [−1, 1) (8-bit unsigned is re-centred). */
	channels: Float32Array[];
	/** Channel mask from WAVE_FORMAT_EXTENSIBLE (0 when absent). */
	channelMask: number;
	/** Bits per sample of the stored data. */
	bitsPerSample: number;
	/** Whether the stored data is floating point. */
	float: boolean;
};

function ascii(v: DataView, at: number): string {
	return String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));
}

/**
 * Decode a little-endian RIFF/WAVE (or RF64) file: PCM 8/16/24/32-bit integer, 32/64-bit float, plain or
 * WAVE_FORMAT_EXTENSIBLE. A `data` chunk size of 0 / 0xFFFFFFFF or past the end (streamed files) reads to
 * the end of the buffer; a trailing partial frame is dropped. Throws on anything else.
 */
export function decodeWav(bytes: Uint8Array): DecodedWav {
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.length < 12) throw new Error('decodeWav: too short');
	const riff = ascii(v, 0);
	if ((riff !== 'RIFF' && riff !== 'RF64') || ascii(v, 8) !== 'WAVE')
		throw new Error('decodeWav: not a RIFF/WAVE file');
	let p = 12;
	let fmt: { tag: number; nch: number; sr: number; align: number; bits: number; mask: number } | null = null;
	let dataStart = -1;
	let dataSize = 0;
	let ds64Data = -1;
	while (p + 8 <= bytes.length) {
		const id = ascii(v, p);
		let size = v.getUint32(p + 4, true);
		const body = p + 8;
		if (id === 'ds64' && size >= 16) {
			// RF64: 64-bit data size (low/high words)
			ds64Data = v.getUint32(body + 8, true) + v.getUint32(body + 12, true) * 2 ** 32;
		} else if (id === 'fmt ') {
			let tag = v.getUint16(body, true);
			const nch = v.getUint16(body + 2, true);
			const sr = v.getUint32(body + 4, true);
			const align = v.getUint16(body + 12, true);
			let bits = v.getUint16(body + 14, true);
			let mask = 0;
			if (tag === WAVE_FORMAT_EXTENSIBLE && size >= 40) {
				const valid = v.getUint16(body + 18, true);
				mask = v.getUint32(body + 20, true);
				tag = v.getUint16(body + 24, true);
				if (bits === 0) bits = valid;
			}
			fmt = { tag, nch, sr, align, bits, mask };
		} else if (id === 'data') {
			dataStart = body;
			if (riff === 'RF64' && size === 0xffffffff && ds64Data >= 0) size = ds64Data;
			dataSize = size === 0 || size === 0xffffffff || body + size > bytes.length ? bytes.length - body : size;
			break;
		}
		p = body + size + (size & 1);
	}
	if (!fmt) throw new Error('decodeWav: missing fmt chunk');
	if (dataStart < 0) throw new Error('decodeWav: missing data chunk');
	const { tag, nch, sr, bits, mask } = fmt;
	if (nch < 1) throw new Error('decodeWav: no channels');
	const isFloat = tag === WAVE_FORMAT_IEEE_FLOAT;
	if (!isFloat && tag !== WAVE_FORMAT_PCM) throw new Error(`decodeWav: unsupported format tag ${tag}`);
	if (isFloat && bits !== 32 && bits !== 64) throw new Error(`decodeWav: unsupported float width ${bits}`);
	if (!isFloat && bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32)
		throw new Error(`decodeWav: unsupported PCM width ${bits}`);
	const bps = bits / 8;
	const align = Math.max(fmt.align, nch * bps);
	const frames = Math.floor(dataSize / align);
	const channels = Array.from({ length: nch }, () => new Float32Array(frames));
	for (let i = 0; i < frames; i++) {
		const base = dataStart + i * align;
		for (let c = 0; c < nch; c++) {
			const q = base + c * bps;
			let x: number;
			if (isFloat) x = bits === 32 ? v.getFloat32(q, true) : v.getFloat64(q, true);
			else if (bits === 8) x = (v.getUint8(q) - 128) / 128;
			else if (bits === 16) x = v.getInt16(q, true) / 32768;
			else if (bits === 24) {
				const u = v.getUint8(q) | (v.getUint8(q + 1) << 8) | (v.getUint8(q + 2) << 16);
				x = ((u << 8) >> 8) / 8388608;
			} else x = v.getInt32(q, true) / 2147483648;
			channels[c][i] = x;
		}
	}
	return { sampleRate: sr, channels, channelMask: mask, bitsPerSample: bits, float: isFloat };
}
