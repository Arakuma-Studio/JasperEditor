// Literal colors baked into the SVG cursors (S05:IC-010). Cursors are rasterized by the browser outside
// the DOM, so they cannot read CSS variables; the values mirror tokens.css (trim red, ripple yellow).
export const CURSOR_COLORS = {
	ink: '#ffffff',
	casing: '#000000',
	trim: '#e4453a',
	ripple: '#f5c518',
	accent: '#4096f3',
	danger: '#df3422',
} as const;
