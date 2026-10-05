// Pure TypeScript maths of the Sapphire Distort family (fx catalogue, wave 2): projective transforms (S_WarpTransform,
// S_WarpCornerPin) and the deterministic shake curves of S_Shake. No DOM, no GL: unit-tested directly.
//
// Coordinates ("frame units", like Sapphire): origin at the centre of the layer box, x right, y DOWN, 1 = the layer
// width (so y spans ±aspect/2 with aspect = height / width). Shaders convert with `dw_frame()` / `dw_tap()`.
import { fxRandom } from '../shader.ts';

/** Row-major 3×3 matrix. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

export const MAT3_IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mat3Mul(a: Mat3, b: Mat3): Mat3 {
	const r: number[] = [];
	for (let i = 0; i < 3; i++)
		for (let j = 0; j < 3; j++)
			r.push(a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!);
	return r as unknown as Mat3;
}

/** Inverse of a 3×3 matrix (null when singular). */
export function mat3Invert(m: Mat3): Mat3 | null {
	const [a, b, c, d, e, f, g, h, i] = m;
	const A = e * i - f * h;
	const B = -(d * i - f * g);
	const C = d * h - e * g;
	const det = a * A + b * B + c * C;
	if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
	const k = 1 / det;
	return [
		A * k,
		-(b * i - c * h) * k,
		(b * f - c * e) * k,
		B * k,
		(a * i - c * g) * k,
		-(a * f - c * d) * k,
		C * k,
		-(a * h - b * g) * k,
		(a * e - b * d) * k,
	];
}

/** Applies a homography to a point; null when the point maps to (or behind) infinity. */
export function mat3Apply(m: Mat3, x: number, y: number): [number, number] | null {
	const w = m[6] * x + m[7] * y + m[8];
	if (!(w > 1e-9)) return null;
	return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

/** Column-major copy for a GLSL `mat3` uniform (`{mat3: […]}`). */
export function mat3ToGlsl(m: Mat3): number[] {
	return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

type P2 = readonly [number, number];

/**
 * The homography mapping the unit square (0,0)→p0, (1,0)→p1, (1,1)→p2, (0,1)→p3 (Heckbert's square-to-quad).
 * Returns null for degenerate quads.
 */
export function squareToQuad(p0: P2, p1: P2, p2: P2, p3: P2): Mat3 | null {
	const [x0, y0] = p0;
	const [x1, y1] = p1;
	const [x2, y2] = p2;
	const [x3, y3] = p3;
	const sx = x0 - x1 + x2 - x3;
	const sy = y0 - y1 + y2 - y3;
	let a: number;
	let b: number;
	let d: number;
	let e: number;
	let g: number;
	let h: number;
	if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12) {
		a = x1 - x0;
		b = x2 - x1;
		d = y1 - y0;
		e = y2 - y1;
		g = 0;
		h = 0;
	} else {
		const dx1 = x1 - x2;
		const dx2 = x3 - x2;
		const dy1 = y1 - y2;
		const dy2 = y3 - y2;
		const den = dx1 * dy2 - dx2 * dy1;
		if (Math.abs(den) < 1e-12) return null;
		g = (sx * dy2 - dx2 * sy) / den;
		h = (dx1 * sy - sx * dy1) / den;
		a = x1 - x0 + g * x1;
		b = x3 - x0 + h * x3;
		d = y1 - y0 + g * y1;
		e = y3 - y0 + h * y3;
	}
	const m: Mat3 = [a, b, x0, d, e, y0, g, h, 1];
	return Number.isFinite(mat3Det(m)) && Math.abs(mat3Det(m)) > 1e-12 ? m : null;
}

function mat3Det(m: Mat3): number {
	return (
		m[0] * (m[4] * m[8] - m[5] * m[7]) -
		m[1] * (m[3] * m[8] - m[5] * m[6]) +
		m[2] * (m[3] * m[7] - m[4] * m[6])
	);
}

/** Layer-normalised point ([0,0] top-left … [1,1]) → frame units. */
export function normToFrame(n: P2, aspect: number): [number, number] {
	return [n[0] - 0.5, (n[1] - 0.5) * aspect];
}

/**
 * S_WarpCornerPin: the homography from OUTPUT frame units to normalised SOURCE coordinates (u, v in 0..1 over the
 * layer), given the four pinned corners as layer-normalised points. Null when the quad is degenerate.
 */
export function cornerPinInverse(corners: { tl: P2; tr: P2; br: P2; bl: P2 }, aspect: number): Mat3 | null {
	const q = squareToQuad(
		normToFrame(corners.tl, aspect),
		normToFrame(corners.tr, aspect),
		normToFrame(corners.br, aspect),
		normToFrame(corners.bl, aspect),
	);
	return q ? mat3Invert(q) : null;
}

export type WarpTransformParams = {
	scale: P2;
	shift: P2;
	zDist: number;
	rotate: number;
	swivel: number;
	tilt: number;
	perspectiveAmount: number;
	shear: P2;
};

/**
 * S_WarpTransform: the forward homography SOURCE frame units → OUTPUT frame units. Order: scale, shear, 2D rotate
 * (clockwise on screen), 3D swivel (about the vertical axis) then tilt (about the horizontal axis) seen by a camera
 * `2 × Perspective Amount` frame widths away, Z Dist (farther = smaller), shift.
 */
export function warpTransformForward(p: WarpTransformParams): Mat3 {
	const rad = Math.PI / 180;
	const S: Mat3 = [p.scale[0], 0, 0, 0, p.scale[1], 0, 0, 0, 1];
	const Sh: Mat3 = [1, p.shear[0], 0, p.shear[1], 1, 0, 0, 0, 1];
	const c = Math.cos(p.rotate * rad);
	const s = Math.sin(p.rotate * rad);
	const R: Mat3 = [c, -s, 0, s, c, 0, 0, 0, 1];
	// 3D: swivel about y, then tilt about x; the plane z = 0 seen from a camera at z = −D (looking +z).
	const cy = Math.cos(p.swivel * rad);
	const sy = Math.sin(p.swivel * rad);
	const cx = Math.cos(p.tilt * rad);
	const sx = Math.sin(p.tilt * rad);
	// R3 = Rx(tilt) · Ry(swivel); columns 0 and 1 (the plane's x and y axes).
	const r00 = cy;
	const r10 = sx * sy;
	const r20 = -cx * sy;
	const r01 = 0;
	const r11 = cx;
	const r21 = sx;
	const D = 2 * Math.max(0.05, p.perspectiveAmount);
	const P: Mat3 = [D * r00, D * r01, 0, D * r10, D * r11, 0, r20, r21, D];
	const z = 1 / Math.max(1e-3, p.zDist);
	const T: Mat3 = [z, 0, p.shift[0], 0, z, p.shift[1], 0, 0, 1];
	return mat3Mul(T, mat3Mul(P, mat3Mul(R, mat3Mul(Sh, S))));
}

/** Bounding box of the transformed layer box (frame units), or null when part of it goes behind the camera. */
export function transformedBounds(
	forward: Mat3,
	aspect: number,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
	const pts: [number, number][] = [];
	const n = 8;
	for (let i = 0; i <= n; i++) {
		const t = i / n;
		for (const [x, y] of [
			[t - 0.5, -aspect / 2],
			[t - 0.5, aspect / 2],
			[-0.5, (t - 0.5) * aspect],
			[0.5, (t - 0.5) * aspect],
		] as [number, number][]) {
			const q = mat3Apply(forward, x, y);
			if (!q) return null;
			pts.push(q);
		}
	}
	return {
		minX: Math.min(...pts.map((q) => q[0])),
		minY: Math.min(...pts.map((q) => q[1])),
		maxX: Math.max(...pts.map((q) => q[0])),
		maxY: Math.max(...pts.map((q) => q[1])),
	};
}

/** Padding (layer px, per side) that keeps a frame-unit bounding box inside the canvas. */
export function boundsPadding(
	b: { minX: number; minY: number; maxX: number; maxY: number },
	width: number,
	height: number,
): { left: number; top: number; right: number; bottom: number } {
	const aspect = height / Math.max(1, width);
	// A couple of pixels of slack for the antialiased edge, none when the box stays inside.
	const px = (v: number) => (v * width > 1e-3 ? Math.ceil(v * width) + 2 : 0);
	return {
		left: px(-0.5 - b.minX),
		right: px(b.maxX - 0.5),
		top: px(-aspect / 2 - b.minY),
		bottom: px(b.maxY - aspect / 2),
	};
}

// ---------------------------------------------------------------- S_Shake

/** Smooth deterministic 1-D noise, about −1..1 (Catmull-Rom through seeded random knots; C1 continuous). */
export function shakeNoise(seed: number, stream: number, x: number): number {
	const i = Math.floor(x);
	const t = x - i;
	const k = (n: number) => 2 * fxRandom(seed, n * 64 + stream) - 1;
	const p0 = k(i - 1);
	const p1 = k(i);
	const p2 = k(i + 1);
	const p3 = k(i + 2);
	const t2 = t * t;
	const t3 = t2 * t;
	return (
		0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
	);
}

const smooth01 = (x: number) => {
	const t = Math.min(1, Math.max(0, x));
	return t * t * (3 - 2 * t);
};

export type ShakeStyle = 'normal' | 'twitchy' | 'jumpy';
export type ShakeAxis = {
	randAmp: number;
	randFreq: number;
	waveAmp: number;
	waveFreq: number;
	phase: number;
};
export type ShakeParams = {
	style: ShakeStyle;
	amplitude: number;
	frequency: number;
	phase: number;
	stillness: number;
	twitchFrequency: number;
	drift: number;
	centerBias: number;
	x: ShakeAxis;
	y: ShakeAxis;
	z: ShakeAxis;
	tilt: ShakeAxis;
	/** Per-channel amplitude and phase (R, G, B). */
	channelAmp: readonly [number, number, number];
	channelPhase: readonly [number, number, number];
	rgbRandomness: number;
	rgbFrequency: number;
};

/** One shake pose: offset in frame units (y down), zoom factor, rotation in degrees (clockwise). */
export type ShakePose = { dx: number; dy: number; zoom: number; tilt: number };

/** Frame units of offset per unit of (Amplitude × Rand/Wave Amp). */
export const SHAKE_OFFSET_UNIT = 0.1;
/** Zoom change per unit of (Amplitude × Z Amp). */
export const SHAKE_ZOOM_UNIT = 0.1;
/** Degrees of rotation per unit of (Amplitude × Tilt Amp). */
export const SHAKE_TILT_UNIT = 5;

const STREAMS = { x: 1, y: 2, z: 3, tilt: 4 } as const;

/** The style-shaped random part of one axis at time `t` (seconds). */
function styledRandom(p: ShakeParams, seed: number, stream: number, a: ShakeAxis, t: number): number {
	const f = Math.max(0, p.frequency);
	const u = (t * f + p.phase) * Math.max(0, a.randFreq);
	if (p.style === 'jumpy') {
		// Holds a random target per jump (rate = Frequency × Rand Freq / 4 per second), snapping back to the centre
		// with probability Center Bias, plus a slow drift between the jumps.
		const seg = Math.floor(u / 4);
		const back = fxRandom(seed, seg * 64 + stream + 32) < Math.min(1, Math.max(0, p.centerBias));
		const target = back ? 0 : 2 * fxRandom(seed, seg * 64 + stream + 16) - 1;
		return target + Math.min(1, Math.max(0, p.drift)) * shakeNoise(seed, stream + 8, u / 4);
	}
	const n = shakeNoise(seed, stream, u);
	if (p.style === 'twitchy') {
		// Periods of 1 / Twitch Frequency seconds; a period is still with probability Stillness. Smooth on/off.
		const tf = Math.max(1e-3, p.twitchFrequency);
		const x = (t + p.phase / Math.max(1e-3, f)) * tf;
		const k = Math.floor(x);
		const on = (j: number) => (fxRandom(seed, j * 64 + 40) >= p.stillness ? 1 : 0);
		const r = x - k;
		const ramp = 0.15;
		let g = on(k);
		if (r < ramp) g = on(k - 1) + (on(k) - on(k - 1)) * smooth01(0.5 + r / (2 * ramp));
		else if (r > 1 - ramp) g = on(k) + (on(k + 1) - on(k)) * smooth01((r - (1 - ramp)) / (2 * ramp));
		return n * g;
	}
	return n;
}

function axisValue(p: ShakeParams, seed: number, axis: keyof typeof STREAMS, t: number): number {
	const a = p[axis];
	const rand = a.randAmp * styledRandom(p, seed, STREAMS[axis], a, t);
	const wave = a.waveAmp * Math.sin(2 * Math.PI * (a.waveFreq * t + a.phase));
	return p.amplitude * (rand + wave);
}

/**
 * The shake pose of colour channel `ch` (0 R, 1 G, 2 B) at time `t` seconds: the shared shake, scaled by the
 * channel's amplitude and shifted in time by its phase (in shake cycles, i.e. 1 / Frequency seconds), plus an
 * independent per-channel wander (RGB Randomness × each axis' Rand Amp, at RGB Frequency Hz).
 */
export function shakePose(p: ShakeParams, seed: number, t: number, ch: 0 | 1 | 2): ShakePose {
	const tc = t + p.channelPhase[ch] / Math.max(1e-3, p.frequency);
	const amp = p.channelAmp[ch];
	const extra = (axis: keyof typeof STREAMS) =>
		p.rgbRandomness > 0
			? p.amplitude *
				p.rgbRandomness *
				p[axis].randAmp *
				shakeNoise(seed, 20 + ch * 4 + STREAMS[axis], t * Math.max(0, p.rgbFrequency))
			: 0;
	const x = amp * axisValue(p, seed, 'x', tc) + extra('x');
	const y = amp * axisValue(p, seed, 'y', tc) + extra('y');
	const z = amp * axisValue(p, seed, 'z', tc) + extra('z');
	const r = amp * axisValue(p, seed, 'tilt', tc) + extra('tilt');
	return {
		dx: x * SHAKE_OFFSET_UNIT,
		dy: y * SHAKE_OFFSET_UNIT,
		zoom: Math.max(0.05, 1 + z * SHAKE_ZOOM_UNIT),
		tilt: r * SHAKE_TILT_UNIT,
	};
}

/** Shutter sample times (seconds) around `t`: `n` evenly spread over `length` frames, centred on the frame. */
export function shutterTimes(t: number, fps: number, length: number, n: number): number[] {
	if (n <= 1 || !(length > 0)) return [t];
	const out: number[] = [];
	for (let i = 0; i < n; i++) out.push(t + ((i + 0.5) / n - 0.5) * (length / Math.max(1, fps)));
	return out;
}
