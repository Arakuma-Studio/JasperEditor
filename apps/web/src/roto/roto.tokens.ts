// Roto Brush overlay colours (After Effects' conventions: green add strokes, red subtract strokes, a magenta
// segmentation boundary / tint). Literal colours live in *.tokens.ts files (scripts/check-tokens.mjs).
export const ROTO_COLORS = {
	add: '#3ddc5a',
	subtract: '#ff4d4d',
	refine: '#4da6ff',
	/** Selection tint and boundary (R, G, B 0..1 for the SVG colour matrix). */
	tint: [1, 0.15, 0.85] as const,
	tintCss: '#ff26d9',
	cursor: 'rgba(255, 255, 255, 0.9)',
	casing: 'rgba(0, 0, 0, 0.6)',
} as const;
