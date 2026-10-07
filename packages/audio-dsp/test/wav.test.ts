import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeWav, encodeWav, wavChannelMask } from '../src/index.ts';

function dv(b: Uint8Array): DataView {
	return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function str(b: Uint8Array, at: number): string {
	return String.fromCharCode(...b.subarray(at, at + 4));
}

/** Hand-built WAV with an arbitrary fmt chunk body and data. */
function rawWav(fmt: number[], data: number[], extraChunk = false): Uint8Array {
	const chunks: number[] = [];
	const push4 = (s: string): void => {
		for (const ch of s) chunks.push(ch.charCodeAt(0));
	};
	const u32 = (v: number): void => {
		chunks.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
	};
	push4('RIFF');
	u32(0);
	push4('WAVE');
	if (extraChunk) {
		push4('LIST');
		u32(3);
		chunks.push(1, 2, 3, 0); // odd size + pad byte
	}
	push4('fmt ');
	u32(fmt.length);
	chunks.push(...fmt);
	push4('data');
	u32(data.length);
	chunks.push(...data);
	const b = new Uint8Array(chunks);
	dv(b).setUint32(4, b.length - 8, true);
	return b;
}

function fmtBody(tag: number, nch: number, sr: number, bits: number): number[] {
	const b = new Uint8Array(16);
	const v = dv(b);
	v.setUint16(0, tag, true);
	v.setUint16(2, nch, true);
	v.setUint32(4, sr, true);
	v.setUint32(8, (sr * nch * bits) / 8, true);
	v.setUint16(12, (nch * bits) / 8, true);
	v.setUint16(14, bits, true);
	return Array.from(b);
}

describe('WAV encode/decode', () => {
	it('f32 round trip is bit exact, mono/stereo use plain IEEE float with fact chunk', () => {
		const l = new Float32Array([0, 0.5, -1, 1.5, -2.25, 1e-30]);
		const r = new Float32Array([0.1, -0.1, 0.2, -0.2, 0.3, -0.3]);
		const bytes = encodeWav([l, r], 48000, 'f32');
		expect(str(bytes, 0)).toBe('RIFF');
		expect(str(bytes, 8)).toBe('WAVE');
		expect(dv(bytes).getUint16(20, true)).toBe(3);
		expect(str(bytes, 38)).toBe('fact');
		const d = decodeWav(bytes);
		expect(d.sampleRate).toBe(48000);
		expect(d.float).toBe(true);
		expect(d.channels[0]).toEqual(l);
		expect(d.channels[1]).toEqual(r);
	});

	it('6 channels use WAVE_FORMAT_EXTENSIBLE with the 5.1 mask', () => {
		const ch = Array.from({ length: 6 }, (_, c) => new Float32Array([c / 10, -c / 10]));
		for (const fmt of ['f32', 's16', 's24'] as const) {
			const bytes = encodeWav(ch, 44100, fmt);
			const v = dv(bytes);
			expect(v.getUint16(20, true)).toBe(0xfffe);
			expect(v.getUint16(22, true)).toBe(6);
			expect(v.getUint32(40, true)).toBe(0x3f);
			expect(v.getUint16(44, true)).toBe(fmt === 'f32' ? 3 : 1);
			const d = decodeWav(bytes);
			expect(d.channelMask).toBe(0x3f);
			expect(d.channels.length).toBe(6);
			const tol = fmt === 'f32' ? 0 : fmt === 's16' ? 1 / 32768 : 1 / 8388608;
			for (let c = 0; c < 6; c++) {
				for (let i = 0; i < 2; i++) expect(Math.abs(d.channels[c][i] - ch[c][i])).toBeLessThanOrEqual(tol);
			}
		}
		expect(wavChannelMask(2)).toBe(3);
		expect(wavChannelMask(7)).toBe(0);
	});

	it('integer formats round and clip', () => {
		const x = new Float32Array([1, -1, 2, -2, 0.5, 1 / 65536, -1 / 65536, 3 / 65536, Number.NaN]);
		const d16 = decodeWav(encodeWav([x], 8000, 's16')).channels[0];
		expect(Array.from(d16)).toEqual([
			32767 / 32768,
			-1,
			32767 / 32768,
			-1,
			0.5,
			1 / 32768,
			-1 / 32768,
			2 / 32768,
			0,
		]);
		const d24 = decodeWav(encodeWav([x], 8000, 's24')).channels[0];
		expect(d24[0]).toBe(8388607 / 8388608);
		expect(d24[3]).toBe(-1);
		expect(d24[5]).toBe(1 / 65536);
		expect(dv(encodeWav([x], 8000, 's16')).getUint16(20, true)).toBe(1);
	});

	it('decodes 8/16/24/32-bit PCM, 32/64-bit float, with unknown chunks and pad bytes', () => {
		const pcm8 = rawWav(fmtBody(1, 1, 8000, 8), [0, 128, 255], true);
		expect(Array.from(decodeWav(pcm8).channels[0])).toEqual([-1, 0, 127 / 128]);
		const pcm32 = rawWav(fmtBody(1, 1, 8000, 32), [0, 0, 0, 0x80, 0, 0, 0, 0x40]);
		expect(Array.from(decodeWav(pcm32).channels[0])).toEqual([-1, 0.5]);
		const f64 = new Uint8Array(16);
		dv(f64).setFloat64(0, 0.25, true);
		dv(f64).setFloat64(8, -0.125, true);
		const fl64 = rawWav(fmtBody(3, 1, 8000, 64), Array.from(f64));
		expect(Array.from(decodeWav(fl64).channels[0])).toEqual([0.25, -0.125]);
		const s24 = rawWav(fmtBody(1, 2, 96000, 24), [0xff, 0xff, 0x7f, 0x00, 0x00, 0x80, 0x01, 0x00, 0x00]);
		const d = decodeWav(s24);
		expect(d.sampleRate).toBe(96000);
		expect(d.channels[0][0]).toBe(8388607 / 8388608);
		expect(d.channels[1][0]).toBe(-1);
		expect(d.channels[0].length).toBe(1); // trailing partial frame dropped
	});

	it('streamed data size and errors', () => {
		const bytes = encodeWav([new Float32Array([0.5, 0.25])], 8000, 's16');
		const v = dv(bytes);
		const dataSizeAt = bytes.length - 4 - 4;
		expect(str(bytes, dataSizeAt - 4)).toBe('data');
		v.setUint32(dataSizeAt, 0xffffffff, true);
		expect(Array.from(decodeWav(bytes).channels[0])).toEqual([0.5, 0.25]);
		expect(() => decodeWav(new Uint8Array(4))).toThrow();
		expect(() => decodeWav(new Uint8Array(44))).toThrow(/RIFF/);
		expect(() => decodeWav(rawWav(fmtBody(2, 1, 8000, 16), [0, 0]))).toThrow(/format tag/);
		expect(() => encodeWav([], 8000, 'f32')).toThrow();
	});

	it('property: encode/decode round trip (f32 exact, integer within half an LSB)', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 8 }),
				fc.integer({ min: 0, max: 64 }),
				fc.constantFrom('f32' as const, 's16' as const, 's24' as const),
				fc.integer({ min: 8000, max: 192000 }),
				fc.array(fc.float({ min: -1, max: 1, noNaN: true }), { minLength: 512, maxLength: 512 }),
				(nch, frames, fmt, sr, pool) => {
					const ch = Array.from({ length: nch }, (_, c) =>
						Float32Array.from({ length: frames }, (_, i) => pool[(c * 61 + i) % pool.length]),
					);
					const d = decodeWav(encodeWav(ch, sr, fmt));
					if (d.sampleRate !== sr || d.channels.length !== nch) return false;
					const lsb = fmt === 's16' ? 1 / 32768 : fmt === 's24' ? 1 / 8388608 : 0;
					return ch.every((c, k) =>
						c.every((x, i) => {
							const y = d.channels[k][i];
							if (fmt === 'f32') return Object.is(y, x) || y === x;
							const clipped = Math.min(x, 1 - lsb);
							return Math.abs(y - clipped) <= lsb / 2 + 1e-12;
						}),
					);
				},
			),
			{ numRuns: 150 },
		);
	});
});
