// Minimal WAVE (RIFF) and AIFF containers for audio essence embedded in AAF / OMF documents. PCM inside the model is
// interleaved little-endian signed integers (8-bit unsigned for WAVE), as in WAVE files.
// Port of FilmCraft `crates/interchange/src/wav.rs` (MIT OR Apache-2.0).

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const eq = (b: Uint8Array, at: number, s: string) =>
	s.split('').every((c, i) => b[at + i] === c.charCodeAt(0));

export type Pcm = { pcm: Uint8Array; channels: number; sampleRate: number; bits: number };

/** The RIFF header of a WAVE file up to and including the `data` chunk header. */
export function wavHeader(dataLen: number, channels: number, sampleRate: number, bits: number): Uint8Array {
	const ch = Math.max(1, channels);
	const block = ch * Math.ceil(bits / 8);
	const out = new Uint8Array(44);
	const dv = new DataView(out.buffer);
	out.set(ascii('RIFF'), 0);
	dv.setUint32(4, Math.min(0xffffffff, 36 + dataLen + (dataLen & 1)), true);
	out.set(ascii('WAVEfmt '), 8);
	dv.setUint32(16, 16, true);
	dv.setUint16(20, 1, true);
	dv.setUint16(22, ch, true);
	dv.setUint32(24, sampleRate, true);
	dv.setUint32(28, Math.min(0xffffffff, sampleRate * block), true);
	dv.setUint16(32, block, true);
	dv.setUint16(34, bits, true);
	out.set(ascii('data'), 36);
	dv.setUint32(40, Math.min(0xffffffff, dataLen), true);
	return out;
}

/** A complete WAVE file around little-endian PCM. */
export function wavFile(pcm: Uint8Array, channels: number, sampleRate: number, bits: number): Uint8Array {
	const h = wavHeader(pcm.length, channels, sampleRate, bits);
	const out = new Uint8Array(h.length + pcm.length + (pcm.length & 1));
	out.set(h, 0);
	out.set(pcm, h.length);
	return out;
}

/** PCM, channels, sample rate and bits of a WAVE file (integer PCM only); null when it is not one. */
export function parseWav(b: Uint8Array): Pcm | null {
	if (b.length < 12 || !eq(b, 0, 'RIFF') || !eq(b, 8, 'WAVE')) return null;
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	let at = 12;
	let fmt: { channels: number; sampleRate: number; bits: number } | null = null;
	let guard = 0;
	while (at + 8 <= b.length && guard++ < 10_000) {
		const len = dv.getUint32(at + 4, true);
		const body = b.subarray(at + 8, Math.min(b.length, at + 8 + len));
		if (eq(b, at, 'fmt ') && body.length >= 16) {
			const tag = body[0]! | (body[1]! << 8);
			if (tag !== 1 && tag !== 0xfffe) return null;
			fmt = {
				channels: body[2]! | (body[3]! << 8),
				sampleRate: (body[4]! | (body[5]! << 8) | (body[6]! << 16) | (body[7]! << 24)) >>> 0,
				bits: body[14]! | (body[15]! << 8),
			};
		} else if (eq(b, at, 'data')) {
			if (!fmt) return null;
			return { pcm: body.slice(), ...fmt };
		}
		at += 8 + len + (len & 1);
	}
	return null;
}

/** 80-bit IEEE 754 extended (AIFF sample rates). */
function extended(x: number): Uint8Array {
	const out = new Uint8Array(10);
	if (x <= 0) return out;
	const e = Math.floor(Math.log2(x));
	const m = BigInt(Math.round((x / 2 ** e) * 2 ** 52)) << 11n;
	const exp = e + 16383;
	out[0] = (exp >> 8) & 0xff;
	out[1] = exp & 0xff;
	for (let i = 0; i < 8; i++) out[2 + i] = Number((m >> BigInt(56 - i * 8)) & 0xffn);
	return out;
}

function fromExtended(b: Uint8Array): number {
	const e = ((b[0]! << 8) | b[1]!) & 0x7fff;
	let m = 0n;
	for (let i = 0; i < 8; i++) m = (m << 8n) | BigInt(b[2 + i]!);
	if (e === 0 && m === 0n) return 0;
	return (Number(m) / 2 ** 63) * 2 ** (e - 16383);
}

/** The AIFF header up to the sound data (`FORM`, `COMM`, `SSND` with offset and block size). */
export function aiffHeader(frames: number, channels: number, sampleRate: number, bits: number): Uint8Array {
	const ch = Math.max(1, channels);
	const dataLen = frames * ch * Math.ceil(bits / 8);
	const out = new Uint8Array(54);
	const dv = new DataView(out.buffer);
	out.set(ascii('FORM'), 0);
	dv.setUint32(4, Math.min(0xffffffff, 4 + 26 + 16 + dataLen + (dataLen & 1)));
	out.set(ascii('AIFFCOMM'), 8);
	dv.setUint32(16, 18);
	dv.setUint16(20, ch);
	dv.setUint32(22, frames >>> 0);
	dv.setUint16(26, bits);
	out.set(extended(sampleRate), 28);
	out.set(ascii('SSND'), 38);
	dv.setUint32(42, Math.min(0xffffffff, 8 + dataLen));
	return out;
}

/** A complete AIFF file (big-endian PCM) from little-endian PCM. */
export function aiffFile(pcm: Uint8Array, channels: number, sampleRate: number, bits: number): Uint8Array {
	const bps = Math.max(1, Math.ceil(bits / 8));
	const frames = Math.floor(pcm.length / (bps * Math.max(1, channels)));
	const h = aiffHeader(frames, channels, sampleRate, bits);
	const n = Math.floor(pcm.length / bps) * bps;
	const pad = (h.length - 8 + n) % 2;
	const out = new Uint8Array(h.length + n + pad);
	out.set(h, 0);
	for (let i = 0; i < n; i += bps)
		for (let k = 0; k < bps; k++) out[h.length + i + k] = bps === 1 ? pcm[i]! ^ 0x80 : pcm[i + bps - 1 - k]!;
	return out;
}

/** PCM (converted to little-endian), channels, sample rate and bits of an AIFF / AIFF-C (`NONE`/`twos`/`sowt`) file. */
export function parseAiff(b: Uint8Array): Pcm | null {
	if (b.length < 12 || !eq(b, 0, 'FORM') || !(eq(b, 8, 'AIFF') || eq(b, 8, 'AIFC'))) return null;
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	let at = 12;
	let comm: { channels: number; sampleRate: number; bits: number; little: boolean } | null = null;
	let guard = 0;
	while (at + 8 <= b.length && guard++ < 10_000) {
		const len = dv.getUint32(at + 4);
		const body = b.subarray(at + 8, Math.min(b.length, at + 8 + len));
		if (eq(b, at, 'COMM') && body.length >= 18) {
			comm = {
				channels: (body[0]! << 8) | body[1]!,
				bits: (body[6]! << 8) | body[7]!,
				sampleRate: Math.round(fromExtended(body.subarray(8, 18))),
				little: body.length >= 22 && eq(body, 18, 'sowt'),
			};
		} else if (eq(b, at, 'SSND') && body.length >= 8) {
			if (!comm) return null;
			const off = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0);
			if (8 + off > body.length) return null;
			const data = body.subarray(8 + off);
			const bps = Math.max(1, Math.ceil(comm.bits / 8));
			const n = Math.floor(data.length / bps) * bps;
			const pcm = new Uint8Array(n);
			for (let i = 0; i < n; i += bps)
				for (let k = 0; k < bps; k++)
					pcm[i + k] = bps === 1 ? data[i]! ^ 0x80 : comm.little ? data[i + k]! : data[i + bps - 1 - k]!;
			return { pcm, channels: comm.channels, sampleRate: comm.sampleRate, bits: comm.bits };
		}
		at += 8 + len + (len & 1);
	}
	return null;
}
