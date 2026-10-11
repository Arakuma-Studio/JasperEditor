// What a multi-camera clip shows, as ordinary clips (wp-multicam): Clip ▸ Multi-Camera ▸ Flatten writes the clips
// of the active angle into the sequence (`resolveMulticamClip` + `pieceVideoClip` / `pieceAudioClip`).
//
// Rendering does not use this: an enabled multi-camera clip renders as the nest it is, with only its angle's track
// visible (`multicamView`, render snapshot) — exactly Premiere's model. Flatten must therefore draw the same picture
// as that nest, which these functions guarantee (tests compare the two frame by frame): at outer frame f the piece
// shows the inner clip under source time T(f) at that clip's media time; the outer clip's Motion is applied after
// the inner clip's (composed into one transform), its Opacity multiplies the inner one, its blend mode applies unless
// the inner clip has its own, and its effects run after the inner clip's effects. Audio pieces add gain, volume and
// pan of the outer clip, the inner clip and its track; effects chain inner → inner track → outer. Keyframes of the
// outer clip (outer content time = source-sequence time) are re-timed to the inner media time. When the inner
// Motion is animated, or the composition would need a skew (inner rotation with a non-uniform outer scale), the
// composed Motion/Opacity are sampled per frame.
import { contentTimeAt } from '../derive/index.ts';
import { evaluate } from '../keyframes.ts';
import { layerMatrix, type Mat2D, multiplyMatrix } from '../render/transform.ts';
import type { Animatable, Keyframe, Vec2 } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type {
	AudioClip,
	BlendMode,
	Clip,
	EffectInstance,
	MulticamSource,
	Sequence,
	Speed,
	Track,
	Transform,
} from '../schema/sequence.ts';
import { flicksPerFrame, type Rational } from '../time.ts';
import {
	angleById,
	audibleTrackIds,
	firstVideoAngle,
	isEnabledMulticamClip,
	type MulticamClip,
} from './model.ts';

/** `m = a + b·t`. */
export type Affine = { a: number; b: number };
const apply = (m: Affine, t: number) => m.a + m.b * t;

export type MulticamPiece = {
	/** The inner clip (on the source sequence) this piece shows. */
	inner: Clip;
	innerTrackId: string;
	/** Outer frames. */
	start: number;
	duration: number;
	/** Outer content time (source sequence flicks) → inner content time (media flicks). */
	map: Affine;
	/** Of the clip that shows the piece: content time at its first frame and its speed. */
	sourceIn: number;
	speed: Speed;
	/** Outer content time at the piece's frames: `T(f) = t.a + t.b·f`. */
	outerTime: Affine;
};

const EPS = 1e-9;

/** Media time of an inner clip as an affine function of source-sequence flicks (`contentTimeAt`, continuous). */
export function innerTimeMap(inner: Clip, sourceRate: Rational): Affine {
	const F = flicksPerFrame(sourceRate);
	const r = inner.speed.rate;
	if (inner.speed.reverse) return { a: inner.sourceIn + (inner.start + inner.duration - 1) * F * r, b: -r };
	return { a: inner.sourceIn - inner.start * F * r, b: r };
}

/** Outer content time as an affine function of the outer frame. */
function outerTimeMap(outer: Clip, rate: Rational): Affine {
	const t0 = contentTimeAt(outer, outer.start, rate);
	const step = flicksPerFrame(rate) * outer.speed.rate * (outer.speed.reverse ? -1 : 1);
	return { a: t0 - step * outer.start, b: step };
}

/**
 * The pieces of `outer` (a nest clip of `source`, outer sequence at `rate`) that show clips of `trackId`: one per
 * inner clip under the outer clip's content range, clipped to it. Disabled inner clips show nothing (as in a nest).
 */
export function piecesOf(outer: Clip, rate: Rational, source: Sequence, trackId: string): MulticamPiece[] {
	const T = outerTimeMap(outer, rate);
	const Fs = flicksPerFrame(source.settings.frameRate);
	const Fo = flicksPerFrame(rate);
	const inners = Object.values(source.clips)
		.filter((c) => c.trackId === trackId && c.enabled)
		.sort((x, y) => x.start - y.start);
	const out: MulticamPiece[] = [];
	const lo = outer.start;
	const hi = outer.start + outer.duration;
	for (const inner of inners) {
		const i0 = inner.start * Fs;
		const i1 = (inner.start + inner.duration) * Fs;
		let fa: number;
		let fb: number;
		if (T.b > 0) {
			// T(f) ≥ i0 and T(f) < i1
			fa = Math.ceil((i0 - T.a) / T.b - EPS);
			fb = Math.ceil((i1 - T.a) / T.b - EPS);
		} else {
			// decreasing: T(f) ≥ i0 ⟺ f ≤ (i0 − a)/b … (b < 0 flips the inequality)
			fb = Math.floor((i0 - T.a) / T.b + EPS) + 1;
			fa = Math.floor((i1 - T.a) / T.b + EPS) + 1;
		}
		fa = Math.max(fa, lo);
		fb = Math.min(fb, hi);
		if (fb <= fa) continue;
		const map = innerTimeMap(inner, source.settings.frameRate);
		// media time per outer frame: m(f) = map(T(f)) = (map.a + map.b·T.a) + map.b·T.b·f
		const slope = map.b * T.b;
		const m = (f: number) => map.a + map.b * (T.a + T.b * f);
		const reverse = slope < 0;
		const speed: Speed = {
			rate: Math.abs(slope) / Fo,
			reverse,
			maintainPitch: (outer.speed as Speed).maintainPitch ?? false,
		};
		out.push({
			inner,
			innerTrackId: trackId,
			start: fa,
			duration: fb - fa,
			map,
			sourceIn: Math.round(reverse ? m(fb - 1) : m(fa)),
			speed,
			outerTime: T,
		});
	}
	return out;
}

function isAnim(v: unknown): v is Animatable<unknown> {
	return (
		!!v && typeof v === 'object' && 'value' in v && Array.isArray((v as { keyframes?: unknown }).keyframes)
	);
}

/** Re-time one animatable through `m` (a decreasing map reverses the keys, swapping eases and tangents). */
export function retimeAnim<T>(a: Animatable<T>, m: Affine): Animatable<T> {
	if (a.keyframes.length === 0) return a;
	const keys = a.keyframes.map((k) => ({ ...k, time: Math.round(apply(m, k.time)) }));
	if (m.b < 0) {
		keys.reverse();
		for (const k of keys) {
			const e = k.easeIn;
			k.easeIn = k.easeOut;
			k.easeOut = e;
			if (k.spatial)
				k.spatial = { ...k.spatial, inTangent: k.spatial.outTangent, outTangent: k.spatial.inTangent };
		}
	}
	return { ...a, keyframes: keys as Keyframe<T>[] };
}

/** A deep copy of `v` with every animatable re-timed through `m`. */
export function retimeDeep<T>(v: T, m: Affine): T {
	if (Array.isArray(v)) return v.map((x) => retimeDeep(x, m)) as T;
	if (!v || typeof v !== 'object') return v;
	if (isAnim(v)) {
		const r = retimeAnim(v, m) as Animatable<unknown>;
		const rest: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v))
			if (k !== 'value' && k !== 'keyframes') rest[k] = retimeDeep(x, m);
		return { ...rest, value: r.value, keyframes: r.keyframes } as T;
	}
	const out: Record<string, unknown> = {};
	for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = retimeDeep(x, m);
	return out as T;
}

const staticAnim = <T>(value: T): Animatable<T> => ({ value, keyframes: [] });

/** Map an animatable's values (and spatial tangents through `tangent`). */
function mapValues<T, U>(a: Animatable<T>, f: (v: T) => U, tangent?: (v: Vec2) => Vec2): Animatable<U> {
	return {
		value: f(a.value),
		keyframes: a.keyframes.map((k) => {
			const nk = { ...k, value: f(k.value) } as unknown as Keyframe<U>;
			if (k.spatial && tangent)
				nk.spatial = {
					...k.spatial,
					inTangent: tangent(k.spatial.inTangent),
					outTangent: tangent(k.spatial.outTangent),
				};
			return nk;
		}),
	};
}

/** Keyframes sampled per frame (linear between samples): `at(f)` gives the content time and value of frame f. */
function sampled<T>(frames: [number, number], at: (f: number) => { time: number; value: T }): Animatable<T> {
	const [fa, fb] = frames;
	const n = fb - fa;
	const stride = Math.max(1, Math.ceil(n / 4000));
	const keys: Keyframe<T>[] = [];
	const seen = new Set<number>();
	const push = (f: number) => {
		const s = at(f);
		const time = Math.round(s.time);
		if (seen.has(time)) return;
		seen.add(time);
		keys.push({
			id: `kf_mc${keys.length}`,
			time,
			value: s.value,
			interpolation: 'linear',
			easeIn: { influence: 1 / 3, slope: 1 },
			easeOut: { influence: 1 / 3, slope: 1 },
		});
	};
	for (let f = fa; f < fb; f += stride) push(f);
	push(fb - 1);
	keys.sort((x, y) => x.time - y.time);
	if (keys.length === 1) return { value: keys[0]!.value, keyframes: [] };
	return { value: keys[0]!.value, keyframes: keys };
}

type TValues = {
	position: Vec2;
	anchor: Vec2;
	scale: number;
	scaleWidth: number;
	uniformScale: boolean;
	rotation: number;
	flipH: boolean;
	flipV: boolean;
};

function valuesAt(t: Transform, time: number): TValues {
	return {
		position: evaluate(t.position, time),
		anchor: evaluate(t.anchor, time),
		scale: evaluate(t.scale, time),
		scaleWidth: evaluate(t.scaleWidth, time),
		uniformScale: t.uniformScale,
		rotation: evaluate(t.rotation, time),
		flipH: t.flipH,
		flipV: t.flipV,
	};
}

const isStaticTransform = (t: Transform) =>
	t.position.keyframes.length === 0 &&
	t.anchor.keyframes.length === 0 &&
	t.scale.keyframes.length === 0 &&
	t.scaleWidth.keyframes.length === 0 &&
	t.rotation.keyframes.length === 0;

function scaleSigns(v: Pick<TValues, 'scale' | 'scaleWidth' | 'uniformScale' | 'flipH' | 'flipV'>) {
	const sx = ((v.uniformScale ? v.scale : v.scaleWidth) / 100) * (v.flipH ? -1 : 1);
	const sy = (v.scale / 100) * (v.flipV ? -1 : 1);
	return { sx, sy };
}

/** Decompose `M` into Motion values about `anchor` (a layer-space point). `skew` = the part that does not fit. */
function decompose(M: Mat2D, anchor: Vec2): { values: TValues; skew: number } {
	const sx = Math.hypot(M.a, M.b);
	const det = M.a * M.d - M.b * M.c;
	const theta = sx > 1e-12 ? Math.atan2(M.b, M.a) : 0;
	let sy = sx > 1e-12 ? det / sx : Math.hypot(M.c, M.d);
	const flipV = sy < 0;
	sy = Math.abs(sy);
	const cos = Math.cos(theta);
	const sin = Math.sin(theta);
	// what the column-2 should be for a pure rotation·scale: sy·(−sin, cos)·(flipV ? −1 : 1)
	const s2 = flipV ? -sy : sy;
	const skew = Math.hypot(M.c - -sin * s2, M.d - cos * s2) / Math.max(1e-9, sy || 1);
	const px = M.a * anchor[0] + M.c * anchor[1] + M.e;
	const py = M.b * anchor[0] + M.d * anchor[1] + M.f;
	return {
		values: {
			position: [px, py],
			anchor,
			scale: sy * 100,
			scaleWidth: sx * 100,
			uniformScale: Math.abs(sx - sy) < 1e-9,
			rotation: (theta * 180) / Math.PI,
			flipH: false,
			flipV,
		},
		skew,
	};
}

/** Inner layer point that the inner Motion maps onto the outer anchor (the composed transform's anchor). */
function composedAnchor(inner: TValues, outerAnchor: Vec2): Vec2 {
	const Mi = layerMatrix(inner);
	const det = Mi.a * Mi.d - Mi.b * Mi.c;
	if (Math.abs(det) < 1e-12) return inner.anchor;
	const x = outerAnchor[0] - Mi.e;
	const y = outerAnchor[1] - Mi.f;
	return [(Mi.d * x - Mi.c * y) / det, (-Mi.b * x + Mi.a * y) / det];
}

export type ComposeContext = {
	/** The piece's outer frames. */
	frames: [number, number];
	/** Outer content time at an outer frame. */
	outerTime: Affine;
	/** Outer content time → inner content time. */
	map: Affine;
	warn(code: string, message: string): void;
};

/** Outer Motion after inner Motion, as one Motion in the inner clip's layer space (keyframes in inner time). */
export function composeTransform(outer: Transform, inner: Transform, ctx: ComposeContext): Transform {
	const o = retimeDeep(outer, ctx.map);
	if (isStaticTransform(inner)) {
		const iv = valuesAt(inner, 0);
		const si = scaleSigns(iv);
		const outerUniform = outer.uniformScale && outer.flipH === outer.flipV;
		if (iv.rotation === 0 || outerUniform) {
			// So·Ri·Si = Ri·(So·Si) when So is uniform (or Ri = I): rotation adds, scales multiply.
			const linv = (v: Vec2): Vec2 => {
				// (Ri·Si)⁻¹ applied to a vector
				const th = (-iv.rotation * Math.PI) / 180;
				const x = v[0] * Math.cos(th) - v[1] * Math.sin(th);
				const y = v[0] * Math.sin(th) + v[1] * Math.cos(th);
				return [x / (si.sx || 1e-12), y / (si.sy || 1e-12)];
			};
			const anchor = mapValues(
				o.anchor,
				(a: Vec2): Vec2 => {
					const d = linv([a[0] - iv.position[0], a[1] - iv.position[1]]);
					return [iv.anchor[0] + d[0], iv.anchor[1] + d[1]];
				},
				linv,
			);
			// outer scale factors (signed by flips) × inner
			const ofx = outer.flipH ? -1 : 1;
			const ofy = outer.flipV ? -1 : 1;
			const sxSign = ofx * Math.sign(si.sx || 1);
			const sySign = ofy * Math.sign(si.sy || 1);
			const width = outer.uniformScale ? o.scale : o.scaleWidth;
			const scaleWidth = mapValues(width, (s: number) => s * Math.abs(si.sx));
			const scale = mapValues(o.scale, (s: number) => s * Math.abs(si.sy));
			const uniform = Math.abs(Math.abs(si.sx) - Math.abs(si.sy)) < 1e-12 && outer.uniformScale;
			return {
				position: o.position,
				anchor,
				scale,
				scaleWidth: uniform ? scale : scaleWidth,
				uniformScale: uniform,
				rotation: mapValues(o.rotation, (r: number) => r + iv.rotation),
				flipH: sxSign < 0,
				flipV: sySign < 0,
			};
		}
	}
	// General case: sample the composed matrix per frame.
	const [fa, fb] = ctx.frames;
	let lastRot: number | null = null;
	let worstSkew = 0;
	const per = (f: number) => {
		const to = apply(ctx.outerTime, f);
		const ti = apply(ctx.map, to);
		const ov = valuesAt(outer, to);
		const iv = valuesAt(inner, ti);
		const M = multiplyMatrix(layerMatrix(ov), layerMatrix(iv));
		const d = decompose(M, composedAnchor(iv, ov.anchor));
		worstSkew = Math.max(worstSkew, d.skew);
		// unwrap the rotation so per-frame keys never spin through ±180°
		if (lastRot !== null) {
			while (d.values.rotation - lastRot > 180) d.values.rotation -= 360;
			while (d.values.rotation - lastRot < -180) d.values.rotation += 360;
		}
		lastRot = d.values.rotation;
		return { time: ti, v: d.values };
	};
	const samples = new Map<number, { time: number; v: TValues }>();
	const at = (f: number) => {
		let s = samples.get(f);
		if (!s) {
			s = per(f);
			samples.set(f, s);
		}
		return s;
	};
	const flipV = at(fa).v.flipV;
	const position = sampled<Vec2>([fa, fb], (f) => ({ time: at(f).time, value: at(f).v.position }));
	const anchor = sampled<Vec2>([fa, fb], (f) => ({ time: at(f).time, value: at(f).v.anchor }));
	const scale = sampled<number>([fa, fb], (f) => ({ time: at(f).time, value: at(f).v.scale }));
	const scaleWidth = sampled<number>([fa, fb], (f) => ({ time: at(f).time, value: at(f).v.scaleWidth }));
	const rotation = sampled<number>([fa, fb], (f) => ({ time: at(f).time, value: at(f).v.rotation }));
	if (worstSkew > 1e-3)
		ctx.warn(
			'MULTICAM_TRANSFORM_SKEW',
			'The multi-camera clip’s non-uniform scale on a rotated angle needs a skew; it is drawn without it',
		);
	const uniform = [...samples.values()].every((s) => s.v.uniformScale);
	return {
		position,
		anchor,
		scale,
		scaleWidth: uniform ? scale : scaleWidth,
		uniformScale: uniform,
		rotation,
		flipH: false,
		flipV,
	};
}

/** Product of two opacities (percent), re-timed; sampled per frame when both are animated. */
export function composeOpacity(
	outer: Animatable<number>,
	inner: Animatable<number>,
	ctx: ComposeContext,
): Animatable<number> {
	const o = retimeAnim(outer, ctx.map);
	if (inner.keyframes.length === 0) return mapValues(o, (v: number) => (v * inner.value) / 100);
	if (outer.keyframes.length === 0) return mapValues(inner, (v: number) => (v * outer.value) / 100);
	return sampled(ctx.frames, (f) => {
		const to = apply(ctx.outerTime, f);
		const ti = apply(ctx.map, to);
		return { time: ti, value: (evaluate(outer, to) * evaluate(inner, ti)) / 100 };
	});
}

/** Sum of animatables (dB, pan), each with its own time map into the result's time; sampled when 2+ animate. */
function sumAnims(
	parts: { anim: Animatable<number>; map: Affine | null }[],
	ctx: ComposeContext,
	clamp?: [number, number],
): Animatable<number> {
	const cl = (v: number) => (clamp ? Math.min(clamp[1], Math.max(clamp[0], v)) : v);
	const animated = parts.filter((p) => p.anim.keyframes.length > 0);
	if (animated.length <= 1) {
		const constant = parts.filter((p) => p.anim.keyframes.length === 0).reduce((s, p) => s + p.anim.value, 0);
		if (animated.length === 0) return staticAnim(cl(constant));
		const p = animated[0]!;
		const re = p.map ? retimeAnim(p.anim, p.map) : p.anim;
		return mapValues(re, (v: number) => cl(v + constant));
	}
	return sampled(ctx.frames, (f) => {
		const to = apply(ctx.outerTime, f);
		const ti = apply(ctx.map, to);
		// parts with a map are in outer time; parts without are already in inner time
		const v = parts.reduce((s, p) => s + evaluate(p.anim, p.map ? to : ti), 0);
		return { time: ti, value: cl(v) };
	});
}

const KNOWN_OUTER_FIELDS = new Set([
	'id',
	'kind',
	'trackId',
	'start',
	'duration',
	'sourceIn',
	'speed',
	'name',
	'label',
	'enabled',
	'linkId',
	'groupId',
	'markers',
	'sequenceId',
	'multicam',
	'transform',
	'opacity',
	'blendMode',
	'effects',
	'gainDb',
	'volumeDb',
	'pan',
]);

function isIdentityInner(inner: Clip, source: Sequence, doc: Pick<ProjectDocument, 'media'>): boolean {
	const t = (inner as { transform?: Transform }).transform;
	if (!t || !isStaticTransform(t)) return false;
	const v = valuesAt(t, 0);
	const asset = doc.media[(inner as { mediaId?: string }).mediaId ?? ''];
	const vs = asset?.probe.streams.find((s) => s.type === 'video');
	const w = vs && vs.type === 'video' ? vs.width : source.settings.width;
	const h = vs && vs.type === 'video' ? vs.height : source.settings.height;
	return (
		v.scale === 100 &&
		v.scaleWidth === 100 &&
		v.rotation === 0 &&
		!v.flipH &&
		!v.flipV &&
		w === source.settings.width &&
		h === source.settings.height &&
		v.anchor[0] - v.position[0] === w / 2 - source.settings.width / 2 &&
		v.anchor[1] - v.position[1] === h / 2 - source.settings.height / 2
	);
}

/** Extra (non-core) fields of the outer clip, re-timed: masks, grades and other per-clip data of other features. */
function extraFields(outer: Clip, map: Affine): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(outer)) if (!KNOWN_OUTER_FIELDS.has(k)) out[k] = retimeDeep(v, map);
	return out;
}

/** The visual clip that shows `piece` of the multi-camera video clip `outer`. */
export function pieceVideoClip(
	doc: Pick<ProjectDocument, 'media'>,
	source: Sequence,
	outer: MulticamClip & { kind: 'nest-video' },
	piece: MulticamPiece,
	id: string,
	warn: (code: string, message: string) => void,
): Clip {
	const inner = piece.inner as Clip & {
		transform?: Transform;
		opacity?: Animatable<number>;
		blendMode?: BlendMode;
		effects?: EffectInstance[];
	};
	const ctx: ComposeContext = {
		frames: [piece.start, piece.start + piece.duration],
		outerTime: piece.outerTime,
		map: piece.map,
		warn,
	};
	const extras = extraFields(outer, piece.map);
	const shared = Object.keys(extras).filter((k) => k in inner);
	if (shared.length > 0)
		warn(
			'MULTICAM_FIELD_SHADOWED',
			`Clip ${outer.id}: the angle clip’s own ${shared.join(', ')} replace the multi-camera clip’s`,
		);
	if (Object.keys(extras).length > shared.length && !isIdentityInner(inner, source, doc))
		warn(
			'MULTICAM_LAYER_SPACE',
			`Clip ${outer.id}: ${Object.keys(extras).join(', ')} of the multi-camera clip apply in the angle’s own layer space (its media is not the source sequence’s frame)`,
		);
	const transform = inner.transform ? composeTransform(outer.transform, inner.transform, ctx) : undefined;
	const opacity = composeOpacity(outer.opacity, inner.opacity ?? staticAnim(100), ctx);
	const innerBlend = inner.blendMode ?? 'normal';
	if (innerBlend !== 'normal' && outer.blendMode !== 'normal')
		warn(
			'MULTICAM_BLEND',
			`Clip ${outer.id}: the angle clip has its own blend mode (${innerBlend}); the multi-camera clip’s ${outer.blendMode} is not applied`,
		);
	const effects = [...(inner.effects ?? []), ...retimeDeep(outer.effects, piece.map)];
	return {
		...extras,
		...(inner as object),
		id,
		trackId: outer.trackId,
		start: piece.start,
		duration: piece.duration,
		sourceIn: piece.sourceIn,
		speed: piece.speed,
		name: outer.name,
		label: outer.label,
		enabled: outer.enabled,
		linkId: outer.linkId,
		groupId: outer.groupId,
		markers: [],
		...(transform ? { transform } : {}),
		opacity,
		blendMode: innerBlend !== 'normal' ? innerBlend : outer.blendMode,
		effects,
	} as unknown as Clip;
}

/** The audio clip that plays `piece` of the multi-camera audio clip `outer`. */
export function pieceAudioClip(
	source: Sequence,
	outer: MulticamClip & { kind: 'nest-audio' },
	piece: MulticamPiece,
	innerTrack: Track,
	id: string,
	warn: (code: string, message: string) => void,
): Clip {
	const inner = piece.inner as AudioClip;
	const ctx: ComposeContext = {
		frames: [piece.start, piece.start + piece.duration],
		outerTime: piece.outerTime,
		map: piece.map,
		warn,
	};
	const zero = staticAnim(0);
	const volumeDb = sumAnims(
		[
			{ anim: outer.volumeDb, map: piece.map },
			{ anim: inner.volumeDb, map: null },
			{ anim: innerTrack.volumeDb ?? zero, map: piece.map },
			{ anim: source.master.volumeDb, map: piece.map },
		],
		ctx,
	);
	const pan = sumAnims(
		[
			{ anim: outer.pan, map: piece.map },
			{ anim: inner.pan, map: null },
			{ anim: innerTrack.pan ?? zero, map: piece.map },
		],
		ctx,
		[-100, 100],
	);
	const effects = [
		...inner.effects,
		...retimeDeep(innerTrack.effects ?? [], piece.map),
		...retimeDeep(source.master.effects, piece.map),
		...retimeDeep(outer.effects, piece.map),
	];
	return {
		...extraFields(outer, piece.map),
		...(inner as object),
		id,
		trackId: outer.trackId,
		start: piece.start,
		duration: piece.duration,
		sourceIn: piece.sourceIn,
		speed: piece.speed,
		name: outer.name,
		label: outer.label,
		enabled: outer.enabled,
		linkId: outer.linkId,
		groupId: outer.groupId,
		markers: [],
		gainDb: outer.gainDb + inner.gainDb,
		volumeDb,
		pan,
		effects,
	} as unknown as Clip;
}

export type ResolvedMulticamClip = {
	source: Sequence;
	multicam: MulticamSource;
	angleId: string | null;
	/** Video: pieces of the angle track. Audio: pieces of every audible track (in track order). */
	pieces: MulticamPiece[];
};

/** The angle's pieces of an enabled multi-camera clip; null when the clip is not one or its source is gone. */
export function resolveMulticamClip(
	doc: Pick<ProjectDocument, 'sequences'>,
	rate: Rational,
	clip: Clip,
): ResolvedMulticamClip | null {
	if (!isEnabledMulticamClip(clip)) return null;
	const source = doc.sequences[clip.sequenceId];
	const mc = (source as { multicam?: MulticamSource } | undefined)?.multicam;
	if (!source || !mc) return null;
	const angle = angleById(mc, clip.multicam.angle) ?? firstVideoAngle(mc);
	if (clip.kind === 'nest-video') {
		const track = angle?.videoTrackId ?? null;
		return {
			source,
			multicam: mc,
			angleId: angle?.id ?? null,
			pieces: track ? piecesOf(clip, rate, source, track) : [],
		};
	}
	const anySolo = source.audioTracks.some((t) => t.solo);
	const audible = new Set(audibleTrackIds(mc, angle?.id ?? null));
	const pieces: MulticamPiece[] = [];
	for (const t of source.audioTracks) {
		if (!audible.has(t.id) || t.mute || (anySolo && !t.solo)) continue;
		pieces.push(...piecesOf(clip, rate, source, t.id));
	}
	return { source, multicam: mc, angleId: angle?.id ?? null, pieces };
}
