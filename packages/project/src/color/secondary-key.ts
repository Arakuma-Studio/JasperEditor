// HSL Secondary eyedroppers (color-grade): Set Color, Add Color and Remove Color turn a picked colour into the key's
// H / S / L ranges (Premiere: "Set color" samples the colour to select, "+" adds a sampled colour to the selection,
// "−" removes one). Pure functions over the key params of `jasper.lumetri`; the panel writes the result in one
// transaction.
import { rgbToHsl } from './grade-math.ts';

export type SecondaryKey = {
	secHueOn: boolean;
	secHueCenter: number;
	secHueRange: number;
	secHueSoft: number;
	secSatOn: boolean;
	secSatLow: number;
	secSatHigh: number;
	secSatSoft: number;
	secLumaOn: boolean;
	secLumaLow: number;
	secLumaHigh: number;
	secLumaSoft: number;
};

export const DEFAULT_SECONDARY_KEY: SecondaryKey = {
	secHueOn: true,
	secHueCenter: 0,
	secHueRange: 180,
	secHueSoft: 0,
	secSatOn: true,
	secSatLow: 0,
	secSatHigh: 100,
	secSatSoft: 0,
	secLumaOn: true,
	secLumaLow: 0,
	secLumaHigh: 100,
	secLumaSoft: 0,
};

/** Tolerances of Set Color around the picked colour (degrees / percent). */
const HUE_HALF = 15;
const HUE_SOFT = 15;
const SAT_HALF = 25;
const LUMA_HALF = 30;
const BAND_SOFT = 10;
/** Margin Add/Remove leave around a picked value. */
const MARGIN_HUE = 5;
const MARGIN_BAND = 5;
/** Below this saturation (%) a colour has no usable hue. */
const GREY_SAT = 5;

const r1 = (v: number) => Math.round(v * 10) / 10;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const wrap = (d: number) => ((d % 360) + 360) % 360;
/** Signed shortest angle from a to b (−180…180]. */
const delta = (a: number, b: number) => {
	const d = wrap(b - a);
	return d > 180 ? d - 360 : d;
};

function hsl(rgb: readonly [number, number, number]) {
	const out = rgbToHsl(rgb[0], rgb[1], rgb[2], [0, 0, 0]);
	return { h: out[0] * 360, s: out[1] * 100, l: out[2] * 100 };
}

/** Set Color: a key centred on the picked colour (greys key on lightness only). */
export function keyFromColor(rgb: readonly [number, number, number]): SecondaryKey {
	const { h, s, l } = hsl(rgb);
	const grey = s < GREY_SAT;
	return {
		secHueOn: !grey,
		secHueCenter: r1(h),
		secHueRange: grey ? 180 : HUE_HALF,
		secHueSoft: grey ? 0 : HUE_SOFT,
		secSatOn: true,
		secSatLow: r1(clamp(s - SAT_HALF, 0, 100)),
		secSatHigh: r1(clamp(s + SAT_HALF, 0, 100)),
		secSatSoft: BAND_SOFT,
		secLumaOn: true,
		secLumaLow: r1(clamp(l - LUMA_HALF, 0, 100)),
		secLumaHigh: r1(clamp(l + LUMA_HALF, 0, 100)),
		secLumaSoft: BAND_SOFT,
	};
}

/** Add Color: widens the ranges just enough to include the picked colour (plus a margin). */
export function addColorToKey(key: SecondaryKey, rgb: readonly [number, number, number]): SecondaryKey {
	const { h, s, l } = hsl(rgb);
	const out = { ...key };
	if (out.secHueOn && out.secHueRange < 180 && s >= GREY_SAT) {
		// The arc [c − r, c + r] grows towards the picked hue on its nearer side.
		const d = delta(out.secHueCenter, h);
		if (Math.abs(d) > out.secHueRange) {
			const lo = out.secHueCenter - out.secHueRange;
			const hi = out.secHueCenter + out.secHueRange;
			const [nlo, nhi] =
				d > 0 ? [lo, out.secHueCenter + d + MARGIN_HUE] : [out.secHueCenter + d - MARGIN_HUE, hi];
			const half = (nhi - nlo) / 2;
			out.secHueCenter = r1(wrap(nlo + half));
			out.secHueRange = r1(Math.min(180, half));
		}
	}
	if (out.secSatOn) {
		if (s < out.secSatLow) out.secSatLow = r1(clamp(s - MARGIN_BAND, 0, 100));
		if (s > out.secSatHigh) out.secSatHigh = r1(clamp(s + MARGIN_BAND, 0, 100));
	}
	if (out.secLumaOn) {
		if (l < out.secLumaLow) out.secLumaLow = r1(clamp(l - MARGIN_BAND, 0, 100));
		if (l > out.secLumaHigh) out.secLumaHigh = r1(clamp(l + MARGIN_BAND, 0, 100));
	}
	return out;
}

/**
 * Remove Color: moves the range edge nearest to the picked colour past it (plus a margin), on the axis where that
 * takes the smallest change — the picked colour falls outside the key.
 */
export function removeColorFromKey(key: SecondaryKey, rgb: readonly [number, number, number]): SecondaryKey {
	const { h, s, l } = hsl(rgb);
	const out = { ...key };
	type Cut = { cost: number; apply(): void };
	const cuts: Cut[] = [];
	if (out.secHueOn && s >= GREY_SAT) {
		const range = Math.min(180, out.secHueRange);
		const d = delta(out.secHueCenter, h);
		if (Math.abs(d) <= range) {
			const lo = out.secHueCenter - range;
			const hi = out.secHueCenter + range;
			// Cut the arc on the picked side.
			// The soft edge must clear the picked hue too.
			const m = MARGIN_HUE + out.secHueSoft;
			const [nlo, nhi] = d >= 0 ? [lo, out.secHueCenter + d - m] : [out.secHueCenter + d + m, hi];
			const half = Math.max(0.5, (nhi - nlo) / 2);
			cuts.push({
				cost: range - half,
				apply: () => {
					out.secHueCenter = r1(wrap(nlo + half));
					out.secHueRange = r1(half);
				},
			});
		}
	}
	const band = (
		low: 'secSatLow' | 'secLumaLow',
		high: 'secSatHigh' | 'secLumaHigh',
		soft: number,
		v: number,
		on: boolean,
	) => {
		if (!on || v < out[low] || v > out[high]) return;
		const up = v + MARGIN_BAND + soft;
		const down = v - MARGIN_BAND - soft;
		// Raise the low edge above v, or lower the high edge below it — whichever keeps more of the range.
		if (v - out[low] <= out[high] - v)
			cuts.push({ cost: up - out[low], apply: () => void (out[low] = r1(clamp(up, 0, out[high]))) });
		else
			cuts.push({ cost: out[high] - down, apply: () => void (out[high] = r1(clamp(down, out[low], 100))) });
	};
	band('secSatLow', 'secSatHigh', out.secSatSoft, s, out.secSatOn);
	band('secLumaLow', 'secLumaHigh', out.secLumaSoft, l, out.secLumaOn);
	if (cuts.length) cuts.sort((a, b) => a.cost - b.cost)[0]!.apply();
	return out;
}
