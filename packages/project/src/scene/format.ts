// Declarative scene files (docs/wp-notes/scene-file.md): the zod schema of the file a user writes (YAML or JSON, parsed
// by the caller) describing one sequence — its settings and its layers (text, image, SVG, shape, composition) with
// position, size, style, keyframes with eases, text animation presets, effects and masks. Validation errors carry the
// path in the file (`layers[2].keyframes.position[0].ease`). Pure: no I/O.
import { z } from 'zod';
import { MASK_FEATHER_FALLOFFS, MASK_MODES } from '../schema/mask.ts';
import { BLEND_MODES, SHAPE_STROKE_POSITIONS } from '../schema/sequence.ts';

/** The `scene:` version this build reads and writes. */
export const SCENE_FORMAT_VERSION = 1;
/** Most layers one scene may describe (each becomes a clip and a handful of commands). */
export const MAX_SCENE_LAYERS = 1000;
/** Most keys one property may carry. */
export const MAX_SCENE_KEYS = 2000;
/** Most effects / masks on one layer. */
export const MAX_SCENE_EFFECTS = 64;
export const MAX_SCENE_MASKS = 64;
/** Longest scene time (24 h, the timeline's design limit). */
export const MAX_SCENE_SECONDS = 86_400;

/** A path in the file, e.g. `["layers", 2, "keyframes", "position", 0, "ease"]`. */
export type ScenePath = readonly (string | number)[];
/** One problem of a scene file, at a path in it. */
export type SceneIssue = { path: ScenePath; message: string };

/** `layers[2].keyframes.position[0].ease` (identifier keys dotted, others quoted, indices bracketed). */
export function formatScenePath(path: ScenePath): string {
	let out = '';
	for (const p of path) {
		if (typeof p === 'number') out += `[${p}]`;
		else if (/^[A-Za-z_][\w-]*$/.test(p)) out += out ? `.${p}` : p;
		else out += `[${JSON.stringify(p)}]`;
	}
	return out || '(file)';
}

/** `path: message` per issue, one per line. */
export function formatSceneIssues(issues: readonly SceneIssue[]): string {
	return issues.map((i) => `${formatScenePath(i.path)}: ${i.message}`).join('\n');
}

/**
 * A time: seconds (`2.5`), or a string with a unit — `"2.5s"`, `"250ms"`, `"45f"` (frames at the sequence rate).
 * Layer starts and durations are sequence times; keyframe times count from the layer's start.
 */
export const SceneTimeSchema = z.union([
	z.number().min(0).max(MAX_SCENE_SECONDS),
	z.string().regex(/^\s*\d+(?:\.\d+)?\s*(?:s|ms|f)\s*$/, 'a time is seconds (2.5) or "2.5s", "250ms", "45f"'),
]);
export type SceneTime = z.infer<typeof SceneTimeSchema>;

const unit = z.number().min(0).max(1);
/** `"#RRGGBB"`, `"#RRGGBBAA"`, `"#RGB"`, or `[r, g, b]` / `[r, g, b, a]` in 0…1. */
export const SceneColorSchema = z.union([
	z
		.string()
		.regex(
			/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/,
			'a colour is "#RRGGBB", "#RRGGBBAA" or "#RGB"',
		),
	z.tuple([unit, unit, unit]),
	z.tuple([unit, unit, unit, unit]),
]);
export type SceneColor = z.infer<typeof SceneColorSchema>;

const finite = z.number().finite();
const Vec2 = z.tuple([finite, finite]);
const Size = z.tuple([z.number().min(0).max(32768), z.number().min(0).max(32768)]);

/**
 * One key: `t` (from the layer's start), `value`, the `ease` of the segment leaving it (a built-in preset id or name,
 * `linear`, `ease-out`… or `"cubic-bezier(x1, y1, x2, y2)"`; `hold` steps; default linear) and, for points
 * (position, anchor), the motion `path` to the next key: `linear` (default) or `auto` (Auto Bezier curves).
 */
export const SceneKeySchema = z.strictObject({
	t: SceneTimeSchema,
	value: z.unknown(),
	ease: z.string().min(1).max(200).optional(),
	path: z.enum(['linear', 'auto']).optional(),
});
export type SceneKey = z.infer<typeof SceneKeySchema>;
const Keys = z.array(SceneKeySchema).min(1).max(MAX_SCENE_KEYS);

/** Animatable properties a scene can key: their names in `keyframes` and in the layer. */
export const SCENE_COMMON_PROPS = ['position', 'anchor', 'scale', 'rotation', 'opacity'] as const;
export const SCENE_SHAPE_PROPS = ['size', 'radius', 'fill'] as const;
export type SceneProp = (typeof SCENE_COMMON_PROPS)[number] | (typeof SCENE_SHAPE_PROPS)[number];

const StrokeSchema = z.strictObject({
	color: SceneColorSchema,
	width: z.number().min(0).max(4096),
	position: z.enum(SHAPE_STROKE_POSITIONS).optional(),
});

const EffectSchema = z.strictObject({
	/** Effect id (`list_effects`), e.g. `jasper.gaussian-blur`. */
	effect: z.string().min(1).max(200),
	enabled: z.boolean().optional(),
	/** Static values over the effect's defaults. */
	params: z.record(z.string(), z.unknown()).optional(),
	/** Keys of params. */
	keyframes: z.record(z.string(), Keys).optional(),
});
export type SceneEffect = z.infer<typeof EffectSchema>;

const Rect = z.tuple([finite, finite, z.number().positive(), z.number().positive()]);
const VertexSchema = z.union([Vec2, z.strictObject({ p: Vec2, in: Vec2.optional(), out: Vec2.optional() })]);
/**
 * An Opacity mask, in layer-box-normalised coordinates (0…1 over the layer): exactly one of `ellipse` / `rect`
 * (`[x, y, width, height]`) or `path` (`points`: `[x, y]` corners or `{p, in?, out?}` with handles relative to `p`).
 */
const MaskSchema = z.strictObject({
	ellipse: Rect.optional(),
	rect: Rect.optional(),
	path: z
		.strictObject({
			closed: z.boolean().optional(),
			points: z.array(VertexSchema).min(2).max(4096),
		})
		.optional(),
	mode: z.enum(MASK_MODES).optional(),
	inverted: z.boolean().optional(),
	/** Layer px (default 10). */
	feather: z.number().min(0).max(10_000).optional(),
	/** 0…100 (default 100). */
	opacity: z.number().min(0).max(100).optional(),
	/** Layer px (default 0). */
	expansion: z.number().min(-10_000).max(10_000).optional(),
	falloff: z.enum(MASK_FEATHER_FALLOFFS).optional(),
});
export type SceneMask = z.infer<typeof MaskSchema>;

const common = {
	/** Stable identity of the layer in this file (the clip's name unless `name` is given). */
	id: z.string().min(1).max(200),
	/** Clip name shown in the timeline (default: the id). */
	name: z.string().min(1).max(200).optional(),
	/** Pins the layer to this clip id (export-scene writes it when clip names collide). */
	clip: z
		.string()
		.regex(/^clp_[0-9A-HJKMNP-TV-Z]{16}$/, 'a clip id ("clp_…")')
		.optional(),
	/** Sequence time (default 0). */
	start: SceneTimeSchema.optional(),
	/** Default: `sequence.duration` minus `start`. */
	duration: SceneTimeSchema.optional(),
	/** Video track: 1 or "V1" (default: the layer's position in the list, first = V1 = bottom). */
	track: z
		.union([z.number().int().min(1).max(99), z.string().regex(/^V\d{1,2}$/, 'a video track, "V1"…"V99"')])
		.optional(),
	position: Vec2.optional(),
	anchor: Vec2.optional(),
	/** Percent (100 = 1:1). */
	scale: finite.optional(),
	/** Degrees, clockwise. */
	rotation: finite.optional(),
	/** 0…100. */
	opacity: finite.optional(),
	blend: z.enum(BLEND_MODES).optional(),
	/** Keys per property (a property given here is animated; give it static at the layer level otherwise). */
	keyframes: z.record(z.string(), Keys).optional(),
	/** The layer's effects, in order (`[]` removes them). */
	effects: z.array(EffectSchema).max(MAX_SCENE_EFFECTS).optional(),
	/** The layer's Opacity masks, in order (`[]` removes them). */
	masks: z.array(MaskSchema).max(MAX_SCENE_MASKS).optional(),
};

/** A text animation side: a preset id (`list_text_animations`) or `{preset, duration?, params?}`. */
const AnimatorSchema = z.union([
	z.string().min(1).max(100),
	z.strictObject({
		preset: z.string().min(1).max(100),
		duration: SceneTimeSchema.optional(),
		params: z.record(z.string(), z.unknown()).optional(),
	}),
]);
export type SceneAnimator = z.infer<typeof AnimatorSchema>;

const TextLayerSchema = z.strictObject({
	...common,
	type: z.literal('text'),
	text: z.string().max(100_000),
	/** Font family (registered in the project when missing). */
	font: z.string().min(1).max(200).optional(),
	/** Pixels. */
	size: z.number().positive().max(10_000).optional(),
	weight: z.number().int().min(1).max(1000).optional(),
	italic: z.boolean().optional(),
	color: SceneColorSchema.optional(),
	align: z.enum(['left', 'center', 'right', 'justify']).optional(),
	lineHeight: z.number().positive().max(100).optional(),
	/** Letter spacing in em. */
	tracking: z.number().min(-10).max(10).optional(),
	allCaps: z.boolean().optional(),
	stroke: StrokeSchema.nullable().optional(),
	shadow: z
		.strictObject({
			color: SceneColorSchema,
			angle: finite.optional(),
			distance: finite.optional(),
			blur: z.number().min(0).max(10_000).optional(),
			spread: z.number().min(0).max(10_000).optional(),
		})
		.nullable()
		.optional(),
	background: z
		.strictObject({
			color: SceneColorSchema,
			padding: z.number().min(0).max(10_000).optional(),
			radius: z.number().min(0).max(10_000).optional(),
		})
		.nullable()
		.optional(),
	/** A fixed text box `[width, height]`; `width` alone wraps paragraph text; neither = point text. */
	box: Size.optional(),
	width: z.number().min(1).max(32768).optional(),
	/** In and Out animators; `null` removes them. */
	animation: z
		.strictObject({ in: AnimatorSchema.nullable().optional(), out: AnimatorSchema.nullable().optional() })
		.nullable()
		.optional(),
});

const ImageLayerSchema = z.strictObject({
	...common,
	type: z.enum(['image', 'svg']),
	/** File path (relative to the scene file) or a media id ("med_…") already in the project. */
	src: z.string().min(1).max(4096),
});

const ShapeLayerSchema = z.strictObject({
	...common,
	type: z.literal('shape'),
	shape: z.enum(['rect', 'ellipse']),
	/** Layer pixels. */
	size: Size.optional(),
	/** `null` = no fill. */
	fill: SceneColorSchema.nullable().optional(),
	stroke: StrokeSchema.nullable().optional(),
	/** Rectangle corner radius in layer pixels. */
	radius: z.number().min(0).max(16384).optional(),
});

const CompositionLayerSchema = z.strictObject({
	...common,
	type: z.literal('composition'),
	/** The Remotion bundle: its folder (relative to the scene file), its media id or its name in the project. */
	bundle: z.string().min(1).max(4096),
	/** Composition id inside the bundle (`list_compositions`). */
	composition: z.string().min(1).max(200),
	/** Props over the composition's defaults (the whole override object). */
	props: z.record(z.string(), z.unknown()).optional(),
});

export const SceneLayerSchema = z.discriminatedUnion('type', [
	TextLayerSchema,
	ImageLayerSchema,
	ShapeLayerSchema,
	CompositionLayerSchema,
]);
export type SceneLayer = z.infer<typeof SceneLayerSchema>;
export type SceneTextLayer = z.infer<typeof TextLayerSchema>;
export type SceneImageLayer = z.infer<typeof ImageLayerSchema>;
export type SceneShapeLayer = z.infer<typeof ShapeLayerSchema>;
export type SceneCompositionLayer = z.infer<typeof CompositionLayerSchema>;

export const SceneSequenceSchema = z.strictObject({
	/** The sequence this scene is (found by name; created when missing). */
	name: z.string().min(1).max(200),
	/** Frame size `[width, height]`. */
	size: z.tuple([z.number().int().min(16).max(8192), z.number().int().min(16).max(8192)]).optional(),
	/** Frames per second: 30, 29.97, 23.976, 59.94 or "30000/1001". */
	fps: z
		.union([
			z.number().positive().max(1000),
			z.string().regex(/^\d{1,6}\/\d{1,6}$/, 'a rate is a number or "num/den"'),
		])
		.optional(),
	/** Default length of the layers. */
	duration: SceneTimeSchema.optional(),
	background: SceneColorSchema.optional(),
});
export type SceneSequence = z.infer<typeof SceneSequenceSchema>;

export const SceneFileSchema = z.strictObject({
	scene: z.literal(SCENE_FORMAT_VERSION),
	sequence: SceneSequenceSchema,
	/** Bottom to top: a later layer draws over an earlier one. */
	layers: z.array(SceneLayerSchema).max(MAX_SCENE_LAYERS),
});
export type SceneFile = z.infer<typeof SceneFileSchema>;

/** Zod issues → scene issues (an unknown key names the key; a wrong `type` lists the layer types). */
function zodIssues(e: z.ZodError): SceneIssue[] {
	return e.issues.map((i) => {
		const path = i.path.map((p) => (typeof p === 'symbol' ? String(p) : p));
		if (i.code === 'unrecognized_keys')
			return {
				path,
				message: `unknown key${i.keys.length > 1 ? 's' : ''} ${i.keys.map((k) => `"${k}"`).join(', ')}`,
			};
		if (i.code === 'invalid_union' && path.at(-1) === 'type')
			return { path, message: 'type is text, image, svg, shape or composition' };
		return { path, message: i.message };
	});
}

/** Validates a parsed scene file. Never throws. */
export function validateSceneFile(
	raw: unknown,
): { ok: true; scene: SceneFile } | { ok: false; issues: SceneIssue[] } {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw))
		return {
			ok: false,
			issues: [{ path: [], message: 'a scene file is an object with scene, sequence and layers' }],
		};
	const r = SceneFileSchema.safeParse(raw);
	if (!r.success) return { ok: false, issues: zodIssues(r.error) };
	return { ok: true, scene: r.data };
}
