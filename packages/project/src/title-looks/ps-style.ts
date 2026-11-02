// Spec 19 TL-113: a Photoshop layer style as a look. Mapping ported from Pachislop src/io/psStyle.ts (port record
// pachislop-interchange), re-targeted at the appearance stack:
//
//   Stroke(s)            → `rim` layers (outermost at the bottom), `inline` for an inside stroke where it exists
//   Colour/Gradient Overlay → `face` layers over the base fill, opacity kept: normal blending stacks exactly
//   Pattern Overlay      → named as unsupported: bitmap patterns are not in a style file
//   Bevel & Emboss       → the face's `bevel` finish      Satin → the face's `satin` finish (one finish per layer)
//   Inner Glow, Inner Shadow → `innerGlow`, `innerShadow`  Outer Glow → `glow`  Drop Shadow → `shadow`
//   "Use Global Light"   → the look's light
//
// Sizes: style dimensions are pixels of the document, so they become percent of `sizePx` (TL-012). Every effect the file
// has lands in exactly one list of the report. Layer types and params are looked up in the catalogue, so a type this build
// does not have is reported as unsupported, not lost, and starts mapping the day it ships. Pure and total: anything that
// reaches here has passed `PsStyleSchema`.
import { z } from 'zod';
import { activeParamSpecs, titleLayerType } from '../registry/fx/title-look/registry.ts';
import type { RGBA } from '../schema/common.ts';
import {
	type GRADIENT_TYPES,
	type Gradient,
	MAX_APPEARANCE_LAYERS,
	MAX_GRADIENT_STOPS,
	type Paint,
	type Role,
} from './model.ts';
import type { LookRecipe, RecipeLayer } from './recipe.ts';

const finite = z.number();
const Units = z.looseObject({ units: z.string().max(32), value: finite });

/** ag-psd's `Color`: RGB 0…255, float RGB, HSB, CMYK, Lab or grey. */
const PsColor = z.union([
	z.looseObject({ r: finite, g: finite, b: finite }),
	z.looseObject({ fr: finite, fg: finite, fb: finite }),
	z.looseObject({ h: finite, s: finite, b: finite }),
	z.looseObject({ c: finite, m: finite, y: finite, k: finite }),
	z.looseObject({ l: finite, a: finite, b: finite }),
	z.looseObject({ k: finite }),
]);
type PsColor = z.infer<typeof PsColor>;

const Contour = z.looseObject({
	name: z.string().max(256).optional(),
	curve: z.array(z.looseObject({ x: finite, y: finite })).max(256),
});

const ColorStop = z.looseObject({ color: PsColor, location: finite, midpoint: finite.optional() });
const OpacityStop = z.looseObject({ opacity: finite, location: finite, midpoint: finite.optional() });
const PsGradient = z.looseObject({
	name: z.string().max(256).optional(),
	type: z.string().max(32),
	colorStops: z.array(ColorStop).max(4096).optional(),
	opacityStops: z.array(OpacityStop).max(4096).optional(),
});

const Common = {
	enabled: z.boolean().optional(),
	blendMode: z.string().max(64).optional(),
	opacity: finite.optional(),
	color: PsColor.optional(),
	useGlobalLight: z.boolean().optional(),
	angle: finite.optional(),
	altitude: finite.optional(),
	distance: Units.optional(),
	size: Units.optional(),
	choke: Units.optional(),
	noise: finite.optional(),
	contour: Contour.optional(),
};

const Shadow = z.looseObject(Common);
const Glow = z.looseObject({
	...Common,
	gradient: PsGradient.optional(),
	source: z.string().max(32).optional(),
});
const Overlay = z.looseObject({
	...Common,
	gradient: PsGradient.optional(),
	type: z.string().max(32).optional(),
	reverse: z.boolean().optional(),
	scale: finite.optional(),
	offset: z.looseObject({ x: finite, y: finite }).optional(),
});
const Stroke = z.looseObject({
	enabled: z.boolean().optional(),
	blendMode: z.string().max(64).optional(),
	opacity: finite.optional(),
	color: PsColor.optional(),
	position: z.string().max(32).optional(),
	fillType: z.string().max(32).optional(),
	size: Units.optional(),
	/** ag-psd keeps a stroke's gradient flat: stops and geometry in one object. */
	gradient: PsGradient.extend({
		style: z.string().max(32).optional(),
		angle: finite.optional(),
		scale: finite.optional(),
		reverse: z.boolean().optional(),
		offset: z.looseObject({ x: finite, y: finite }).optional(),
	}).optional(),
	pattern: z.looseObject({ name: z.string().max(256).optional() }).optional(),
});
const Bevel = z.looseObject({
	enabled: z.boolean().optional(),
	style: z.string().max(32).optional(),
	technique: z.string().max(32).optional(),
	direction: z.string().max(16).optional(),
	size: Units.optional(),
	soften: Units.optional(),
	strength: finite.optional(),
	angle: finite.optional(),
	altitude: finite.optional(),
	useGlobalLight: z.boolean().optional(),
	useShape: z.boolean().optional(),
	useTexture: z.boolean().optional(),
	contour: Contour.optional(),
	shapeContour: Contour.optional(),
	highlightColor: PsColor.optional(),
	highlightOpacity: finite.optional(),
	shadowColor: PsColor.optional(),
	shadowOpacity: finite.optional(),
});
const Satin = z.looseObject({
	enabled: z.boolean().optional(),
	blendMode: z.string().max(64).optional(),
	color: PsColor.optional(),
	opacity: finite.optional(),
	angle: finite.optional(),
	distance: Units.optional(),
	size: Units.optional(),
	invert: z.boolean().optional(),
	contour: Contour.optional(),
});

/** What the mapper reads of a style; `apps/engine` builds it from the file and it is checked again at the boundary. */
export const PsStyleSchema = z.object({
	effects: z.looseObject({
		disabled: z.boolean().optional(),
		scale: finite.optional(),
		dropShadow: z.array(Shadow).max(64).optional(),
		innerShadow: z.array(Shadow).max(64).optional(),
		outerGlow: Glow.optional(),
		innerGlow: Glow.optional(),
		bevel: Bevel.optional(),
		satin: Satin.optional(),
		solidFill: z.array(Overlay).max(64).optional(),
		gradientOverlay: z.array(Overlay).max(64).optional(),
		patternOverlay: z
			.looseObject({
				enabled: z.boolean().optional(),
				pattern: z.looseObject({ name: z.string().max(256).optional() }).optional(),
			})
			.optional(),
		stroke: z.array(Stroke).max(64).optional(),
	}),
	/** Text colour under the overlays; null = keep the clip's own colours. */
	baseColor: PsColor.nullable(),
	ppi: finite.positive().max(100_000),
	globalAngle: finite,
	globalAltitude: finite,
	fillOpacity: finite.min(0).max(1),
	knockout: z.boolean(),
});
export type PsStyle = z.infer<typeof PsStyleSchema>;

export type PsStyleReport = { mapped: string[]; approximated: string[]; unsupported: string[] };
export type PsStyleLook = { recipe: LookRecipe; report: PsStyleReport };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number) => Math.round(v * 100) / 100;
const mod360 = (v: number) => ((v % 360) + 360) % 360;
const on = <T extends { enabled?: boolean | undefined }>(e: T | undefined): e is T =>
	!!e && e.enabled !== false;

/** `v` in px: styles store px, but points and physical units occur in hand-made files. */
function toPx(u: z.infer<typeof Units> | undefined, ppi: number, fallback: number): number {
	if (!u) return fallback;
	const k: Record<string, number> = {
		Points: ppi / 72,
		Picas: ppi / 6,
		Inches: ppi,
		Millimeters: ppi / 25.4,
		Centimeters: ppi / 2.54,
	};
	return u.value * (k[u.units] ?? 1);
}

/** sRGB of a Photoshop colour (RGB, float RGB, HSB, CMYK naive, grey, Lab D50). */
export function psColorRgb(color: PsColor): [number, number, number] {
	const c = color as Record<string, number>;
	const n = (k: string) => c[k]!;
	const out = (r: number, g: number, b: number): [number, number, number] => [
		clamp(r, 0, 1),
		clamp(g, 0, 1),
		clamp(b, 0, 1),
	];
	if ('fr' in c) return out(n('fr'), n('fg'), n('fb'));
	if ('h' in c) {
		const f = (i: number) => {
			const k = (i + n('h') / 60) % 6;
			return n('b') - n('b') * n('s') * Math.max(0, Math.min(k, 4 - k, 1));
		};
		return out(f(5), f(3), f(1));
	}
	if ('c' in c) {
		const k = 1 - n('k') / 255;
		return out((1 - n('c') / 255) * k, (1 - n('m') / 255) * k, (1 - n('y') / 255) * k);
	}
	if ('l' in c) {
		// Lab (D50) → XYZ → linear sRGB (Bradford-adapted matrix) → sRGB.
		const fy = (n('l') * 100 + 16) / 116;
		const fx = fy + n('a') / 500;
		const fz = fy - n('b') / 200;
		const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
		const [X, Y, Z] = [0.9642 * inv(fx), inv(fy), 0.8249 * inv(fz)];
		const lin = [
			3.1339 * X - 1.6169 * Y - 0.4906 * Z,
			-0.9788 * X + 1.9161 * Y + 0.0335 * Z,
			0.0719 * X - 0.229 * Y + 1.4052 * Z,
		];
		const [r, g, b] = lin.map((v) =>
			v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055,
		) as [number, number, number];
		return out(r, g, b);
	}
	if ('r' in c) return out(n('r') / 255, n('g') / 255, n('b') / 255);
	return out(1 - n('k') / 255, 1 - n('k') / 255, 1 - n('k') / 255);
}

const rgba = (c: PsColor | undefined, fallback: readonly [number, number, number]): RGBA => {
	const [r, g, b] = c ? psColorRgb(c) : fallback;
	return [r, g, b, 1];
};

const isLinearContour = (c: { curve: { x: number; y: number }[] } | undefined) =>
	!c || c.curve.every((p) => Math.abs(p.x - p.y) <= 2);

/** The value of stops `{at, v}` (sorted) at `at`, linear between them. */
function stopValue(stops: readonly { at: number; v: number }[], at: number): number {
	if (!stops.length) return 1;
	if (at <= stops[0]!.at) return stops[0]!.v;
	for (let i = 1; i < stops.length; i++) {
		const a = stops[i - 1]!;
		const b = stops[i]!;
		if (at <= b.at) return a.v + ((b.v - a.v) * (at - a.at)) / Math.max(b.at - a.at, 1e-9);
	}
	return stops[stops.length - 1]!.v;
}

type StopList = Gradient['stops'];

/** Photoshop stops as gradient stops: a midpoint off centre adds a stop, opacity stops become stop alpha. */
function gradientStops(g: z.infer<typeof PsGradient>, report: PsStyleReport, label: string): StopList | null {
	const src = [...(g.colorStops ?? [])]
		.map((s) => ({ ...s, location: clamp(s.location, 0, 1) }))
		.sort((a, b) => a.location - b.location);
	if (!src.length) return null;
	const alpha = [...(g.opacityStops ?? [])]
		.map((s) => ({ at: clamp(s.location, 0, 1), v: clamp(s.opacity, 0, 1) }))
		.sort((a, b) => a.at - b.at);
	const stops: StopList = [];
	const push = (at: number, c: readonly [number, number, number]) => {
		const a = stopValue(alpha, at);
		stops.push({ at, paint: { color: [c[0], c[1], c[2], 1] }, ...(a < 0.999 ? { alpha: a } : {}) });
	};
	for (const [i, s] of src.entries()) {
		const prev = src[i - 1];
		const mid = s.midpoint ?? 0.5;
		if (prev && Math.abs(mid - 0.5) > 0.02 && s.location > prev.location) {
			// The 50 % colour sits at the midpoint instead of halfway.
			const a = psColorRgb(prev.color);
			const b = psColorRgb(s.color);
			push(prev.location + mid * (s.location - prev.location), [
				(a[0] + b[0]) / 2,
				(a[1] + b[1]) / 2,
				(a[2] + b[2]) / 2,
			]);
		}
		push(s.location, psColorRgb(s.color));
	}
	if (stops.length === 1) stops.push({ ...stops[0]!, at: 1 });
	stops[0]!.at = stops.length ? Math.min(stops[0]!.at, 1) : 0;
	if (stops.length > MAX_GRADIENT_STOPS) {
		report.approximated.push(`${label}: ${stops.length} gradient stops reduced to ${MAX_GRADIENT_STOPS}`);
		const n = stops.length;
		return Array.from({ length: MAX_GRADIENT_STOPS }, (_, i) => stops[Math.round((i * (n - 1)) / 31)]!);
	}
	return stops;
}

type GradientInfo = {
	gradient?: z.infer<typeof PsGradient> | undefined;
	style?: string | undefined;
	angle?: number | undefined;
	scale?: number | undefined;
	reverse?: boolean | undefined;
	offset?: { x: number; y: number } | undefined;
};

const STYLE_TYPES: Record<string, (typeof GRADIENT_TYPES)[number]> = {
	linear: 'linear',
	reflected: 'linear',
	radial: 'radial',
	diamond: 'radial',
	angle: 'sweep',
	shapeburst: 'shape',
};

/**
 * The gradient of a Photoshop gradient. Photoshop's angle runs counter-clockwise from the start stop to the end stop
 * (90 = bottom to top); ours clockwise on screen (90 = top to bottom). Reflected is linear with mirrored stops, exactly.
 */
function gradientPaint(g: GradientInfo, report: PsStyleReport, label: string): Paint | null {
	if (!g.gradient) return null;
	if (g.gradient.type === 'noise') {
		report.unsupported.push(`${label}: noise gradient "${g.gradient.name ?? ''}"`);
		return null;
	}
	let stops = gradientStops(g.gradient, report, label);
	if (!stops) return null;
	if (g.reverse) stops = stops.map((s) => ({ ...s, at: 1 - s.at })).reverse();
	const style = g.style ?? 'linear';
	if (style === 'diamond') report.approximated.push(`${label}: Diamond gradient drawn as radial`);
	if (style === 'reflected') {
		const half = stops.map((s) => ({ ...s, at: 0.5 + s.at / 2 }));
		const mirror = stops.map((s) => ({ ...s, at: 0.5 - s.at / 2 })).reverse();
		stops = [...mirror, ...half].slice(0, MAX_GRADIENT_STOPS);
	}
	const scale = g.scale ?? 1;
	if (Math.abs(scale - 1) > 0.01)
		stops = stops.map((s) => ({ ...s, at: clamp(0.5 + (s.at - 0.5) * scale, 0, 1) }));
	if (g.offset && (Math.abs(g.offset.x) > 0.001 || Math.abs(g.offset.y) > 0.001))
		report.approximated.push(`${label}: gradient offset ignored`);
	const psAngle = g.angle ?? 90;
	return {
		kind: 'gradient',
		gradient: {
			type: STYLE_TYPES[style] ?? 'linear',
			span: 'block',
			angle: round(mod360(360 - psAngle)),
			stops: stops.length >= 2 ? stops : [...stops, ...stops],
		},
	};
}

/** Gives colours roles, so colourways recolour an imported look (TL-051); a look has one of each. */
class Roles {
	readonly palette: Partial<Record<Role, RGBA>> = {};
	paint(prefer: readonly Role[], color: RGBA): Paint {
		for (const role of prefer) {
			const had = this.palette[role];
			if (!had || had.every((v, i) => Math.abs(v - color[i]!) < 1 / 512)) {
				this.palette[role] = color;
				return { kind: 'role', role };
			}
		}
		return { kind: 'color', color };
	}
}

const noteBlend = (r: PsStyleReport, label: string, mode: string | undefined) => {
	if (mode && mode !== 'normal') r.approximated.push(`${label}: blend mode ${mode} drawn as normal`);
};
const noteContour = (
	r: PsStyleReport,
	label: string,
	c: { name?: string | undefined; curve: { x: number; y: number }[] } | undefined,
) => {
	if (!isLinearContour(c)) r.unsupported.push(`${label}: contour "${c?.name ?? ''}"`);
};

/**
 * A recipe layer with what this build has of it: an unknown type is reported and left out, an unknown finish or param is
 * reported and removed, so `appearanceFromRecipe` always accepts the result.
 */
function fit(layer: RecipeLayer, label: string, report: PsStyleReport): RecipeLayer | null {
	const def = titleLayerType(layer.type);
	if (!def) {
		report.unsupported.push(`${label}: this build has no ${layer.type} layer`);
		return null;
	}
	const params = { ...layer.params };
	const finish = typeof params.finish === 'string' ? params.finish : 'flat';
	const finishSpec = def.params.find((p) => p.name === 'finish') as
		| { options?: readonly string[] }
		| undefined;
	if (finish !== 'flat' && !finishSpec?.options?.includes(finish)) {
		report.unsupported.push(`${label}: this build has no ${finish} finish`);
		delete params.finish;
		for (const k of Object.keys(params)) if (k.startsWith(finish)) delete params[k];
	}
	const names = new Set(
		activeParamSpecs(def, typeof params.finish === 'string' ? params.finish : 'flat').map((p) => p.name),
	);
	for (const k of Object.keys(params))
		if (!names.has(k)) {
			report.approximated.push(`${label}: ${k} is not a setting of ${layer.type}`);
			delete params[k];
		}
	return { ...layer, params };
}

/** One Photoshop style as a look for a source of `sizePx` px: style px become percent of it. */
export function mapPsStyle(src: PsStyle, sizePx: number): PsStyleLook {
	if (!(sizePx > 0) || !Number.isFinite(sizePx))
		throw new RangeError('The reference size must be above 0 px');
	const e = src.effects;
	const report: PsStyleReport = { mapped: [], approximated: [], unsupported: [] };
	const roles = new Roles();
	const k = clamp(e.scale ?? 1, 0.01, 100); // "Scale Effects"
	const px = (u: z.infer<typeof Units> | undefined, fallback: number) => toPx(u, src.ppi, fallback) * k;
	const pct = (v: number) => round((Math.max(0, v) / sizePx) * 100);
	/** Clockwise on screen from Photoshop's counter-clockwise light angle. */
	const shadowAngle = (light: number) => round(mod360(180 - light));
	const layers: RecipeLayer[] = [];
	const add = (layer: RecipeLayer, label: string, done: string) => {
		const fitted = fit(layer, label, report);
		if (!fitted) return;
		layers.push(fitted);
		report.mapped.push(done);
	};

	if (e.disabled) report.unsupported.push('Layer effects are switched off in the file');

	// Drop shadows, bottom of the stack; the file lists them top first.
	const light = { angle: src.globalAngle, altitude: src.globalAltitude };
	for (const s of [...(e.dropShadow ?? [])].reverse().filter(on)) {
		const size = px(s.size, 5);
		const choke = clamp((s.choke?.value ?? 0) / 100, 0, 1);
		noteBlend(report, 'Drop Shadow', s.blendMode);
		noteContour(report, 'Drop Shadow', s.contour);
		if (s.noise) report.unsupported.push(`Drop Shadow: noise ${Math.round(s.noise * 100)} %`);
		add(
			{
				type: 'shadow',
				params: {
					kind: 'drop',
					useLight: !!s.useGlobalLight,
					angle: shadowAngle(s.useGlobalLight ? light.angle : (s.angle ?? 120)),
					distance: pct(px(s.distance, 5)),
					blur: pct(size * (1 - choke)),
					spread: pct(size * choke),
					paint: roles.paint(['shadow'], rgba(s.color, [0, 0, 0])),
					opacity: round(clamp(s.opacity ?? 0.75, 0, 1) * 100),
				},
			},
			'Drop Shadow',
			'Drop Shadow',
		);
	}

	const og = e.outerGlow;
	if (on(og)) {
		noteContour(report, 'Outer Glow', og.contour);
		noteBlend(report, 'Outer Glow', og.blendMode === 'screen' ? undefined : og.blendMode);
		if (og.noise) report.unsupported.push(`Outer Glow: noise ${Math.round(og.noise * 100)} %`);
		if (og.choke?.value)
			report.approximated.push(`Outer Glow: spread ${Math.round(og.choke.value)} % ignored`);
		const grad = og.gradient?.type === 'solid' ? og.gradient.colorStops?.[0]?.color : undefined;
		if (og.gradient && !og.color && og.gradient.type !== 'solid')
			report.unsupported.push(`Outer Glow: noise gradient "${og.gradient.name ?? ''}"`);
		if (grad && !og.color) report.approximated.push('Outer Glow: gradient drawn in its first colour');
		add(
			{
				type: 'glow',
				params: {
					technique: og.source === 'precise' ? 'precise' : 'soft',
					radius: pct(Math.max(1, px(og.size, 5))),
					intensity: round(clamp(og.opacity ?? 0.75, 0, 1) * 100),
					paint: roles.paint(['glow'], rgba(og.color ?? grad, [1, 1, 0.75])),
				},
			},
			'Outer Glow',
			'Outer Glow',
		);
	}

	// Strokes: top-most first in the file; a stroke reaching no further than one above it is hidden by it.
	const reach = (s: z.infer<typeof Stroke>) => {
		const size = px(s.size, 3);
		return s.position === 'center' ? size / 2 : size;
	};
	const shown: { stroke: z.infer<typeof Stroke>; reach: number }[] = [];
	for (const s of (e.stroke ?? []).filter(on)) {
		const r = reach(s);
		if (s.position === 'inside' && titleLayerType('inline')) continue;
		if (r > 0 && shown.every((o) => o.reach < r)) shown.push({ stroke: s, reach: r });
		else if (r > 0) report.unsupported.push('Stroke: hidden under a wider stroke above it');
	}
	shown.sort((a, b) => b.reach - a.reach);
	const strokeRoles: Role[] = ['keyline', 'accent1', 'accent2', 'accent3'];
	const strokePaint = (s: z.infer<typeof Stroke>, label: string): Paint => {
		const solid = roles.paint(strokeRoles, rgba(s.color, [0, 0, 0]));
		if (s.fillType === 'pattern') {
			report.unsupported.push(
				`${label}: pattern "${s.pattern?.name ?? ''}" (bitmap patterns are not in the style file)`,
			);
			return solid;
		}
		if (s.fillType === 'gradient' && s.gradient)
			return gradientPaint({ ...s.gradient, gradient: s.gradient }, report, label) ?? solid;
		return solid;
	};
	shown.forEach(({ stroke: s, reach: r }, i) => {
		const next = shown[i + 1]?.reach ?? 0;
		const label = shown.length > 1 ? `Stroke ${shown.length - i}` : 'Stroke';
		if (s.position === 'inside') report.approximated.push(`${label}: inside stroke drawn outside the face`);
		if (s.position === 'center') report.approximated.push(`${label}: centre stroke drawn as its outer half`);
		noteBlend(report, label, s.blendMode);
		add(
			{
				type: 'rim',
				params: {
					width: pct(r - next),
					paint: strokePaint(s, label),
					opacity: round(clamp(s.opacity ?? 1, 0, 1) * 100),
				},
			},
			label,
			label,
		);
	});

	// Base fill and overlays. Photoshop stacks them under the inner effects, gradient below colour.
	const overlays: { paint: Paint; opacity: number; label: string }[] = [];
	for (const g of [...(e.gradientOverlay ?? [])].reverse().filter(on)) {
		noteBlend(report, 'Gradient Overlay', g.blendMode);
		const paint = gradientPaint({ ...g, style: g.type }, report, 'Gradient Overlay');
		if (paint) overlays.push({ paint, opacity: clamp(g.opacity ?? 1, 0, 1), label: 'Gradient Overlay' });
	}
	for (const c of [...(e.solidFill ?? [])].reverse().filter(on)) {
		noteBlend(report, 'Colour Overlay', c.blendMode);
		overlays.push({
			paint: roles.paint(['face', 'faceAlt'], rgba(c.color, [0, 0, 0])),
			opacity: clamp(c.opacity ?? 1, 0, 1),
			label: 'Colour Overlay',
		});
	}
	let opaqueFrom = overlays.length - 1;
	while (opaqueFrom >= 0 && overlays[opaqueFrom]!.opacity < 0.995) opaqueFrom--;
	const visible = opaqueFrom >= 0 ? overlays.slice(opaqueFrom) : overlays;
	const base: Paint = src.baseColor
		? { kind: 'color', color: rgba(src.baseColor, [1, 1, 1]) }
		: { kind: 'source' };

	// Finish of the top face: bevel, else satin; one finish per layer.
	const finishParams: Record<string, unknown> = {};
	const bv = e.bevel;
	let bevelUsed = false;
	if (on(bv)) {
		const style = bv.style ?? 'inner bevel';
		if (
			style === 'stroke emboss' ||
			style === 'pillow emboss' ||
			style === 'emboss' ||
			style === 'outer bevel'
		)
			report.approximated.push(`Bevel: ${style} drawn as an inner bevel of the face`);
		if (bv.technique === 'chisel soft') report.approximated.push('Bevel: Chisel Soft drawn as a chamfer');
		noteContour(report, 'Bevel gloss', bv.contour);
		if (bv.useTexture) report.unsupported.push('Bevel: texture');
		if (bv.direction === 'down') report.approximated.push('Bevel: direction Down drawn by turning the light');
		if (bv.highlightColor || bv.shadowColor)
			report.approximated.push('Bevel: highlight and shadow colours follow the finish');
		const a = bv.useGlobalLight ? src.globalAngle : (bv.angle ?? 120);
		light.angle = bv.direction === 'down' ? mod360(a + 180) : a;
		light.altitude = clamp(bv.useGlobalLight ? src.globalAltitude : (bv.altitude ?? 30), 0, 90);
		Object.assign(finishParams, {
			finish: 'bevel',
			bevelSize: Math.max(0.1, pct(px(bv.size, 5))),
			bevelProfile: bv.technique && bv.technique !== 'smooth' ? 'chamfer' : 'round',
			bevelDepth: round(clamp(bv.strength ?? 1, 0, 10) * 100),
			bevelSoftness: pct(px(bv.soften, 0)),
		});
		bevelUsed = true;
	}
	const sa = e.satin;
	if (on(sa)) {
		noteContour(report, 'Satin', sa.contour);
		noteBlend(report, 'Satin', sa.blendMode === 'multiply' ? undefined : sa.blendMode);
		if (bevelUsed) report.unsupported.push('Satin: a face has one finish, and Bevel took it');
		else {
			Object.assign(finishParams, {
				finish: 'satin',
				satinSize: pct(px(sa.size, 14)),
				satinOffset: pct(px(sa.distance, 11)),
				satinAngle: round(mod360(360 - (sa.angle ?? 19))),
				satinIntensity: round(clamp(sa.opacity ?? 0.5, 0, 1) * 100),
			});
		}
	}
	const finishName = finishParams.finish as string | undefined;

	const faces: { paint: Paint; opacity: number; label: string }[] =
		opaqueFrom >= 0 ? visible : [{ paint: base, opacity: 1, label: 'Base fill' }, ...visible];
	faces.forEach((f, i) => {
		const top = i === faces.length - 1;
		const opacity = i === 0 ? f.opacity * (opaqueFrom >= 0 ? 1 : src.fillOpacity) : f.opacity;
		add(
			{
				type: 'face',
				params: { paint: f.paint, opacity: round(opacity * 100), ...(top ? finishParams : {}) },
			},
			f.label,
			f.label,
		);
	});
	if (src.fillOpacity < 0.995) {
		if (opaqueFrom >= 0) report.approximated.push('Fill Opacity: an opaque overlay covers the fill');
		else report.mapped.push(`Fill Opacity ${Math.round(src.fillOpacity * 100)} %`);
	}
	if (finishName === 'bevel') report.mapped.push('Bevel & Emboss');
	if (finishName === 'satin') report.mapped.push('Satin');

	const po = e.patternOverlay;
	if (on(po))
		report.unsupported.push(
			`Pattern Overlay: "${po.pattern?.name ?? ''}" (bitmap patterns are not in the style file)`,
		);
	if (src.knockout) report.unsupported.push('Knockout');

	for (const s of [...(e.innerShadow ?? [])].reverse().filter(on)) {
		noteBlend(report, 'Inner Shadow', s.blendMode);
		noteContour(report, 'Inner Shadow', s.contour);
		const size = px(s.size, 5);
		add(
			{
				type: 'innerShadow',
				params: {
					angle: shadowAngle(s.useGlobalLight ? src.globalAngle : (s.angle ?? 120)),
					distance: pct(px(s.distance, 5)),
					blur: pct(size),
					paint: roles.paint(['shadow', 'accent3'], rgba(s.color, [0, 0, 0])),
					opacity: round(clamp(s.opacity ?? 0.75, 0, 1) * 100),
				},
			},
			'Inner Shadow',
			'Inner Shadow',
		);
	}

	const ig = e.innerGlow;
	if (on(ig)) {
		noteBlend(report, 'Inner Glow', ig.blendMode === 'screen' ? undefined : ig.blendMode);
		noteContour(report, 'Inner Glow', ig.contour);
		if (ig.source === 'center') report.approximated.push('Inner Glow: Center source drawn from the edge');
		if (ig.noise) report.unsupported.push(`Inner Glow: noise ${Math.round(ig.noise * 100)} %`);
		const grad = ig.gradient?.type === 'solid' ? ig.gradient.colorStops?.[0]?.color : undefined;
		add(
			{
				type: 'innerGlow',
				params: {
					radius: pct(px(ig.size, 5)),
					intensity: round(clamp(ig.opacity ?? 0.75, 0, 1) * 100),
					paint: roles.paint(['glow', 'accent1'], rgba(ig.color ?? grad, [1, 1, 0.75])),
				},
			},
			'Inner Glow',
			'Inner Glow',
		);
	}

	for (const s of (e.stroke ?? []).filter(on)) {
		if (s.position !== 'inside' || !titleLayerType('inline')) continue;
		noteBlend(report, 'Inside Stroke', s.blendMode);
		add(
			{
				type: 'inline',
				params: { width: pct(px(s.size, 3)), inset: 0, paint: strokePaint(s, 'Inside Stroke') },
			},
			'Inside Stroke',
			'Inside Stroke',
		);
	}

	if (layers.length > MAX_APPEARANCE_LAYERS) {
		const over = layers.length - MAX_APPEARANCE_LAYERS;
		report.unsupported.push(`${over} effects past the limit of ${MAX_APPEARANCE_LAYERS} layers`);
		layers.length = MAX_APPEARANCE_LAYERS;
	}

	return {
		recipe: {
			palette: roles.palette,
			light: {
				source: 'look',
				angle: round(mod360(360 - light.angle)),
				altitude: round(clamp(light.altitude, 0, 90)),
			},
			layers,
		},
		report: {
			mapped: [...new Set(report.mapped)],
			approximated: [...new Set(report.approximated)],
			unsupported: [...new Set(report.unsupported)],
		},
	};
}
