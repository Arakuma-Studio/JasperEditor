// Custom SVG cursors (S05:IC-010, R-PUI §18): 32×32 with hotspots and 2× variants for HiDPI. Drawn by
// us: a dark casing stroke under a colored ink stroke so every cursor reads on any background.
import { CURSOR_COLORS } from './cursor-colors.tokens.ts';

type Ink = keyof typeof CURSOR_COLORS;
type Stroke = { d: string; ink?: Ink; fill?: boolean };
export type CursorSpec = { strokes: Stroke[]; hotspot: [number, number]; fallback: string };

const ARROW = 'M6 4v19l5-5 3.5 7.5 3-1.4L14 16.6h7z';

export const CURSORS = {
	trimIn: {
		strokes: [
			{ d: 'M19 8h-4v16h4', ink: 'trim' },
			{ d: 'M22 16h6M25 13l3 3-3 3', ink: 'trim' },
		],
		hotspot: [15, 16],
		fallback: 'col-resize',
	},
	trimOut: {
		strokes: [
			{ d: 'M13 8h4v16h-4', ink: 'trim' },
			{ d: 'M10 16H4M7 13l-3 3 3 3', ink: 'trim' },
		],
		hotspot: [17, 16],
		fallback: 'col-resize',
	},
	rippleIn: {
		strokes: [
			{ d: 'M19 8h-4v16h4', ink: 'ripple' },
			{ d: 'M22 16h6M25 13l3 3-3 3', ink: 'ripple' },
		],
		hotspot: [15, 16],
		fallback: 'col-resize',
	},
	rippleOut: {
		strokes: [
			{ d: 'M13 8h4v16h-4', ink: 'ripple' },
			{ d: 'M10 16H4M7 13l-3 3 3 3', ink: 'ripple' },
		],
		hotspot: [17, 16],
		fallback: 'col-resize',
	},
	rolling: {
		strokes: [
			{ d: 'M13 8h2.5v16H13M19 8h-2.5v16H19', ink: 'trim' },
			{ d: 'M9 16H3M6 13l-3 3 3 3M23 16h6M26 13l3 3-3 3', ink: 'trim' },
		],
		hotspot: [16, 16],
		fallback: 'col-resize',
	},
	slip: {
		strokes: [{ d: 'M7 9v14M25 9v14M10 16h12M13 13l-3 3 3 3M19 13l3 3-3 3' }],
		hotspot: [16, 16],
		fallback: 'ew-resize',
	},
	slide: {
		strokes: [{ d: 'M14 9v14M18 9v14M3 16h8M6 13l-3 3 3 3M21 16h8M26 13l3 3-3 3' }],
		hotspot: [16, 16],
		fallback: 'ew-resize',
	},
	rateStretch: {
		strokes: [{ d: 'M7 9v14M25 9v14M10 16h12M13 13l-3 3 3 3M19 13l3 3-3 3M14 6h4l-2 3z' }],
		hotspot: [16, 16],
		fallback: 'ew-resize',
	},
	razor: {
		strokes: [{ d: 'M16 3v10M12 13h8l-4 15z' }],
		hotspot: [16, 3],
		fallback: 'crosshair',
	},
	pen: {
		strokes: [{ d: 'M6 26l4-12 8-8 6 6-8 8zM6 26l6-6' }],
		hotspot: [6, 26],
		fallback: 'crosshair',
	},
	penAddKeyframe: {
		strokes: [{ d: 'M6 26l4-12 8-8 6 6-8 8zM6 26l6-6' }, { d: 'M25 21v8M21 25h8', ink: 'accent' }],
		hotspot: [6, 26],
		fallback: 'crosshair',
	},
	hand: {
		strokes: [
			{
				d: 'M11 17V8a2 2 0 014 0v7M15 14V6a2 2 0 014 0v8M19 14V8a2 2 0 014 0v9c0 5-3 9-8 9h-1c-3 0-5-2-7-5l-3-5a2 2 0 013-2l3 3',
			},
		],
		hotspot: [16, 16],
		fallback: 'grab',
	},
	grab: {
		strokes: [
			{
				d: 'M10 14v-2a2 2 0 014 0v2M14 13v-2a2 2 0 014 0v3M18 13a2 2 0 014 0v4c0 5-3 9-8 9h-1c-3 0-5-2-6-5l-1-4a2 2 0 013-2',
			},
		],
		hotspot: [16, 16],
		fallback: 'grabbing',
	},
	zoomIn: {
		strokes: [{ d: 'M13 5a8 8 0 100 16 8 8 0 000-16zM19 19l8 8M9 13h8M13 9v8' }],
		hotspot: [13, 13],
		fallback: 'zoom-in',
	},
	zoomOut: {
		strokes: [{ d: 'M13 5a8 8 0 100 16 8 8 0 000-16zM19 19l8 8M9 13h8' }],
		hotspot: [13, 13],
		fallback: 'zoom-out',
	},
	trackSelectForward: {
		strokes: [{ d: 'M6 6v20M10 11h14M20 7l4 4-4 4M10 21h14M20 17l4 4-4 4' }],
		hotspot: [6, 16],
		fallback: 'e-resize',
	},
	trackSelectBackward: {
		strokes: [{ d: 'M26 6v20M22 11H8M12 7l-4 4 4 4M22 21H8M12 17l-4 4 4 4' }],
		hotspot: [26, 16],
		fallback: 'w-resize',
	},
	insertDrag: {
		strokes: [
			{ d: ARROW, fill: true },
			{ d: 'M20 27h9M26 24l3 3-3 3', ink: 'ripple' },
		],
		hotspot: [6, 4],
		fallback: 'copy',
	},
	overwriteDrag: {
		strokes: [
			{ d: ARROW, fill: true },
			{ d: 'M20 27h10M25 23v8', ink: 'accent' },
		],
		hotspot: [6, 4],
		fallback: 'copy',
	},
	noDrop: {
		strokes: [{ d: 'M16 6a10 10 0 100 20 10 10 0 000-20zM9 9l14 14', ink: 'danger' }],
		hotspot: [16, 16],
		fallback: 'no-drop',
	},
} satisfies Record<string, CursorSpec>;

export type CursorId = keyof typeof CURSORS;

/** SVG markup for a cursor at `scale` (1 = 32 px, 2 = 64 px HiDPI variant). */
export function cursorSvg(id: CursorId, scale: 1 | 2 = 1): string {
	const spec: CursorSpec = CURSORS[id];
	const size = 32 * scale;
	const layer = (s: Stroke, casing: boolean) => {
		const color = casing ? CURSOR_COLORS.casing : CURSOR_COLORS[s.ink ?? 'ink'];
		const fill = s.fill ? (casing ? CURSOR_COLORS.casing : CURSOR_COLORS.ink) : 'none';
		return `<path d="${s.d}" fill="${fill}" stroke="${color}" stroke-width="${casing ? 3.5 : 1.5}" stroke-linecap="round" stroke-linejoin="round"/>`;
	};
	const body = [...spec.strokes.map((s) => layer(s, true)), ...spec.strokes.map((s) => layer(s, false))].join(
		'',
	);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">${body}</svg>`;
}

function url(id: CursorId, scale: 1 | 2): string {
	return `url("data:image/svg+xml,${encodeURIComponent(cursorSvg(id, scale))}")`;
}

let imageSetSupport: boolean | null = null;
function supportsImageSet(): boolean {
	if (imageSetSupport === null) {
		imageSetSupport =
			typeof CSS !== 'undefined' &&
			typeof CSS.supports === 'function' &&
			CSS.supports('cursor', `image-set(${url('razor', 1)} 1x, ${url('razor', 2)} 2x) 16 3, auto`);
	}
	return imageSetSupport;
}

/** CSS `cursor` value with hotspot, a 2× image-set where supported, and a system fallback. */
export function cursorCss(id: CursorId): string {
	const spec: CursorSpec = CURSORS[id];
	const [x, y] = spec.hotspot;
	const image = supportsImageSet() ? `image-set(${url(id, 1)} 1x, ${url(id, 2)} 2x)` : url(id, 1);
	return `${image} ${x} ${y}, ${spec.fallback}`;
}
