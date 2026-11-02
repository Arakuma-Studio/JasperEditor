// Spec 19 TL-116: which pixels of a frame an output cannot hold. Video only; print gamuts are a non-goal (spec §1).
//
// Gamut: the working signal in the output's linear light with nothing mapped (`unmappedOutputFn`): a channel below 0 is a
// colour outside the output's primaries, one above `peak` is brighter than it can show. Exports gamut-compress these, so
// this shows what will change.
//
// Legal range: EBU R 103 (v3.0, 2020) limits on the signal an encoder delivers, RGB components within −5 % … +105 % and
// luma within −1 % … +103 %. Full-range RGB cannot break them by itself: every 8-bit value maps inside the narrow range.
// What breaks them is 4:2:0: Y′ keeps its detail while Cb and Cr are averaged over 2 × 2 pixels, so a thin saturated rim
// on a dark background comes back out of range. So each pixel is rebuilt as a player would rebuild it, from its own Y′
// and its block's chroma, with BT.709 or BT.2020 luma weights (BT.709-6, BT.2020-2 §4). R 103 tolerates excursions over
// less than 1 % of the picture; the percentage reported is there to compare with that.
//
// Assumption, not from a standard: chroma is rebuilt by nearest neighbour; a real decoder interpolates, which softens the
// rebuilt edge. The check is therefore a little stricter than a scope after a real decoder.
import { gamutLuma } from './cms/gamut.ts';
import { colorSpace } from './cms/spaces.ts';
import { outputTransformFn, unmappedOutputFn, type WorkingColorSettings } from './cms/transform.ts';
import type { Rgb } from './lut.ts';

/** A rounding step of an 8-bit signal in linear light near white: smaller excursions are not colours, they are noise. */
const EPSILON = 1 / 512;
const RGB_LOW = -0.05;
const RGB_HIGH = 1.05;
const LUMA_LOW = -0.01;
const LUMA_HIGH = 1.03;

/** `rgba` holds this flag per pixel in the mask's red (`gamut`) and green (`legal`) bits. */
export const GAMUT_FLAG = 1;
export const LEGAL_FLAG = 2;

export type GamutCheck = {
	/** Per pixel: `GAMUT_FLAG | LEGAL_FLAG`. */
	flags: Uint8Array;
	gamutPercent: number;
	legalPercent: number;
	anyPercent: number;
};

/** Each pixel of the frame judged against `output` (a `colorSpace` id). `rgba`'s alpha is ignored: frames are composites. */
export function checkGamut(
	rgba: Uint8Array,
	width: number,
	height: number,
	working: WorkingColorSettings,
	output: string,
): GamutCheck {
	const o = colorSpace(output);
	if (!o) throw new RangeError(`Unknown colour space "${output}"`);
	const n = width * height;
	const flags = new Uint8Array(n);
	if (n === 0) return { flags, gamutPercent: 0, legalPercent: 0, anyPercent: 0 };
	const { fn: toLinear, peak } = unmappedOutputFn(working, o);
	const toSignal = outputTransformFn(working, o);
	const [kr, kg, kb] = gamutLuma(o.gamut);
	const db = 2 * (1 - kb);
	const dr = 2 * (1 - kr);
	const luma = new Float32Array(n);
	const cb = new Float32Array(n);
	const cr = new Float32Array(n);
	const c: Rgb = [0, 0, 0];
	// Pictures repeat colours: most frames hold far fewer than 2^24 of them.
	const seen = new Map<number, number>();
	let gamut = 0;
	for (let i = 0; i < n; i++) {
		const r = rgba[i * 4]!;
		const g = rgba[i * 4 + 1]!;
		const b = rgba[i * 4 + 2]!;
		const key = (r << 16) | (g << 8) | b;
		let out = seen.get(key);
		if (out === undefined) {
			c[0] = r / 255;
			c[1] = g / 255;
			c[2] = b / 255;
			toLinear(c);
			out = 0;
			const high = peak + EPSILON;
			if (c[0] < -EPSILON || c[1] < -EPSILON || c[2] < -EPSILON || c[0] > high || c[1] > high || c[2] > high)
				out = GAMUT_FLAG;
			if (seen.size < 1 << 20) seen.set(key, out);
		}
		if (out) {
			flags[i] = GAMUT_FLAG;
			gamut++;
		}
		c[0] = r / 255;
		c[1] = g / 255;
		c[2] = b / 255;
		toSignal?.(c);
		const y = kr * c[0] + kg * c[1] + kb * c[2];
		luma[i] = y;
		cb[i] = (c[2] - y) / db;
		cr[i] = (c[0] - y) / dr;
	}
	let legal = 0;
	let any = gamut;
	for (let y = 0; y < height; y += 2) {
		for (let x = 0; x < width; x += 2) {
			const x1 = Math.min(x + 1, width - 1);
			const y1 = Math.min(y + 1, height - 1);
			const a = y * width + x;
			const b = y * width + x1;
			const d = y1 * width + x;
			const e = y1 * width + x1;
			const mb = (cb[a]! + cb[b]! + cb[d]! + cb[e]!) / 4;
			const mr = (cr[a]! + cr[b]! + cr[d]! + cr[e]!) / 4;
			for (const i of a === b && a === d ? [a] : a === b ? [a, d] : a === d ? [a, b] : [a, b, d, e]) {
				const ly = luma[i]!;
				const R = ly + dr * mr;
				const B = ly + db * mb;
				const G = (ly - kr * R - kb * B) / kg;
				if (
					ly < LUMA_LOW ||
					ly > LUMA_HIGH ||
					R < RGB_LOW ||
					R > RGB_HIGH ||
					G < RGB_LOW ||
					G > RGB_HIGH ||
					B < RGB_LOW ||
					B > RGB_HIGH
				) {
					if (!flags[i]) any++;
					flags[i] = flags[i]! | LEGAL_FLAG;
					legal++;
				}
			}
		}
	}
	return {
		flags,
		gamutPercent: (gamut / n) * 100,
		legalPercent: (legal / n) * 100,
		anyPercent: (any / n) * 100,
	};
}

/** An RGBA picture of the flags: straight colours, transparent where a pixel passes. */
export function gamutMask(check: GamutCheck, width: number, height: number): Uint8Array {
	const px = new Uint8Array(width * height * 4);
	for (let i = 0; i < check.flags.length; i++) {
		const f = check.flags[i]!;
		if (!f) continue;
		const o = i * 4;
		// Magenta for gamut (it wins: the colour itself cannot exist), amber for legal range.
		px[o] = 255;
		px[o + 1] = f & GAMUT_FLAG ? 0 : 176;
		px[o + 2] = f & GAMUT_FLAG ? 255 : 0;
		px[o + 3] = 255;
	}
	return px;
}
