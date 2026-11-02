// Spec 19 TL-110: Photoshop's Warp Text styles as Bézier patches. Photoshop bakes every style into a patch over the
// layer's box (cubic 4×2, 4×3 or 4×4, quadratic 3×3); these constructions are Patchy's, reverse-engineered from
// Photoshop's own captures, ported line for line from `src/core/warp_mesh.cpp` (MIT, Copyright (c) 2026 Seth A. Robinson,
// licenses/ported/patchy-warp.md). Content space: origin at the box's top-left, +y down, size `width` × `height`.
//
// Ours on top of the port:
// - `warpSurface`: the patch elevated to 4×4 in layer-normalised coordinates, re-centred on the box (Pachislop's rule, so
//   a title does not drift as its bend animates), and the map past the box: a straight continuation along the edge
//   tangent (C1), where a Bernstein polynomial would run away on the far side of a wide glow.
export const WARP_STYLES = [
	'arc',
	'arcLower',
	'arcUpper',
	'arch',
	'bulge',
	'shellLower',
	'shellUpper',
	'flag',
	'wave',
	'fish',
	'rise',
	'fisheye',
	'inflate',
	'squeeze',
	'twist',
] as const;
export type WarpStyle = (typeof WARP_STYLES)[number];
export const WARP_STYLE_LABELS: Record<WarpStyle, string> = {
	arc: 'Arc',
	arcLower: 'Arc Lower',
	arcUpper: 'Arc Upper',
	arch: 'Arch',
	bulge: 'Bulge',
	shellLower: 'Shell Lower',
	shellUpper: 'Shell Upper',
	flag: 'Flag',
	wave: 'Wave',
	fish: 'Fish',
	rise: 'Rise',
	fisheye: 'Fisheye',
	inflate: 'Inflate',
	squeeze: 'Squeeze',
	twist: 'Twist',
};

/** Control points, row-major: `uOrder` per row, `vOrder` rows. */
export type WarpMeshGrid = { uOrder: number; vOrder: number; xs: number[]; ys: number[] };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const ZERO_BEND = 1e-9;

export function identityWarpMesh(
	left: number,
	top: number,
	right: number,
	bottom: number,
	uOrder: number,
	vOrder: number,
): WarpMeshGrid {
	const mesh: WarpMeshGrid = { uOrder: clamp(uOrder, 2, 4), vOrder: clamp(vOrder, 2, 4), xs: [], ys: [] };
	for (let row = 0; row < mesh.vOrder; row++) {
		const fv = row / (mesh.vOrder - 1);
		for (let column = 0; column < mesh.uOrder; column++) {
			const fu = column / (mesh.uOrder - 1);
			mesh.xs.push(left + (right - left) * fu);
			mesh.ys.push(top + (bottom - top) * fv);
		}
	}
	return mesh;
}

/** Bernstein basis of degree `order - 1` at `t`. */
function bernstein(order: number, t: number): [number, number, number, number] {
	const s = 1 - t;
	if (order === 2) return [s, t, 0, 0];
	if (order === 3) return [s * s, 2 * s * t, t * t, 0];
	return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
}

export function evaluateWarpMesh(mesh: WarpMeshGrid, u: number, v: number): [number, number] {
	const wu = bernstein(mesh.uOrder, u);
	const wv = bernstein(mesh.vOrder, v);
	let x = 0;
	let y = 0;
	for (let row = 0; row < mesh.vOrder; row++)
		for (let column = 0; column < mesh.uOrder; column++) {
			const i = row * mesh.uOrder + column;
			const w = wu[column]! * wv[row]!;
			x += w * mesh.xs[i]!;
			y += w * mesh.ys[i]!;
		}
	return [x, y];
}

/** One exact Bézier degree elevation of a row of control points. */
function elevateRow(source: readonly number[], target: number[]): void {
	const count = source.length;
	target.push(source[0]!);
	for (let i = 1; i < count; i++) {
		const alpha = i / count;
		target.push(alpha * source[i - 1]! + (1 - alpha) * source[i]!);
	}
	target.push(source[count - 1]!);
}

function elevateU(mesh: WarpMeshGrid): WarpMeshGrid {
	const out: WarpMeshGrid = { uOrder: mesh.uOrder + 1, vOrder: mesh.vOrder, xs: [], ys: [] };
	for (let row = 0; row < mesh.vOrder; row++) {
		const a = row * mesh.uOrder;
		elevateRow(mesh.xs.slice(a, a + mesh.uOrder), out.xs);
		elevateRow(mesh.ys.slice(a, a + mesh.uOrder), out.ys);
	}
	return out;
}

function transposeMesh(mesh: WarpMeshGrid, swapAxes = false): WarpMeshGrid {
	const n = mesh.xs.length;
	const out: WarpMeshGrid = {
		uOrder: mesh.vOrder,
		vOrder: mesh.uOrder,
		xs: new Array<number>(n),
		ys: new Array<number>(n),
	};
	for (let row = 0; row < mesh.vOrder; row++)
		for (let column = 0; column < mesh.uOrder; column++) {
			const from = row * mesh.uOrder + column;
			const to = column * mesh.vOrder + row;
			out.xs[to] = swapAxes ? mesh.ys[from]! : mesh.xs[from]!;
			out.ys[to] = swapAxes ? mesh.xs[from]! : mesh.ys[from]!;
		}
	return out;
}

/** The same surface as a cubic 4×4 patch. */
export function elevateWarpMeshToCubic(mesh: WarpMeshGrid): WarpMeshGrid {
	let current = mesh;
	while (current.uOrder < 4) current = elevateU(current);
	while (current.vOrder < 4) current = transposeMesh(elevateU(transposeMesh(current)));
	return current;
}

/**
 * One row of the classic cubic circle arc: horizontal chord (ax,y)…(bx,y), central angle 2·theta, bulging toward −y
 * when `bulgeUp` (+y is down). Handle length (4/3)·tan(theta/2)·radius, tangents rotated by theta off the chord.
 */
function appendArcRow(m: WarpMeshGrid, ax: number, bx: number, y: number, theta: number, bulgeUp: boolean) {
	const sin = Math.sin(theta);
	const cos = Math.cos(theta);
	const radius = (bx - ax) / (2 * sin);
	const handle = (4 / 3) * Math.tan(theta / 2) * radius;
	const dy = bulgeUp ? -handle * sin : handle * sin;
	m.xs.push(ax, ax + handle * cos, bx - handle * cos, bx);
	m.ys.push(y, y + dy, y + dy, y);
}

function appendIdentityRow(m: WarpMeshGrid, width: number, y: number) {
	m.xs.push(0, width / 3, (2 * width) / 3, width);
	m.ys.push(y, y, y, y);
}

/** y → height − y, rows swapped: Photoshop's negative arc is exactly the positive arc flipped. */
function mirrorMeshVertically(mesh: WarpMeshGrid, height: number): WarpMeshGrid {
	const out: WarpMeshGrid = { uOrder: mesh.uOrder, vOrder: mesh.vOrder, xs: [], ys: [] };
	for (let row = 0; row < mesh.vOrder; row++) {
		const source = mesh.vOrder - 1 - row;
		for (let column = 0; column < mesh.uOrder; column++) {
			const from = source * mesh.uOrder + column;
			out.xs.push(mesh.xs[from]!);
			out.ys.push(height - mesh.ys[from]!);
		}
	}
	return out;
}

function horizontalStyleMesh(style: WarpStyle, value: number, width: number, height: number): WarpMeshGrid {
	const bend = clamp(value, -100, 100);
	const theta = (Math.abs(bend) * Math.PI) / 200;
	// Flag, wave and rise scale with the height.
	const displacement = (2 * height * bend) / 100;
	const m: WarpMeshGrid = { uOrder: 4, vOrder: style === 'wave' ? 3 : 2, xs: [], ys: [] };
	const flat = Math.abs(bend) < ZERO_BEND;
	switch (style) {
		case 'arcLower':
		case 'arcUpper':
			if (flat) return identityWarpMesh(0, 0, width, height, 4, 2);
			// One edge stays put; the other arcs away from the box for positive bend and into it for negative.
			appendIdentityRow(m, width, 0);
			appendArcRow(m, 0, width, height, theta, bend < 0);
			return style === 'arcUpper' ? mirrorMeshVertically(m, height) : m;
		case 'fish':
			// Flag's S on the top edge and the opposite S on the bottom edge pinch tail and head.
			appendIdentityRow(m, width, 0);
			appendIdentityRow(m, width, height);
			m.ys[1]! -= displacement;
			m.ys[2]! += displacement;
			m.ys[5]! += displacement;
			m.ys[6]! -= displacement;
			return m;
		case 'fisheye': {
			// The four interior points move toward their nearest corner by bend/50 (on the corners at 50).
			const f = identityWarpMesh(0, 0, width, height, 4, 4);
			const t = bend / 50;
			for (let row = 1; row <= 2; row++)
				for (let column = 1; column <= 2; column++) {
					const i = row * 4 + column;
					f.xs[i]! += t * ((column === 1 ? 0 : width) - f.xs[i]!);
					f.ys[i]! += t * ((row === 1 ? 0 : height) - f.ys[i]!);
				}
			return f;
		}
		case 'inflate':
		case 'squeeze': {
			// Quadratic 3×3: edge midpoints slide a quarter of the extent per 50 % bend. Inflate pushes all four out;
			// squeeze pushes top and bottom out and the sides in.
			const q = identityWarpMesh(0, 0, width, height, 3, 3);
			const dx = (width * bend) / 200;
			const dy = (height * bend) / 200;
			q.ys[1]! -= dy;
			q.ys[7]! += dy;
			q.xs[3]! += style === 'inflate' ? -dx : dx;
			q.xs[5]! += style === 'inflate' ? dx : -dx;
			return q;
		}
		case 'twist': {
			// The interior ring circulates by the full extent per 100 % bend, clockwise for positive.
			const t = identityWarpMesh(0, 0, width, height, 4, 4);
			const moveX = (width * Math.abs(bend)) / 100;
			const moveY = (height * Math.abs(bend)) / 100;
			if (bend > 0) {
				t.xs[5]! += moveX;
				t.ys[6]! += moveY;
				t.xs[10]! -= moveX;
				t.ys[9]! -= moveY;
			} else if (bend < 0) {
				t.ys[5]! += moveY;
				t.xs[6]! -= moveX;
				t.ys[10]! -= moveY;
				t.xs[9]! += moveX;
			}
			return t;
		}
		case 'shellLower':
		case 'shellUpper': {
			if (flat) return identityWarpMesh(0, 0, width, height, 4, 4);
			// Two rows stay; the third row's ends rotate by theta about the anchor corners; the shell edge fans out
			// (positive) or arcs into the box over its chord (negative).
			const sin = Math.sin(theta);
			const cos = Math.cos(theta);
			m.vOrder = 4;
			appendIdentityRow(m, width, 0);
			appendIdentityRow(m, width, height / 3);
			if (bend > 0) {
				const radius = (2 * height) / 3;
				m.xs.push(-radius * sin, width / 3, (2 * width) / 3, width + radius * sin);
				m.ys.push(radius * cos, (2 * height) / 3, (2 * height) / 3, radius * cos);
				appendArcRow(m, -height * sin, width + height * sin, height * cos, theta, false);
			} else {
				const radius = height / 3;
				m.xs.push(-radius * sin, width / 3, (2 * width) / 3, width + radius * sin);
				m.ys.push(height - radius * cos, (2 * height) / 3, (2 * height) / 3, height - radius * cos);
				appendArcRow(m, 0, width, height, theta, true);
			}
			return style === 'shellUpper' ? mirrorMeshVertically(m, height) : m;
		}
		case 'arc': {
			if (flat) return identityWarpMesh(0, 0, width, height, 4, 2);
			// Top corners swing out about the bottom corners; both edges arc with the same angle, so the band keeps
			// its thickness.
			const sin = Math.sin(theta);
			appendArcRow(m, -height * sin, width + height * sin, height * (1 - Math.cos(theta)), theta, true);
			appendArcRow(m, 0, width, height, theta, true);
			return bend < 0 ? mirrorMeshVertically(m, height) : m;
		}
		case 'arch':
		case 'bulge': {
			if (flat) return identityWarpMesh(0, 0, width, height, 4, 2);
			const topUp = bend > 0;
			appendArcRow(m, 0, width, 0, theta, topUp);
			// Arch: both edges bow the same way; bulge: the bottom bows the other way and the band inflates.
			appendArcRow(m, 0, width, height, theta, style === 'bulge' ? !topUp : topUp);
			return m;
		}
		case 'flag':
			appendIdentityRow(m, width, 0);
			appendIdentityRow(m, width, height);
			m.ys[1]! -= displacement;
			m.ys[2]! += displacement;
			m.ys[5]! -= displacement;
			m.ys[6]! += displacement;
			return m;
		case 'wave':
			// Edges stay pinned; only the middle row waves, opposite to flag's S.
			appendIdentityRow(m, width, 0);
			appendIdentityRow(m, width, height / 2);
			appendIdentityRow(m, width, height);
			m.ys[5]! += displacement;
			m.ys[6]! -= displacement;
			return m;
		default:
			// Rise: a rigid ramp of the columns.
			appendIdentityRow(m, width, 0);
			appendIdentityRow(m, width, height);
			m.ys[0]! += displacement;
			m.ys[1]! += displacement;
			m.ys[4]! += displacement;
			m.ys[5]! += displacement;
			return m;
	}
}

/**
 * The control mesh of a style at `bend` (−100…100) over a `width` × `height` box. `rotateVertical` is Photoshop's
 * Vertical orientation: the horizontal construction over swapped dimensions, axes swapped back. Twist is orientation
 * invariant, as Photoshop bakes it.
 */
export function styleWarpMesh(
	style: WarpStyle,
	bend: number,
	rotateVertical: boolean,
	width: number,
	height: number,
): WarpMeshGrid {
	if (!rotateVertical || style === 'twist') return horizontalStyleMesh(style, bend, width, height);
	return transposeMesh(horizontalStyleMesh(style, bend, height, width), true);
}

/**
 * Photoshop's distortion: the vertical first (each row scales about the midpoint of its two edge points by
 * 1 + (2v − 1)·vertical), then the horizontal (each column likewise, by 1 + (2u − 1)·horizontal). In place.
 */
export function applyWarpDistortion(mesh: WarpMeshGrid, horizontalPercent: number, verticalPercent: number): void {
	const vertical = clamp(verticalPercent, -100, 100);
	const horizontal = clamp(horizontalPercent, -100, 100);
	const scale = (points: number[], k: number) => {
		const a = points[0]!;
		const z = points[points.length - 1]!;
		const midX = (mesh.xs[a]! + mesh.xs[z]!) / 2;
		const midY = (mesh.ys[a]! + mesh.ys[z]!) / 2;
		for (const i of points) {
			mesh.xs[i] = midX + (mesh.xs[i]! - midX) * k;
			mesh.ys[i] = midY + (mesh.ys[i]! - midY) * k;
		}
	};
	if (vertical !== 0)
		for (let row = 0; row < mesh.vOrder; row++)
			scale(
				Array.from({ length: mesh.uOrder }, (_, c) => row * mesh.uOrder + c),
				1 + ((2 * row) / (mesh.vOrder - 1) - 1) * (vertical / 100),
			);
	if (horizontal !== 0)
		for (let column = 0; column < mesh.uOrder; column++)
			scale(
				Array.from({ length: mesh.vOrder }, (_, r) => r * mesh.uOrder + column),
				1 + ((2 * column) / (mesh.uOrder - 1) - 1) * (horizontal / 100),
			);
}

export type WarpParams = {
	style: WarpStyle;
	bend: number;
	horizontal: number;
	vertical: number;
	/** Photoshop's Vertical orientation. */
	rotateVertical: boolean;
};

/** 16 control points of a cubic patch, layer-normalised (0…1 = the box), row-major `[x0, y0, x1, y1, …]`. */
export type WarpSurface = Float64Array;

export function warpIsIdentity(p: Pick<WarpParams, 'bend' | 'horizontal' | 'vertical'>): boolean {
	return p.bend === 0 && p.horizontal === 0 && p.vertical === 0;
}

/** Samples along each edge when finding the warped frame. */
const FRAME_SAMPLES = 64;

/**
 * The surface of a warp over a `width` × `height` box: elevated to a cubic 4×4 patch, in layer-normalised coordinates,
 * with the warped frame re-centred on the box, so the title stays where it is while the bend animates. Null for a
 * degenerate box.
 */
export function warpSurface(p: WarpParams, width: number, height: number): WarpSurface | null {
	if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
	const mesh = styleWarpMesh(p.style, p.bend, p.rotateVertical, width, height);
	applyWarpDistortion(mesh, p.horizontal, p.vertical);
	const cubic = elevateWarpMeshToCubic(mesh);
	let x0 = Number.POSITIVE_INFINITY;
	let y0 = Number.POSITIVE_INFINITY;
	let x1 = Number.NEGATIVE_INFINITY;
	let y1 = Number.NEGATIVE_INFINITY;
	for (let i = 0; i <= FRAME_SAMPLES; i++) {
		const t = i / FRAME_SAMPLES;
		for (const [u, v] of [
			[t, 0],
			[t, 1],
			[0, t],
			[1, t],
		] as const) {
			const [x, y] = evaluateWarpMesh(cubic, u, v);
			x0 = Math.min(x0, x);
			x1 = Math.max(x1, x);
			y0 = Math.min(y0, y);
			y1 = Math.max(y1, y);
		}
	}
	const dx = width / 2 - (x0 + x1) / 2;
	const dy = height / 2 - (y0 + y1) / 2;
	const out = new Float64Array(32);
	for (let i = 0; i < 16; i++) {
		out[i * 2] = (cubic.xs[i]! + dx) / width;
		out[i * 2 + 1] = (cubic.ys[i]! + dy) / height;
	}
	return out;
}

/** Bernstein cubic values and derivatives at `t`. */
function cubicBasis(t: number): { b: [number, number, number, number]; d: [number, number, number, number] } {
	const s = 1 - t;
	return {
		b: [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t],
		d: [-3 * s * s, 3 * s * s - 6 * s * t, 6 * s * t - 3 * t * t, 3 * t * t],
	};
}

/**
 * The warp map at a layer-normalised point `(u, v)`, which may lie outside the box: past an edge the surface goes on
 * along its tangent there. `shader` in `text-warp.ts` is the same function in GLSL.
 */
export function warpMapPoint(surface: WarpSurface, u: number, v: number): [number, number] {
	const cu = clamp(u, 0, 1);
	const cv = clamp(v, 0, 1);
	const a = cubicBasis(cu);
	const b = cubicBasis(cv);
	let x = 0;
	let y = 0;
	for (let row = 0; row < 4; row++)
		for (let column = 0; column < 4; column++) {
			const i = (row * 4 + column) * 2;
			const w = a.b[column]! * b.b[row]! + (u - cu) * a.d[column]! * b.b[row]! + (v - cv) * a.b[column]! * b.d[row]!;
			x += w * surface[i]!;
			y += w * surface[i + 1]!;
		}
	return [x, y];
}

/**
 * Where a window of the layer goes (layer-normalised bounds), from a lattice of `steps + 1` points per side: enough
 * for padding, because the padding guard covers what falls between lattice points.
 */
export function warpBounds(
	surface: WarpSurface,
	window: { x0: number; y0: number; x1: number; y1: number },
	steps = 32,
): { x0: number; y0: number; x1: number; y1: number } {
	const out = {
		x0: Number.POSITIVE_INFINITY,
		y0: Number.POSITIVE_INFINITY,
		x1: Number.NEGATIVE_INFINITY,
		y1: Number.NEGATIVE_INFINITY,
	};
	for (let j = 0; j <= steps; j++)
		for (let i = 0; i <= steps; i++) {
			const [x, y] = warpMapPoint(
				surface,
				window.x0 + ((window.x1 - window.x0) * i) / steps,
				window.y0 + ((window.y1 - window.y0) * j) / steps,
			);
			out.x0 = Math.min(out.x0, x);
			out.x1 = Math.max(out.x1, x);
			out.y0 = Math.min(out.y0, y);
			out.y1 = Math.max(out.y1, y);
		}
	return out;
}
