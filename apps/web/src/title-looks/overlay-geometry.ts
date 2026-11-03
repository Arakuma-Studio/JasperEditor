// Spec 19 TL-092: where a look layer's outline and handles sit, and what dragging them means. Pure: everything is in
// sequence pixels; distances in a look are percent of its unit (TL-012), and a layer's own axes turn with the clip, so a
// handle stays on the picture it edits whatever the clip's transform.
import type { Vec2 } from '@jasper/project';

export type Quad = readonly [Vec2, Vec2, Vec2, Vec2];

/** A layer's place on the canvas. */
export type LookFrame = {
	center: Vec2;
	/** Unit vectors of the layer's +x and +y. */
	u: Vec2;
	v: Vec2;
	halfW: number;
	halfH: number;
	/** Sequence px per 1 % of the look's unit. */
	perPercent: number;
};

const add = (a: Vec2, b: Vec2, k = 1): Vec2 => [a[0] + b[0] * k, a[1] + b[1] * k];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const len = (a: Vec2) => Math.hypot(a[0], a[1]);
const unit = (a: Vec2, fallback: Vec2): Vec2 => {
	const l = len(a);
	return l > 1e-6 ? [a[0] / l, a[1] / l] : fallback;
};
const DEG = Math.PI / 180;

/** The frame of a layer from its quad (TL, TR, BR, BL). `unitPx`: the unit in layer px; null = the shorter side of the box. */
export function lookFrame(
	quad: Quad,
	box: { width: number; height: number },
	unitPx: number | null,
): LookFrame {
	const [tl, tr, br, bl] = quad;
	const top = sub(tr, tl);
	const left = sub(bl, tl);
	const w = len(top);
	const h = len(left);
	const scale = box.width > 0 ? w / box.width : 1;
	return {
		center: [(tl[0] + tr[0] + br[0] + bl[0]) / 4, (tl[1] + tr[1] + br[1] + bl[1]) / 4],
		u: unit(top, [1, 0]),
		v: unit(left, [0, 1]),
		halfW: w / 2,
		halfH: h / 2,
		perPercent: (unitPx ?? Math.min(box.width, box.height)) * 0.01 * scale,
	};
}

export type Sides = { left: number; top: number; right: number; bottom: number };

/** The frame grown by a reach, percent of the unit per side. */
export function outlineQuad(f: LookFrame, reach: Sides): Quad {
	const k = f.perPercent;
	const at = (x: number, y: number) => add(add(f.center, f.u, x), f.v, y);
	const l = -f.halfW - reach.left * k;
	const r = f.halfW + reach.right * k;
	const t = -f.halfH - reach.top * k;
	const b = f.halfH + reach.bottom * k;
	return [at(l, t), at(r, t), at(r, b), at(l, b)];
}

/** A screen direction at `deg`, 0° = the layer's +x, clockwise. */
export function direction(f: LookFrame, deg: number): Vec2 {
	const a = deg * DEG;
	return add(add([0, 0], f.u, Math.cos(a)), f.v, Math.sin(a));
}

function angleOf(f: LookFrame, p: Vec2): number {
	const d = sub(p, f.center);
	return Math.atan2(dot(d, f.v), dot(d, f.u)) / DEG;
}

export type Handle =
	/** A length measured outward from `anchor` along `dir`. */
	| { kind: 'distance'; param: string; anchor: Vec2; dir: Vec2; start: number; value: number }
	/** Angle and length together. The length starts at the edge of the box, so small offsets stay reachable. */
	| { kind: 'offset'; angleParam: string; distanceParam: string; angle: number; distance: number }
	/** The same length along a fixed direction (a shadow following the light). */
	| { kind: 'axis'; param: string; dir: Vec2; value: number }
	/** A direction, on a ring. `base` is added to the value for where it points. */
	| { kind: 'angle'; param: string; base: number; value: number; radius: number }
	/** A place along the shape, 0…100 %. */
	| { kind: 'position'; param: string; dir: Vec2; extent: number; value: number };

/** Where a handle sits. */
export function handlePoint(f: LookFrame, h: Handle): Vec2 {
	switch (h.kind) {
		case 'distance':
			return add(h.anchor, h.dir, (h.start + h.value) * f.perPercent);
		case 'offset': {
			const d = direction(f, h.angle);
			return add(f.center, d, extentAlong(f, d) + h.distance * f.perPercent);
		}
		case 'axis':
			return add(f.center, h.dir, extentAlong(f, h.dir) + h.value * f.perPercent);
		case 'angle':
			return add(f.center, direction(f, h.base + h.value), h.radius);
		case 'position':
			return add(f.center, h.dir, (h.value * 0.02 - 1) * h.extent);
	}
}

const round = (x: number, q: number) => Math.round(x / q) * q;

/** What dragging a handle to `p` sets: param → value, rounded to what the eye can place. */
export function handleValues(f: LookFrame, h: Handle, p: Vec2): Record<string, number> {
	const k = Math.max(1e-6, f.perPercent);
	switch (h.kind) {
		case 'distance':
			return { [h.param]: round(Math.max(0, dot(sub(p, h.anchor), h.dir) / k - h.start), 0.1) };
		case 'offset': {
			const angle = (angleOf(f, p) + 360) % 360;
			const edge = extentAlong(f, direction(f, angle));
			return {
				[h.angleParam]: round(angle, 0.1),
				[h.distanceParam]: round(Math.max(0, len(sub(p, f.center)) - edge) / k, 0.1),
			};
		}
		case 'axis':
			return { [h.param]: round(Math.max(0, dot(sub(p, f.center), h.dir) - extentAlong(f, h.dir)) / k, 0.1) };
		case 'angle':
			return { [h.param]: round(angleOf(f, p) - h.base, 0.1) };
		case 'position':
			return { [h.param]: round((dot(sub(p, f.center), h.dir) / Math.max(1e-6, h.extent) + 1) * 50, 0.1) };
	}
}

/** Half the extent of the frame along a direction (the renderer's `ext` for bands across the shape). */
export function extentAlong(f: LookFrame, dir: Vec2): number {
	return Math.abs(dot(dir, f.u)) * f.halfW + Math.abs(dot(dir, f.v)) * f.halfH;
}

/** Edge midpoints for distance handles, one per handle, right edge first. */
export function edgeAnchor(f: LookFrame, index: number): { anchor: Vec2; dir: Vec2 } {
	const edges: [Vec2, number][] = [
		[f.u, f.halfW],
		[f.v, f.halfH],
		[[-f.u[0], -f.u[1]], f.halfW],
		[[-f.v[0], -f.v[1]], f.halfH],
	];
	const [dir, half] = edges[index % edges.length]!;
	return { anchor: add(f.center, dir, half), dir };
}
