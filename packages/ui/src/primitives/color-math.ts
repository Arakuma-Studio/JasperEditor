// Color math for the swatch/picker (S05:CT-014). Colors are S01 RGBA tuples: straight sRGB floats 0..1.
// These are document content colors (DT-002 exception), so building CSS color strings here is allowed.

export type Rgba = [number, number, number, number];
export type Hsv = { h: number; s: number; v: number };

const clamp01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));

export function rgbToHsv(r: number, g: number, b: number): Hsv {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	let h = 0;
	if (d > 0) {
		if (max === r) h = ((g - b) / d) % 6;
		else if (max === g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
		h *= 60;
		if (h < 0) h += 360;
	}
	return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): [number, number, number] {
	const c = v * s;
	const hh = (((h % 360) + 360) % 360) / 60;
	const x = c * (1 - Math.abs((hh % 2) - 1));
	let rgb: [number, number, number];
	if (hh < 1) rgb = [c, x, 0];
	else if (hh < 2) rgb = [x, c, 0];
	else if (hh < 3) rgb = [0, c, x];
	else if (hh < 4) rgb = [0, x, c];
	else if (hh < 5) rgb = [x, 0, c];
	else rgb = [c, 0, x];
	const m = v - c;
	return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
}

const hex2 = (x: number) =>
	Math.round(clamp01(x) * 255)
		.toString(16)
		.padStart(2, '0');

/** `#rrggbb` (or `#rrggbbaa` when `withAlpha` and alpha < 1). */
export function rgbaToHex(c: Rgba, withAlpha = false): string {
	const body = hex2(c[0]) + hex2(c[1]) + hex2(c[2]) + (withAlpha && c[3] < 1 ? hex2(c[3]) : '');
	return `#${body}`;
}

/** Parses `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` (with or without `#`). */
export function parseHex(input: string): Rgba | null {
	let s = input.trim().replace(/^#/, '');
	if (!/^[0-9a-f]+$/i.test(s)) return null;
	if (s.length === 3 || s.length === 4) s = [...s].map((ch) => ch + ch).join('');
	if (s.length !== 6 && s.length !== 8) return null;
	const n = (i: number) => Number.parseInt(s.slice(i, i + 2), 16) / 255;
	return [n(0), n(2), n(4), s.length === 8 ? n(6) : 1];
}

/** CSS color for a content color (swatches, picker surfaces). */
export function rgbaToCss(c: Rgba): string {
	const [r, g, b] = [c[0], c[1], c[2]].map((x) => Math.round(clamp01(x) * 255));
	return `rgb(${r} ${g} ${b} / ${clamp01(c[3])})`; // tokens-allow: document content color
}

export function hsvToCss(h: Hsv): string {
	const [r, g, b] = hsvToRgb(h);
	return rgbaToCss([r, g, b, 1]);
}

export function sameColor(a: Rgba, b: Rgba): boolean {
	return a.every((x, i) => Math.abs(x - (b[i] ?? 0)) < 1 / 512);
}
