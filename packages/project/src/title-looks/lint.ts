// Spec 19 TL-056: the style check. Flags what practitioners call amateur, each with the rule it breaks and, where the
// repair is mechanical, an undoable fix as commands. Deterministic: the same appearance gives the same issues in the same
// order. Colours are judged on samples of each element in CIE L*a*b*, so lightness and hue match what the eye compares.
// Rules and method ported from Pachislop's presets/lint.ts (licenses/ported/pachislop-looks.md), which had no tests.
//
// Thresholds are for video, where Pachislop's were for a still seen at full size:
// - `MIN_DELTA_L` 15 (was 12): 4:2:0 chroma subsampling leaves edges to luma, so hue alone cannot separate two rings.
// - `MIN_RIM_PX` 2 px at 1080p (was 5 % of the size, for busy still backgrounds): one pixel does not survive a 1080p to 720p
//   downscale and a streaming encode. Without a known size, `MIN_RIM_PERCENT` 2 %, that line on a 100 px title.
// - `MAX_RIM_PERCENT` 16 %, the stem of the heavy faces titles use; `FLOOD_RIM_PERCENT` 30 %: both sides of a stroke then
//   meet and counters fill, so the word is lost. That one is an error.
// - A hard shadow is opaque, near black and blurred less than 4 % of the size, and only counts on letters with no outline:
//   behind an inked ring a hard block is a drawn extrusion, not a cheap shadow.
//
// What this file cannot see is the picture behind the title. Rendered checks reach it through `LintContext.rendered`: the
// caller measures, this file compares, and a check with no measurement is listed in `unmeasured`, never passed.
import type { Command } from '../commands/schemas/index.ts';
import type { RGBA } from '../schema/common.ts';
import { type Appearance, type Gradient, MAX_APPEARANCE_LAYERS, type Paint, type Role } from './model.ts';
import { paintRoles } from './overrides.ts';
import { type ResolvedTitleLayer, resolveAppearance } from './resolve.ts';

export const LINT_SEVERITIES = ['error', 'warning', 'info'] as const;
export type LintSeverity = (typeof LINT_SEVERITIES)[number];

const LINT_CODES = [
	'LOOK_INVISIBLE',
	'LOOK_NOOP_LAYER',
	'LOOK_HIDDEN_LAYER',
	'LOOK_FLAT_GRADIENT',
	'LOOK_RINGS_MERGE',
	'LOOK_TOO_MANY_HUES',
	'LOOK_RIMS_THIN',
	'LOOK_RIMS_THICK',
	'LOOK_RIMS_FLOOD',
	'LOOK_HARD_SHADOW',
	'LOOK_SPECTRUM_SPAN',
	'LOOK_FIXED_READS_ROLE',
	'LOOK_BACKDROP_CONTRAST',
] as const;
export type LintCode = (typeof LINT_CODES)[number];

export type LintFix = {
	/** English UI literal (the i18n key). */
	label: string;
	/** One transaction, so one undo step. */
	commands: Command[];
};

export type LintIssue = {
	/** Stable per rule and element (a React key, a `title_check` row id). */
	id: string;
	code: LintCode;
	severity: LintSeverity;
	/** English, rendered. */
	message: string;
	/** `message` as an i18n key with `{0}` placeholders, and their values: what the UI translates. */
	template: string;
	args: string[];
	/** The practice it breaks. */
	rule: string;
	/** The layers it is about, topmost first. */
	layerIds: string[];
	measured?: number;
	expected?: string;
	/** A mechanical repair exists. `fix` holds it when the context names the effect instance. */
	fixable: boolean;
	fix?: LintFix;
};

/** Measured from pixels by the caller (`title_check`): the seam for rendered checks. */
export type RenderedLookMeasures = {
	/** Mean L* of the picture just outside the title, the worst of the sampled frames. */
	backdropL: number;
	/** Frames sampled. */
	frames: number;
};

export type LintContext = {
	/** The look's instance: fixes need it to address layers. */
	effectInstanceId?: string;
	/** Content time to judge values at (flicks). */
	time?: number;
	/** TL-012: rims are judged against lettering only on text. */
	clipKind?: string;
	/** Multi-line text: gradients must span lines. */
	text?: string;
	/** Text size and frame height, px: the rim thresholds then follow the real size. */
	sizePx?: number;
	frameHeight?: number;
	rendered?: RenderedLookMeasures;
};

/** Rendered checks with no measurement in the context. */
export const RENDERED_CHECKS = ['backdrop-contrast'] as const;
export type RenderedCheck = (typeof RENDERED_CHECKS)[number];

export type LintReport = {
	/** Errors first, then top of the stack first. */
	issues: LintIssue[];
	/** Rendered checks not run: unknown, not passed. */
	unmeasured: RenderedCheck[];
};

// ---------- thresholds ----------

/** Adjacent elements closer than this in L* blur into one shape. */
export const MIN_DELTA_L = 15;
/** Below this L* both rings are black: two dark rings read as one thick keyline, which is fine. */
const DARK_L = 25;
/** Banded metals (L* range wider than this) separate from each other through their banding. */
const BANDED = 30;
/** Chroma (C*) above which a colour counts as a hue rather than a neutral. */
const CHROMATIC = 25;
/** Hues within this many degrees (a*b* angle) are one colour family. */
const HUE_FAMILY = 30;
/** A gradient whose chromatic samples spread wider than this is a spectrum, not one hue. */
const SPECTRUM_SPREAD = 120;
export const MIN_RIM_PX_1080 = 2;
export const MIN_RIM_PERCENT = 2;
export const MAX_RIM_PERCENT = 16;
export const FLOOD_RIM_PERCENT = 30;
/** What a thin or thick stack is scaled to. */
const RIM_FIX_THIN = 4;
const RIM_FIX_THICK = 12;
/** Hard shadow: more opaque than this, percent. */
const HARD_OPACITY = 80;
/** Hard shadow: blurred less than this, percent of the size. */
const HARD_BLUR = 4;
const HARD_LUMA = 0.15;
const SOFT_OPACITY = 60;
const SOFT_BLUR = 7;
/** Roles a separator ring may take, by what it has to be. */
const DARK_ROLES: readonly Role[] = ['keyline', 'base', 'shadow'];
const LIGHT_ROLES: readonly Role[] = ['accent1', 'accent3', 'face', 'glow'];
/** Width of an inserted separator ring, percent of the size. */
const SEPARATOR_WIDTH = 2;
/** L* a title's outside must differ from what is behind it, with no halo between them. */
export const MIN_BACKDROP_DELTA_L = 20;
/** Under this the outside is gone: the title's edge cannot be seen at all. */
const LOST_BACKDROP_DELTA_L = 6;

const MESSAGES = {
	invisible: 'Nothing in this look draws: the title is invisible.',
	rimZero: 'Rim of width 0: this layer draws nothing.',
	rimClear: 'Rim at 0 % opacity: this layer draws nothing.',
	shadowClear: 'Shadow at 0 % opacity: this layer draws nothing.',
	shadowBehind: 'Shadow with no distance, blur or spread: it sits behind the title and draws nothing.',
	glowZero: 'Glow with no radius or intensity: this layer draws nothing.',
	hiddenFace: 'A face under an opaque face cannot be seen.',
	flatGradient: 'This gradient has one colour under the current palette.',
	merge: '{0} and {1} are close in lightness (ΔL {2}): they merge into one band.',
	hues: '{0} chromatic hues ({1}): the eye cannot find the face.',
	thin: 'Rims total {0} % of the size: too thin to survive on video.',
	thick: 'Rims total {0} % of the size: thicker than the letter strokes.',
	flood: 'Rims total {0} % of the size: counters fill and the word is lost.',
	hardShadow: 'Hard black drop shadow: opaque, with almost no blur.',
	span: 'A spectrum spans the whole block: each line only gets part of it.',
	fixedReads: 'This layer is marked fixed but reads {0}: colourways change it.',
	backdrop: '{0} is close to the picture behind it (ΔL {1}, frames sampled: {2}).',
} as const;

const FIX_LABELS = [
	'Remove the layer',
	'Show the face',
	'Insert a light line',
	'Insert a dark line',
	'Scale the rims up',
	'Scale the rims down',
	'Soften it',
	'Span each line',
	'Fix its colours',
	'Add a soft halo',
] as const;

const RULES: Record<string, string> = {
	invisible: 'A look must draw something.',
	noop: 'A setting that is on but changes nothing hides why a look does not work.',
	contrast:
		'Neighbouring rings need lightness contrast: a light face takes a dark rim and vice versa, alternating outward. On video the chroma is subsampled, so hue alone does not separate them.',
	hues: 'Three chromatic hues across face and rims leave the eye nowhere to land: keep rims neutral or in the face’s own family.',
	thin: 'Rims under about two pixels at 1080p vanish in a downscale and a streaming encode.',
	thick:
		'Rims thicker than the letter strokes eat into the shapes and flood the counters: use a heavier font or thinner rims.',
	shadow:
		'A hard black drop shadow on plain letters reads cheap: use a soft blur, a small offset and a tint of the scene.',
	span: 'A spectrum belongs on every line: spanning the block gives each line only part of it.',
	fixed: 'A layer marked fixed must not read a role, or colourways change it.',
	backdrop: 'A title’s outside must stand apart from the picture behind it, or carry a halo that does.',
};

/** Every string the check shows, for the catalogues. */
export const LINT_STRINGS: readonly string[] = [
	...Object.values(MESSAGES),
	...Object.values(RULES),
	...FIX_LABELS,
	'Face',
	...Array.from({ length: MAX_APPEARANCE_LAYERS }, (_, i) => `Rim ${i + 1}`),
];

// ---------- colour ----------

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const labF = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);

/** sRGB 0..1 → CIE L*a*b* (D65). */
export function labOf(c: readonly number[]): [number, number, number] {
	const R = toLinear(c[0]!);
	const G = toLinear(c[1]!);
	const B = toLinear(c[2]!);
	const fx = labF((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
	const fy = labF(0.2126 * R + 0.7152 * G + 0.0722 * B);
	const fz = labF((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
	return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const luma601 = (c: readonly number[]) => 0.299 * c[0]! + 0.587 * c[1]! + 0.114 * c[2]!;
const hueOf = (a: number, b: number) => ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
const hueDist = (x: number, y: number) => Math.min(Math.abs(x - y), 360 - Math.abs(x - y));

const SAMPLES = 9;

/** A gradient at 0..1 under a palette, in the signal, as stops interpolate. */
function gradientAt(g: Gradient, palette: Record<Role, RGBA>, x: number): RGBA {
	const stops = [...g.stops].sort((a, b) => a.at - b.at);
	const colorOf = (s: Gradient['stops'][number]): RGBA =>
		'role' in s.paint ? palette[s.paint.role] : (s.paint.color as RGBA);
	if (x <= stops[0]!.at) return colorOf(stops[0]!);
	for (let i = 1; i < stops.length; i++) {
		const b = stops[i]!;
		if (x > b.at) continue;
		const a = stops[i - 1]!;
		const f = b.at > a.at ? (x - a.at) / (b.at - a.at) : 1;
		const ca = colorOf(a);
		const cb = colorOf(b);
		return [0, 1, 2, 3].map((k) => ca[k]! + (cb[k]! - ca[k]!) * f) as RGBA;
	}
	return colorOf(stops.at(-1)!);
}

/** Representative colours of a paint, or null for the clip's own picture (it cannot be judged here). */
function samplesOf(p: Paint, palette: Record<Role, RGBA>): RGBA[] | null {
	if (p.kind === 'source') return null;
	if (p.kind === 'role') return [palette[p.role]];
	if (p.kind === 'color') return [p.color as RGBA];
	return Array.from({ length: SAMPLES }, (_, i) => gradientAt(p.gradient, palette, i / (SAMPLES - 1)));
}

type Element = {
	layer: ResolvedTitleLayer;
	/** English; `Face` or `Rim n`. */
	label: string;
	/** Mean L*. */
	L: number;
	/** L* range across the samples (banding). */
	spread: number;
	/** Mean hue of the chromatic samples; null = neutral or a spectrum. */
	hue: number | null;
	spectrum: boolean;
};

function element(layer: ResolvedTitleLayer, label: string, rgb: readonly RGBA[]): Element {
	const labs = rgb.map(labOf);
	const Ls = labs.map((c) => c[0]);
	const L = Ls.reduce((s, v) => s + v, 0) / Ls.length;
	const spread = Math.max(...Ls) - Math.min(...Ls);
	const chroma = labs.filter(([, a, b]) => Math.hypot(a, b) > CHROMATIC);
	const hues = chroma.map(([, a, b]) => hueOf(a, b));
	const spectrum = hues.some((h) => hues.some((k) => hueDist(h, k) > SPECTRUM_SPREAD));
	let hue: number | null = null;
	if (!spectrum && chroma.length * 2 >= labs.length) {
		const a = chroma.reduce((s, c) => s + c[1], 0);
		const b = chroma.reduce((s, c) => s + c[2], 0);
		hue = hueOf(a, b);
	}
	return { layer, label, L, spread, hue, spectrum };
}

// ---------- reading the stack ----------

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const paintOfLayer = (l: ResolvedTitleLayer, name = 'paint') => l.params[name] as Paint | undefined;

const pctOf = (l: ResolvedTitleLayer) => num(l.params.opacity, 100);
const isFace = (l: ResolvedTitleLayer) => l.type === 'face';
const isRim = (l: ResolvedTitleLayer) => l.type === 'rim';
const rimSize = (l: ResolvedTitleLayer) => num(l.params.width, 0) + num(l.params.offset, 0);

/** Lettering rings, face then outward. A rim standing off with an offset starts a new run: air separates it. */
function rings(layers: readonly ResolvedTitleLayer[], palette: Record<Role, RGBA>) {
	const runs: Element[][] = [[]];
	let topFace = -1;
	for (let i = layers.length - 1; i >= 0; i--)
		if (isFace(layers[i]!) && pctOf(layers[i]!) > 0) {
			topFace = i;
			break;
		}
	const addTo = (l: ResolvedTitleLayer, label: string) => {
		const p = paintOfLayer(l);
		const rgb = p ? samplesOf(p, palette) : null;
		if (rgb) runs.at(-1)!.push(element(l, label, rgb));
	};
	if (topFace >= 0) addTo(layers[topFace]!, 'Face');
	let n = 0;
	for (let i = (topFace >= 0 ? topFace : layers.length) - 1; i >= 0; i--) {
		const l = layers[i]!;
		if (!isRim(l) || num(l.params.width) <= 0 || pctOf(l) <= 0) continue;
		n++;
		if (num(l.params.offset) > 0) runs.push([]);
		addTo(l, `Rim ${n}`);
	}
	return runs;
}

const setParam = (fx: string, layerId: string, param: string, value: unknown): Command =>
	({ type: 'param.set', target: ['appearance', fx, layerId, param], value }) as unknown as Command;

const removeLayer = (fx: string, layerId: string): Command =>
	({ type: 'appearance.removeLayer', effectInstanceId: fx, layerId }) as unknown as Command;

type Draft = Omit<LintIssue, 'fixable' | 'fix'> & { build?: (fx: string) => LintFix };

/** A message: its template, its arguments and the English text. */
function say(template: string, ...args: (string | number)[]) {
	const list = args.map(String);
	return { template, args: list, message: template.replace(/\{(\d+)\}/g, (_, i) => list[Number(i)] ?? '') };
}

/** Every rim's width × `k`. */
const scaleRims = (rims: readonly ResolvedTitleLayer[], k: number) => (fx: string) =>
	rims.map((r) => setParam(fx, r.id, 'width', Math.round(num(r.params.width) * k * 100) / 100));

function noopIssues(layers: readonly ResolvedTitleLayer[], palette: Record<Role, RGBA>): Draft[] {
	const out: Draft[] = [];
	const noop = (l: ResolvedTitleLayer, template: string) => {
		out.push({
			id: `noop-${l.id}`,
			code: 'LOOK_NOOP_LAYER',
			severity: 'warning',
			...say(template),
			rule: RULES.noop!,
			layerIds: [l.id],
			build: (fx) => ({ label: 'Remove the layer', commands: [removeLayer(fx, l.id)] }),
		});
	};
	layers.forEach((l, i) => {
		if (isRim(l) && num(l.params.width) <= 0) noop(l, MESSAGES.rimZero);
		else if (isRim(l) && pctOf(l) <= 0) noop(l, MESSAGES.rimClear);
		else if (l.type === 'shadow') {
			if (pctOf(l) <= 0) noop(l, MESSAGES.shadowClear);
			else if (
				l.params.kind !== 'perspective' &&
				num(l.params.distance) <= 0 &&
				num(l.params.blur) <= 0 &&
				num(l.params.spread) <= 0
			)
				noop(l, MESSAGES.shadowBehind);
		} else if (l.type === 'glow' && (num(l.params.intensity) <= 0 || num(l.params.radius) <= 0))
			noop(l, MESSAGES.glowZero);
		// A face under an opaque flat face with the same outline cannot be seen.
		if (isFace(l)) {
			const above = layers.slice(i + 1).find((x) => isFace(x) && pctOf(x) >= 100);
			if (above)
				out.push({
					id: `hidden-${l.id}`,
					code: 'LOOK_HIDDEN_LAYER',
					severity: 'warning',
					...say(MESSAGES.hiddenFace),
					rule: RULES.noop!,
					layerIds: [l.id, above.id],
					build: (fx) => ({ label: 'Remove the layer', commands: [removeLayer(fx, l.id)] }),
				});
		}
		const p = paintOfLayer(l);
		if (p?.kind === 'gradient') {
			const s = samplesOf(p, palette)!;
			const flat = s.every((c) => c.every((v, k) => Math.abs(v - s[0]![k]!) < 1 / 255));
			if (flat)
				out.push({
					id: `flat-gradient-${l.id}`,
					code: 'LOOK_FLAT_GRADIENT',
					severity: 'info',
					...say(MESSAGES.flatGradient),
					rule: RULES.noop!,
					layerIds: [l.id],
				});
		}
	});
	return out;
}

function visibleIssues(layers: readonly ResolvedTitleLayer[]): Draft[] {
	const draws = layers.some((l) => {
		if (isFace(l)) return pctOf(l) > 0;
		if (isRim(l)) return num(l.params.width) > 0 && pctOf(l) > 0;
		if (l.type === 'shadow') return pctOf(l) > 0;
		if (l.type === 'glow') return num(l.params.intensity) > 0 && num(l.params.radius) > 0;
		return true;
	});
	if (draws) return [];
	return [
		{
			id: 'invisible',
			code: 'LOOK_INVISIBLE',
			severity: 'error',
			...say(MESSAGES.invisible),
			rule: RULES.invisible!,
			layerIds: layers.map((l) => l.id).reverse(),
			...(layers.find(isFace)
				? {
						build: (fx: string) => ({
							label: 'Show the face',
							commands: [setParam(fx, layers.find(isFace)!.id, 'opacity', 100)],
						}),
					}
				: {}),
		},
	];
}

function contrastIssues(
	runs: readonly Element[][],
	palette: Record<Role, RGBA>,
	stored: Appearance['layers'],
): Draft[] {
	const out: Draft[] = [];
	for (const run of runs)
		for (let i = 1; i < run.length; i++) {
			const a = run[i - 1]!;
			const b = run[i]!;
			// A spectrum spans every lightness; two blacks are one thick keyline; two banded metals separate by their banding.
			if (a.spectrum || b.spectrum) continue;
			if ((a.L < DARK_L && b.L < DARK_L) || (a.spread > BANDED && b.spread > BANDED)) continue;
			const dL = Math.abs(a.L - b.L);
			if (dL >= MIN_DELTA_L) continue;
			// A ring opposite in lightness to the pair it separates, in a role the palette can take.
			const mean = (a.L + b.L) / 2;
			const light = mean <= 50;
			const role = (light ? LIGHT_ROLES : DARK_ROLES).find((r) => {
				const L = labOf(palette[r])[0];
				return Math.abs(L - a.L) >= MIN_DELTA_L && Math.abs(L - b.L) >= MIN_DELTA_L;
			});
			// Right under `a`: the stack is bottom-first, so the new ring takes `a`'s index and sits between the two.
			const index = stored.findIndex((l) => l.id === a.layer.id);
			out.push({
				id: `contrast-${b.layer.id}`,
				code: 'LOOK_RINGS_MERGE',
				severity: 'warning',
				...say(MESSAGES.merge, a.label, b.label, dL.toFixed(0)),
				rule: RULES.contrast!,
				layerIds: [a.layer.id, b.layer.id],
				measured: Math.round(dL * 10) / 10,
				expected: `ΔL ≥ ${MIN_DELTA_L}`,
				...(role
					? {
							build: (fx: string) => ({
								label: light ? 'Insert a light line' : 'Insert a dark line',
								commands: [
									{
										type: 'appearance.addLayer',
										effectInstanceId: fx,
										layerType: 'rim',
										index,
										name: light ? 'Light line' : 'Dark line',
										params: { width: SEPARATOR_WIDTH, paint: { kind: 'role', role } },
									} as unknown as Command,
								],
							}),
						}
					: {}),
			});
		}
	return out;
}

function hueIssues(runs: readonly Element[][]): Draft[] {
	const families: { hue: number; els: Element[] }[] = [];
	for (const el of runs.flat()) {
		if (el.hue === null) continue;
		const fam = families.find((f) => hueDist(f.hue, el.hue!) < HUE_FAMILY);
		if (fam) fam.els.push(el);
		else families.push({ hue: el.hue, els: [el] });
	}
	if (families.length < 3) return [];
	const list = families.map((f) => f.els.map((e) => e.label).join(' + ')).join(' / ');
	return [
		{
			id: 'hues',
			code: 'LOOK_TOO_MANY_HUES',
			severity: 'warning',
			...say(MESSAGES.hues, families.length, list),
			rule: RULES.hues!,
			layerIds: families.flatMap((f) => f.els.map((e) => e.layer.id)),
			measured: families.length,
			expected: 'at most 2 hue families',
		},
	];
}

function thicknessIssues(layers: readonly ResolvedTitleLayer[], ctx: LintContext): Draft[] {
	if (ctx.clipKind !== undefined && ctx.clipKind !== 'text') return [];
	const rims = layers.filter((l) => isRim(l) && num(l.params.width) > 0 && pctOf(l) > 0).reverse();
	const total = rims.reduce((s, r) => s + rimSize(r), 0);
	if (total <= 0) return [];
	const ids = rims.map((r) => r.id);
	const min =
		ctx.sizePx && ctx.sizePx > 0
			? Math.max(
					MIN_RIM_PERCENT / 2,
					(MIN_RIM_PX_1080 * (ctx.frameHeight ?? 1080)) / 1080 / (ctx.sizePx / 100),
				)
			: MIN_RIM_PERCENT;
	const stat = { measured: Math.round(total * 10) / 10 };
	if (total < min)
		return [
			{
				id: 'rims-thin',
				code: 'LOOK_RIMS_THIN',
				severity: 'warning',
				...say(MESSAGES.thin, total.toFixed(1)),
				rule: RULES.thin!,
				layerIds: ids,
				...stat,
				expected: `at least ${min.toFixed(1)} %`,
				build: (fx) => {
					const to = Math.max(RIM_FIX_THIN, min);
					return {
						label: 'Scale the rims up',
						commands: scaleRims(rims, to / total)(fx),
					};
				},
			},
		];
	if (total > MAX_RIM_PERCENT) {
		const flood = total >= FLOOD_RIM_PERCENT;
		return [
			{
				id: flood ? 'rims-flood' : 'rims-thick',
				code: flood ? 'LOOK_RIMS_FLOOD' : 'LOOK_RIMS_THICK',
				severity: flood ? 'error' : 'warning',
				...say(flood ? MESSAGES.flood : MESSAGES.thick, total.toFixed(1)),
				rule: RULES.thick!,
				layerIds: ids,
				...stat,
				expected: `at most ${MAX_RIM_PERCENT} %`,
				build: (fx) => ({
					label: 'Scale the rims down',
					commands: scaleRims(rims, RIM_FIX_THICK / total)(fx),
				}),
			},
		];
	}
	return [];
}

function shadowIssues(layers: readonly ResolvedTitleLayer[], palette: Record<Role, RGBA>): Draft[] {
	if (layers.some((l) => isRim(l) && num(l.params.width) > 0 && pctOf(l) > 0)) return [];
	const out: Draft[] = [];
	for (const l of layers) {
		if (l.type !== 'shadow' || l.params.kind === 'long') continue;
		const p = paintOfLayer(l);
		const rgb = p ? samplesOf(p, palette) : null;
		if (!rgb || pctOf(l) <= HARD_OPACITY || num(l.params.blur) >= HARD_BLUR) continue;
		if (num(l.params.distance) <= 0 || luma601(rgb[0]!) >= HARD_LUMA) continue;
		out.push({
			id: `hard-shadow-${l.id}`,
			code: 'LOOK_HARD_SHADOW',
			severity: 'warning',
			...say(MESSAGES.hardShadow),
			rule: RULES.shadow!,
			layerIds: [l.id],
			build: (fx) => ({
				label: 'Soften it',
				commands: [setParam(fx, l.id, 'opacity', SOFT_OPACITY), setParam(fx, l.id, 'blur', SOFT_BLUR)],
			}),
		});
	}
	return out;
}

function spanIssues(
	layers: readonly ResolvedTitleLayer[],
	palette: Record<Role, RGBA>,
	ctx: LintContext,
): Draft[] {
	if (!ctx.text?.trim().includes('\n')) return [];
	const out: Draft[] = [];
	for (const l of layers) {
		const p = paintOfLayer(l);
		if (p?.kind !== 'gradient' || p.gradient.span !== 'block') continue;
		if (!element(l, '', samplesOf(p, palette)!).spectrum) continue;
		const gradient = p.gradient;
		out.push({
			id: `span-${l.id}`,
			code: 'LOOK_SPECTRUM_SPAN',
			severity: 'warning',
			...say(MESSAGES.span),
			rule: RULES.span!,
			layerIds: [l.id],
			build: (fx) => ({
				label: 'Span each line',
				commands: [
					{
						type: 'appearance.setGradient',
						effectInstanceId: fx,
						layerId: l.id,
						gradient: { ...gradient, span: 'line' },
					} as unknown as Command,
				],
			}),
		});
	}
	return out;
}

function fixedIssues(layers: readonly ResolvedTitleLayer[]): Draft[] {
	const out: Draft[] = [];
	for (const l of layers) {
		if (!l.fixedColor) continue;
		const roles = new Set(Object.values(l.params).flatMap((v) => paintRoles(v)));
		if (roles.size === 0) continue;
		out.push({
			id: `fixed-${l.id}`,
			code: 'LOOK_FIXED_READS_ROLE',
			severity: 'warning',
			...say(MESSAGES.fixedReads, [...roles].join(', ')),
			rule: RULES.fixed!,
			layerIds: [l.id],
			build: (fx) => ({
				label: 'Fix its colours',
				commands: [
					{
						type: 'appearance.setLayerFixedColor',
						effectInstanceId: fx,
						layerId: l.id,
						fixed: true,
					} as unknown as Command,
				],
			}),
		});
	}
	return out;
}

/** The outermost element a title shows, for a backdrop comparison, or null when it paints the clip's own picture. */
function outermost(runs: readonly Element[][]): Element | null {
	const flat = runs.flat();
	return flat.at(-1) ?? null;
}

function backdropIssues(
	runs: readonly Element[][],
	layers: readonly ResolvedTitleLayer[],
	rendered: RenderedLookMeasures,
): Draft[] {
	const edge = outermost(runs);
	if (!edge) return [];
	// A halo or a soft shadow behind the title separates it from anything.
	const halo = layers.some(
		(l) =>
			(l.type === 'glow' && num(l.params.intensity) >= 40 && num(l.params.radius) > 0) ||
			(l.type === 'shadow' && pctOf(l) >= 40 && num(l.params.blur) > 0),
	);
	if (halo) return [];
	const dL = Math.abs(edge.L - rendered.backdropL);
	if (dL >= MIN_BACKDROP_DELTA_L) return [];
	const lost = dL < LOST_BACKDROP_DELTA_L;
	return [
		{
			id: 'backdrop',
			code: 'LOOK_BACKDROP_CONTRAST',
			severity: lost ? 'error' : 'warning',
			...say(MESSAGES.backdrop, edge.label, dL.toFixed(0), rendered.frames),
			rule: RULES.backdrop!,
			layerIds: [edge.layer.id],
			measured: Math.round(dL * 10) / 10,
			expected: `ΔL ≥ ${MIN_BACKDROP_DELTA_L}`,
			build: (fx) => ({
				label: 'Add a soft halo',
				commands: [
					{
						type: 'appearance.addLayer',
						effectInstanceId: fx,
						layerType: 'glow',
						index: 0,
						name: 'Halo',
						params: { radius: 22, intensity: 62, paint: { kind: 'role', role: 'shadow' } },
					} as unknown as Command,
				],
			}),
		},
	];
}

const RANK: Record<LintSeverity, number> = { error: 0, warning: 1, info: 2 };

/** The issues of an appearance, errors first. Pure and deterministic. */
export function lintAppearance(a: Appearance, ctx: LintContext = {}): LintReport {
	const look = resolveAppearance(a, ctx.time ?? 0);
	const { layers, palette } = look;
	const runs = rings(layers, palette);
	const drafts: Draft[] = [
		...visibleIssues(layers),
		...noopIssues(layers, palette),
		...spanIssues(layers, palette, ctx),
		...contrastIssues(runs, palette, a.layers),
		...hueIssues(runs),
		...thicknessIssues(layers, ctx),
		...shadowIssues(layers, palette),
		...fixedIssues(layers),
		...(ctx.rendered ? backdropIssues(runs, layers, ctx.rendered) : []),
	];
	const issues = drafts
		.map(({ build, ...d }, order) => ({
			issue: {
				...d,
				fixable: !!build,
				...(build && ctx.effectInstanceId ? { fix: build(ctx.effectInstanceId) } : {}),
			} as LintIssue,
			order,
		}))
		.sort((x, y) => RANK[x.issue.severity] - RANK[y.issue.severity] || x.order - y.order)
		.map((x) => x.issue);
	return { issues, unmeasured: ctx.rendered ? [] : [...RENDERED_CHECKS] };
}
