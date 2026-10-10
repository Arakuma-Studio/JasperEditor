// Built-in creative looks of Lumetri ▸ Creative ▸ Look (color-grade). Procedural: every look is a short formula of
// our own on display-encoded RGB (no third-party LUT files, AGENTS.md §3), so the Looks browser can show them on
// the current frame and they bake into the colour run's LUT like every other Lumetri step. A look LUT asset (the
// `look` param) takes precedence over the built-in look (one Look per Lumetri instance, as in Premiere).
// Teal & Orange, Warm Film, Cool Blue, Bleach Bypass, Faded Matte, Monochrome, Golden Hour and Night follow the
// procedural looks of FilmCraft `apply_look` (MIT OR Apache-2.0, licenses/ported/color-grade.md); the rest are new.
import type { Rgb } from './lut.ts';

export type CreativeLookId =
	| 'none'
	| 'teal-orange'
	| 'warm-film'
	| 'cool-blue'
	| 'bleach-bypass'
	| 'faded-matte'
	| 'monochrome'
	| 'golden-hour'
	| 'night'
	| 'vintage-print'
	| 'cross-process'
	| 'soft-pastel'
	| 'high-contrast-bw'
	| 'sepia'
	| 'moody-green'
	| 'arctic'
	| 'sunset'
	| 'kodachrome-style'
	| 'cinema-neutral';

export type CreativeLook = { id: CreativeLookId; label: string; description: string; family: string };

/** The built-in looks in browser order (first = None). */
export const CREATIVE_LOOKS: readonly CreativeLook[] = [
	{ id: 'none', label: 'None', description: 'No built-in look.', family: 'None' },
	{
		id: 'teal-orange',
		label: 'Teal & Orange',
		description: 'Teal shadows, warm highlights, gentle S-curve.',
		family: 'Cinematic',
	},
	{
		id: 'cinema-neutral',
		label: 'Cinema Neutral',
		description: 'Soft roll-off of the highlights and a slight contrast lift.',
		family: 'Cinematic',
	},
	{
		id: 'bleach-bypass',
		label: 'Bleach Bypass',
		description: 'Silver retained: half the colour, hard contrast.',
		family: 'Cinematic',
	},
	{
		id: 'night',
		label: 'Night',
		description: 'Blue, darker day-for-night.',
		family: 'Cinematic',
	},
	{ id: 'warm-film', label: 'Warm Film', description: 'Warm print film with lifted blacks.', family: 'Film' },
	{
		id: 'vintage-print',
		label: 'Vintage Print',
		description: 'Faded, yellowed print with soft contrast.',
		family: 'Film',
	},
	{
		id: 'kodachrome-style',
		label: 'Saturated Slide',
		description: 'Rich reds and blues of slide film, deep blacks.',
		family: 'Film',
	},
	{
		id: 'cross-process',
		label: 'Cross Process',
		description: 'Green-yellow highlights, blue shadows, punchy.',
		family: 'Film',
	},
	{ id: 'faded-matte', label: 'Faded Matte', description: 'Matte blacks and muted colour.', family: 'Film' },
	{ id: 'cool-blue', label: 'Cool Blue', description: 'Cool, crisp and slightly contrasty.', family: 'Tone' },
	{ id: 'arctic', label: 'Arctic', description: 'Icy cyan, bright and desaturated.', family: 'Tone' },
	{
		id: 'golden-hour',
		label: 'Golden Hour',
		description: 'Warm golden sunlight, soft blues.',
		family: 'Tone',
	},
	{
		id: 'sunset',
		label: 'Sunset',
		description: 'Magenta-orange highlights, purple shadows.',
		family: 'Tone',
	},
	{
		id: 'moody-green',
		label: 'Moody Green',
		description: 'Green-tinted, low-key thriller look.',
		family: 'Tone',
	},
	{ id: 'soft-pastel', label: 'Soft Pastel', description: 'Light, airy and low contrast.', family: 'Tone' },
	{
		id: 'monochrome',
		label: 'Monochrome',
		description: 'Black and white with a soft S-curve.',
		family: 'Black & White',
	},
	{
		id: 'high-contrast-bw',
		label: 'High Contrast B&W',
		description: 'Black and white with crushed blacks and bright whites.',
		family: 'Black & White',
	},
	{ id: 'sepia', label: 'Sepia', description: 'Warm brown-toned black and white.', family: 'Black & White' },
];

export const CREATIVE_LOOK_IDS: readonly CreativeLookId[] = CREATIVE_LOOKS.map((l) => l.id);

const KR = 0.2126;
const KG = 0.7152;
const KB = 0.0722;
const sat01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** S-curve of strength k around mid-grey (smoothstep blend, end points fixed). */
const sCurve = (v: number, k: number) => {
	const x = sat01(v);
	return x + (x * x * (3 - 2 * x) - x) * k;
};

/**
 * The pixel function of a built-in look (in place, display-encoded RGB), or null for `none` / an unknown id.
 * Results may leave 0..1; the Lumetri chain clamps at its end.
 */
export function creativeLookFn(id: string | null | undefined): ((c: Rgb) => void) | null {
	switch (id) {
		case 'teal-orange':
			return (c) => {
				const l = KR * c[0] + KG * c[1] + KB * c[2];
				c[0] = sCurve(c[0] + 0.1 * l, 0.35);
				c[1] = sCurve(c[1] + 0.08 * (1 - l) + 0.04 * l, 0.35);
				c[2] = sCurve(c[2] + 0.1 * (1 - l) - 0.06 * l, 0.35);
			};
		case 'warm-film':
			return (c) => {
				const r = c[0] * 1.06 + 0.02;
				const g = c[1] + 0.01;
				const b = c[2] * 0.9;
				const l = KR * c[0] + KG * c[1] + KB * c[2];
				c[0] = (r + (l - r) * 0.15) * 0.94 + 0.04;
				c[1] = (g + (l - g) * 0.15) * 0.94 + 0.04;
				c[2] = (b + (l - b) * 0.15) * 0.94 + 0.04;
			};
		case 'cool-blue':
			return (c) => {
				c[0] = sCurve(c[0] * 0.9, 0.2);
				c[1] = sCurve(c[1] * 0.98, 0.2);
				c[2] = sCurve(c[2] * 1.1 + 0.02, 0.2);
			};
		case 'bleach-bypass':
			return (c) => {
				const l = KR * c[0] + KG * c[1] + KB * c[2];
				for (let k = 0; k < 3; k++) c[k] = sCurve(c[k]! + (l - c[k]!) * 0.55, 0.6);
			};
		case 'faded-matte':
			return (c) => {
				const l = KR * c[0] + KG * c[1] + KB * c[2];
				for (let k = 0; k < 3; k++) c[k] = 0.08 + (c[k]! + (l - c[k]!) * 0.25) * 0.84;
			};
		case 'monochrome':
			return (c) => {
				const l = sCurve(KR * c[0] + KG * c[1] + KB * c[2], 0.3);
				c[0] = l;
				c[1] = l;
				c[2] = l;
			};
		case 'golden-hour':
			return (c) => {
				c[0] = sCurve(c[0] * 1.1 + 0.03, 0.15);
				c[1] = sCurve(c[1] * 1.02 + 0.01, 0.15);
				c[2] = sCurve(c[2] * 0.82, 0.15);
			};
		case 'night':
			return (c) => {
				c[0] = c[0] * 0.75 * 0.8;
				c[1] = c[1] * 0.85 * 0.8;
				c[2] = c[2] * 1.15 * 0.8;
			};
		case 'vintage-print':
			return (c) => {
				const l = KR * c[0] + KG * c[1] + KB * c[2];
				const r = c[0] + (l - c[0]) * 0.3;
				const g = c[1] + (l - c[1]) * 0.3;
				const b = c[2] + (l - c[2]) * 0.3;
				c[0] = 0.07 + sCurve(r * 1.04, -0.15) * 0.86;
				c[1] = 0.06 + sCurve(g * 1.0, -0.15) * 0.85;
				c[2] = 0.05 + sCurve(b * 0.86, -0.15) * 0.8;
			};
		case 'cross-process':
			return (c) => {
				const r = sCurve(c[0], 0.5);
				const g = sCurve(c[1], 0.3) * 1.05 + 0.02;
				const b = 0.12 + c[2] * 0.7;
				c[0] = r;
				c[1] = g;
				c[2] = b;
			};
		case 'soft-pastel':
			return (c) => {
				const l = KR * c[0] + KG * c[1] + KB * c[2];
				for (let k = 0; k < 3; k++) c[k] = 0.1 + sCurve(c[k]! + (l - c[k]!) * 0.2, -0.25) * 0.88;
			};
		case 'high-contrast-bw':
			return (c) => {
				const l = sCurve(sCurve((KR * c[0] + KG * c[1] + KB * c[2] - 0.5) * 1.25 + 0.5, 0.6), 0.4);
				c[0] = l;
				c[1] = l;
				c[2] = l;
			};
		case 'sepia':
			return (c) => {
				const l = sCurve(KR * c[0] + KG * c[1] + KB * c[2], 0.2);
				c[0] = l * 1.07 + 0.03;
				c[1] = l * 0.95 + 0.015;
				c[2] = l * 0.78;
			};
		case 'moody-green':
			return (c) => {
				const l = KR * c[0] + KG * c[1] + KB * c[2];
				for (let k = 0; k < 3; k++) c[k] = c[k]! + (l - c[k]!) * 0.3;
				c[0] = sCurve(c[0] * 0.88, 0.3) * 0.9;
				c[1] = sCurve(c[1] * 1.04 + 0.015, 0.3) * 0.9;
				c[2] = sCurve(c[2] * 0.92 + 0.01, 0.3) * 0.9;
			};
		case 'arctic':
			return (c) => {
				const l = KR * c[0] + KG * c[1] + KB * c[2];
				for (let k = 0; k < 3; k++) c[k] = c[k]! + (l - c[k]!) * 0.35;
				c[0] = c[0] * 0.92 + 0.04;
				c[1] = c[1] * 1.0 + 0.06;
				c[2] = c[2] * 1.06 + 0.08;
			};
		case 'sunset':
			return (c) => {
				const l = KR * c[0] + KG * c[1] + KB * c[2];
				c[0] = sCurve(c[0] + 0.08 * l + 0.03 * (1 - l), 0.2);
				c[1] = sCurve(c[1] * 0.95 + 0.02 * l, 0.2);
				c[2] = sCurve(c[2] * 0.9 + 0.07 * (1 - l) - 0.03 * l, 0.2);
			};
		case 'kodachrome-style':
			return (c) => {
				const l = KR * c[0] + KG * c[1] + KB * c[2];
				for (let k = 0; k < 3; k++) c[k] = sCurve(l + (c[k]! - l) * 1.3, 0.35);
				c[0] = c[0] * 1.03;
				c[2] = c[2] * 0.97;
			};
		case 'cinema-neutral':
			return (c) => {
				for (let k = 0; k < 3; k++) {
					const v = sCurve(c[k]!, 0.2);
					// Soft shoulder: compress above 0.8.
					c[k] = v > 0.8 ? 0.8 + (1 - Math.exp(-(v - 0.8) * 5)) * 0.2 * (1 / (1 - Math.exp(-1))) : v;
				}
			};
		default:
			return null;
	}
}
