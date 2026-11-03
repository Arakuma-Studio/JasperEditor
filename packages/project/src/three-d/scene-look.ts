// Spec 19 TL-076, TL-077: what a sequence's Advanced 3D does after shading: exposure, tone mapping and glints. Their
// numbers are animatable in sequence time, addressed `["scene3d", sequenceId, prop]` like the global light. Also the
// decision that a run needs the floating-point scene target, and what it costs: TL-078's `costClass`.
import { anim } from '../factories.ts';
import { evaluate } from '../keyframes.ts';
import type { ParamSpec } from '../registry/effects.ts';
import type { RenderScene3D } from '../render/snapshot.ts';
import type { Animatable, RGBA } from '../schema/common.ts';
import type { Glint3D, Layer3D, Sequence3D, ToneMapping } from '../schema/three-d.ts';
import { FLICKS_PER_SECOND, type Rational } from '../time.ts';
import { finiteOr } from './math.ts';
import { layerIsPhysical } from './surfaces.ts';

export const SCENE_3D_PATH = 'scene3d';

/** Refusal of a run that needs a floating-point scene target where the browser has none (TL-076). */
export const THREE_D_NEEDS_FLOAT = 'THREE_D_NEEDS_FLOAT';
/** Refusal of an export whose HDR environment or 3D model is gone: never a scene without it (TL-075). */
export const THREE_D_ASSET_MISSING = 'THREE_D_ASSET_MISSING';
export const THREE_D_FLOAT_MESSAGE =
	'Physical 3D materials, HDR environments, tone mapping and glints need float render targets (EXT_color_buffer_float), which this browser does not have';

type Num = { min?: number; max?: number; step: number };
const num = (name: string, label: string, def: number, range: Num, unit?: string): ParamSpec =>
	({
		name,
		label,
		type: 'number',
		default: def,
		range,
		animatable: true,
		...(unit ? { unit } : {}),
	}) as ParamSpec;

/** The sequence's animatable 3D values. */
export const SCENE_3D_SPECS: Record<string, ParamSpec> = {
	exposure: num('exposure', 'Exposure', 0, { min: -10, max: 10, step: 0.01 }, 'stops'),
	glintThreshold: num('glintThreshold', 'Glint Threshold', 1.5, { min: 0, max: 64, step: 0.01 }),
	glintIntensity: num('glintIntensity', 'Glint Intensity', 100, { min: 0, max: 800, step: 1 }, '%'),
	glintRadius: num('glintRadius', 'Glint Radius', 24, { min: 0, max: 400, step: 0.1 }, 'px'),
	glintLength: num('glintLength', 'Glint Length', 120, { min: 0, max: 2000, step: 0.1 }, 'px'),
	glintAngle: num('glintAngle', 'Glint Angle', 45, { step: 0.1 }, 'deg'),
	glintTint: {
		name: 'glintTint',
		label: 'Glint Tint',
		type: 'color',
		default: [1, 1, 1, 1],
		animatable: true,
	} as ParamSpec,
};

const GLINT_FIELDS = {
	glintThreshold: 'threshold',
	glintIntensity: 'intensity',
	glintRadius: 'radius',
	glintLength: 'length',
	glintAngle: 'angle',
	glintTint: 'tint',
} as const;

/** A glint at its defaults, off. */
export function newGlint(): Glint3D {
	return {
		enabled: false,
		threshold: anim(1.5),
		intensity: anim(100),
		radius: anim(24),
		rays: 4,
		length: anim(120),
		angle: anim(45),
		tint: anim<RGBA>([1, 1, 1, 1]),
	};
}

/** Where the sequence stores one of `SCENE_3D_SPECS`, or undefined while it has none. */
export function scene3dAnim(three: Sequence3D | undefined, prop: string): Animatable<unknown> | undefined {
	if (!three) return undefined;
	if (prop === 'exposure') return three.exposure as Animatable<unknown> | undefined;
	const k = GLINT_FIELDS[prop as keyof typeof GLINT_FIELDS];
	return k ? ((three.glint?.[k] as Animatable<unknown> | undefined) ?? undefined) : undefined;
}

/** Makes the storage of `prop` exist in a sequence's 3D settings (a draft), for a value written to it. */
export function ensureScene3dAnim(three: Sequence3D, prop: string): Animatable<unknown> | undefined {
	if (prop === 'exposure') three.exposure ??= anim(0);
	else if (prop in GLINT_FIELDS) three.glint ??= newGlint();
	return scene3dAnim(three, prop);
}

/** Every animatable value a sequence's 3D settings hold. */
export function scene3dAnims(
	three: Sequence3D | undefined,
): { prop: string; anim: Animatable<unknown>; at: string[] }[] {
	const out: { prop: string; anim: Animatable<unknown>; at: string[] }[] = [];
	if (!three) return out;
	if (three.exposure)
		out.push({ prop: 'exposure', anim: three.exposure as never, at: ['threeD', 'exposure'] });
	if (three.glint)
		for (const [prop, k] of Object.entries(GLINT_FIELDS)) {
			const a = three.glint[k] as Animatable<unknown> | undefined;
			if (a) out.push({ prop, anim: a, at: ['threeD', 'glint', k] });
		}
	return out;
}

export type GlintState = {
	threshold: number;
	intensity: number;
	radius: number;
	rays: number;
	length: number;
	/** Radians. */
	angle: number;
	/** Signal values. */
	tint: RGBA;
};

export type SceneLook = {
	toneMapping: ToneMapping;
	/** Linear multiplier, 2^stops. */
	exposure: number;
	glint: GlintState | null;
};

/** Exposure, tone mapping and glint of a sequence at a frame. */
export function sceneLookAt(scene3d: RenderScene3D | undefined, frame: number, fps: Rational): SceneLook {
	const t = (frame * FLICKS_PER_SECOND * fps.den) / fps.num;
	const num = (a: Animatable<number> | undefined, d: number) => (a ? finiteOr(evaluate(a, t), d) : d);
	const g = scene3d?.glint?.enabled ? scene3d.glint : null;
	const tint = g ? (evaluate(g.tint as Animatable<RGBA>, t) as RGBA) : null;
	return {
		toneMapping: scene3d?.toneMapping ?? 'none',
		exposure: 2 ** Math.max(-10, Math.min(10, num(scene3d?.exposure as Animatable<number> | undefined, 0))),
		glint: g
			? {
					threshold: Math.max(0, num(g.threshold as Animatable<number>, 1.5)),
					intensity: Math.max(0, num(g.intensity as Animatable<number>, 100)) / 100,
					radius: Math.max(0, num(g.radius as Animatable<number>, 24)),
					rays: Math.round(finiteOr(g.rays, 4)),
					length: Math.max(0, num(g.length as Animatable<number>, 120)),
					angle: (num(g.angle as Animatable<number>, 45) * Math.PI) / 180,
					tint: tint ?? [1, 1, 1, 1],
				}
			: null,
	};
}

/** The structural view of a render document the decisions below read: it may be untrusted JSON. */
type Doc3D = {
	scene3d?: Partial<RenderScene3D> | null;
	videoTracks?: readonly { clips?: readonly { kind?: unknown; threeD?: unknown }[] }[];
	media?: Record<string, { kind?: unknown } | null | undefined>;
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Environment lights drawn from a preset or an HDR; an 8-bit picture stays on the 8-bit path. */
function hasFloatEnvironment(doc: Doc3D): boolean {
	return (doc.scene3d?.lights ?? []).some((l) => {
		if (!isObj(l?.light) || l.light.type !== 'environment') return false;
		const id = l.light.environmentMediaId;
		return !id || doc.media?.[id]?.kind === 'hdri';
	});
}

/** Whether the scene's settings alone (no layer) ask for the float pipeline. */
function sceneSettingsHdr(scene: Partial<RenderScene3D>): boolean {
	if ((scene.toneMapping ?? 'none') !== 'none' || scene.glint?.enabled) return true;
	if ((scene.supersampling ?? 1) > 1) return true;
	const e = scene.exposure as Animatable<number> | undefined;
	return !!e && (e.keyframes?.length > 0 || !!e.expression || e.value !== 0);
}

/** Whether a 3D layer draws through the float pipeline: anything physically based, and models. */
function layerNeedsHdr(c: { kind?: unknown; threeD?: unknown }): boolean {
	if (!isObj(c.threeD)) return false;
	return c.kind === 'model' || layerIsPhysical(c.threeD as Layer3D);
}

/**
 * Whether a run of Advanced 3D needs the floating-point scene target. A sequence that uses none of §9 stays on the
 * 8-bit path, draws what it always drew, and needs no extension.
 */
export function advancedNeedsFloat(doc: Doc3D): boolean {
	const scene = doc.scene3d;
	if (scene?.renderer !== 'advanced') return false;
	if (sceneSettingsHdr(scene) || hasFloatEnvironment(doc)) return true;
	return (doc.videoTracks ?? []).some((t) => (t.clips ?? []).some(layerNeedsHdr));
}

/**
 * The 3D media a render document needs and does not have: environment lights' media and model layers' models, offline
 * or gone. Environment lights only light Advanced 3D, so a Classic 3D scene needs none of them.
 */
export function missing3dAssets(doc: Doc3D & { videoTracks?: unknown }): { clipId: string; label: string }[] {
	const out: { clipId: string; label: string }[] = [];
	const scene = doc.scene3d;
	if (scene?.renderer !== 'advanced') return out;
	for (const l of scene.lights ?? []) {
		if (!isObj(l?.light) || l.light.type !== 'environment') continue;
		const id = l.light.environmentMediaId;
		if (id && !doc.media?.[id]) out.push({ clipId: l.clipId, label: `Environment of "${l.name}"` });
	}
	for (const t of (doc.videoTracks ?? []) as readonly { clips?: readonly Record<string, unknown>[] }[])
		for (const c of t.clips ?? []) {
			if (c.kind !== 'model' || !isObj(c.source)) continue;
			const id = c.source.mediaId;
			if (typeof id === 'string' && !doc.media?.[id])
				out.push({ clipId: String(c.clipId), label: `3D model "${String(c.name)}"` });
		}
	return out;
}

/** What a title costs to export (TL-078): `fast` needs no 3D at all. */
export type CostClass = 'fast' | '3d' | '3d-heavy';

/** Relative frame cost of a look of one layer, measured against the 2D look: docs/wp-notes/three-d.md §9. */
export const COST_CLASSES: Record<CostClass, { label: string; detail: string }> = {
	fast: { label: 'Fast', detail: 'Native or baked export' },
	'3d': {
		label: '3D',
		detail: 'Exports on the Remotion path: every frame is drawn in a browser, not baked once',
	},
	'3d-heavy': {
		label: '3D, heavy',
		detail:
			'Exports on the Remotion path with transmission, glints or supersampling: expect several times the cost of a plain 3D title',
	},
};

/** The cost class of a 3D layer in a sequence (TL-078). */
export function costClassOf(
	threeD: Layer3D | undefined,
	scene: Pick<Sequence3D, 'glint' | 'supersampling'> | undefined,
): CostClass {
	if (!threeD?.enabled) return 'fast';
	const heavyScene = !!scene?.glint?.enabled || (scene?.supersampling ?? 1) > 1;
	const g = threeD.geometry;
	return heavyScene || hasTransmission(threeD) || g?.mode === 'inflate' ? '3d-heavy' : '3d';
}

function hasTransmission(td: Layer3D): boolean {
	const seen: unknown[] = [td.material.pbr, td.geometry?.surfaces];
	for (const b of (td.geometry?.bands ?? []) as { material?: unknown }[]) seen.push(b.material);
	for (const p of (td.geometry?.backplates ?? []) as { face?: unknown; side?: unknown }[])
		seen.push(p.face, p.side);
	const walk = (v: unknown): boolean => {
		if (!isObj(v)) return false;
		const t = v.transmission;
		if (isObj(t) && (Number(t.value) > 0 || (t.keyframes as unknown[] | undefined)?.length)) return true;
		return ['face', 'side', 'back'].some((k) => walk(v[k]));
	};
	return seen.some(walk);
}
