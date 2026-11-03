// Spec 19 §5: the extension contract of Title Looks. A layer type, a finish or a generator is one `define…` call in its
// own file plus one line in `layers/index.ts`, `finishes/index.ts` or `generators/index.ts`; the planner (`plan.ts`),
// validation (`title-looks/validate.ts`), commands, padding, UI summaries and the test harness all read these records,
// so no new type edits the core. Authoring guide with worked examples: docs/wp-notes/title-looks.md "How to extend".
//
// Units: every distance param (`lp.distance`) is a percentage of the look's unit (TL-012: the text size for text clips,
// the shorter side of the alpha bounds otherwise). GLSL converts with `tl_px(u_x)` to canvas pixels, so a look never
// depends on the render resolution. Colours inside a look are linear light, premultiplied (TL-032).
import type { RGBA } from '../../../schema/common.ts';
import type { LayerParamValue, Paint, Role } from '../../../title-looks/model.ts';
import type { ResolvedAppearance } from '../../../title-looks/resolve.ts';
import type { EffectCategory, ParamSpec } from '../../effects.ts';
import { fxParam } from '../params.ts';
import type { FxUniformValue, GlslChunk, ShaderPass } from '../shader.ts';

/** Evaluated params of a layer at a frame: stored values over the type's defaults. */
export type LayerParams = Record<string, LayerParamValue>;

/** A paint param (hold-only structure, edited by `appearance.setPaint` / `appearance.setGradient`). */
export type PaintParamSpec = {
	name: string;
	label: string;
	type: 'paint';
	default: Paint;
	animatable: false;
	group?: string;
};

/** A distance param (a percentage of the look's unit): `unit: '%'` with `distance: true`. */
export type TitleParamSpec = (ParamSpec & { distance?: boolean }) | PaintParamSpec;

export const isPaintParam = (p: TitleParamSpec): p is PaintParamSpec => p.type === 'paint';

/**
 * Padding reach of one layer, in percent of the unit, per side, beyond the silhouette the layer starts from.
 * `boxHeight`: more on the left and right as a fraction of the layer box's height (a leaning plate reaches further the
 * taller the shape is, which percent of the unit cannot say).
 */
export type LayerReach =
	| number
	| { left: number; top: number; right: number; bottom: number; boxHeight?: number };

export type LayerShader = {
	/**
	 * GLSL defining `vec4 tl_layer(TlSurface s)`: this layer's picture, premultiplied linear light, composited over
	 * what is below it. Available: everything of `GLSL_TL` (`glsl.ts`), `u_<param>` of each param, `tlPaint_<param>(s)`
	 * of each paint param, `tl_finish(paint, s)` when the type takes a finish, `u_tlLight` (unit vector to the light),
	 * `u_tlSeed` (0..1, from the appearance), `u_tlTime` (content seconds, continuous across razor cuts). Mentioning
	 * `tl_bounds()` makes the planner run the alpha bounds reduction.
	 */
	glsl: string;
	include?: readonly GlslChunk[];
	/** The shader or its includes read `tl_bounds()` where `plan.ts` cannot see it (chunks, prepasses). */
	usesBounds?: boolean;
};

/** A blur the framework runs for a layer: `tlMask` → horizontal and vertical passes → `u_tlBlur`, all at reduced size. */
export type LayerBlur = {
	/** Gaussian sigma in percent of the unit (0 = no blur passes; read `u_tlBlur` only when this is above 0). */
	sigma: number;
	/** GLSL `vec4 tl_mask(TlSurface s)`: the premultiplied picture to blur. */
	mask: string;
	include?: readonly GlslChunk[];
};

/** Passes a layer runs before its own (shared intermediates beyond the blur). See "How to extend". */
export type LayerPrepass = (p: LayerParams, ctx: PrepassContext) => readonly ShaderPass[];

export type LayerPlanContext = {
	look: ResolvedAppearance;
	/** Canvas pixels per 1 % of the unit; for clips without a known unit an upper bound (see `plan.ts`). */
	pxPerPercent: number;
	/** Silhouette growth of the layers above this one, percent of the unit (TL §5.1 rim: cumulative). */
	base: number;
};

/** What a prepass needs on top of `LayerPlanContext`: a prepass draws with the same surface as the layer's own pass. */
export type PrepassContext = LayerPlanContext & {
	/**
	 * Chunks that give a prepass `tl_surface()`, `tl_px()` and `tl_bounds()` (when planned): the unit, the field and the
	 * bounds, not the layer's own chunks (a prepass adds what it reads; `surfacePass` adds them all).
	 */
	include: readonly GlslChunk[];
	/** This layer's uniforms (`u_tlBase`, every param): spread them into each prepass. */
	uniforms: Readonly<Record<string, FxUniformValue>>;
	/** This layer's `#define`s (media params, finish variants): start each prepass's `frag` with them. */
	defines: string;
	/** The layer's own shape (`TitleLayerType.depth`). */
	depth: LayerDepth;
	/** Growth of the whole stack, percent of the unit: the silhouette of everything is at `s.d` = this. */
	outer: number;
	/**
	 * `pxPerPercent` is exact (the text size); false = an upper bound, the true unit comes from the alpha bounds (a clip
	 * without text): size reduced passes with a margin.
	 */
	unitKnown: boolean;
	/** The GLSL of `tl_px` and `tl_unit` (a blur prepass needs nothing else). */
	unit: GlslChunk;
	/**
	 * `pass` with what the layer's own pass has: `frag` may use `tl_surface()`, `tl_px`, `tlPaint_<param>(s)`, the
	 * layer's `u_<param>` and `tl_finish`. Without it a prepass sees the framework's prelude only (or `include`,
	 * `uniforms` and `defines` above, which give the surface without the layer's own GLSL).
	 */
	surfacePass: (pass: ShaderPass) => ShaderPass;
	/** The `update` flag of a write to output `name`: true from its second write in this plan on. */
	write(name: string): { update?: true };
};

/**
 * The layer's own shape for its finish. `glsl` defines `float tl_depth(TlSurface s)`: how deep `s` lies inside it (canvas
 * px, 0 at its outer edge, negative outside), and `float tl_bandPx(TlSurface s)`: the width of a ring, 0 for a filled
 * shape. `ring`: a ring knows its thickness, a filled shape must measure it (Fit to stroke width).
 */
export type LayerDepth = { glsl: string; ring: boolean };

export const FILLED_DEPTH: LayerDepth = {
	glsl: /* glsl */ `
float tl_depth(TlSurface s) { return -s.d; }
float tl_bandPx(TlSurface s) { return 0.0; }
`,
	ring: false,
};

/** What the shape field must get right for a layer: distance from the shape edge, percent of the unit. */
export type LayerFieldReach = { outside: number; inside: number };

export type SummaryContext = {
	/** Role value lookup for swatches. */
	palette?: Partial<Record<Role, RGBA>>;
};

/** One line in the Appearance list (TL-089): a swatch, a sentence and the primary value's param. */
export type LayerSummary = { swatch: Paint | null; text: string; primary: string | null };

/** An on-canvas handle of a layer (TL-092). */
export type LayerHandle = {
	kind: 'distance' | 'offset' | 'angle' | 'position';
	params: readonly string[];
	/** Whose `params`: the layer's (default), or the look's `light` (address `["appearance", fxId, "light", <param>]`). */
	target?: 'layer' | 'light';
	/** The handle exists only while this param has this value (a shadow following the light has no angle of its own). */
	when?: { param: string; value: boolean | string };
};

export type TitleLayerType = {
	/** `face`, `rim`, …; a generator layer is `generator:<id>`. Stored in documents: never rename. */
	type: string;
	label: string;
	description: string;
	/** Own params; finish params are added by `finish: true`. Names: letters and digits, unique within the type. */
	params: readonly TitleParamSpec[];
	/** The type takes the shared finish param (TL §5.1): `tl_finish` is available and the finish's params are valid. */
	finish: boolean;
	/**
	 * TL-093: letters whose run sets a finish (`content.runs[].finish`) draw this layer with that finish instead of its
	 * own (the face: the letters themselves; rims stay one outline across letters). Needs `finish`.
	 */
	letterFinish?: boolean;
	shader: (p: LayerParams, ctx: LayerPlanContext) => LayerShader;
	/** How far this layer paints beyond the silhouette it starts from, for `gpu.padding` (default 0). */
	reach?: (p: LayerParams) => LayerReach;
	/** The silhouette growth this layer adds for the layers below it (rims; default 0). */
	grows?: (p: LayerParams) => number;
	/**
	 * The layer starts from the whole look's silhouette wherever it sits: `s.base` and padding count every layer's
	 * growth, not only that of the layers above it (a reflection on top of the stack mirrors about the outermost rim).
	 */
	outermost?: boolean;
	/** What the shape field must reach for this layer. Default: `reach`'s largest side outside, nothing inside. */
	fieldReach?: (p: LayerParams) => Partial<LayerFieldReach>;
	/** A blur the layer reads through `u_tlBlur`, or null. */
	blur?: (p: LayerParams, ctx: LayerPlanContext) => LayerBlur | null;
	/** Extra passes before this layer's own; they run before the finish's. */
	prepass?: LayerPrepass;
	/** A prepass reads `tl_bounds()`: the planner cannot see into it, so it says so. */
	prepassReadsBounds?: (p: LayerParams) => boolean;
	/** Default `FILLED_DEPTH`. Layers that take a finish and are not the filled shape say what their shape is. */
	depth?: LayerDepth;
	/** Uniforms beyond one per param: data textures, values derived from several params. */
	uniforms?: (p: LayerParams) => Readonly<Record<string, FxUniformValue>>;
	/** The layer's picture changes with time on its own (generators, grain): the clip then redraws every frame. */
	timeDependent?: (p: LayerParams) => boolean;
	/** TL-051: colours come from the shader, not from paints: the planner binds `tl_recolor`'s ramp (`recolor.ts`). */
	recolors?: boolean;
	summary: (p: LayerParams, ctx: SummaryContext) => LayerSummary;
	/** Program-monitor handles (TL-092). Read by the UI. */
	handles?: readonly LayerHandle[];
	/** Generators: this layer goes above the face when it is added without an index (TL-064). */
	front?: boolean;
};

export type TitleLayerInit = Omit<TitleLayerType, 'finish'> & { finish?: boolean };

export type TitleFinish = {
	/** The `finish` param's option. Stored in documents: never rename. */
	id: string;
	label: string;
	description: string;
	/** Params of this finish, valid on any layer that takes finishes. Names start with the finish id. */
	params: readonly TitleParamSpec[];
	/** GLSL defining `vec4 tl_finish(vec4 paint, TlSurface s)`: premultiplied linear light in and out. */
	glsl: string;
	include?: readonly GlslChunk[];
	/** How far inside / outside the shape field must be right for this finish (percent of the unit). */
	fieldReach?: (p: LayerParams) => Partial<LayerFieldReach>;
	/** Extra passes before the layer's own (height fields, satin blurs). */
	prepass?: LayerPrepass;
	/** Uniforms beyond one per param: data textures, values derived from several params. */
	uniforms?: (p: LayerParams) => Readonly<Record<string, FxUniformValue>>;
	/** `#define` lines before `glsl` and in prepasses: one program per variant instead of every variant in one. */
	defines?: (p: LayerParams) => string;
	summary?: (p: LayerParams) => string;
};

/** One preset chip of a generator (TL-063): values over the defaults, usable in a recipe or in `clip.addGenerator`. */
export type GeneratorPreset = {
	id: string;
	label: string;
	params: Readonly<Record<string, LayerParamValue>>;
};

/** How a look recolours a generator (TL-051). Colours of a generator's own params stay its "own colours". */
export type GeneratorColor = {
	/** The role of the layer's default paint. */
	role: Role;
	/**
	 * `light`: brightness through the luma gradient map, hot cores white (premultiplied light, alpha = brightest channel).
	 * `luma`: the same on a picture with real transparency (smoke). `flat`: the paint, by the generator's alpha (ink).
	 */
	mode: 'light' | 'luma' | 'flat';
	/** A new layer keeps its own colours until it is told otherwise (fire, TL-051). */
	fixed?: boolean;
};

/** A virtual shape for a standalone instance, which has no title to read (TL-060). */
export type GeneratorStandIn = 'none' | 'ground' | 'disc';

/** What a generator's prepass gets, the same for a look layer and for its standalone effect (TL-060). */
export type GeneratorPassContext = {
	/** Canvas px per 1 % of the unit: exact for text and standalone, an upper bound otherwise. */
	pxPerPercent: number;
	/**
	 * A pass of this generator: the output name (`tlGenA`…`tlGenC`, scratch, shared by every generator of a look) as a
	 * ping-pong write, the unit and field chunks, the generator's `include`, its `defines` and its params as uniforms.
	 */
	pass(pass: ShaderPass): ShaderPass;
};

/** Spec 19 §7: a generator is one GLSL function, shared by its standalone effect and its look layer (TL-060). */
export type TitleGenerator = {
	id: string;
	label: string;
	/** Effects-panel name when `label` is taken by another effect of the panel. */
	effectLabel?: string;
	description: string;
	params: readonly TitleParamSpec[];
	/** GLSL defining `vec4 tl_generate(TlSurface s)`, closed-form in `u_tlTime` and `u_tlSeed` (TL-061). */
	glsl: string;
	include?: readonly GlslChunk[];
	/** `#define`s per hold-only param value, so a program holds only the branch it runs. */
	defines?: (p: LayerParams) => string;
	/** Whether a look layer sits in front of the title by default (TL-064). */
	front?: boolean;
	/** Reads the shape (`s.d`, `tl_surfaceAt`, `tlg_d`). Standalone instances see `standIn`. */
	shapeAware?: boolean;
	/** The shape a standalone instance reads (default `none`: `s.d` large, `s.opacity` 0). */
	standIn?: GeneratorStandIn;
	/** Reads `tl_bounds()`, or may at these params. */
	usesBounds?: (p: LayerParams) => boolean;
	/** Passes before `tl_generate`: draw passes, analysis. Build each with `ctx.pass`. */
	prepass?: (p: LayerParams, ctx: GeneratorPassContext) => readonly ShaderPass[];
	/** Soft pictures are drawn at 1 / `lowRes` of the canvas side and upsampled: it is the same in preview and export. */
	lowRes?: number;
	/** Palette role and recolour mode in a look; default the `glow` role, `light`. */
	color?: GeneratorColor;
	/** At least three (TL-063); the registry test checks them. */
	presets?: readonly GeneratorPreset[];
	reach?: (p: LayerParams) => LayerReach;
	/** What the shape field must reach. Default: `reach`'s largest side outside, nothing inside. */
	fieldReach?: (p: LayerParams) => Partial<LayerFieldReach>;
	timeDependent?: (p: LayerParams) => boolean;
	summary?: (p: LayerParams) => string;
	category?: EffectCategory;
	keywords?: readonly string[];
};

export const defineFinish = (init: TitleFinish): TitleFinish => init;
export const defineGenerator = (init: TitleGenerator): TitleGenerator => init;

/** Param builders of a look layer: the framework's `fxParam` plus distances and paints. */
export const lp = {
	...fxParam,
	/**
	 * A distance as a percentage of the look's unit (TL-012): `u_<name>` float; `tl_px(u_<name>)` = canvas px. `min`
	 * default 0, `softMax` = the slider's end, `max` the hard limit.
	 */
	distance(
		name: string,
		label: string,
		def: number,
		opts: { min?: number; softMin?: number; softMax?: number; max?: number; group?: string } = {},
	): TitleParamSpec {
		return {
			name,
			label,
			type: 'number',
			default: def,
			range: {
				min: opts.min ?? 0,
				max: opts.max ?? 1000,
				softMax: opts.softMax ?? 100,
				...(opts.softMin !== undefined ? { softMin: opts.softMin } : {}),
				step: 0.1,
			},
			unit: '%',
			animatable: true,
			distance: true,
			...(opts.group ? { group: opts.group } : {}),
		};
	},
	/**
	 * A paint and its animatable gradient rotation: `tlPaint_<name>(s)` in GLSL, and `<name>Angle` degrees added to the
	 * gradient's angle (TL-014: every number animates; a gradient itself is hold-only structure).
	 */
	paint(name: string, label: string, def: Paint, group?: string): readonly TitleParamSpec[] {
		return [
			{ name, label, type: 'paint', default: def, animatable: false, ...(group ? { group } : {}) },
			{
				...lp.angle(`${name}Angle`, `${label} Angle`, 0, group ? { group } : undefined),
			},
		];
	},
};

/** What a look's GLSL must not do (TL-034, TL-035); the registry test scans every layer, finish and generator. */
export const FORBIDDEN_TITLE_GLSL: readonly (readonly [RegExp, string])[] = [
	[/\bfract\s*\(\s*sin\b/, 'float hash: use the integer hashes of GLSL_HASH'],
	[/\bMath\.random\b/, 'not deterministic'],
	[/\bgl_FragCoord\b/, 'flipped on the last pass: use s.px'],
	[/\bu_seed\b/, 'id-based: looks use u_tlSeed from the appearance'],
	[/\bu_frame\b/, 'restarts at a razor cut: use u_tlTime'],
	[/\bu_pxScale\b/, 'distances are tl_px(percent), never canvas pixels'],
];

const percent = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
export const fmtNumber = (v: unknown, digits = 1): string => {
	const n = percent(v);
	const s = n.toFixed(digits);
	return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};
/** A distance for a summary line. */
export const fmtDistance = (v: unknown): string => `${fmtNumber(v)} %`;

/** A paint for a summary line. */
export function paintText(p: unknown): string {
	const x = p as Paint | undefined;
	switch (x?.kind) {
		case 'role':
			return x.role;
		case 'color':
			return 'colour';
		case 'gradient':
			return `${x.gradient.type} gradient`;
		case 'source':
			return 'clip picture';
		default:
			return '';
	}
}

/** The swatch of a summary line: the first paint param of a layer. */
export function layerSwatch(t: Pick<TitleLayerType, 'params'>, p: LayerParams): Paint | null {
	const spec = t.params.find(isPaintParam);
	return spec ? ((p[spec.name] as Paint | undefined) ?? spec.default) : null;
}
