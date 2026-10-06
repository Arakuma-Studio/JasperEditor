// Film-stock model of S_FilmEffect (family-private): a negative (characteristic curve: density vs log exposure, a
// sigmoid with toe and shoulder, per-channel contrast) printed on a print stock (another sigmoid), with printer
// lights. The stock tables are this family's own approximations of each stock's published character (contrast,
// saturation, colour bias), not measured data. `filmStockUniforms` solves the per-channel printer offsets that keep
// an 18 % grey neutral at the default lights (25-25-25), so every stock pair is balanced; the shader evaluates the
// same curves (see S_FilmEffect in film.ts).
import type { EffectParams } from '../../effects.ts';
import type { FxUniformValue } from '../shader.ts';
import { num } from './common.ts';

type V3 = [number, number, number];

export type NegStock = { label: string; gamma: V3; sat: number; bias: V3 };
export type PrintStock = {
	label: string;
	gamma: V3;
	range: number;
	sat: number;
	tint: V3;
	reversal?: boolean;
};

/** Negative stocks (Sapphire's "Neg Film" options, in order). */
export const NEG_STOCKS: Record<string, NegStock> = {
	none: { label: 'None', gamma: [1, 1, 1], sat: 1, bias: [1, 1, 1] },
	k5245: { label: 'Kodak 5245 (EXR 50D)', gamma: [0.6, 0.62, 0.65], sat: 1.08, bias: [1.02, 1, 0.97] },
	k5246: { label: 'Kodak 5246 (VISION 250D)', gamma: [0.6, 0.6, 0.62], sat: 1.02, bias: [1.01, 1, 0.98] },
	k5248: { label: 'Kodak 5248 (EXR 100T)', gamma: [0.62, 0.62, 0.66], sat: 1.05, bias: [0.98, 1, 1.03] },
	k5274: { label: 'Kodak 5274 (VISION 200T)', gamma: [0.58, 0.6, 0.62], sat: 0.98, bias: [0.99, 1, 1.02] },
	k5277: { label: 'Kodak 5277 (VISION 320T)', gamma: [0.54, 0.55, 0.57], sat: 0.94, bias: [0.99, 1, 1.02] },
	k5279: { label: 'Kodak 5279 (VISION 500T)', gamma: [0.6, 0.6, 0.62], sat: 1, bias: [0.99, 1, 1.02] },
	k5284: {
		label: 'Kodak 5284 (VISION Expression 500T)',
		gamma: [0.5, 0.5, 0.52],
		sat: 0.9,
		bias: [1, 1, 1.01],
	},
	k5289: { label: 'Kodak 5289 (VISION 800T)', gamma: [0.62, 0.62, 0.64], sat: 1.02, bias: [0.98, 1, 1.03] },
	k5293: { label: 'Kodak 5293 (EXR 200T)', gamma: [0.62, 0.63, 0.66], sat: 1.05, bias: [0.98, 1, 1.03] },
	k5298: { label: 'Kodak 5298 (EXR 500T)', gamma: [0.6, 0.62, 0.66], sat: 1, bias: [0.98, 1, 1.03] },
	ksfx200t: { label: 'K SFX200T', gamma: [0.7, 0.7, 0.74], sat: 1.12, bias: [0.98, 1, 1.04] },
	k5217: { label: 'Kodak 5217 (Vision2 200T)', gamma: [0.6, 0.6, 0.62], sat: 1, bias: [0.99, 1, 1.02] },
	k5218: { label: 'Kodak 5218 (Vision2 500T)', gamma: [0.6, 0.6, 0.61], sat: 0.98, bias: [0.99, 1, 1.02] },
};

/** Print stocks (Sapphire's "Print Film" options, in order). The two reversal stocks ignore the negative. */
export const PRINT_STOCKS: Record<string, PrintStock> = {
	none: { label: 'None', gamma: [1, 1, 1], range: 3, sat: 1, tint: [1, 1, 1] },
	k2383: { label: 'Kodak 2383', gamma: [2.55, 2.6, 2.7], range: 3.6, sat: 1.05, tint: [1, 1, 0.99] },
	k2393: { label: 'Kodak 2393', gamma: [2.8, 2.85, 2.95], range: 3.8, sat: 1.1, tint: [1, 1, 1] },
	k2395: { label: 'Kodak 2395', gamma: [1.7, 1.7, 1.75], range: 2.6, sat: 0.92, tint: [1, 1, 1] },
	k5386: { label: 'Kodak 5386', gamma: [2.5, 2.5, 2.6], range: 3.4, sat: 1, tint: [1.02, 1, 0.95] },
	k5285: {
		label: 'Kodak 5285 Rev',
		gamma: [1.6, 1.62, 1.7],
		range: 3.4,
		sat: 1.15,
		tint: [0.97, 1, 1.04],
		reversal: true,
	},
	k7270: {
		label: 'Kodak 7270 Rev',
		gamma: [1.7, 1.65, 1.6],
		range: 3.6,
		sat: 1.25,
		tint: [1.04, 1, 0.93],
		reversal: true,
	},
};

/** Density range of the negatives (the sigmoid's height). */
export const NEG_RANGE = 2.4;
/** log10 of the mid-grey exposure. */
export const E_GREY = Math.log10(0.18);

const logit = (y: number) => Math.log(y / (1 - y));

/**
 * Uniforms of the stock pair: curve slopes/ranges, the per-channel print offsets (balanced for a neutral grey, then
 * moved by the printer lights and Print Exposure), saturation and tint.
 */
export function filmStockUniforms(p: EffectParams): Record<string, FxUniformValue> {
	const pr = PRINT_STOCKS[String(p.printFilm)] ?? PRINT_STOCKS.k2383!;
	const ng = pr.reversal ? NEG_STOCKS.none! : (NEG_STOCKS[String(p.negFilm)] ?? NEG_STOCKS.k5245!);
	const printNone = String(p.printFilm) === 'none';
	// Print density of a grey: −log10(0.18) (a neutral grey stays an 18 % grey on the screen).
	const target = -Math.log10(0.18);
	const lights = [num(p.printLightsRed, 25), num(p.printLightsGreen, 25), num(p.printLightsBlue, 25)];
	const offset = [0, 1, 2].map((c) => {
		const gp = pr.gamma[c]!;
		const ep = (pr.range / (4 * gp)) * logit(Math.min(0.999, target / pr.range));
		// the negative's density of a grey is half its range (the curve is centred on the grey)
		const balance = ep + NEG_RANGE / 2;
		return balance + (lights[c]! - 25) * 0.025 + num(p.printExposure) * 0.30103;
	}) as V3;
	// Normalise the output so a video white prints at ≈ 92 % (green channel, default lights): film compresses the
	// highlights, this keeps the picture's overall brightness close to the source.
	const sig = (x: number) => 1 / (1 + Math.exp(-x));
	const dnWhite = NEG_RANGE * sig((4 * ng.gamma[1] * (0 - E_GREY)) / NEG_RANGE);
	const gp = pr.gamma[1];
	const epBal = (pr.range / (4 * gp)) * logit(Math.min(0.999, target / pr.range)) + NEG_RANGE / 2;
	const whiteT = 10 ** -(pr.range * sig((4 * gp * (epBal - dnWhite)) / pr.range));
	return {
		u_outScale: printNone ? 1 : Math.min(2, 0.92 / Math.max(whiteT, 1e-3)),
		u_negGamma: ng.gamma,
		u_negSat: ng.sat,
		u_negBias: ng.bias,
		u_printGamma: pr.gamma,
		u_printRange: pr.range,
		u_printSat: pr.sat,
		u_printTint: pr.tint,
		u_printOffset: offset,
		u_printNone: printNone,
	};
}
