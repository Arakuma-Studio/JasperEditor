// Blend modes JasperEditor (Premiere's 27 + After Effects' utility modes) ↔ the interchange formats.
import type { BlendMode } from '@jasper/project';

/**
 * FCP7 XML `<compositemode>` values (Apple, "Final Cut Pro XML Interchange Format", clipitem element): normal, add,
 * subtract, difference, multiply, screen, overlay, hardlight, softlight, darken, lighten, travelmatte-alpha,
 * travelmatte-luma. Premiere Pro writes the same names.
 */
export const FCP7_BLEND: Partial<Record<BlendMode, string>> = {
	normal: 'normal',
	add: 'add',
	subtract: 'subtract',
	difference: 'difference',
	multiply: 'multiply',
	screen: 'screen',
	overlay: 'overlay',
	'hard-light': 'hardlight',
	'soft-light': 'softlight',
	darken: 'darken',
	lighten: 'lighten',
	'stencil-alpha': 'travelmatte-alpha',
	'stencil-luma': 'travelmatte-luma',
};

/**
 * Final Cut Pro X blend modes in the order of its Compositing ▸ Blend Mode menu; FCPXML `adjust-blend mode` holds
 * the index (written `"N (Name)"` by some producers; both forms and bare names are read).
 */
export const FCPXML_BLEND_ORDER: readonly (readonly [number, BlendMode | null, string])[] = [
	[0, 'normal', 'Normal'],
	[2, 'subtract', 'Subtract'],
	[3, 'darken', 'Darken'],
	[4, 'multiply', 'Multiply'],
	[5, 'color-burn', 'Color Burn'],
	[6, 'linear-burn', 'Linear Burn'],
	[8, 'add', 'Add'],
	[9, 'lighten', 'Lighten'],
	[10, 'screen', 'Screen'],
	[11, 'color-dodge', 'Color Dodge'],
	[12, null, 'Linear Dodge'],
	[14, 'overlay', 'Overlay'],
	[15, 'soft-light', 'Soft Light'],
	[16, 'hard-light', 'Hard Light'],
	[17, 'vivid-light', 'Vivid Light'],
	[18, 'linear-light', 'Linear Light'],
	[19, 'pin-light', 'Pin Light'],
	[20, 'hard-mix', 'Hard Mix'],
	[22, 'difference', 'Difference'],
	[23, 'exclusion', 'Exclusion'],
	[25, 'stencil-alpha', 'Stencil Alpha'],
	[26, 'stencil-luma', 'Stencil Luma'],
	[27, 'silhouette-alpha', 'Silhouette Alpha'],
	[28, 'silhouette-luma', 'Silhouette Luma'],
	[29, null, 'Behind'],
	[31, 'alpha-add', 'Alpha Add'],
	[32, null, 'Premultiplied Mix'],
];

export function fcp7BlendName(m: BlendMode): string | null {
	return FCP7_BLEND[m] ?? null;
}

export function blendFromFcp7(name: string): BlendMode | null {
	const n = name.trim().toLowerCase().replace(/[\s_]/g, '');
	for (const [k, v] of Object.entries(FCP7_BLEND)) if (v === n) return k as BlendMode;
	return null;
}

export function fcpxmlBlend(m: BlendMode): string | null {
	const e = FCPXML_BLEND_ORDER.find((x) => x[1] === m);
	return e ? `${e[0]} (${e[2]})` : null;
}

export function blendFromFcpxml(v: string): BlendMode | null {
	const t = v.trim();
	const num = /^(\d+)/.exec(t);
	if (num) {
		const e = FCPXML_BLEND_ORDER.find((x) => x[0] === Number(num[1]));
		if (e) return e[1] ?? (e[2] === 'Linear Dodge' ? 'add' : null);
	}
	const name = t
		.replace(/^\d+\s*/, '')
		.replace(/[()]/g, '')
		.trim()
		.toLowerCase();
	const e = FCPXML_BLEND_ORDER.find((x) => x[2].toLowerCase() === name);
	if (e) return e[1] ?? (e[2] === 'Linear Dodge' ? 'add' : null);
	return null;
}

/** Blend modes a format carries (other applications' view; OTIO keeps every mode in its metadata). */
export function formatCarriesBlend(format: string, m: BlendMode): boolean {
	if (m === 'normal') return true;
	if (format === 'fcp7') return !!FCP7_BLEND[m];
	if (format === 'fcpxml') return !!FCPXML_BLEND_ORDER.find((x) => x[1] === m);
	return false;
}
