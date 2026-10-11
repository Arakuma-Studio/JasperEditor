// Colour-grading UI model (S06 §6, wp-m2-color). Pure helpers shared by the Lumetri panel, the Effect Controls
// editor, the curves editor, the colour wheels, the LUT pickers and the grade clipboard: which clip is graded,
// the rows of the first `jasper.lumetri` instance (created on first edit, like the pinned Crop), tone-curve point
// edits, wheel geometry, and the command plans of Copy/Paste Grade and "apply LUT as Look".
import {
	type Animatable,
	type Clip,
	type ClipTiming,
	type Command,
	type EffectInstance,
	type EffectRegistry,
	type EffectSpec,
	effectParamPropertySpec,
	isColorEffect,
	isKnownClipKind,
	kindCapabilities,
	LUMETRI_EFFECT,
	LUMETRI_EFFECT_ID,
	MAX_CURVE_POINTS,
	type MediaAsset,
	type ParamSpec,
	type ProjectDocument,
	type Rational,
	retimeKeyframes,
	type Sequence,
} from '@jasper/project';
import { type Binding, bindEffectParam, makeRow, type Row } from '../panels/properties/lib/model.ts';

const effectsOf = (clip: Clip): EffectInstance[] => (clip as { effects?: EffectInstance[] }).effects ?? [];

/** Visual clips that take effects (video, stills, solids, text…) can carry a grade. */
export function gradeEligible(clip: Clip | null | undefined): clip is Clip {
	if (!clip || !isKnownClipKind(clip.kind)) return false;
	const caps = kindCapabilities(clip.kind);
	return !!caps?.visual && !!caps.supportsEffects;
}

/** The clip's first `jasper.lumetri` instance (the one the Lumetri panel edits, S06:CGU-001). */
export function firstLumetri(clip: Clip): EffectInstance | null {
	return effectsOf(clip).find((e) => e.effectId === LUMETRI_EFFECT_ID) ?? null;
}

function lumetriParam(name: string, spec: EffectSpec = LUMETRI_EFFECT): ParamSpec {
	const p = spec.params.find((x) => x.name === name);
	if (!p) throw new Error(`jasper.lumetri has no parameter ${name}`);
	return p;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * Binding of one Lumetri param: the existing first instance, or registry defaults whose first edit adds the
 * instance (`effect.add` with the edited value and a `$ref`) in the same transaction — one undo step.
 */
function bindLumetri(
	doc: ProjectDocument,
	seq: Sequence,
	clip: Clip,
	fx: EffectInstance | null,
	name: string,
	frame: number,
	spec: EffectSpec = LUMETRI_EFFECT,
): Binding {
	const p = lumetriParam(name, spec);
	if (fx) return bindEffectParam(doc, seq, clip, fx, spec, p, frame);
	return {
		clip,
		spec: effectParamPropertySpec('new', spec, p),
		path: null,
		param: name,
		resolved: { value: clone(p.default), animated: false, anim: null, time: 0, outside: false },
		create: (ref, params) => [
			{
				type: 'effect.add',
				target: { clipId: clip.id },
				effectId: LUMETRI_EFFECT_ID,
				...(params ? { params } : {}),
				ref,
			} as Command,
		],
	};
}

/** The row of a Lumetri param (id `effects.<fx>.<param>` once the instance exists, like Effect Controls). */
export function lumetriRow(
	doc: ProjectDocument,
	seq: Sequence,
	clip: Clip,
	fx: EffectInstance | null,
	name: string,
	frame: number,
	spec: EffectSpec = LUMETRI_EFFECT,
): Row {
	const id = fx ? `effects.${fx.id}.${name}` : `lumetri.${name}`;
	return makeRow(id, [bindLumetri(doc, seq, clip, fx, name, frame, spec)])!;
}

/** Scalar value of a row (single clip). */
export function rowNumber(row: Row, fallback = 0): number {
	const v = row.bindings[0]?.resolved.value;
	return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export type CurvePoint = [number, number];

const IDENTITY: CurvePoint[] = [
	[0, 0],
	[1, 1],
];
/** Minimum x distance between neighbouring points (keeps x strictly increasing). */
const CURVE_MIN_GAP = 0.01;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const round4 = (x: number) => Math.round(x * 10000) / 10000;

/** Points of a curve param value (`{curve}`), sorted; the identity for anything unusable. */
export function curvePoints(value: unknown, fallback: readonly CurvePoint[] = IDENTITY): CurvePoint[] {
	const raw = (value as { curve?: unknown } | null)?.curve;
	if (!Array.isArray(raw)) return fallback.map((p) => [...p] as CurvePoint);
	const pts = raw
		.filter((p): p is number[] => Array.isArray(p) && p.length >= 2)
		.map((p) => [clamp01(Number(p[0])), clamp01(Number(p[1]))] as CurvePoint)
		.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
		.sort((a, b) => a[0] - b[0]);
	return pts.length >= 2 ? pts : fallback.map((p) => [...p] as CurvePoint);
}

/** color-grade: the neutral (flat) hue/saturation curve. */
export const NEUTRAL_POINTS: readonly CurvePoint[] = [
	[0, 0.5],
	[1, 0.5],
];

/** True when every point of a hue/saturation curve sits at the neutral 0.5. */
export const isNeutralPoints = (pts: readonly CurvePoint[]) => pts.every((p) => Math.abs(p[1] - 0.5) < 1e-9);

export const curveValue = (pts: readonly CurvePoint[]) => ({
	curve: pts.map(([x, y]) => [round4(x), round4(y)]),
});

/** Adds a point at (x, y); null when the curve is full or a point already sits at that x. */
export function addCurvePoint(
	pts: readonly CurvePoint[],
	x: number,
	y: number,
): { points: CurvePoint[]; index: number } | null {
	if (pts.length >= MAX_CURVE_POINTS) return null;
	const px = clamp01(x);
	if (pts.some((p) => Math.abs(p[0] - px) < CURVE_MIN_GAP)) return null;
	const points = [...pts.map((p) => [...p] as CurvePoint), [px, clamp01(y)] as CurvePoint].sort(
		(a, b) => a[0] - b[0],
	);
	return { points, index: points.findIndex((p) => p[0] === px) };
}

/** Moves point `index`; x stays strictly between its neighbours, so the order never changes. */
export function moveCurvePoint(
	pts: readonly CurvePoint[],
	index: number,
	x: number,
	y: number,
): CurvePoint[] {
	const lo = index > 0 ? pts[index - 1]![0] + CURVE_MIN_GAP : 0;
	const hi = index < pts.length - 1 ? pts[index + 1]![0] - CURVE_MIN_GAP : 1;
	const out = pts.map((p) => [...p] as CurvePoint);
	out[index] = [Math.min(hi, Math.max(lo, clamp01(x))), clamp01(y)];
	return out;
}

/** Removes point `index`; null when only two points are left (a curve needs at least two). */
export function removeCurvePoint(pts: readonly CurvePoint[], index: number): CurvePoint[] | null {
	if (pts.length <= 2 || index < 0 || index >= pts.length) return null;
	return pts.filter((_, i) => i !== index).map((p) => [...p] as CurvePoint);
}

/** Index of the point within `radius` (curve units) of (x, y), or -1. */
export function hitCurvePoint(pts: readonly CurvePoint[], x: number, y: number, radius: number): number {
	let best = -1;
	let bestD = radius;
	pts.forEach(([px, py], i) => {
		const d = Math.hypot(px - x, py - y);
		if (d <= bestD) {
			best = i;
			bestD = d;
		}
	});
	return best;
}

export const isIdentityPoints = (pts: readonly CurvePoint[]) =>
	pts.length === 2 && pts[0]![0] === 0 && pts[0]![1] === 0 && pts[1]![0] === 1 && pts[1]![1] === 1;

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Wheel value (unit disc, y up) of a pointer offset from the wheel centre in px. */
export function wheelFromOffset(dx: number, dy: number, radius: number): [number, number] {
	let x = dx / radius;
	let y = -dy / radius;
	const m = Math.hypot(x, y);
	if (m > 1) {
		x /= m;
		y /= m;
	}
	return [round3(x) || 0, round3(y) || 0];
}

/** Pixel offset from the centre of a wheel value. */
export function wheelToOffset(v: unknown, radius: number): { dx: number; dy: number } {
	const [x, y] = wheelVec(v);
	return { dx: x * radius, dy: -y * radius };
}

export function wheelVec(v: unknown): [number, number] {
	if (!Array.isArray(v)) return [0, 0];
	const x = Number(v[0]);
	const y = Number(v[1]);
	return [Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0];
}

type LutItem = {
	mediaId: string;
	name: string;
	size: number | null;
	/** `33³` / `1D 1024` (empty when the header is unknown). */
	sizeText: string;
	title: string | null;
};

/** `33³` (3D) or `1D 1024` (1D) — the Project panel and the pickers show this next to the name. */
export function lutSizeText(asset: Pick<MediaAsset, 'lut'> | undefined): string {
	const lut = asset?.lut;
	if (!lut) return '';
	return lut.dimensions === 1 ? `1D ${lut.size}` : `${lut.size}³`;
}

/** The project's LUT media (kind `lut`), by item name. */
export function lutItems(doc: ProjectDocument): LutItem[] {
	const out: LutItem[] = [];
	const seen = new Set<string>();
	for (const item of Object.values(doc.items)) {
		if (item.kind !== 'media') continue;
		const asset = doc.media[item.mediaId];
		if (asset?.kind !== 'lut' || seen.has(asset.id)) continue;
		seen.add(asset.id);
		out.push({
			mediaId: asset.id,
			name: item.name,
			size: asset.lut?.size ?? null,
			sizeText: lutSizeText(asset),
			title: asset.lut?.title ?? null,
		});
	}
	// LUT media registered without a project item (MCP import_lut) are listed too.
	for (const asset of Object.values(doc.media)) {
		if (asset.kind !== 'lut' || seen.has(asset.id)) continue;
		out.push({
			mediaId: asset.id,
			name: asset.originalName,
			size: asset.lut?.size ?? null,
			sizeText: lutSizeText(asset),
			title: asset.lut?.title ?? null,
		});
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

export const mediaIdOf = (v: unknown): string =>
	typeof (v as { mediaId?: unknown } | null)?.mediaId === 'string' ? (v as { mediaId: string }).mediaId : '';

/** One copied colour effect (S06:CGU-004). */
export type CopiedColorEffect = {
	effectId: string;
	effectVersion: number;
	enabled: boolean;
	params: Record<string, unknown>;
	/** Timing of the source clip: keyframes are re-timed to keep their offset from the clip start. */
	from?: ClipTiming;
};

function isColorInstance(fx: EffectInstance, registry: EffectRegistry): boolean {
	return isColorEffect(registry.get(fx.effectId, fx.effectVersion));
}

/** Every colour effect of a clip (effects whose spec has a colour op), in stack order. */
export function colorEffectsOf(clip: Clip, registry: EffectRegistry): EffectInstance[] {
	return effectsOf(clip).filter((fx) => isColorInstance(fx, registry));
}

export function copyGrade(clip: Clip, registry: EffectRegistry): CopiedColorEffect[] {
	return colorEffectsOf(clip, registry).map((fx) => ({
		effectId: fx.effectId,
		effectVersion: fx.effectVersion,
		enabled: fx.enabled,
		params: clone(fx.params) as Record<string, unknown>,
		from: { start: clip.start, duration: clip.duration, sourceIn: clip.sourceIn, speed: { ...clip.speed } },
	}));
}

function sequenceRateOf(doc: ProjectDocument, clipId: string): Rational | null {
	for (const seq of Object.values(doc.sequences)) if (seq.clips[clipId]) return seq.settings.frameRate;
	return null;
}

function findClip(doc: ProjectDocument, clipId: string): Clip | null {
	for (const seq of Object.values(doc.sequences)) {
		const c = seq.clips[clipId];
		if (c) return c;
	}
	return null;
}

/**
 * Paste Grade: the target's colour effects are replaced by the copied ones, inserted where its first colour
 * effect was (appended when it had none). Params unknown to the registry spec are dropped (effect.add would
 * refuse them). One transaction for every target.
 */
export function planPasteGrade(
	doc: ProjectDocument,
	grade: readonly CopiedColorEffect[],
	targetClipIds: readonly string[],
	registry: EffectRegistry,
): Command[] {
	const cmds: Command[] = [];
	let ref = 0;
	for (const clipId of targetClipIds) {
		const clip = findClip(doc, clipId);
		if (!gradeEligible(clip)) continue;
		const effects = effectsOf(clip);
		const firstColor = effects.findIndex((fx) => isColorInstance(fx, registry));
		const at = firstColor < 0 ? effects.length : firstColor;
		for (const fx of effects)
			if (isColorInstance(fx, registry))
				cmds.push({ type: 'effect.remove', effectInstanceId: fx.id } as Command);
		grade.forEach((g, i) => {
			const spec = registry.get(g.effectId, g.effectVersion) ?? registry.get(g.effectId);
			if (!spec) return;
			const rate = sequenceRateOf(doc, clipId);
			const params = Object.fromEntries(
				Object.entries(g.params)
					.filter(([k]) => spec.params.some((p) => p.name === k))
					.map(([k, v]) => {
						const a = v as Animatable<unknown> | undefined;
						if (!g.from || !rate || !a || !Array.isArray(a.keyframes) || a.keyframes.length === 0)
							return [k, v];
						return [k, { ...a, keyframes: retimeKeyframes(a.keyframes, g.from, clip!, rate) }];
					}),
			);
			const r = `$grade${ref++}`;
			cmds.push({
				type: 'effect.add',
				target: { clipId },
				effectId: g.effectId,
				index: at + i,
				params,
				ref: r,
			} as Command);
			if (!g.enabled)
				cmds.push({ type: 'effect.setEnabled', effectInstanceId: r, enabled: false } as Command);
		});
	}
	return cmds;
}

/**
 * Apply a LUT as the Look (S06:LUT-002): sets `look` on each clip's first Lumetri instance, or adds one with
 * the LUT as its look.
 */
export function planApplyLook(doc: ProjectDocument, mediaId: string, clipIds: readonly string[]): Command[] {
	const cmds: Command[] = [];
	for (const clipId of clipIds) {
		const clip = findClip(doc, clipId);
		if (!gradeEligible(clip)) continue;
		const fx = firstLumetri(clip);
		if (fx)
			cmds.push({ type: 'param.set', target: ['effect', fx.id, 'look'], value: { mediaId } } as Command);
		else
			cmds.push({
				type: 'effect.add',
				target: { clipId },
				effectId: LUMETRI_EFFECT_ID,
				params: { look: { mediaId } },
			} as Command);
	}
	return cmds;
}
