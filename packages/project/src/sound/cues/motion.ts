// Keyframed motion (spec 12 §2.2): every animated visual clip is sampled per frame with `resolveLayerProps` (the
// renderers' own evaluator), and 3D cameras with `rigFrameAt`. A per-frame speed curve
//   speed = |Δposition| / diagonal + K_SCALE·|Δ ln scale| + K_ROT·|Δrotation|      (per second)
// is cut into movement segments (hysteresis MOVE_ON / MOVE_OFF, short pauses bridged so an overshoot's turnaround
// stays one segment). Each segment gives:
// - `move` at its peak speed (whoosh when the move lasts ≥ 0.3 s, else swish), with the pan following the layer;
// - `land` where it settles: at the first velocity reversal after the peak (overshoot / bounce), or at the stop when
//   it stops abruptly (last moving frame still ≥ ABRUPT_STOP of the peak); a gentle ease-out gets no land. The type
//   follows the impact: on-screen area × incoming speed → hit / thump / tap;
// - `appear` / `exit` instead when the scale grows from ≤ 20 % (shrinks to ≤ 20 %);
// - `emphasis` instead when the scale pulses out and back (± ≥ 8 %, ≤ 1.2 s).
// Opacity ramps 0 → ≥ 50 % (and back) give `appear` / `exit` too.
import { clipEnd, contentTimeAt } from '../../derive/index.ts';
import { evaluate, hasActiveExpression, isAnimated } from '../../keyframes.ts';
import { intrinsicBoxOf } from '../../registry/properties.ts';
import { CORNER_PIN_EFFECT_ID, clipContentTime, resolveLayerProps } from '../../render/scene.ts';
import { scaleFactors } from '../../render/transform.ts';
import type { Animatable, Keyframe } from '../../schema/common.ts';
import type { CameraClip, Clip, EffectInstance, Transform } from '../../schema/sequence.ts';
import type { Layer3D } from '../../schema/three-d.ts';
import { rigFrameAt } from '../../three-d/scene.ts';
import type { SoundTypeId, SoundWeight } from '../taxonomy.ts';
import type { CueCandidate, CueSpeedCurve, DerivedCueAnchor } from './types.ts';
import {
	type CueContext,
	candidate,
	clamp01,
	clipName,
	inRange,
	isContentClip,
	label,
	panOfX,
	secs,
	sortedClips,
} from './util.ts';

/** Weight of a natural-log scale change against screen travel (diagonals): 100 → 200 % ≈ 0.42 diagonal. */
export const K_SCALE = 0.6;
/** Weight of a rotation in degrees: a quarter turn ≈ a third of the diagonal. */
export const K_ROT = 1 / 270;
/** A segment starts above this speed (diagonals per second) and ends below MOVE_OFF. */
export const MOVE_ON = 0.12;
export const MOVE_OFF = 0.03;
/** A stop is abrupt when the last moving frame still has this share of the peak speed. */
export const ABRUPT_STOP = 0.35;
/** Most frames sampled per clip (≈ 11 min at 30 fps); longer animated spans are truncated with a warning. */
export const MAX_SAMPLES_PER_CLIP = 20_000;

type Sample = {
	x: number;
	y: number;
	z: number;
	lnS: number;
	rot: number;
	op: number;
	area: number;
	cx: number;
};

type Segment = { a: number; b: number; peak: number };

const num = (a: Animatable<number> | undefined, t: number, d: number): number => {
	if (!a || typeof a !== 'object') return d;
	const v = evaluate(a, t);
	return typeof v === 'number' && Number.isFinite(v) ? v : d;
};
const fin = (v: number, d = 0) => (Number.isFinite(v) ? v : d);

function animatedProps(c: Clip): { name: string; anim: Animatable<unknown> }[] {
	const out: { name: string; anim: Animatable<unknown> }[] = [];
	const tr = (c as { transform?: Transform | null }).transform;
	const push = (name: string, a: unknown) => {
		if (
			a &&
			typeof a === 'object' &&
			Array.isArray((a as Animatable<unknown>).keyframes) &&
			isAnimated(a as Animatable<unknown>)
		)
			out.push({ name, anim: a as Animatable<unknown> });
	};
	if (tr) {
		push('position', tr.position);
		push('scale', tr.scale);
		push('scaleWidth', tr.scaleWidth);
		push('rotation', tr.rotation);
		push('anchor', tr.anchor);
	}
	push('opacity', (c as { opacity?: unknown }).opacity);
	const td = (c as { threeD?: Layer3D }).threeD;
	if (td?.enabled) {
		push('positionZ', td.positionZ);
		push('rotationX', td.rotationX);
		push('rotationY', td.rotationY);
		push('orientation', td.orientation);
	}
	return out;
}

/** Content-time span covered by keyframes (null = the whole clip: an expression animates it everywhere). */
function keySpan(props: { anim: Animatable<unknown> }[]): { lo: number; hi: number } | null {
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	for (const p of props) {
		if (hasActiveExpression(p.anim)) return null;
		for (const k of p.anim.keyframes) {
			if (!Number.isFinite(k?.time)) continue;
			lo = Math.min(lo, k.time);
			hi = Math.max(hi, k.time);
		}
	}
	return lo <= hi ? { lo, hi } : { lo: 0, hi: -1 };
}

/** Local frame indices `[i0, i1)` of a clip whose content time lies in a keyframe span (plus one frame each side). */
function localSpan(ctx: CueContext, c: Clip, span: { lo: number; hi: number } | null): [number, number] {
	if (!span) return [0, c.duration];
	if (span.hi < span.lo) return [0, 0];
	const step = ctx.F * (Number.isFinite(c.speed?.rate) && c.speed.rate > 0 ? c.speed.rate : 1);
	let a = Math.floor((span.lo - c.sourceIn) / step) - 1;
	let b = Math.ceil((span.hi - c.sourceIn) / step) + 2;
	if (c.speed?.reverse) [a, b] = [c.duration - b, c.duration - a];
	return [Math.max(0, a), Math.min(c.duration, b)];
}

/** Clamp the span to the analysed range (± 2 s of context so segments crossing the edge are still seen). */
function clampToRange(ctx: CueContext, c: Clip, [a, b]: [number, number]): [number, number] {
	const margin = Math.round(2 * ctx.fps);
	return [Math.max(a, ctx.range.start - margin - c.start), Math.min(b, ctx.range.end + margin - c.start)];
}

function nearestKeyframeId(anim: Animatable<unknown> | undefined, t: number): string | undefined {
	const kfs = anim?.keyframes as Keyframe<unknown>[] | undefined;
	if (!kfs?.length) return undefined;
	let best: Keyframe<unknown> | undefined;
	for (const k of kfs)
		if (typeof k?.id === 'string' && (!best || Math.abs(k.time - t) < Math.abs(best.time - t))) best = k;
	return best?.id;
}

/**
 * Movement segments of a speed series (`v[i]` = speed reaching sample i): runs above MOVE_OFF that reach MOVE_ON,
 * joined across pauses of at most `bridge` samples.
 */
export function speedSegments(v: ArrayLike<number>, bridge: number): Segment[] {
	const runs: Segment[] = [];
	let i = 0;
	while (i < v.length) {
		if (!(v[i]! > MOVE_OFF)) {
			i++;
			continue;
		}
		const a = i;
		let peak = i;
		while (i < v.length && v[i]! > MOVE_OFF) {
			if (v[i]! > v[peak]!) peak = i;
			i++;
		}
		runs.push({ a, b: i - 1, peak });
	}
	const joined: Segment[] = [];
	for (const r of runs) {
		const last = joined[joined.length - 1];
		if (last && r.a - last.b - 1 <= bridge) {
			last.b = r.b;
			if (v[r.peak]! > v[last.peak]!) last.peak = r.peak;
		} else joined.push({ ...r });
	}
	return joined.filter((s) => v[s.peak]! >= MOVE_ON && s.b - s.a + 1 >= 2);
}

type Dominant = 'position' | 'scale' | 'rotation' | 'positionZ';

export function deriveMotionCues(ctx: CueContext, opts: { curves: CueSpeedCurve[] }): CueCandidate[] {
	const cues: CueCandidate[] = [];
	const shown = new Set(ctx.videoTracks.map((v) => v.track.id));
	for (const c of sortedClips(ctx)) {
		if (!shown.has(c.trackId) || c.enabled === false || !isContentClip(c) || !inRange(ctx, c)) continue;
		if ((c as { frameHold?: { holdFilters?: boolean } }).frameHold?.holdFilters) continue;
		const props = animatedProps(c);
		if (!props.length) continue;
		clipMotion(ctx, c, props, cues, opts.curves);
	}
	return cues;
}

function clipMotion(
	ctx: CueContext,
	c: Clip,
	props: { name: string; anim: Animatable<unknown> }[],
	cues: CueCandidate[],
	curves: CueSpeedCurve[],
): void {
	let [i0, i1] = clampToRange(ctx, c, localSpan(ctx, c, keySpan(props)));
	if (i1 - i0 > MAX_SAMPLES_PER_CLIP) {
		ctx.warn({
			code: 'W_SAMPLING_TRUNCATED',
			message: `Motion of ${clipName(c)} sampled over its first ${MAX_SAMPLES_PER_CLIP} frames only`,
			source: 'keyframes',
			clipId: c.id,
		});
		i1 = i0 + MAX_SAMPLES_PER_CLIP;
	}
	if (i1 - i0 < 2) return;
	const vc = c as Clip & {
		transform?: Transform | null;
		opacity: Animatable<number>;
		effects?: EffectInstance[];
		threeD?: Layer3D;
	};
	const box = intrinsicBoxOf({ clip: c, doc: ctx.doc, seq: ctx.seq });
	const src = {
		transform: vc.transform ?? null,
		opacity: vc.opacity,
		intrinsicBox: { width: fin(box.width, ctx.width), height: fin(box.height, ctx.height) },
		effects: (vc.effects ?? []).filter(
			(fx) => fx?.enabled && (fx.effectId === 'jasper.crop' || fx.effectId === CORNER_PIN_EFFECT_ID),
		),
	};
	const frameArea = ctx.width * ctx.height;
	const td = vc.threeD?.enabled ? vc.threeD : undefined;
	const sample = (i: number): Sample => {
		const t = clipContentTime(c as never, c.start + i, ctx.rate);
		const p = resolveLayerProps(src as never, t);
		const tr = p.transform;
		const { sx, sy } = tr ? scaleFactors(tr) : { sx: 1, sy: 1 };
		const s = Math.sqrt(Math.abs(sx * sy));
		const rx = td ? num(td.rotationX, t, 0) : 0;
		const ry = td ? num(td.rotationY, t, 0) : 0;
		return {
			x: fin(tr?.position?.[0] ?? ctx.width / 2),
			y: fin(tr?.position?.[1] ?? ctx.height / 2),
			z: td ? num(td.positionZ, t, 0) : 0,
			lnS: Math.log(Math.max(1e-4, fin(s, 1))),
			rot: fin(tr?.rotation ?? 0) + rx + ry,
			op: clamp01(p.opacity / 100),
			area: clamp01((p.bounds.width * p.bounds.height) / frameArea),
			cx: fin(p.bounds.x + p.bounds.width / 2, ctx.width / 2),
		};
	};
	// samples[k] is local frame i0 − 1 + k (one frame before the span gives the first speed).
	const n = i1 - i0;
	const samples: Sample[] = new Array(n + 1);
	for (let k = 0; k <= n; k++) samples[k] = sample(i0 - 1 + k);
	const v = new Float32Array(n);
	const parts = new Float64Array(n * 4); // per frame: position, scale, rotation, z (signed: see below)
	for (let k = 0; k < n; k++) {
		const p = samples[k]!;
		const q = samples[k + 1]!;
		const pos = Math.hypot(q.x - p.x, q.y - p.y) / ctx.diag;
		const sc = K_SCALE * Math.abs(q.lnS - p.lnS);
		const ro = K_ROT * Math.abs(q.rot - p.rot);
		const z = Math.abs(q.z - p.z) / ctx.diag;
		const sp = (pos + sc + ro + z) * ctx.fps;
		v[k] = Number.isFinite(sp) ? Math.min(sp, 1e6) : 0;
		parts[k * 4] = pos;
		parts[k * 4 + 1] = sc;
		parts[k * 4 + 2] = ro;
		parts[k * 4 + 3] = z;
	}
	curves.push({ clipId: c.id, start: c.start + i0, speed: v });
	const at = (k: number) => samples[k + 1]!; // the sample reached at speed index k
	const frameOf = (k: number) => c.start + i0 + k;
	const where = `on ${label(ctx, c.trackId)} ${clipName(c)}`;
	const propOf = (name: string) => props.find((p) => p.name === name)?.anim;
	const kfId = (name: string, k: number) =>
		nearestKeyframeId(
			propOf(name) ?? (name === 'scale' ? propOf('scaleWidth') : undefined),
			clipContentTime(c as never, frameOf(k), ctx.rate),
		);
	const anchor = (
		name: string,
		k: number,
		event: 'peak-speed' | 'settle' | 'start' | 'end',
	): DerivedCueAnchor => {
		const id = kfId(name, k);
		return { type: 'keyframe', clipId: c.id, property: name, ...(id ? { keyframeId: id } : {}), event };
	};
	const bridge = Math.max(2, Math.round(0.1 * ctx.fps));
	for (const seg of speedSegments(v, bridge)) {
		const before = samples[seg.a]!; // last rest sample
		const after = at(seg.b);
		const peakS = at(seg.peak);
		const peakV = v[seg.peak]!;
		let tot = [0, 0, 0, 0];
		for (let k = seg.a; k <= seg.b; k++) tot = tot.map((x, j) => x + parts[k * 4 + j]!);
		const dom: Dominant = (['position', 'scale', 'rotation', 'positionZ'] as const)[
			tot.indexOf(Math.max(...tot))
		]!;
		const sBefore = Math.exp(before.lnS);
		const sAfter = Math.exp(after.lnS);
		const lenFrames = seg.b - seg.a + 1;
		const window = { start: frameOf(seg.a), end: frameOf(seg.b) + 1 };
		const key = (kind: string, k: number) => `keyframes:${c.id}:${kind}:${frameOf(k)}`;
		const pct = (s: number) => `${Math.round(s * 100)} %`;
		if (dom === 'scale' && sBefore <= 0.2 && sAfter >= 0.5) {
			// Grows from small: appears when it first reaches 95 % of its final size.
			let k = seg.a;
			while (k < seg.b && Math.exp(at(k).lnS) < 0.95 * sAfter) k++;
			const short = k - seg.a + 1 <= 0.25 * ctx.fps;
			cues.push(
				candidate('keyframes', {
					key: key('appear', k),
					frame: frameOf(k),
					kind: 'appear',
					weight: 'support',
					types: short ? ['pop', 'ui', 'swish'] : ['whoosh', 'reverse', 'shimmer'],
					align: short ? 'peak' : 'end',
					pan: panOfX(ctx, at(k).cx),
					anchor: anchor('scale', k, 'end'),
					confidence: 0.7,
					reason: `Scale ${pct(sBefore)}→${pct(sAfter)}: pops in (${secs(ctx, k - seg.a + 1)}) ${where}`,
					window: { start: window.start, end: frameOf(k) + 1 },
					size: Math.max(at(k).area, 0.02),
				}),
			);
			continue;
		}
		if (dom === 'scale' && sBefore >= 0.5 && sAfter <= 0.2) {
			cues.push(
				candidate('keyframes', {
					key: key('exit', seg.a),
					frame: frameOf(seg.a),
					kind: 'exit',
					weight: 'support',
					types: ['swish', 'whoosh', 'pop'],
					align: 'peak',
					pan: panOfX(ctx, before.cx),
					anchor: anchor('scale', seg.a, 'start'),
					confidence: 0.55,
					reason: `Scale ${pct(sBefore)}→${pct(sAfter)}: shrinks away ${where}`,
					window,
					size: Math.max(before.area, 0.02),
				}),
			);
			continue;
		}
		// Signed velocity along the dominant component (position: along the direction of travel at the peak).
		const pk = seg.peak;
		const pPrev = pk === 0 ? samples[0]! : at(pk - 1);
		const dir = [peakS.x - pPrev.x, peakS.y - pPrev.y];
		const dirLen = Math.hypot(dir[0]!, dir[1]!) || 1;
		const signed = (k: number): number => {
			const q = at(k);
			const p = samples[k]!;
			if (dom === 'position') return ((q.x - p.x) * dir[0]! + (q.y - p.y) * dir[1]!) / dirLen;
			if (dom === 'scale') return q.lnS - p.lnS;
			if (dom === 'rotation') return q.rot - p.rot;
			return q.z - p.z;
		};
		const vPeak = signed(pk);
		let flip = -1;
		for (let k = pk + 1; k <= seg.b; k++) {
			const u = signed(k);
			if (u * vPeak < 0 && Math.abs(u) >= 0.02 * Math.abs(vPeak)) {
				flip = k - 1; // the extreme: the last sample before the reversal
				break;
			}
		}
		const durationSec = lenFrames / ctx.fps;
		// Scale pulse: out and back to where it started.
		if (dom === 'scale' && flip >= 0 && durationSec <= 1.2) {
			let ext = seg.a;
			for (let k = seg.a; k <= seg.b; k++)
				if (Math.abs(at(k).lnS - before.lnS) > Math.abs(at(ext).lnS - before.lnS)) ext = k;
			const swing = Math.abs(at(ext).lnS - before.lnS);
			if (Math.abs(after.lnS - before.lnS) < 0.05 && swing >= 0.08) {
				cues.push(
					candidate('keyframes', {
						key: key('emphasis', ext),
						frame: frameOf(ext),
						kind: 'emphasis',
						weight: 'support',
						types: ['pop', 'ui', 'thump', 'hit'],
						align: 'peak',
						pan: panOfX(ctx, at(ext).cx),
						anchor: anchor('scale', ext, 'peak-speed'),
						confidence: 0.6,
						reason: `Scale pulses ${pct(sBefore)}→${pct(Math.exp(at(ext).lnS))}→${pct(sAfter)} ${where}`,
						window,
						size: Math.max(at(ext).area, 0.02),
					}),
				);
				continue;
			}
		}
		const what = describeChange(ctx, dom, before, after);
		const long = durationSec >= 0.3;
		const fromPan = panOfX(ctx, before.cx);
		const toPan = panOfX(ctx, after.cx);
		cues.push(
			candidate('keyframes', {
				key: key('move', pk),
				frame: frameOf(pk),
				kind: 'move',
				weight: 'support',
				types: long ? ['whoosh', 'swish', 'transition'] : ['swish', 'whoosh'],
				align: 'peak',
				pan: panOfX(ctx, peakS.cx),
				...(Math.abs(toPan - fromPan) >= 10 ? { panSweep: { from: fromPan, to: toPan } } : {}),
				anchor: anchor(dom, pk, 'peak-speed'),
				confidence: 0.4 + 0.45 * Math.min(1, peakV / 1),
				reason: `${what} (peak ${peakV.toFixed(2)} screens/s, ${secs(ctx, lenFrames)}) ${where}`,
				window,
				size: Math.max(peakS.area, 0.02),
			}),
		);
		// Landing: overshoot / bounce, or an abrupt stop.
		const lastV = v[seg.b]!;
		let land = -1;
		let how = '';
		if (flip >= 0) {
			land = flip;
			how = 'overshoot';
			// Several reversals = a bounce.
			let flips = 0;
			let sign = Math.sign(signed(flip + 1));
			for (let k = flip + 2; k <= seg.b; k++) {
				const sgn = Math.sign(signed(k));
				if (sgn !== 0 && sgn !== sign) {
					flips++;
					sign = sgn;
				}
			}
			if (flips >= 1) how = 'bounce';
		} else if (lastV >= ABRUPT_STOP * peakV) {
			land = seg.b;
			how = 'abrupt stop';
		}
		if (land < 0) continue;
		const ls = at(land);
		let incoming = 0;
		for (let k = Math.max(seg.a, land - Math.round(0.2 * ctx.fps)); k <= land; k++)
			incoming = Math.max(incoming, v[k]!);
		const energy = Math.sqrt(ls.area) * incoming;
		let types: SoundTypeId[];
		let weight: SoundWeight = 'support';
		if (energy >= 0.5) {
			types = ['hit', 'thump', 'tap'];
			if (ls.area >= 0.2) weight = 'hero';
		} else if (energy >= 0.15) types = ['thump', 'hit', 'tap'];
		else types = ['tap', 'thump', 'pop'];
		const ease =
			how === 'abrupt stop' ? 'stops' : `ends (${how === 'overshoot' ? 'ease-out overshoot' : how})`;
		cues.push(
			candidate('keyframes', {
				key: key('land', land),
				frame: frameOf(land),
				kind: 'land',
				weight,
				types,
				align: 'peak',
				pan: panOfX(ctx, ls.cx),
				anchor: anchor(dom, land, 'settle'),
				confidence: how === 'abrupt stop' ? 0.7 : 0.75,
				reason: `${describeChange(ctx, dom, before, ls)} ${ease} ${where}`,
				size: Math.max(ls.area, 0.02),
			}),
		);
	}
	opacityRamps(ctx, c, samples, i0, cues, (k, ev) => anchor('opacity', k, ev), where);
}

function describeChange(ctx: CueContext, dom: Dominant, a: Sample, b: Sample): string {
	switch (dom) {
		case 'scale':
			return `Scale ${Math.round(Math.exp(a.lnS) * 100)}→${Math.round(Math.exp(b.lnS) * 100)} %`;
		case 'rotation':
			return `Rotation ${Math.round(a.rot)}→${Math.round(b.rot)}°`;
		case 'positionZ':
			return `Z position ${Math.round(a.z)}→${Math.round(b.z)} px`;
		default: {
			const d = Math.round(Math.hypot(b.x - a.x, b.y - a.y));
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const dir = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : dy >= 0 ? 'down' : 'up';
			void ctx;
			return `Position moves ${d} px ${dir}`;
		}
	}
}

/** Opacity ramps from ≤ 5 % to ≥ 50 % (appear, at the first frame reaching 95 % of the ramp's top) and back (exit). */
function opacityRamps(
	ctx: CueContext,
	c: Clip,
	samples: Sample[],
	i0: number,
	cues: CueCandidate[],
	anchor: (k: number, ev: 'start' | 'end') => DerivedCueAnchor,
	where: string,
): void {
	if (!isAnimated((c as { opacity?: Animatable<number> }).opacity)) return;
	// samples[k] = local frame i0 − 1 + k
	const frameOf = (k: number) => c.start + i0 - 1 + k;
	const n = samples.length;
	let k = 1;
	while (k < n) {
		const prev = samples[k - 1]!.op;
		const cur = samples[k]!.op;
		if (prev <= 0.05 && cur > prev + 1e-4) {
			const a = k - 1;
			while (k < n && samples[k]!.op > samples[k - 1]!.op + 1e-4) k++;
			const e = k - 1;
			const top = samples[e]!.op;
			if (top >= 0.5) {
				let m = a;
				while (m < e && samples[m]!.op < 0.95 * top) m++;
				const short = m - a <= 0.25 * ctx.fps;
				cues.push(
					candidate('keyframes', {
						key: `keyframes:${c.id}:fade-in:${frameOf(m)}`,
						frame: frameOf(m),
						kind: 'appear',
						weight: 'support',
						types: short ? ['pop', 'ui', 'swish'] : ['shimmer', 'reverse', 'whoosh'],
						align: short ? 'peak' : 'end',
						pan: panOfX(ctx, samples[m]!.cx),
						anchor: anchor(m - 1, 'end'),
						confidence: short ? 0.55 : 0.45,
						reason: `Opacity ${Math.round(samples[a]!.op * 100)}→${Math.round(top * 100)} % fades in (${secs(ctx, m - a)}) ${where}`,
						window: { start: frameOf(a + 1), end: frameOf(m) + 1 },
						size: Math.max(samples[m]!.area, 0.02),
					}),
				);
			}
			continue;
		}
		if (prev >= 0.5 && cur < prev - 1e-4) {
			const a = k - 1;
			while (k < n && samples[k]!.op < samples[k - 1]!.op - 1e-4) k++;
			const e = k - 1;
			if (samples[e]!.op <= 0.05) {
				cues.push(
					candidate('keyframes', {
						key: `keyframes:${c.id}:fade-out:${frameOf(a + 1)}`,
						frame: frameOf(a + 1),
						kind: 'exit',
						weight: 'ambient',
						types: ['swish', 'whoosh', 'reverse'],
						align: 'peak',
						pan: panOfX(ctx, samples[a]!.cx),
						anchor: anchor(a, 'start'),
						confidence: 0.4,
						reason: `Opacity ${Math.round(prev * 100)}→${Math.round(samples[e]!.op * 100)} % fades out (${secs(ctx, e - a)}) ${where}`,
						window: { start: frameOf(a + 1), end: frameOf(e) + 1 },
						size: Math.max(samples[a]!.area, 0.02),
					}),
				);
			}
			continue;
		}
		k++;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// 3D cameras

function cameraAnimated(c: CameraClip): { name: string; anim: Animatable<unknown> }[] {
	const tr = c.camera?.transform;
	const out: { name: string; anim: Animatable<unknown> }[] = [];
	const push = (name: string, a: unknown) => {
		if (
			a &&
			typeof a === 'object' &&
			Array.isArray((a as Animatable<unknown>).keyframes) &&
			isAnimated(a as Animatable<unknown>)
		)
			out.push({ name, anim: a as Animatable<unknown> });
	};
	if (tr) {
		push('position', tr.position);
		push('pointOfInterest', tr.pointOfInterest);
		push('orientation', tr.orientation);
		push('rotationX', tr.rotationX);
		push('rotationY', tr.rotationY);
		push('rotationZ', tr.rotationZ);
	}
	push('zoom', c.camera?.zoom);
	return out;
}

/** Camera moves of the active 3D camera (the topmost enabled camera clip covering the frame): `move` at peak speed. */
export function deriveCameraCues(ctx: CueContext, opts: { curves: CueSpeedCurve[] }): CueCandidate[] {
	const cams: { c: CameraClip; index: number }[] = [];
	const shown = new Map(ctx.videoTracks.map((v) => [v.track.id, v.index]));
	for (const c of sortedClips(ctx)) {
		const index = shown.get(c.trackId);
		if (index !== undefined && c.kind === 'camera' && c.enabled !== false && c.camera?.transform)
			cams.push({ c: c as CameraClip, index });
	}
	const activeAt = (f: number): CameraClip | null => {
		let best: { c: CameraClip; index: number } | null = null;
		for (const x of cams) if (f >= x.c.start && f < clipEnd(x.c) && (!best || x.index > best.index)) best = x;
		return best?.c ?? null;
	};
	const cues: CueCandidate[] = [];
	for (const { c } of cams) {
		if (!inRange(ctx, c)) continue;
		const props = cameraAnimated(c);
		if (!props.length) continue;
		let [i0, i1] = clampToRange(ctx, c, localSpan(ctx, c, keySpan(props)));
		if (i1 - i0 > MAX_SAMPLES_PER_CLIP) {
			ctx.warn({
				code: 'W_SAMPLING_TRUNCATED',
				message: `Camera ${clipName(c)} sampled over its first ${MAX_SAMPLES_PER_CLIP} frames only`,
				source: 'camera3d',
				clipId: c.id,
			});
			i1 = i0 + MAX_SAMPLES_PER_CLIP;
		}
		if (i1 - i0 < 2) continue;
		const hold = (c as { frameHold?: { flicks: number; holdFilters?: boolean } }).frameHold;
		const timeAt = (f: number) => (hold?.holdFilters ? hold.flicks : contentTimeAt(c, f, ctx.rate));
		const sampleAt = (i: number) => {
			const t = timeAt(c.start + i);
			const r = rigFrameAt(c.camera.transform, t);
			const zoom = Math.max(1e-3, num(c.camera.zoom, t, 1));
			return { eye: r.eye, fwd: r.fwd, lnZ: Math.log(zoom) };
		};
		const n = i1 - i0;
		const s = Array.from({ length: n + 1 }, (_, k) => sampleAt(i0 - 1 + k));
		const v = new Float32Array(n);
		const parts = new Float64Array(n * 3);
		for (let k = 0; k < n; k++) {
			if (activeAt(c.start + i0 + k) !== c) continue;
			const p = s[k]!;
			const q = s[k + 1]!;
			const move = Math.hypot(q.eye[0] - p.eye[0], q.eye[1] - p.eye[1], q.eye[2] - p.eye[2]) / ctx.diag;
			const dot = p.fwd[0] * q.fwd[0] + p.fwd[1] * q.fwd[1] + p.fwd[2] * q.fwd[2];
			const turn = (K_ROT * (Math.acos(Math.min(1, Math.max(-1, dot))) * 180)) / Math.PI;
			const zoom = K_SCALE * Math.abs(q.lnZ - p.lnZ);
			const sp = (fin(move) + fin(turn) + fin(zoom)) * ctx.fps;
			v[k] = Math.min(1e6, sp);
			parts[k * 3] = fin(move);
			parts[k * 3 + 1] = fin(turn);
			parts[k * 3 + 2] = fin(zoom);
		}
		opts.curves.push({ clipId: c.id, start: c.start + i0, speed: v });
		const bridge = Math.max(2, Math.round(0.1 * ctx.fps));
		for (const seg of speedSegments(v, bridge)) {
			let tot = [0, 0, 0];
			for (let k = seg.a; k <= seg.b; k++) tot = tot.map((x, j) => x + parts[k * 3 + j]!);
			const which = tot.indexOf(Math.max(...tot));
			const property =
				which === 0
					? 'position'
					: which === 2
						? 'zoom'
						: (props.find((p) => p.name !== 'position' && p.name !== 'zoom')?.name ?? 'orientation');
			const frame = c.start + i0 + seg.peak;
			const t = timeAt(frame);
			const kf = nearestKeyframeId(props.find((p) => p.name === property)?.anim, t);
			const lenFrames = seg.b - seg.a + 1;
			const long = lenFrames >= 0.3 * ctx.fps;
			const peakV = v[seg.peak]!;
			const verb = which === 0 ? 'moves' : which === 2 ? 'zooms' : 'turns';
			cues.push(
				candidate('camera3d', {
					key: `camera3d:${c.id}:move:${frame}`,
					frame,
					kind: 'move',
					weight: 'support',
					types: long ? ['whoosh', 'swish', 'transition'] : ['swish', 'whoosh'],
					align: 'peak',
					anchor: {
						type: 'keyframe',
						clipId: c.id,
						property,
						...(kf ? { keyframeId: kf } : {}),
						event: 'peak-speed',
					},
					confidence: 0.4 + 0.4 * Math.min(1, peakV),
					reason: `3D camera ${clipName(c)} ${verb} (peak ${peakV.toFixed(2)} screens/s, ${secs(ctx, lenFrames)}) on ${label(ctx, c.trackId)}`,
					window: { start: c.start + i0 + seg.a, end: c.start + i0 + seg.b + 1 },
					size: 1,
				}),
			);
		}
	}
	return cues;
}
