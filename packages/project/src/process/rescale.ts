// Motion compensation for a source swap between media versions of different pixel size (S07:PRC-006).
//
// The layer map is M(q) = P + R·S·(q − A) (render/transform.ts) with q in layer (media) pixels. A new source of
// size (W', H') shows the same picture as the old one of size (W, H) at q' = D·q, D = diag(W'/W, H'/H). Keeping
// the rendered framing identical requires M'(D·q) = M(q) for every q, i.e. S' = S·D⁻¹ and A' = D·A:
//   - horizontal scale ×= W/W', vertical scale ×= H/H' ("Scale" is vertical, "Scale Width" horizontal);
//   - anchor ×= (W'/W, H'/H); position, rotation, flips and opacity are unchanged;
//   - crop is in percent of the layer box and the corner pin is normalised to it: both unchanged;
//   - tracker geometry (S09) is in media pixels: scaled like the anchor.
// Every keyframe value is compensated like the static value. Keyframe interpolation is linear in the values
// (same progress for every component), except `auto-bezier` on vectors, whose slope uses Euclidean distances:
// under an anisotropic change those anchor keyframes are frozen to `bezier` with the eases they had, so the
// motion stays identical.
//
// Uniform Scale on + anisotropic size change (e.g. 848×480 → 1920×1080): a single scale cannot express it, so the
// clip switches to non-uniform scale with Scale Width derived from Scale. The opposite anisotropic swap turns
// Uniform Scale back on when Scale Width equals Scale again, so going to a processed version and back restores
// the transform (up to floating-point rounding).
import { mediaDisplaySize } from '../interpret/model.ts';
import { autoSlope } from '../keyframes.ts';
import type { Animatable, Keyframe, Vec2 } from '../schema/common.ts';
import type { MediaAsset } from '../schema/media.ts';
import type { ClipTracker, Transform } from '../schema/sequence.ts';
import { scaleTracker } from '../tracking/samples.ts';

export type PixelSize = { width: number; height: number };

/** Anything with a Motion transform and optional trackers (video clips; also stills). */
export type RescalableClip = { transform: Transform; trackers?: ClipTracker[] };

export type RescaleOptions = {
	/**
	 * New keyframe ids (`kf_…`) — needed only when Uniform Scale has to be switched off and Scale Width takes a
	 * copy of Scale's keyframes. Without it that case throws.
	 */
	newKeyframeId?: () => string;
};

/** Relative tolerance under which Scale Width is considered equal to Scale (re-enabling Uniform Scale). */
const SAME_SCALE_TOLERANCE = 1e-9;
const AUTO_INFLUENCE = 1 / 3;

/** Layer box of a media asset: its first video stream, with width/height swapped for 90°/270° rotation. */
export function mediaIntrinsicSize(
	asset:
		| (Pick<MediaAsset, 'probe'> & Partial<Pick<MediaAsset, 'kind' | 'interpretation'>>)
		| undefined
		| null,
): PixelSize | null {
	if (!asset) return null;
	// imports: the display size (rotation, then the — possibly conformed — pixel aspect ratio).
	return mediaDisplaySize({
		kind: asset.kind ?? 'video',
		probe: asset.probe,
		interpretation: asset.interpretation,
	});
}

function assertSize(s: PixelSize, name: string): void {
	if (!(s.width > 0 && s.height > 0 && Number.isFinite(s.width) && Number.isFinite(s.height)))
		throw new Error(`rescaleClipForSource: invalid ${name} ${s.width}x${s.height}`);
}

/** Maps values with a linear per-axis map `f`; spatial tangents (offsets, S03:KF-030) are mapped the same way. */
function mapAnim<T>(a: Animatable<T>, f: (v: T) => T): Animatable<T> {
	return {
		...a,
		value: f(a.value),
		keyframes: a.keyframes.map((k) => ({
			...k,
			value: f(k.value),
			...(k.spatial
				? {
						spatial: {
							...k.spatial,
							inTangent: f(k.spatial.inTangent as T) as Vec2,
							outTangent: f(k.spatial.outTangent as T) as Vec2,
						},
					}
				: {}),
		})),
	};
}

/** `auto-bezier` keyframes of a vector property → `bezier` with the eases auto-bezier computed. */
function freezeAutoBezier(a: Animatable<Vec2>): Animatable<Vec2> {
	if (!a.keyframes.some((k) => k.interpolation === 'auto-bezier')) return a;
	const kfs = a.keyframes;
	return {
		...a,
		keyframes: kfs.map((k, i): Keyframe<Vec2> => {
			if (k.interpolation !== 'auto-bezier') return k;
			return {
				...k,
				interpolation: 'bezier',
				// keyframe-sides: an explicit Auto Bezier incoming side freezes with it.
				...(k.inInterpolation === 'auto-bezier' ? { inInterpolation: 'bezier' as const } : {}),
				easeIn: { influence: AUTO_INFLUENCE, slope: autoSlope(kfs, i, 'in') },
				easeOut: { influence: AUTO_INFLUENCE, slope: autoSlope(kfs, i, 'out') },
			};
		}),
	};
}

function nearlyEqual(a: number, b: number): boolean {
	return Math.abs(a - b) <= SAME_SCALE_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Same keyframe structure (times, interpolation, eases) and values equal within tolerance. */
function sameAnimNumber(a: Animatable<number>, b: Animatable<number>): boolean {
	if (!nearlyEqual(a.value, b.value) || a.keyframes.length !== b.keyframes.length) return false;
	return a.keyframes.every((k, i) => {
		const o = b.keyframes[i]!;
		return (
			k.time === o.time &&
			k.interpolation === o.interpolation &&
			k.inInterpolation === o.inInterpolation &&
			nearlyEqual(k.value, o.value) &&
			k.easeIn.influence === o.easeIn.influence &&
			k.easeIn.slope === o.easeIn.slope &&
			k.easeOut.influence === o.easeOut.influence &&
			k.easeOut.slope === o.easeOut.slope
		);
	});
}

/** Scale Width becomes a copy of Scale (fresh keyframe ids unless the keyframe structure already matches). */
function scaleWidthFromScale(t: Transform, opts: RescaleOptions | undefined): Animatable<number> {
	const s = t.scale;
	const w = t.scaleWidth;
	const sameShape =
		w.keyframes.length === s.keyframes.length && w.keyframes.every((k, i) => k.time === s.keyframes[i]!.time);
	if (sameShape) {
		return { ...w, value: s.value, keyframes: s.keyframes.map((k, i) => ({ ...k, id: w.keyframes[i]!.id })) };
	}
	if (s.keyframes.length > 0 && !opts?.newKeyframeId)
		throw new Error('rescaleClipForSource: newKeyframeId is required to split animated Uniform Scale');
	return { ...w, value: s.value, keyframes: s.keyframes.map((k) => ({ ...k, id: opts!.newKeyframeId!() })) };
}

function rescaleTransform(
	t: Transform,
	oldSize: PixelSize,
	newSize: PixelSize,
	opts?: RescaleOptions,
): Transform {
	const isotropic = oldSize.width * newSize.height === oldSize.height * newSize.width;
	// Per-axis factors; for 2×/4× versions they are powers of two, so a swap and its inverse are bit-exact.
	const kx = oldSize.width / newSize.width;
	const ky = oldSize.height / newSize.height;
	const sx = (v: number) => v * kx;
	const sy = (v: number) => v * ky;

	let anchor = t.anchor;
	if (!isotropic) anchor = freezeAutoBezier(anchor);
	anchor = mapAnim(anchor, (v): Vec2 => [v[0] / kx, v[1] / ky]);

	let uniformScale = t.uniformScale;
	let scale: Animatable<number>;
	let scaleWidth: Animatable<number>;
	if (uniformScale && isotropic) {
		// One factor for both axes; Scale Width (ignored while uniform) follows so that it stays consistent.
		scale = mapAnim(t.scale, sx);
		scaleWidth = mapAnim(t.scaleWidth, sx);
	} else if (uniformScale) {
		uniformScale = false;
		scale = mapAnim(t.scale, sy);
		scaleWidth = mapAnim(scaleWidthFromScale(t, opts), sx);
	} else {
		scale = mapAnim(t.scale, sy);
		scaleWidth = mapAnim(t.scaleWidth, sx);
		// The inverse of the split above: back on uniform when both axes agree again.
		if (!isotropic && sameAnimNumber(scale, scaleWidth)) uniformScale = true;
	}
	return { ...t, anchor, scale, scaleWidth, uniformScale };
}

/**
 * Motion compensation for swapping a clip's source from a media of `oldSize` to one of `newSize` (layer boxes,
 * see `mediaIntrinsicSize`) so that the rendered framing is identical (S07:PRC-006). Pure: returns a new clip
 * (deep copy); `transform` and `trackers` are the only fields that change. Same size → an unchanged copy.
 */
export function rescaleClipForSource<C extends RescalableClip>(
	clip: C,
	oldSize: PixelSize,
	newSize: PixelSize,
	opts?: RescaleOptions,
): C {
	assertSize(oldSize, 'oldSize');
	assertSize(newSize, 'newSize');
	const out = JSON.parse(JSON.stringify(clip)) as C;
	if (oldSize.width === newSize.width && oldSize.height === newSize.height) return out;
	out.transform = rescaleTransform(out.transform, oldSize, newSize, opts);
	if (out.trackers)
		out.trackers = out.trackers.map((tr) =>
			scaleTracker(tr, newSize.width / oldSize.width, newSize.height / oldSize.height),
		);
	return out;
}
