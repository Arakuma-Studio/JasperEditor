// Cut kits as data (spec 15 EA-020): a kit pack is a set of kit families (weights = their measured shares, lengths
// before and after the cut, variants = directions), each variant one or two adjustment-clip segments with effects and
// keys expressed relative to the cut frame. Keys are 2-key eased curves using the built-in ease presets (Penner
// families, per-side interpolation), never baked one key per frame. The built-in packs reproduce the parameters
// measured on the user's projects (private research `.prproj-analysis/research/auto`, FINDINGS §3; the curves and
// key spans were re-derived per family and documented in docs/wp-notes/edit-automation.md "Decorate Cuts"). Packs are
// plain JSON-able data so style recipes can carry custom ones. Pure.
import { z } from 'zod';
import { cubicToEases } from '../ease/curve.ts';
import { fitCubicEase } from '../ease/fit.ts';
import { builtinEaseSource } from '../ease/presets.ts';
import type { Ease } from '../schema/common.ts';

/** Limits of a kit pack (they bound the work of the planner and the size of a proposal item). */
export const KIT_LIMITS = {
	families: 16,
	variants: 16,
	segments: 2,
	effects: 32,
	keys: 64,
	/** Frames on one side of the cut. */
	side: 600,
} as const;

/** `linear`, `hold` or a built-in ease preset id (`penner.cubic-in`, `basic.easy-ease`, …). */
export const KitEaseSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^(linear|hold|[a-z]+\.[a-z0-9-]+)$/, 'linear, hold or an ease preset id like penner.cubic-in');
export type KitEase = z.infer<typeof KitEaseSchema>;

const IdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/, 'a lower-case id like "zoom-blur"');

/** One key: `at` frames from the cut (negative = before it); `ease` = the curve arriving here from the previous key. */
export const KitKeySchema = z.strictObject({
	at: z.number().int().min(-KIT_LIMITS.side).max(KIT_LIMITS.side),
	value: z.union([z.number(), z.tuple([z.number(), z.number()]), z.boolean()]),
	ease: KitEaseSchema.optional(),
});
export type KitKey = z.infer<typeof KitKeySchema>;

export const KitEffectSchema = z.strictObject({
	effectId: z.string().min(1).max(128),
	params: z.record(z.string(), z.unknown()).optional(),
	keyframes: z.record(z.string(), z.array(KitKeySchema).min(1).max(KIT_LIMITS.keys)).optional(),
	/** Params in pixels of a frame whose short side is 1080 px: scaled to the sequence's short side. */
	scaleWithFrame: z.array(z.string()).max(16).optional(),
});
export type KitEffect = z.infer<typeof KitEffectSchema>;

/** `whole` = one clip over the kit; `before` / `after` = the clip on that side of the cut (two clips per kit). */
export const KIT_SEGMENT_SPANS = ['whole', 'before', 'after'] as const;
export const KitSegmentSchema = z.strictObject({
	span: z.enum(KIT_SEGMENT_SPANS),
	effects: z.array(KitEffectSchema).min(1).max(KIT_LIMITS.effects),
});
export type KitSegment = z.infer<typeof KitSegmentSchema>;

export const KitVariantSchema = z.strictObject({
	id: IdSchema,
	label: z.string().min(1).max(80),
	weight: z.number().min(0).max(1e6),
	/** Frames before / after the cut when they differ from the family's. */
	before: z.number().int().min(1).max(KIT_LIMITS.side).optional(),
	after: z.number().int().min(1).max(KIT_LIMITS.side).optional(),
	segments: z.array(KitSegmentSchema).min(1).max(KIT_LIMITS.segments),
});
export type KitVariant = z.infer<typeof KitVariantSchema>;

export const KitFamilySchema = z.strictObject({
	id: IdSchema,
	label: z.string().min(1).max(80),
	/** Target share of the family among the kits of a pass (relative weights). */
	weight: z.number().min(0).max(1e6),
	before: z.number().int().min(1).max(KIT_LIMITS.side),
	after: z.number().int().min(1).max(KIT_LIMITS.side),
	variants: z.array(KitVariantSchema).min(1).max(KIT_LIMITS.variants),
});
export type KitFamily = z.infer<typeof KitFamilySchema>;

export const KitPackSchema = z.strictObject({
	id: IdSchema,
	label: z.string().min(1).max(80),
	description: z.string().max(400).optional(),
	families: z.array(KitFamilySchema).min(1).max(KIT_LIMITS.families),
	/**
	 * Weight factor of the previous kit's family for the next kit (1 = independent choices; smaller = fewer repeats).
	 * The family weights stay the long-run shares (the chain is fitted, see `chainWeights`).
	 */
	repeatPenalty: z.number().min(0).max(1),
});
export type KitPack = z.infer<typeof KitPackSchema>;

/** Frames before and after the cut of a variant. */
export function variantSpan(f: KitFamily, v: KitVariant): { before: number; after: number } {
	return { before: v.before ?? f.before, after: v.after ?? f.after };
}

/** Problems of a pack the schema cannot see (unknown eases, keys outside their segment, duplicate ids). Pure. */
export function kitPackIssues(pack: KitPack): string[] {
	const out: string[] = [];
	const fam = new Set<string>();
	for (const f of pack.families) {
		if (fam.has(f.id)) out.push(`families: duplicate id "${f.id}"`);
		fam.add(f.id);
		const vars = new Set<string>();
		for (const v of f.variants) {
			const where = `${f.id}/${v.id}`;
			if (vars.has(v.id)) out.push(`${f.id}: duplicate variant "${v.id}"`);
			vars.add(v.id);
			const { before, after } = variantSpan(f, v);
			const spans = v.segments.map((s) => s.span);
			if (spans.includes('whole') && spans.length > 1)
				out.push(`${where}: a "whole" segment cannot be combined with another segment`);
			if (new Set(spans).size !== spans.length) out.push(`${where}: two segments on the same side`);
			for (const s of v.segments) {
				const lo = s.span === 'after' ? 0 : -before;
				const hi = s.span === 'before' ? 0 : after;
				for (const e of s.effects)
					for (const [param, keys] of Object.entries(e.keyframes ?? {})) {
						let prev = Number.NEGATIVE_INFINITY;
						for (const k of keys) {
							if (k.at < lo || k.at > hi)
								out.push(
									`${where} ${e.effectId}.${param}: key at ${k.at} is outside its ${s.span} segment (${lo}…${hi})`,
								);
							if (k.at <= prev) out.push(`${where} ${e.effectId}.${param}: keys must be in time order`);
							prev = k.at;
							if (k.ease && resolveKitEase(k.ease) === null)
								out.push(`${where} ${e.effectId}.${param}: unknown ease "${k.ease}"`);
						}
					}
			}
		}
	}
	return out;
}

/** The two sides of an eased segment (`out` on the leaving key, `in` on the arriving key). */
export type KitEaseSides = { easeOut: Ease; easeIn: Ease };
const easeCache = new Map<string, KitEaseSides | 'linear' | 'hold' | null>();

/**
 * A kit ease as keyframe sides: `linear`, `hold`, or the best single cubic of an ease preset turned into the
 * leaving key's `easeOut` and the arriving key's `easeIn` (a 2-key curve; null for an unknown id).
 */
export function resolveKitEase(id: string): KitEaseSides | 'linear' | 'hold' | null {
	if (id === 'linear' || id === 'hold') return id;
	const hit = easeCache.get(id);
	if (hit !== undefined) return hit;
	const fn = builtinEaseSource(id);
	let out: KitEaseSides | null = null;
	if (fn) {
		try {
			out = cubicToEases(fitCubicEase(fn));
		} catch {
			out = null;
		}
	}
	easeCache.set(id, out);
	return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Built-in packs (measured; frames at 59.94 fps in the user's projects, used as frames at any rate)

const SHUTTER = { useCompShutterAngle: false, shutterAngle: 360 } as const;

/** Mirrors that turn the copies around a centred picture of `size` (0…1 of the frame) into seamless reflections. */
function edgeMirrors(lo: number, hi: number): KitEffect[] {
	return [
		{ effectId: 'jasper.mirror', params: { reflectionCenter: [0.5, lo], reflectionAngle: -90 } },
		{ effectId: 'jasper.mirror', params: { reflectionCenter: [lo, 0.5], reflectionAngle: 180 } },
		{ effectId: 'jasper.mirror', params: { reflectionCenter: [0.5, hi], reflectionAngle: 90 } },
		{ effectId: 'jasper.mirror', params: { reflectionCenter: [hi, 0.5], reflectionAngle: 0 } },
	];
}

const SHAKE: KitFamily = {
	id: 'shake',
	label: 'Shake',
	weight: 1,
	before: 10,
	after: 10,
	variants: [
		{
			id: 'default',
			label: 'Shake',
			weight: 1,
			segments: [
				{
					span: 'whole',
					effects: [
						{
							effectId: 'jasper.s.shake',
							params: { amplitude: 0.5, frequency: 6, motionBlur: true, seed: 0 },
						},
					],
				},
			],
		},
	],
};

const JOLT: KitFamily = {
	id: 'jolt',
	label: 'Jolt',
	weight: 699,
	before: 10,
	after: 10,
	variants: [
		{
			id: 'default',
			label: 'Jolt',
			weight: 1,
			segments: [
				{
					span: 'whole',
					// 3 × 3 copies with mirrored neighbours, then the centre copy back to full frame at 300 %: the jiggle
					// shows reflections instead of empty edges (the user's 4 × Mirror + Replicate 3 layer under Transform).
					effects: [
						{ effectId: 'jasper.replicate', params: { count: 3 } },
						...edgeMirrors(1 / 3, 2 / 3),
						{
							effectId: 'jasper.transform',
							params: { scaleHeight: 300, uniformScale: true, ...SHUTTER },
							keyframes: {
								position: [
									{ at: -10, value: [0.5, 0.5] },
									{ at: -5, value: [0.4885, 0.5167], ease: 'linear' },
									{ at: 0, value: [0.52, 0.481], ease: 'linear' },
									{ at: 5, value: [0.4833, 0.5222], ease: 'linear' },
									{ at: 10, value: [0.5, 0.5], ease: 'linear' },
								],
							},
						},
					],
				},
			],
		},
	],
};

const WHIP_DIRS: {
	id: string;
	label: string;
	weight: number;
	dir: number;
	a: [number, number];
	m: [number, number];
	b: [number, number];
}[] = [
	{ id: 'left', label: 'Whip left', weight: 65, dir: 90, a: [0.5, 0.5], m: [0, 0.5], b: [-0.5, 0.5] },
	{ id: 'right', label: 'Whip right', weight: 61, dir: 90, a: [-0.5, 0.5], m: [0, 0.5], b: [0.5, 0.5] },
	{ id: 'up', label: 'Whip up', weight: 62, dir: 0, a: [0.5, 0.5], m: [0.5, 0], b: [0.5, -0.5] },
	{ id: 'down', label: 'Whip down', weight: 57, dir: 0, a: [0.5, -0.5], m: [0.5, 0], b: [0.5, 0.5] },
];

const WHIP: KitFamily = {
	id: 'whip',
	label: 'Whip',
	weight: 249,
	before: 20,
	after: 20,
	variants: WHIP_DIRS.map(
		(d): KitVariant => ({
			id: d.id,
			label: d.label,
			weight: d.weight,
			segments: [
				{
					span: 'whole',
					effects: [
						{
							effectId: 'jasper.offset',
							params: { blendWithOriginal: 0 },
							keyframes: {
								shiftCenterTo: [
									{ at: -12, value: d.a },
									{ at: 0, value: d.m, ease: 'penner.quart-in' },
									{ at: 13, value: d.b, ease: 'penner.quart-out' },
								],
							},
						},
						{
							effectId: 'jasper.directional-blur',
							params: { direction: d.dir },
							scaleWithFrame: ['blurLength'],
							keyframes: {
								blurLength: [
									{ at: -12, value: 0 },
									{ at: -3, value: 270, ease: 'penner.quart-in' },
									{ at: 3, value: 270, ease: 'linear' },
									{ at: 13, value: 0, ease: 'penner.quart-out' },
								],
							},
						},
					],
				},
			],
		}),
	),
};

type ZoomBlurDir = {
	id: string;
	label: string;
	weight: number;
	axis: 'v' | 'h';
	a: [number, number];
	m: [number, number];
	b: [number, number];
};
const ZOOM_BLUR_DIRS: ZoomBlurDir[] = [
	{ id: 'down', label: 'Zoom blur down', weight: 64, axis: 'v', a: [0.5, 0], m: [0.5, 0.6], b: [0.5, 1] },
	{ id: 'up', label: 'Zoom blur up', weight: 55, axis: 'v', a: [0.5, 1], m: [0.5, 0.504], b: [0.5, 0] },
	{ id: 'right', label: 'Zoom blur right', weight: 63, axis: 'h', a: [0, 0.5], m: [0.25, 0.5], b: [1, 0.5] },
	{ id: 'left', label: 'Zoom blur left', weight: 60, axis: 'h', a: [1, 0.5], m: [0.75, 0.5], b: [0, 0.5] },
];

function zoomBlurVariant(d: ZoomBlurDir): KitVariant {
	// Vertical: Scale Height 100 → 190 about the leading edge (18 + 22 frames); horizontal: Scale Width 100 → 160
	// (19 + 21). The anchor (= position) jumps to the opposite edge at the cut; Directional Blur 0 → 40 → 0 linear.
	const v = d.axis === 'v';
	const before = v ? 18 : 19;
	const after = v ? 22 : 21;
	const scale = v ? 'scaleHeight' : 'scaleWidth';
	const peak = v ? 190 : 160;
	const fixed = v ? { scaleWidth: 100 } : { scaleHeight: 100 };
	const blur = (keys: KitKey[]): KitEffect => ({
		effectId: 'jasper.directional-blur',
		params: { direction: v ? 0 : -90 },
		scaleWithFrame: ['blurLength'],
		keyframes: { blurLength: keys },
	});
	return {
		id: d.id,
		label: d.label,
		weight: d.weight,
		before,
		after,
		segments: [
			{
				span: 'before',
				effects: [
					{
						effectId: 'jasper.transform',
						params: { uniformScale: false, ...fixed, ...SHUTTER },
						keyframes: {
							[scale]: [
								{ at: v ? -17 : -19, value: 100 },
								{ at: 0, value: peak, ease: 'penner.cubic-in' },
							],
							anchorPoint: [
								{ at: -1, value: d.a },
								{ at: 0, value: d.m, ease: 'linear' },
							],
							position: [
								{ at: -1, value: d.a },
								{ at: 0, value: d.m, ease: 'linear' },
							],
						},
					},
					blur([
						{ at: -before, value: 0 },
						{ at: 0, value: 40, ease: 'linear' },
					]),
				],
			},
			{
				span: 'after',
				effects: [
					{
						effectId: 'jasper.transform',
						params: { uniformScale: false, ...fixed, ...SHUTTER },
						keyframes: {
							[scale]: v
								? [
										{ at: 0, value: peak },
										{ at: 17, value: 100, ease: 'penner.cubic-out' },
									]
								: [
										{ at: 0, value: peak },
										{ at: 1, value: peak, ease: 'linear' },
										{ at: 21, value: 100, ease: 'penner.quart-out' },
									],
							anchorPoint: [
								{ at: 0, value: d.m },
								{ at: 1, value: d.b, ease: 'linear' },
							],
							position: [
								{ at: 0, value: d.m },
								{ at: 1, value: d.b, ease: 'linear' },
							],
						},
					},
					blur([
						{ at: 0, value: 40 },
						{ at: v ? 20 : 21, value: 0, ease: 'linear' },
					]),
				],
			},
		],
	};
}

const ZOOM_BLUR: KitFamily = {
	id: 'zoom-blur',
	label: 'Zoom blur',
	weight: 242,
	before: 18,
	after: 22,
	variants: ZOOM_BLUR_DIRS.map(zoomBlurVariant),
};

/** Half size picture with mirrored surroundings, then the keyed Transform: the incoming picture comes from 50 %. */
const shrunk = (keys: KitKey[]): KitEffect[] => [
	{ effectId: 'jasper.transform', params: { scaleHeight: 50, uniformScale: true } },
	...edgeMirrors(0.25, 0.75),
	{
		effectId: 'jasper.transform',
		params: { uniformScale: true, ...SHUTTER },
		keyframes: { scaleHeight: keys },
	},
];
const plainZoom = (keys: KitKey[]): KitEffect[] => [
	{
		effectId: 'jasper.transform',
		params: { uniformScale: true, ...SHUTTER },
		keyframes: { scaleHeight: keys },
	},
];

const ZOOM_THROUGH: KitFamily = {
	id: 'zoom-through',
	label: 'Zoom through',
	weight: 123,
	before: 20,
	after: 20,
	variants: [
		{
			id: 'in',
			label: 'Zoom through in',
			weight: 62,
			segments: [
				{
					span: 'before',
					effects: plainZoom([
						{ at: -19, value: 100 },
						{ at: 0, value: 200, ease: 'penner.circ-in' },
					]),
				},
				{
					span: 'after',
					effects: shrunk([
						{ at: 0, value: 100 },
						{ at: 19, value: 200, ease: 'penner.circ-out' },
					]),
				},
			],
		},
		{
			id: 'out',
			label: 'Zoom through out',
			weight: 60,
			segments: [
				{
					span: 'before',
					effects: shrunk([
						{ at: -20, value: 200 },
						{ at: 0, value: 100, ease: 'penner.circ-in' },
					]),
				},
				{
					span: 'after',
					effects: plainZoom([
						{ at: 0, value: 200 },
						{ at: 20, value: 100, ease: 'penner.circ-out' },
					]),
				},
			],
		},
	],
};

const spinVariant = (id: string, label: string, weight: number, sign: 1 | -1): KitVariant => ({
	id,
	label,
	weight,
	segments: [
		{
			span: 'before',
			effects: [
				{
					effectId: 'jasper.transform',
					params: { uniformScale: true, ...SHUTTER },
					keyframes: {
						scaleHeight: [
							{ at: -20, value: 100 },
							{ at: 0, value: 300, ease: 'penner.cubic-in' },
						],
						rotation: [
							{ at: -15, value: 0 },
							{ at: 0, value: -90 * sign, ease: 'penner.cubic-in' },
						],
					},
				},
			],
		},
		{
			span: 'after',
			effects: [
				{
					effectId: 'jasper.transform',
					params: { uniformScale: true, ...SHUTTER },
					keyframes: {
						scaleHeight: [
							{ at: 0, value: 300 },
							{ at: 20, value: 100, ease: 'penner.cubic-out' },
						],
						rotation: [
							{ at: 0, value: 90 * sign },
							{ at: 19, value: 0, ease: 'penner.cubic-out' },
						],
					},
				},
			],
		},
	],
});

const SPIN: KitFamily = {
	id: 'spin',
	label: 'Spin',
	weight: 116,
	before: 20,
	after: 20,
	variants: [
		spinVariant('ccw', 'Spin counter-clockwise', 60, 1),
		spinVariant('cw', 'Spin clockwise', 56, -1),
	],
};

/** Shorts: S_Shake on 10 + 10 frames at every cut (Amplitude 0.5, Frequency 6, Motion Blur on, Seed 0). */
export const SHORTS_SHAKE_PACK: KitPack = {
	id: 'shorts-shake',
	label: 'Shorts shake',
	description:
		'S_Shake on an adjustment clip 10 frames before and after every cut (the vertical shorts recipe).',
	families: [SHAKE],
	repeatPenalty: 1,
};

/**
 * Long form: five families with their measured shares (Jolt 49 %, Whip 17 %, Zoom blur 17 %, Zoom through 9 %,
 * Spin 8 %). Repeat penalty 0.54 makes P(same family as the previous kit) = 0.23, as measured, with these shares.
 */
export const LONG_PACK: KitPack = {
	id: 'long-pack',
	label: 'Long-form transition pack',
	description:
		'Five cut kits chosen at random with the measured shares and few repeats: Jolt, Whip, Zoom blur, Zoom through and Spin.',
	families: [JOLT, WHIP, ZOOM_BLUR, ZOOM_THROUGH, SPIN],
	repeatPenalty: 0.54,
};

export const BUILTIN_KIT_PACKS: readonly KitPack[] = [SHORTS_SHAKE_PACK, LONG_PACK];
export const BUILTIN_KIT_PACK_IDS = ['shorts-shake', 'long-pack'] as const;
export type BuiltinKitPackId = (typeof BUILTIN_KIT_PACK_IDS)[number];

export function builtinKitPack(id: string): KitPack | undefined {
	return BUILTIN_KIT_PACKS.find((p) => p.id === id);
}

/** A kit of a pack: its family id, or `family/variant` for one variant (direction) of it. */
export const KitRefSchema = z
	.string()
	.regex(/^[a-z][a-z0-9-]{0,47}(?:\/[a-z][a-z0-9-]{0,47})?$/, 'a kit id like "whip" or "whip/left"');

/** Every kit ref of a pack (families, then `family/variant`), for refusals that list them. */
export function kitRefsOf(pack: KitPack): string[] {
	return pack.families.flatMap((f) => [f.id, ...f.variants.map((v) => `${f.id}/${v.id}`)]);
}

/**
 * The part of `pack` that `refs` select (same id, weights and repeat penalty): a family ref keeps the family with all its
 * variants, `family/variant` refs keep only those variants of it. `{unknown}` lists refs the pack does not have. Pure.
 */
export function selectKits(
	pack: KitPack,
	refs: readonly string[],
): { ok: true; pack: KitPack } | { ok: false; unknown: string[] } {
	const whole = new Set<string>();
	const parts = new Map<string, Set<string>>();
	const unknown: string[] = [];
	for (const ref of refs) {
		const [fid, vid] = ref.split('/') as [string, string | undefined];
		const f = pack.families.find((x) => x.id === fid);
		if (!f || (vid !== undefined && !f.variants.some((v) => v.id === vid))) {
			unknown.push(ref);
			continue;
		}
		if (vid === undefined) whole.add(fid);
		else parts.set(fid, (parts.get(fid) ?? new Set()).add(vid));
	}
	if (unknown.length) return { ok: false, unknown };
	const families: KitFamily[] = [];
	for (const f of pack.families) {
		if (whole.has(f.id)) families.push(f);
		else if (parts.has(f.id)) {
			const keep = parts.get(f.id)!;
			families.push({ ...f, variants: f.variants.filter((v) => keep.has(v.id)) });
		}
	}
	return { ok: true, pack: { ...pack, families } };
}

/** Labels the editor translates (pack, family and variant names). */
export const KIT_MODEL_STRINGS: readonly string[] = BUILTIN_KIT_PACKS.flatMap((p) => [
	p.label,
	...(p.description ? [p.description] : []),
	...p.families.flatMap((f) => [f.label, ...f.variants.map((v) => v.label)]),
]);

// ---------------------------------------------------------------------------------------------------------------
// Family choice with a repeat penalty

const MAX_CHAIN_ITERATIONS = 200;

/**
 * Per-family weights of the choice after each previous family so that, with `penalty` applied to the previous
 * family, the long-run shares equal `shares` (fixed-point iteration on the stationary distribution of the chain;
 * bounded, deterministic). `penalty` 1 returns the shares. Families with share 0 keep weight 0.
 */
export function chainWeights(shares: readonly number[], penalty: number): number[] {
	const n = shares.length;
	const s = shares.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
	const total = s.reduce((a, b) => a + b, 0);
	if (!(total > 0)) return s;
	const t = s.map((x) => x / total);
	const k = Number.isFinite(penalty) ? Math.min(1, Math.max(0, penalty)) : 1;
	if (k === 1 || n < 2) return t;
	let w = [...t];
	for (let it = 0; it < MAX_CHAIN_ITERATIONS; it++) {
		const p = stationary(w, k);
		if (!p) break;
		let diff = 0;
		const next = w.map((x, i) => {
			const v = p[i]! > 0 ? (x * t[i]!) / p[i]! : 0;
			return v;
		});
		const sum = next.reduce((a, b) => a + b, 0);
		if (!(sum > 0)) break;
		for (let i = 0; i < n; i++) {
			next[i] = next[i]! / sum;
			diff = Math.max(diff, Math.abs(next[i]! - w[i]!));
		}
		w = next;
		if (diff < 1e-10) break;
	}
	return w;
}

/** Row `prev` of the transition matrix (weights with the penalty on `prev`), normalised; null when all zero. */
export function transitionRow(weights: readonly number[], penalty: number, prev: number): number[] | null {
	const row = weights.map((w, i) => (i === prev ? w * penalty : w));
	const sum = row.reduce((a, b) => a + b, 0);
	return sum > 0 ? row.map((x) => x / sum) : null;
}

/** Stationary distribution of the chain (power iteration). */
function stationary(w: readonly number[], k: number): number[] | null {
	const n = w.length;
	const rows: number[][] = [];
	for (let i = 0; i < n; i++) {
		const r = transitionRow(w, k, i);
		// a family nothing can follow keeps the next choice independent
		rows.push(r ?? w.map((x) => x));
	}
	let p = w.map(() => 1 / n);
	for (let it = 0; it < 500; it++) {
		const q = new Array<number>(n).fill(0);
		for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) q[j]! += p[i]! * rows[i]![j]!;
		const sum = q.reduce((a, b) => a + b, 0);
		if (!(sum > 0)) return null;
		let diff = 0;
		for (let j = 0; j < n; j++) {
			q[j] = q[j]! / sum;
			diff = Math.max(diff, Math.abs(q[j]! - p[j]!));
		}
		p = q;
		if (diff < 1e-13) break;
	}
	return p;
}

/** P(same family as the previous kit) of the chain (for reports and tests). */
export function repeatProbability(shares: readonly number[], penalty: number): number {
	const w = chainWeights(shares, penalty);
	const p = stationary(w, Math.min(1, Math.max(0, penalty)));
	if (!p) return 0;
	let same = 0;
	for (let i = 0; i < w.length; i++) {
		const r = transitionRow(w, penalty, i);
		if (r) same += p[i]! * r[i]!;
	}
	return same;
}
