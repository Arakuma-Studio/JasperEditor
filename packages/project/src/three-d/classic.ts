// three-d: the Classic 3D renderer of a 3D run — preparation (shared by the GL renderer of the compositions) and the
// CPU reference composite (the oracle of the GL tests). Port of EffectCraft `render/three_d/compose.rs` and
// `light.rs` (MIT OR Apache-2.0; licenses/ported/three-d.md).
//
// Each 3D layer is a textured plane: its finished picture (source, masks, effects; depth-of-field blurred) mapped
// through projection · world. Per output pixel every plane covering it is inverse-mapped through its homography
// (exact perspective-correct texture coordinates, bilinear sampling), its camera depth taken from the plane equation
// and the fragment shaded by the lights (Blinn-Phong, lit from both sides, ray-cast shadows against the casting
// planes). The pixel's fragments are sorted far → near (coplanar fragments keep stack order) and blended over the
// composite below with each layer's blend mode and opacity: intersecting layers are exact, and blend modes and
// transparency compose in depth order, as After Effects' Classic 3D renderer.
import { blendPixel, dissolveNoise, type Rgba } from '../blend-modes.ts';
import { invertMat3, type Mat3, multiplyMat3 } from '../render/homography.ts';
import type { Vec3 } from '../schema/common.ts';
import {
	blurLevels,
	boostHighlights,
	dofPad,
	type FloatImage,
	newFloatImage,
	progressiveBlur,
} from './bokeh.ts';
import {
	cross3,
	dot3,
	len3,
	type Matrix4,
	mat4Apply,
	mat4ApplyVec,
	mat4Invert,
	mat4Mul,
	norm3,
	planeToMat3,
	scale3,
} from './math.ts';
import { NEAR_PLANE } from './model.ts';
import {
	type CameraState,
	cameraProjection,
	circleOfConfusion,
	type Dof,
	type LightState,
	lightAttenuation,
	type MaterialState,
	shininessExponent,
	toLight,
	toViewer,
} from './scene.ts';

/** What the renderer is given per plane. */
export type PlaneSource = {
	key: string;
	/** Picture size (pixels). */
	width: number;
	height: number;
	/** Layer pixels → picture pixels (affine, row-major). */
	layerToPicture: Mat3;
	/** Layer → world. */
	world: Matrix4;
	material: MaterialState;
	/** 0…1. */
	opacity: number;
	mode: string;
	/** Dissolve seed. */
	seed: number;
	/** Stack order (coplanar fragments draw lower orders first). */
	order: number;
	/** Drawn (false: only casts shadows, "Casts Shadows: Only"). */
	draw: boolean;
};

/** A plane prepared for one output. */
export type ClassicPlane = PlaneSource & {
	/** Output pixel → homogeneous layer coordinates. */
	hinv: Mat3;
	/** Camera depth = d0·u + d1·v + d2. */
	depth: [number, number, number];
	/** Unit world normal. */
	normal: Vec3;
	winv: Matrix4;
	/** Layer-space rectangle the picture covers [u0, v0, u1, v1]. */
	bounds: [number, number, number, number];
	/** Output pixel bounds [x0, y0, x1, y1). */
	bbox: [number, number, number, number];
	/**
	 * Depth of field to apply to the picture before drawing: pad it by `pad` transparent pixels (then picture px are
	 * offset by `pad`), boost highlights, blur each pixel by `radiusAt` (picture pixels of the padded buffer).
	 */
	dof: {
		pad: number;
		radius: (x: number, y: number) => number;
		/** Camera depth at a picture pixel: z0 + zx·x + zy·y. */
		zPlane: [number, number, number];
		/** radius = coc(z) · z · k. */
		k: number;
		/** Whether the depths (of the corners) lie on both sides of the focus distance. */
		crossesFocus: (zs: number[]) => boolean;
	} | null;
};

export type ClassicSetup = {
	/** Output size (pixels). */
	width: number;
	height: number;
	/** Output pixels per frame pixel (preview resolution). */
	scale: number;
	/** The frame the camera looks through (sequence pixels). */
	frame: { width: number; height: number };
	camera: CameraState;
	lights: LightState[];
	/** Draft 3D: no lights, shadows or depth of field. */
	draft?: boolean;
};

/** Upper bound of a plane's blur radius (picture pixels): beyond it the blur is clamped. */
export const MAX_DOF_RADIUS = 192;

/** (x, y) through a projective 3×3 (row-major). */
export function applyProjective(m: Mat3, x: number, y: number): [number, number] {
	const w = m[6] * x + m[7] * y + m[8];
	const k = w === 0 ? 0 : 1 / w;
	return [(m[0] * x + m[1] * y + m[2]) * k, (m[3] * x + m[4] * y + m[5]) * k];
}

/** Picture pixels per layer pixel (of the linear part; corner pins: at the layer origin). */
export function pictureScale(m: Mat3): number {
	return Math.hypot(m[0], m[3]) / Math.max(1e-12, Math.abs(m[8])) || 1;
}

/** Layer-space bounding rectangle of a picture (the inverse map of its corners). */
export function pictureBounds(
	src: Pick<PlaneSource, 'width' | 'height' | 'layerToPicture'>,
): [number, number, number, number] {
	const inv = invertMat3(src.layerToPicture);
	if (!inv) return [0, 0, 0, 0];
	const pts = [
		applyProjective(inv, 0, 0),
		applyProjective(inv, src.width, 0),
		applyProjective(inv, src.width, src.height),
		applyProjective(inv, 0, src.height),
	];
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** The projection to output pixels (frame pixels × scale). */
export function outputProjection(s: Pick<ClassicSetup, 'camera' | 'frame' | 'scale'>): Matrix4 {
	const p = cameraProjection(s.camera, s.frame.width, s.frame.height);
	const k = s.scale;
	return [
		p[0]! * k,
		p[1]! * k,
		p[2]! * k,
		p[3]! * k,
		p[4]! * k,
		p[5]! * k,
		p[6]! * k,
		p[7]! * k,
		p[8]!,
		p[9]!,
		p[10]!,
		p[11]!,
		p[12]!,
		p[13]!,
		p[14]!,
		p[15]!,
	];
}

/**
 * Depth of field of a plane: the blur radius (picture pixels) at a picture pixel centre, from the camera depth there
 * (the circle of confusion over the on-screen size of one layer pixel). `zPlane`: depth = z0 + zx·x + zy·y.
 */
function dofOf(
	cam: CameraState,
	dof: Dof,
	world: Matrix4,
	layerToPicture: Mat3,
	pad: number,
): { zPlane: [number, number, number]; k: number; radius: (x: number, y: number) => number } {
	const inv = invertMat3(layerToPicture)!;
	const s = pictureScale(layerToPicture);
	const sx = len3(mat4ApplyVec(world, [1, 0, 0])) || 1e-9;
	const at = (x: number, y: number) => {
		const [u, v] = applyProjective(inv, x - pad, y - pad);
		return mat4Apply(cam.view, mat4Apply(world, [u, v, 0]))[2];
	};
	// Depth is affine in the picture pixel for an affine picture map (exact); a corner-pinned (projective) map is
	// linearised about the picture centre.
	const cx = layerToPicture[6] === 0 && layerToPicture[7] === 0 ? 0 : pad;
	const z0 = at(cx, cx);
	const zx = at(cx + 1, cx) - z0;
	const zy = at(cx, cx + 1) - z0;
	const zPlane: [number, number, number] = [z0 - zx * cx - zy * cx, zx, zy];
	// radius = coc(z) · ½ · z / (zoom · sx) · s
	const k = (0.5 * s) / (cam.zoom * sx);
	const radius = (x: number, y: number) => {
		const z = zPlane[0] + zPlane[1] * x + zPlane[2] * y;
		if (z <= NEAR_PLANE) return 0;
		return Math.min(MAX_DOF_RADIUS, circleOfConfusion(dof, z) * z * k);
	};
	return { zPlane, k, radius };
}

/** Largest blur radius over a w×h picture (radius is |affine| in the pixel: extremes at the corners). */
export function maxRadius(radius: (x: number, y: number) => number, w: number, h: number): number {
	return Math.max(radius(0.5, 0.5), radius(w - 0.5, 0.5), radius(0.5, h - 0.5), radius(w - 0.5, h - 0.5));
}

/** Prepares a plane for the output; null when it shows nothing (edge-on, behind the camera, off screen). */
export function prepareClassicPlane(setup: ClassicSetup, src: PlaneSource): ClassicPlane | null {
	if (src.width <= 0 || src.height <= 0) return null;
	const cam = setup.camera;
	let layerToPicture = src.layerToPicture;
	let width = src.width;
	let height = src.height;
	let dof: ClassicPlane['dof'] = null;
	if (cam.dof && !setup.draft) {
		const probe = dofOf(cam, cam.dof, src.world, layerToPicture, 0);
		const rmax = maxRadius(probe.radius, width, height);
		if (rmax > 0.3) {
			const pad = dofPad(cam.dof.iris, rmax);
			layerToPicture = multiplyMat3([1, 0, pad, 0, 1, pad, 0, 0, 1], layerToPicture);
			width += 2 * pad;
			height += 2 * pad;
			const d = dofOf(cam, cam.dof, src.world, src.layerToPicture, pad);
			const focus = cam.dof.focus;
			dof = {
				pad,
				radius: d.radius,
				zPlane: d.zPlane,
				k: d.k,
				crossesFocus: (zs) => zs.some((z) => z < focus) && zs.some((z) => z > focus),
			};
		}
	}
	const bounds = pictureBounds({ width, height, layerToPicture });
	const full = mat4Mul(outputProjection(setup), src.world);
	const h = planeToMat3(full);
	const col = (j: number) => Math.hypot(h[j]!, h[3 + j]!, h[6 + j]!);
	const det =
		h[0] * (h[4] * h[8] - h[5] * h[7]) -
		h[1] * (h[3] * h[8] - h[5] * h[6]) +
		h[2] * (h[3] * h[7] - h[4] * h[6]);
	if (!(Math.abs(det) > 1e-10 * col(0) * col(1) * col(2))) return null;
	const hinv = invertMat3(h);
	if (!hinv) return null;
	const cv = mat4Mul(cam.view, src.world);
	const depth: [number, number, number] = [cv[8]!, cv[9]!, cv[11]!];
	const n = norm3(cross3(mat4ApplyVec(src.world, [1, 0, 0]), mat4ApplyVec(src.world, [0, 1, 0])));
	if (len3(n) < 1e-12) return null;
	let x0 = Number.POSITIVE_INFINITY;
	let y0 = Number.POSITIVE_INFINITY;
	let x1 = Number.NEGATIVE_INFINITY;
	let y1 = Number.NEGATIVE_INFINITY;
	let behind = 0;
	for (const [u, v] of [
		[bounds[0], bounds[1]],
		[bounds[2], bounds[1]],
		[bounds[2], bounds[3]],
		[bounds[0], bounds[3]],
	] as const) {
		const z = depth[0] * u + depth[1] * v + depth[2];
		if (!cam.ortho && z < NEAR_PLANE) {
			behind++;
			continue;
		}
		const p = mat4Apply(full, [u, v, 0]);
		x0 = Math.min(x0, p[0]);
		y0 = Math.min(y0, p[1]);
		x1 = Math.max(x1, p[0]);
		y1 = Math.max(y1, p[1]);
	}
	if (behind === 4) return null;
	const W = setup.width;
	const H = setup.height;
	const bbox: [number, number, number, number] =
		behind > 0
			? [0, 0, W, H]
			: [
					Math.max(0, Math.floor(x0) - 2),
					Math.max(0, Math.floor(y0) - 2),
					Math.min(W, Math.ceil(x1) + 2),
					Math.min(H, Math.ceil(y1) + 2),
				];
	if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
		// Off screen: it may still cast a shadow into the frame.
		if (src.material.castsShadows === 0) return null;
		bbox[0] = bbox[1] = bbox[2] = bbox[3] = 0;
	}
	return {
		...src,
		width,
		height,
		layerToPicture,
		hinv,
		depth,
		normal: n,
		winv: mat4Invert(src.world) ?? src.world,
		bounds,
		bbox,
		dof,
	};
}

/** Inverse-maps an output pixel centre onto a plane: (u, v, camera depth) or null. */
export function unproject(
	p: ClassicPlane,
	ortho: boolean,
	sx: number,
	sy: number,
): [number, number, number] | null {
	const h = p.hinv;
	const qz = h[6] * sx + h[7] * sy + h[8];
	if ((!ortho && qz <= 0) || qz === 0) return null;
	const u = (h[0] * sx + h[1] * sy + h[2]) / qz;
	const v = (h[3] * sx + h[4] * sy + h[5]) / qz;
	const z = p.depth[0] * u + p.depth[1] * v + p.depth[2];
	if (!ortho && z < NEAR_PLANE) return null;
	return [u, v, z];
}

// ---------------------------------------------------------------- CPU reference

/** A plane with its (DOF-blurred, padded) picture as premultiplied floats. */
export type CpuPlane = ClassicPlane & { pixels: FloatImage };

/** Premultiplied bilinear sample at picture coordinates (pixel centres at +0.5); transparent outside. */
export function samplePicture(img: FloatImage, x: number, y: number): Rgba {
	const fx = x - 0.5;
	const fy = y - 0.5;
	const x0 = Math.floor(fx);
	const y0 = Math.floor(fy);
	const tx = fx - x0;
	const ty = fy - y0;
	const get = (xi: number, yi: number, c: number) =>
		xi < 0 || yi < 0 || xi >= img.width || yi >= img.height ? 0 : img.data[(yi * img.width + xi) * 4 + c]!;
	const out: Rgba = [0, 0, 0, 0];
	for (let c = 0; c < 4; c++) {
		const top = get(x0, y0, c) + (get(x0 + 1, y0, c) - get(x0, y0, c)) * tx;
		const bot = get(x0, y0 + 1, c) + (get(x0 + 1, y0 + 1, c) - get(x0, y0 + 1, c)) * tx;
		out[c] = top + (bot - top) * ty;
	}
	return out;
}

function texel(p: CpuPlane, u: number, v: number): Rgba {
	const [x, y] = applyProjective(p.layerToPicture, u, v);
	return samplePicture(p.pixels, x, y);
}

/**
 * The blur levels of a plane's depth of field (EffectCraft `blur_levels` over its radius map). The radius is |affine|
 * in the picture pixel, so its extremes over the pixel centres are at the corners — or 0 where the plane crosses the
 * focus distance. Shared by the CPU reference and the GL renderer (identical levels).
 */
export function dofLevels(p: Pick<ClassicPlane, 'dof' | 'width' | 'height'>): number[] | null {
	if (!p.dof) return null;
	const { radius, zPlane } = p.dof;
	const xs = [0.5, p.width - 0.5];
	const ys = [0.5, p.height - 0.5];
	const rs: number[] = [];
	const zs: number[] = [];
	for (const x of xs)
		for (const y of ys) {
			rs.push(radius(x, y));
			zs.push(zPlane[0] + zPlane[1] * x + zPlane[2] * y);
		}
	return blurLevels(rs.concat(p.dof.crossesFocus(zs) ? [0] : []));
}

/** Applies a plane's depth of field to its (unpadded) picture: the padded, blurred buffer. */
export function dofPicture(p: ClassicPlane, picture: FloatImage, dof: Dof): FloatImage {
	if (!p.dof) return picture;
	const pad = p.dof.pad;
	const padded = newFloatImage(p.width, p.height);
	for (let y = 0; y < picture.height; y++)
		padded.data.set(
			picture.data.subarray(y * picture.width * 4, (y + 1) * picture.width * 4),
			((y + pad) * p.width + pad) * 4,
		);
	boostHighlights(padded, dof.highlight);
	const radius = new Float32Array(p.width * p.height);
	for (let y = 0; y < p.height; y++)
		for (let x = 0; x < p.width; x++) radius[y * p.width + x] = p.dof.radius(x + 0.5, y + 0.5);
	return progressiveBlur(padded, dof.iris, radius, dofLevels(p));
}

/** RGB transmittance of light `l` reaching `p` past caster `c` (1 = unoccluded). */
export function occlusion(c: CpuPlane, p: Vec3, l: LightState): Vec3 {
	const FAR = 1e6;
	const a = mat4Apply(c.winv, p);
	const target: Vec3 =
		l.type === 'parallel' ? [p[0] - l.dir[0] * FAR, p[1] - l.dir[1] * FAR, p[2] - l.dir[2] * FAR] : l.pos;
	const b = mat4Apply(c.winv, target);
	if (a[2] === b[2] || Math.sign(a[2]) === Math.sign(b[2])) return [1, 1, 1];
	const t = a[2] / (a[2] - b[2]);
	if (t <= 1e-6 || t >= 1 - 1e-9) return [1, 1, 1];
	const hit = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
	const seg = len3([target[0] - p[0], target[1] - p[1], target[2] - p[2]]);
	const dPc = seg * t;
	const dCl = l.type === 'parallel' ? 1000 : Math.max(1, seg * (1 - t));
	const r = l.shadowDiffusion * Math.min(4, dPc / dCl);
	const bd = c.bounds;
	if (hit[0]! < bd[0] - r || hit[1]! < bd[1] - r || hit[0]! > bd[2] + r || hit[1]! > bd[3] + r)
		return [1, 1, 1];
	const s = pictureScale(c.layerToPicture);
	let px: Rgba = [0, 0, 0, 0];
	if (r * s < 0.5) px = texel(c, hit[0]!, hit[1]!);
	else
		for (let j = -1; j <= 1; j++)
			for (let i = -1; i <= 1; i++) {
				const q = texel(c, hit[0]! + i * r * 0.66, hit[1]! + j * r * 0.66);
				for (let k = 0; k < 4; k++) px[k] = px[k]! + q[k]! / 9;
			}
	const alpha = Math.min(1, Math.max(0, px[3] * c.opacity));
	if (alpha <= 0) return [1, 1, 1];
	const tr = c.material.lightTransmission;
	const out: Vec3 = [1, 1, 1];
	for (let k = 0; k < 3; k++) {
		const straight = px[3] > 0 ? Math.min(1, Math.max(0, px[k]! / px[3])) : 0;
		const pass = 1 - alpha + alpha * tr * straight;
		out[k] = 1 - l.shadowDarkness * (1 - pass);
	}
	return out;
}

/** Shades one premultiplied texel of plane `it` at layer (u, v). */
function shadeTexel(
	it: CpuPlane,
	cam: CameraState,
	u: number,
	v: number,
	t: Rgba,
	lights: LightState[],
	casters: CpuPlane[],
): Rgba {
	const m = it.material;
	if (lights.length === 0 || !m.acceptsLights) return m.acceptsShadows === 2 ? [0, 0, 0, 0] : t;
	const a = t[3];
	const rgb: Vec3 = [t[0] / a, t[1] / a, t[2] / a];
	const p = mat4Apply(it.world, [u, v, 0]);
	const view = toViewer(cam, p);
	const n = dot3(it.normal, view) < 0 ? scale3(it.normal, -1) : it.normal;
	const amb: Vec3 = [0, 0, 0];
	const diff: Vec3 = [0, 0, 0];
	const spec: Vec3 = [0, 0, 0];
	let shadowAmt = 0;
	const exp = shininessExponent(m);
	for (const l of lights) {
		if (l.type === 'ambient') {
			for (let c = 0; c < 3; c++) amb[c] = amb[c]! + l.color[c]!;
			continue;
		}
		const k = lightAttenuation(l, p);
		if (k <= 0) continue;
		const lv = toLight(l, p).v;
		const ndl = dot3(n, lv);
		const front = ndl > 0;
		const lambert = front ? ndl : -ndl * m.lightTransmission;
		if (lambert <= 0) continue;
		let sh: Vec3 = [1, 1, 1];
		if (l.castsShadows && m.acceptsShadows !== 0)
			for (const c of casters) {
				// A plane never shadows itself (nor the other planes of its layer: per-character planes share the order).
				if (c === it || c.order === it.order) continue;
				const o = occlusion(c, p, l);
				sh = [sh[0] * o[0], sh[1] * o[1], sh[2] * o[2]];
			}
		shadowAmt = Math.max(shadowAmt, 1 - (sh[0] + sh[1] + sh[2]) / 3);
		const kd = lambert * k;
		for (let c = 0; c < 3; c++) diff[c] = diff[c]! + l.color[c]! * kd * sh[c]!;
		if (front && m.specular > 0) {
			const hv = norm3([lv[0] + view[0], lv[1] + view[1], lv[2] + view[2]]);
			const s = Math.max(0, dot3(n, hv)) ** exp * k;
			for (let c = 0; c < 3; c++) {
				const tint = 1 + (rgb[c]! - 1) * m.metal;
				spec[c] = spec[c]! + l.color[c]! * s * sh[c]! * tint;
			}
		}
	}
	if (m.acceptsShadows === 2) return [0, 0, 0, a * shadowAmt];
	return [
		(rgb[0] * (m.ambient * amb[0] + m.diffuse * diff[0]) + m.specular * spec[0]) * a,
		(rgb[1] * (m.ambient * amb[1] + m.diffuse * diff[1]) + m.specular * spec[1]) * a,
		(rgb[2] * (m.ambient * amb[2] + m.diffuse * diff[2]) + m.specular * spec[2]) * a,
		a,
	];
}

/** a draws before b: farther, or coplanar and lower in the stack. */
export function drawsBefore(za: number, oa: number, zb: number, ob: number): boolean {
	const tol = 1e-5 * Math.max(Math.abs(za), Math.abs(zb), 1);
	if (Math.abs(za - zb) <= tol) return oa < ob;
	return za > zb;
}

/**
 * The CPU reference composite of a run over `canvas` (premultiplied floats, output size), in place. Planes in stack
 * order; casters = the planes that cast shadows (in the same order).
 */
export function compositeClassicCPU(canvas: FloatImage, setup: ClassicSetup, planes: CpuPlane[]): void {
	const lights = setup.draft ? [] : setup.lights;
	const casters = planes.filter((p) => p.material.castsShadows !== 0);
	const ortho = setup.camera.ortho;
	const W = canvas.width;
	for (let y = 0; y < canvas.height; y++)
		for (let x = 0; x < W; x++) {
			const frags: { z: number; order: number; px: Rgba; p: CpuPlane }[] = [];
			for (const p of planes) {
				if (!p.draw || x < p.bbox[0] || x >= p.bbox[2] || y < p.bbox[1] || y >= p.bbox[3]) continue;
				const q = unproject(p, ortho, x + 0.5, y + 0.5);
				if (!q) continue;
				const t = texel(p, q[0], q[1]);
				if (t[3] <= 1e-6) continue;
				const px = shadeTexel(p, setup.camera, q[0], q[1], t, lights, casters);
				if (!(px[3] > 0 || px[0] !== 0 || px[1] !== 0 || px[2] !== 0)) continue;
				const f = { z: q[2], order: p.order, px, p };
				let j = frags.length;
				frags.push(f);
				while (j > 0 && drawsBefore(f.z, f.order, frags[j - 1]!.z, frags[j - 1]!.order)) {
					frags[j] = frags[j - 1]!;
					j--;
				}
				frags[j] = f;
			}
			if (frags.length === 0) continue;
			const i = (y * W + x) * 4;
			let d: Rgba = [canvas.data[i]!, canvas.data[i + 1]!, canvas.data[i + 2]!, canvas.data[i + 3]!];
			for (const f of frags) {
				const op = f.p.opacity;
				const s: Rgba = [f.px[0] * op, f.px[1] * op, f.px[2] * op, f.px[3] * op];
				const noise = f.p.mode === 'dissolve' ? dissolveNoise(x, y, f.p.seed) : 0.5;
				d = blendPixel(f.p.mode, d, s, noise);
			}
			canvas.data.set(d, i);
		}
}

/** Prepares and renders a run on the CPU (pictures straight from `pictures`, unpadded; DOF applied here). */
export function renderClassicCPU(
	canvas: FloatImage,
	setup: ClassicSetup,
	sources: { src: PlaneSource; pixels: FloatImage }[],
): void {
	const planes: CpuPlane[] = [];
	for (const { src, pixels } of sources) {
		const p = prepareClassicPlane(setup, src);
		if (!p) continue;
		planes.push({
			...p,
			pixels: p.dof && setup.camera.dof ? dofPicture(p, pixels, setup.camera.dof) : pixels,
		});
	}
	compositeClassicCPU(canvas, setup, planes);
}
