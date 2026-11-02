// Spec 19 TL-091: paints in the UI. Pure: conversions between paint kinds, CSS previews and stop edits.
import {
	type Appearance,
	DEFAULT_PALETTE,
	type Gradient,
	type GradientStop,
	MAX_GRADIENT_STOPS,
	type Paint,
	type RGBA,
	type Role,
} from '@jasper/project';

export type PaintKind = Paint['kind'];
export const PAINT_KINDS: readonly PaintKind[] = ['role', 'color', 'gradient', 'source'];
export const PAINT_KIND_LABELS: Record<PaintKind, string> = {
	role: 'Palette Role',
	color: 'Colour',
	gradient: 'Gradient',
	source: 'Clip Picture',
};

export type Palette = Record<Role, RGBA>;

/** An appearance's palette as flat colours, the defaults under what it sets. */
export function flatPalette(a: Pick<Appearance, 'palette'> | undefined): Palette {
	const out = { ...DEFAULT_PALETTE };
	for (const [role, anim] of Object.entries(a?.palette ?? {}))
		if (anim) out[role as Role] = anim.value as RGBA;
	return out;
}

export const rgbaCss = (c: readonly number[], alpha = 1): string =>
	`rgba(${Math.round((c[0] ?? 0) * 255)}, ${Math.round((c[1] ?? 0) * 255)}, ${Math.round((c[2] ?? 0) * 255)}, ${Math.round((c[3] ?? 1) * alpha * 1000) / 1000})`; // tokens-allow: document color

export function stopColor(s: Pick<GradientStop, 'paint'>, palette: Palette): RGBA {
	return 'role' in s.paint ? palette[s.paint.role] : (s.paint.color as RGBA);
}

export const sortedStops = (g: Pick<Gradient, 'stops'>) => [...g.stops].sort((a, b) => a.at - b.at);

/** A gradient's ramp, left to right, over whatever is behind it. */
export function gradientRampCss(g: Pick<Gradient, 'stops'>, palette: Palette): string {
	const stops = sortedStops(g).map(
		(s) => `${rgbaCss(stopColor(s, palette), s.alpha ?? 1)} ${Math.round(s.at * 1000) / 10}%`,
	);
	return `linear-gradient(to right, ${stops.join(', ')})`;
}

/** A swatch of a paint. */
export function paintCss(p: Paint | null | undefined, palette: Palette): string {
	switch (p?.kind) {
		case 'role':
			return rgbaCss(palette[p.role]);
		case 'color':
			return rgbaCss(p.color);
		case 'gradient':
			return gradientRampCss(p.gradient, palette);
		case 'source':
			return 'repeating-conic-gradient(var(--pr-border-strong) 0 25%, transparent 0 50%) 0 0 / 6px 6px';
		default:
			return 'transparent';
	}
}

/** The colour a paint reads as, for a kind change. */
function paintColor(p: Paint | undefined, palette: Palette): RGBA {
	if (p?.kind === 'role') return palette[p.role];
	if (p?.kind === 'color') return p.color as RGBA;
	if (p?.kind === 'gradient') return stopColor(sortedStops(p.gradient)[0]!, palette);
	return palette.face;
}

/** The paint a kind change starts from: as close as the new kind can get to what was there. */
export function convertPaint(p: Paint | undefined, kind: PaintKind, palette: Palette): Paint {
	if (p?.kind === kind) return p;
	switch (kind) {
		case 'role':
			return { kind: 'role', role: 'face' };
		case 'color':
			return { kind: 'color', color: [...paintColor(p, palette)] as RGBA };
		case 'source':
			return { kind: 'source' };
		case 'gradient':
			return {
				kind: 'gradient',
				gradient: {
					type: 'linear',
					span: 'block',
					angle: 90,
					stops: [
						{ at: 0, paint: p?.kind === 'role' ? { role: p.role } : { role: 'face' } },
						{ at: 1, paint: { role: 'faceAlt' } },
					],
				},
			};
	}
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** The stop a click on the ramp adds: the colour the gradient already has there. */
export function stopAt(g: Pick<Gradient, 'stops'>, at: number, palette: Palette): GradientStop {
	const stops = sortedStops(g);
	const x = Math.min(1, Math.max(0, at));
	let i = 0;
	while (i < stops.length - 2 && x > stops[i + 1]!.at) i++;
	const a = stops[i]!;
	const b = stops[Math.min(i + 1, stops.length - 1)]!;
	const span = b.at - a.at;
	const f = span > 0 ? Math.min(1, Math.max(0, (x - a.at) / span)) : 0;
	const ca = stopColor(a, palette);
	const cb = stopColor(b, palette);
	const color = [0, 1, 2, 3].map((k) => round3(lerp(ca[k]!, cb[k]!, f))) as RGBA;
	const alpha = lerp(a.alpha ?? 1, b.alpha ?? 1, f);
	return { at: round3(x), paint: { color }, ...(alpha < 1 ? { alpha: round3(alpha) } : {}) };
}

/** Adds a stop, or leaves the gradient as it is at the limit. */
export function addStop(g: Gradient, at: number, palette: Palette): { gradient: Gradient; index: number } {
	if (g.stops.length >= MAX_GRADIENT_STOPS) return { gradient: g, index: -1 };
	const stops = [...g.stops, stopAt(g, at, palette)];
	return { gradient: { ...g, stops }, index: stops.length - 1 };
}

/** Removes a stop; a gradient keeps at least two. */
export function removeStop(g: Gradient, index: number): Gradient {
	if (g.stops.length <= 2) return g;
	return { ...g, stops: g.stops.filter((_, i) => i !== index) };
}

export function updateStop(g: Gradient, index: number, patch: Partial<GradientStop>): Gradient {
	return { ...g, stops: g.stops.map((s, i) => (i === index ? { ...s, ...patch } : s)) };
}
