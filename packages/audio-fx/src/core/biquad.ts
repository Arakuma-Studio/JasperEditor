// Second-order IIR sections: RBJ "Audio EQ Cookbook" designs (R. Bristow-Johnson), transposed direct form II
// (port of filmcraft `biquad.rs`).
import { flush } from './math.ts';

export type FilterType =
	| 'peaking'
	| 'lowShelf'
	| 'highShelf'
	| 'lowPass'
	| 'highPass'
	| 'notch'
	| 'bandPass'
	| 'allPass'
	/**
	 * Constant-bandwidth cut: `1 + (g − 1)·BP(s)` — the −3 dB width of the band-pass stays `f/Q` however deep the
	 * cut (`gainDb` ≤ 0), unlike the RBJ peaking filter whose cut widens with depth. Used by the Notch Filter.
	 */
	| 'cut';

/** Order of the parametric EQs' band `type` choice. */
export const FILTER_TYPES: readonly FilterType[] = [
	'peaking',
	'lowShelf',
	'highShelf',
	'lowPass',
	'highPass',
	'notch',
	'bandPass',
];

/** Normalised biquad coefficients (`a0 == 1`). */
export type Coeffs = { b0: number; b1: number; b2: number; a1: number; a2: number };

export const IDENTITY: Readonly<Coeffs> = Object.freeze({ b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 });

function norm(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Coeffs {
	return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/**
 * RBJ cookbook design. `freq` in Hz (clamped to 1 Hz … 0.49·fs), `q` > 0, `gainDb` used by peaking, shelving and
 * cut types (shelves use `q` as the shelf "Q": S = 1 ≙ Q = 1/√2).
 */
export function designBiquad(
	kind: FilterType,
	sampleRate: number,
	freq: number,
	q: number,
	gainDb: number,
): Coeffs {
	const f = Math.min(Math.max(freq, 1), sampleRate * 0.49);
	const qq = Math.max(q, 1e-3);
	const w0 = (2 * Math.PI * f) / sampleRate;
	const sn = Math.sin(w0);
	const cs = Math.cos(w0);
	const alpha = sn / (2 * qq);
	const a = 10 ** (gainDb / 40);
	switch (kind) {
		case 'lowPass':
			return norm((1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + alpha, -2 * cs, 1 - alpha);
		case 'highPass':
			return norm((1 + cs) / 2, -(1 + cs), (1 + cs) / 2, 1 + alpha, -2 * cs, 1 - alpha);
		case 'bandPass':
			return norm(alpha, 0, -alpha, 1 + alpha, -2 * cs, 1 - alpha);
		case 'notch':
			return norm(1, -2 * cs, 1, 1 + alpha, -2 * cs, 1 - alpha);
		case 'allPass':
			return norm(1 - alpha, -2 * cs, 1 + alpha, 1 + alpha, -2 * cs, 1 - alpha);
		case 'cut': {
			const g = 10 ** (gainDb / 20);
			return norm(1 + g * alpha, -2 * cs, 1 - g * alpha, 1 + alpha, -2 * cs, 1 - alpha);
		}
		case 'peaking':
			return norm(1 + alpha * a, -2 * cs, 1 - alpha * a, 1 + alpha / a, -2 * cs, 1 - alpha / a);
		case 'lowShelf': {
			const k = 2 * Math.sqrt(a) * alpha;
			return norm(
				a * (a + 1 - (a - 1) * cs + k),
				2 * a * (a - 1 - (a + 1) * cs),
				a * (a + 1 - (a - 1) * cs - k),
				a + 1 + (a - 1) * cs + k,
				-2 * (a - 1 + (a + 1) * cs),
				a + 1 + (a - 1) * cs - k,
			);
		}
		case 'highShelf': {
			const k = 2 * Math.sqrt(a) * alpha;
			return norm(
				a * (a + 1 + (a - 1) * cs + k),
				-2 * a * (a - 1 + (a + 1) * cs),
				a * (a + 1 + (a - 1) * cs - k),
				a + 1 - (a - 1) * cs + k,
				2 * (a - 1 - (a + 1) * cs),
				a + 1 - (a - 1) * cs - k,
			);
		}
	}
}

/** |H(e^{jω})| at `freq` Hz. */
export function magnitude(c: Coeffs, freq: number, sampleRate: number): number {
	const w = (2 * Math.PI * freq) / sampleRate;
	const s1 = Math.sin(w);
	const c1 = Math.cos(w);
	const s2 = Math.sin(2 * w);
	const c2 = Math.cos(2 * w);
	const nr = c.b0 + c.b1 * c1 + c.b2 * c2;
	const ni = -(c.b1 * s1 + c.b2 * s2);
	const dr = 1 + c.a1 * c1 + c.a2 * c2;
	const di = -(c.a1 * s1 + c.a2 * s2);
	return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
}

/** Magnitude in dB. */
export function magnitudeDb(c: Coeffs, freq: number, sampleRate: number): number {
	return 20 * Math.log10(magnitude(c, freq, sampleRate));
}

/** One biquad section's state (TDF-II, f64). */
export class Biquad {
	s1 = 0;
	s2 = 0;

	tick(c: Coeffs, x: number): number {
		const y = c.b0 * x + this.s1;
		this.s1 = flush(c.b1 * x - c.a1 * y + this.s2);
		this.s2 = flush(c.b2 * x - c.a2 * y);
		return y;
	}

	reset(): void {
		this.s1 = 0;
		this.s2 = 0;
	}

	/** Filter `buf[start..end)` in place. */
	process(c: Coeffs, buf: Float32Array, start = 0, end = buf.length): void {
		for (let i = start; i < end; i++) buf[i] = this.tick(c, buf[i]!);
	}
}
