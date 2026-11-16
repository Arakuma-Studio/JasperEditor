// Tracking fixtures: synthetic plates with exact ground truth.
//
//   plate-planar.mp4 / .json  1920x1080, 30 fps, 150 frames. A textured plane (noise + checker + blocks inside a dark
//                             bezel-like border) warped by a known per-frame homography (translation, rotation, scale
//                             and keystone) over a moving noise background, with sensor noise. Frames 100–109 are
//                             partly covered by a solid bar (occlusion).
//   plate-planar-hard.mp4 / .json  1920x1080, 30 fps, 96 frames. The same plane filmed "handheld": camera shake up to
//                             ~35 px/frame with a 180° shutter (6-sample motion blur), auto-exposure drift and a
//                             blurred hand-like occluder that sweeps across up to ~40 % of the plane (frames 30–77).
//                             The JSON adds the occluder's swept outline per frame (`holdout`, media px).
//   plate-point.mp4 / .json   1280x720, 30 fps, 90 frames. A small textured disc moving along a known path over a
//                             noise background.
//
// Frames are rendered in Node (bilinear sampling, 4x4 supersampling on the plane's edges) and piped as gray rawvideo
// into ffmpeg. Everything is deterministic (seeded PRNG). Geometry convention: pixel centres at integer coordinates;
// the ground-truth corners are the images of the plane's unit-square corners.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';

const VERSION = 'track-fixtures v1';
const HARD_VERSION = 'track-fixtures hard v1';

function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Multi-octave value noise in 0..1 (bilinear interpolation of random lattices), `w`x`h` Float32Array. */
function valueNoise(w, h, seed, octaves) {
	const rnd = mulberry32(seed);
	const out = new Float32Array(w * h);
	let total = 0;
	for (const [cell, amp] of octaves) {
		total += amp;
		const gw = Math.ceil(w / cell) + 2;
		const gh = Math.ceil(h / cell) + 2;
		const grid = new Float32Array(gw * gh);
		for (let i = 0; i < grid.length; i++) grid[i] = rnd();
		for (let y = 0; y < h; y++) {
			const gy = y / cell;
			const y0 = Math.floor(gy);
			let fy = gy - y0;
			fy = fy * fy * (3 - 2 * fy);
			for (let x = 0; x < w; x++) {
				const gx = x / cell;
				const x0 = Math.floor(gx);
				let fx = gx - x0;
				fx = fx * fx * (3 - 2 * fx);
				const i = y0 * gw + x0;
				const a = grid[i] + (grid[i + 1] - grid[i]) * fx;
				const b = grid[i + gw] + (grid[i + gw + 1] - grid[i + gw]) * fx;
				out[y * w + x] += amp * (a + (b - a) * fy);
			}
		}
	}
	for (let i = 0; i < out.length; i++) out[i] /= total;
	return out;
}

/** Bilinear sample of a Float32Array image at index coordinates (clamped to the edge). */
function sample(img, w, h, x, y) {
	if (x < 0) x = 0;
	else if (x > w - 1) x = w - 1;
	if (y < 0) y = 0;
	else if (y > h - 1) y = h - 1;
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const x1 = x0 < w - 1 ? x0 + 1 : x0;
	const y1 = y0 < h - 1 ? y0 + 1 : y0;
	const fx = x - x0;
	const fy = y - y0;
	const a = img[y0 * w + x0] + (img[y0 * w + x1] - img[y0 * w + x0]) * fx;
	const b = img[y1 * w + x0] + (img[y1 * w + x1] - img[y1 * w + x0]) * fx;
	return a + (b - a) * fy;
}

/** Homography mapping the unit square (0,0),(1,0),(1,1),(0,1) to quad TL, TR, BR, BL (row-major 3x3). */
function unitSquareToQuad(q) {
	const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
	const dx1 = x1 - x2;
	const dx2 = x3 - x2;
	const dy1 = y1 - y2;
	const dy2 = y3 - y2;
	const sx = x0 - x1 + x2 - x3;
	const sy = y0 - y1 + y2 - y3;
	const den = dx1 * dy2 - dx2 * dy1;
	const g = (sx * dy2 - dx2 * sy) / den;
	const hh = (dx1 * sy - sx * dy1) / den;
	return [x1 - x0 + g * x1, x3 - x0 + hh * x3, x0, y1 - y0 + g * y1, y3 - y0 + hh * y3, y0, g, hh, 1];
}

function invert3(m) {
	const [a, b, c, d, e, f, g, h, i] = m;
	const A = e * i - f * h;
	const B = -(d * i - f * g);
	const C = d * h - e * g;
	const det = a * A + b * B + c * C;
	return [
		A / det,
		-(b * i - c * h) / det,
		(b * f - c * e) / det,
		B / det,
		(a * i - c * g) / det,
		-(a * f - c * d) / det,
		C / det,
		-(a * h - b * g) / det,
		(a * e - b * d) / det,
	];
}

const PLANAR = {
	width: 1920,
	height: 1080,
	fps: 30,
	frames: 150,
	referenceFrame: 75,
	occluded: [100, 101, 102, 103, 104, 105, 106, 107, 108, 109],
	/** Solid occluding bar during `occluded` (x0, x1; full height), value 0..255. */
	bar: { x0: 700, x1: 960, value: 92 },
};

/** Ground-truth corners (TL, TR, BR, BL) of the plane at frame `f`. */
function planarCorners(f) {
	const t = f / PLANAR.fps;
	const cx = 960 + 170 * Math.sin(2 * Math.PI * 0.22 * t + 0.3);
	const cy = 540 + 70 * Math.sin(2 * Math.PI * 0.31 * t + 1.1);
	const rot = 0.1 * Math.sin(2 * Math.PI * 0.17 * t);
	const k = 1 + 0.1 * Math.sin(2 * Math.PI * 0.13 * t + 0.5);
	const p = 0.08 * Math.sin(2 * Math.PI * 0.2 * t + 0.7);
	const q = 0.05 * Math.sin(2 * Math.PI * 0.27 * t + 2.1);
	const a = 380;
	const b = 235;
	const local = [
		[-a * (1 + q), -b * (1 + p)],
		[a * (1 + q), -b * (1 - p)],
		[a * (1 - q), b * (1 - p)],
		[-a * (1 - q), b * (1 + p)],
	];
	const cs = Math.cos(rot);
	const sn = Math.sin(rot);
	return local.map(([x, y]) => [cx + k * (cs * x - sn * y), cy + k * (sn * x + cs * y)]);
}

function planarBackgroundOffset(f) {
	const t = f / PLANAR.fps;
	return [300 + 45 * Math.sin(2 * Math.PI * 0.15 * t), 200 + 30 * Math.sin(2 * Math.PI * 0.21 * t + 0.4)];
}

function planarTexture() {
	const W = 1024;
	const H = 640;
	const tex = valueNoise(W, H, 7, [
		[96, 1],
		[24, 0.8],
		[6, 0.5],
	]);
	const rnd = mulberry32(99);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			const checker = (Math.floor(x / 64) + Math.floor(y / 64)) % 2 === 0 ? 0.12 : -0.12;
			tex[i] = 40 + 180 * Math.min(1, Math.max(0, tex[i] + checker));
		}
	// "Text" blocks: dark rectangles on light panels.
	for (let n = 0; n < 60; n++) {
		const bw = 20 + Math.floor(rnd() * 120);
		const bh = 8 + Math.floor(rnd() * 22);
		const bx = 40 + Math.floor(rnd() * (W - 80 - bw));
		const by = 40 + Math.floor(rnd() * (H - 80 - bh));
		const v = rnd() < 0.5 ? 25 : 235;
		for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) tex[y * W + x] = v;
	}
	// Dark bezel-like border (3 % of the width).
	const border = Math.round(W * 0.03);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++)
			if (x < border || y < border || x >= W - border || y >= H - border) tex[y * W + x] = 18;
	return { tex, W, H };
}

async function renderPlate(out, ctx, { width, height, fps, frames }, renderFrame) {
	const x264 = ctx.h264.includes('libx264');
	const args = [
		...ctx.base,
		...['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0'],
		...ctx.h264,
		...(x264 ? ['-crf', '16'] : ['-b:v', '16M']),
		...['-movflags', '+faststart', '-f', 'mp4', out],
	];
	const child = spawn(ctx.ffmpeg, args, { stdio: ['pipe', 'inherit', 'inherit'] });
	const exited = once(child, 'close');
	const buf = Buffer.alloc(width * height);
	for (let f = 0; f < frames; f++) {
		renderFrame(f, buf);
		if (!child.stdin.write(buf)) await once(child.stdin, 'drain');
	}
	child.stdin.end();
	const [code] = await exited;
	if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
}

function noisePool() {
	const rnd = mulberry32(4242);
	const pool = new Float32Array(1 << 22);
	for (let i = 0; i < pool.length; i++) pool[i] = (rnd() - 0.5) * 6;
	return pool;
}

async function makePlanarVideo(out, ctx) {
	const { width: W, height: H } = PLANAR;
	const { tex, W: TW, H: TH } = planarTexture();
	const BGW = 2600;
	const BGH = 1500;
	const bg = valueNoise(BGW, BGH, 3, [
		[120, 1],
		[30, 0.7],
		[8, 0.45],
	]);
	for (let i = 0; i < bg.length; i++) bg[i] = 60 + 140 * bg[i];
	const pool = noisePool();
	const occluded = new Set(PLANAR.occluded);
	const planeAt = (hinv, x, y) => {
		const zw = hinv[6] * x + hinv[7] * y + hinv[8];
		const u = (hinv[0] * x + hinv[1] * y + hinv[2]) / zw;
		const v = (hinv[3] * x + hinv[4] * y + hinv[5]) / zw;
		if (u < 0 || u > 1 || v < 0 || v > 1) return null;
		return sample(tex, TW, TH, u * TW - 0.5, v * TH - 0.5);
	};
	await renderPlate(out, ctx, PLANAR, (f, buf) => {
		const corners = planarCorners(f);
		const hinv = invert3(unitSquareToQuad(corners));
		const [ox, oy] = planarBackgroundOffset(f);
		// Side lines (normalised) for edge supersampling.
		const lines = corners.map((p, i) => {
			const q = corners[(i + 1) % 4];
			const dx = q[0] - p[0];
			const dy = q[1] - p[1];
			const len = Math.hypot(dx, dy);
			return [-dy / len, dx / len, (dy * p[0] - dx * p[1]) / len];
		});
		const xs = corners.map((c) => c[0]);
		const ys = corners.map((c) => c[1]);
		const bx0 = Math.max(0, Math.floor(Math.min(...xs)) - 2);
		const bx1 = Math.min(W - 1, Math.ceil(Math.max(...xs)) + 2);
		const by0 = Math.max(0, Math.floor(Math.min(...ys)) - 2);
		const by1 = Math.min(H - 1, Math.ceil(Math.max(...ys)) + 2);
		let np = (f * 7919) % (pool.length - W * H);
		const occ = occluded.has(f);
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				let v;
				if (occ && x >= PLANAR.bar.x0 && x < PLANAR.bar.x1) v = PLANAR.bar.value;
				else {
					const back = sample(bg, BGW, BGH, x + ox, y + oy);
					if (x < bx0 || x > bx1 || y < by0 || y > by1) v = back;
					else {
						let near = false;
						for (const l of lines) if (Math.abs(l[0] * x + l[1] * y + l[2]) < 1.2) near = true;
						if (!near) v = planeAt(hinv, x, y) ?? back;
						else {
							let acc = 0;
							for (let sy = 0; sy < 4; sy++)
								for (let sx = 0; sx < 4; sx++) {
									const px = x - 0.375 + sx * 0.25;
									const py = y - 0.375 + sy * 0.25;
									acc += planeAt(hinv, px, py) ?? sample(bg, BGW, BGH, px + ox, py + oy);
								}
							v = acc / 16;
						}
					}
				}
				v += pool[np++];
				buf[y * W + x] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
			}
		}
	});
}

function planarTruth() {
	const corners = [];
	for (let f = 0; f < PLANAR.frames; f++)
		corners.push(planarCorners(f).map(([x, y]) => [round4(x), round4(y)]));
	return {
		version: VERSION,
		width: PLANAR.width,
		height: PLANAR.height,
		fps: { num: PLANAR.fps, den: 1 },
		frames: PLANAR.frames,
		reference: { frame: PLANAR.referenceFrame, corners: corners[PLANAR.referenceFrame] },
		occluded: PLANAR.occluded,
		occluder: PLANAR.bar,
		/** Corners TL, TR, BR, BL per frame, media px (pixel centres at integer coordinates). */
		corners,
	};
}

const HARD = {
	width: 1920,
	height: 1080,
	fps: 30,
	frames: 96,
	referenceFrame: 20,
	/** Sub-frames per frame over the 180° shutter (motion blur). */
	shutterSamples: 6,
	/** Frames the occluder overlaps the plane. */
	occluded: { start: 30, end: 78 },
};

/** Camera shake of the handheld plate at time `t` (s): translation, rotation and zoom (deterministic). */
function hardShake(t) {
	const s = (a, hz, ph) => a * Math.sin(2 * Math.PI * hz * t + ph);
	return {
		dx: s(150, 0.21, 0.3) + s(26, 1.7, 1.1) + s(11, 3.9, 0.2) + s(5, 6.1, 2.3),
		dy: s(80, 0.27, 1.4) + s(20, 2.3, 0.6) + s(9, 4.4, 1.9),
		rot: s(0.07, 0.19, 0.5) + s(0.012, 2.9, 1.3),
		k: 1 + s(0.08, 0.15, 0.2) + s(0.01, 3.3, 0.9),
		p: s(0.07, 0.23, 0.4),
		q: s(0.05, 0.31, 2.0),
	};
}

/** Corners (TL, TR, BR, BL) of the plane at time `t` (s). */
function hardCorners(t) {
	const m = hardShake(t);
	const a = 400;
	const b = 250;
	const local = [
		[-a * (1 + m.q), -b * (1 + m.p)],
		[a * (1 + m.q), -b * (1 - m.p)],
		[a * (1 - m.q), b * (1 - m.p)],
		[-a * (1 - m.q), b * (1 + m.p)],
	];
	const cs = Math.cos(m.rot);
	const sn = Math.sin(m.rot);
	return local.map(([x, y]) => [960 + m.dx + m.k * (cs * x - sn * y), 540 + m.dy + m.k * (sn * x + cs * y)]);
}

/** Hand-like occluder at time `t` (s): palm ellipse plus four fingers (capsules), or null when out of view. */
function hardHand(t) {
	const f = t * HARD.fps;
	const { start, end } = HARD.occluded;
	if (f < start - 6 || f > end + 6) return null;
	const u = (f - (start - 6)) / (end - start + 12);
	const cam = hardShake(t);
	// Sweeps in from the lower left, across the plane's lower half, and out to the right; moves with the camera
	// only partly (it is closer to it).
	const cx = -260 + 2300 * u + 0.4 * cam.dx;
	const cy = 1060 - 520 * Math.sin(Math.PI * u) + 0.4 * cam.dy;
	const ang = -0.6 + 0.5 * u;
	const fingers = [-0.55, -0.2, 0.15, 0.5].map((o, i) => {
		const len = 230 - 25 * Math.abs(i - 1.5);
		const bx = cx + Math.cos(ang + o) * 150;
		const by = cy + Math.sin(ang + o) * 150;
		return {
			x0: bx,
			y0: by,
			x1: bx + Math.cos(ang + o * 0.4) * len,
			y1: by + Math.sin(ang + o * 0.4) * len,
			r: 34,
		};
	});
	return { cx, cy, rx: 200, ry: 150, ang, fingers };
}

/** Coverage 0..1 of the hand at (x, y) (one-pixel soft edge). */
function handCoverage(h, x, y) {
	const dx = x - h.cx;
	const dy = y - h.cy;
	const c = Math.cos(h.ang);
	const s = Math.sin(h.ang);
	const ex = (c * dx + s * dy) / h.rx;
	const ey = (-s * dx + c * dy) / h.ry;
	let d = (Math.hypot(ex, ey) - 1) * Math.min(h.rx, h.ry);
	for (const g of h.fingers) {
		const vx = g.x1 - g.x0;
		const vy = g.y1 - g.y0;
		const tt = Math.max(0, Math.min(1, ((x - g.x0) * vx + (y - g.y0) * vy) / (vx * vx + vy * vy)));
		d = Math.min(d, Math.hypot(x - g.x0 - tt * vx, y - g.y0 - tt * vy) - g.r);
	}
	return Math.max(0, Math.min(1, 0.5 - d));
}

/** Outline points of the hand (palm ellipse and finger capsules), for the hold-out polygons. */
function handOutline(h) {
	const pts = [];
	const c = Math.cos(h.ang);
	const s = Math.sin(h.ang);
	for (let k = 0; k < 24; k++) {
		const a = (2 * Math.PI * k) / 24;
		const ex = h.rx * Math.cos(a);
		const ey = h.ry * Math.sin(a);
		pts.push([h.cx + c * ex - s * ey, h.cy + s * ex + c * ey]);
	}
	for (const g of h.fingers)
		for (const [x, y] of [
			[g.x0, g.y0],
			[g.x1, g.y1],
		])
			for (let k = 0; k < 8; k++) {
				const a = (2 * Math.PI * k) / 8;
				pts.push([x + g.r * Math.cos(a), y + g.r * Math.sin(a)]);
			}
	return pts;
}

/** Convex hull (monotone chain), clockwise in image coordinates. */
function convexHull(points) {
	const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	const lower = [];
	for (const q of p) {
		while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
		lower.push(q);
	}
	const upper = [];
	for (let i = p.length - 1; i >= 0; i--) {
		const q = p[i];
		while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
		upper.push(q);
	}
	return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Shutter times (s) of frame `f`: 180° shutter centred on the frame time. */
function shutterTimes(f) {
	const n = HARD.shutterSamples;
	return Array.from({ length: n }, (_, i) => (f + (i + 0.5) / n / 2 - 0.25) / HARD.fps);
}

async function makeHardVideo(out, ctx) {
	const { width: W, height: H } = HARD;
	const { tex, W: TW, H: TH } = planarTexture();
	const BGW = 2900;
	const BGH = 1800;
	const bg = valueNoise(BGW, BGH, 5, [
		[120, 1],
		[30, 0.7],
		[8, 0.45],
	]);
	for (let i = 0; i < bg.length; i++) bg[i] = 60 + 140 * bg[i];
	const skin = valueNoise(512, 512, 17, [
		[40, 1],
		[10, 0.4],
	]);
	for (let i = 0; i < skin.length; i++) skin[i] = 120 + 70 * skin[i];
	const pool = noisePool();
	const acc = new Float32Array(W * H);
	await renderPlate(out, ctx, HARD, (f, buf) => {
		acc.fill(0);
		const times = shutterTimes(f);
		for (const t of times) {
			const corners = hardCorners(t);
			const hinv = invert3(unitSquareToQuad(corners));
			const m = hardShake(t);
			// The background is a far wall: it moves with the camera's translation and rotation.
			const cs = Math.cos(m.rot);
			const sn = Math.sin(m.rot);
			const hand = hardHand(t);
			for (let y = 0; y < H; y++) {
				for (let x = 0; x < W; x++) {
					const zw = hinv[6] * x + hinv[7] * y + hinv[8];
					const u = (hinv[0] * x + hinv[1] * y + hinv[2]) / zw;
					const v = (hinv[3] * x + hinv[4] * y + hinv[5]) / zw;
					let val;
					if (u >= 0 && u <= 1 && v >= 0 && v <= 1) val = sample(tex, TW, TH, u * TW - 0.5, v * TH - 0.5);
					else {
						const lx = x - 960 - m.dx;
						const ly = y - 540 - m.dy;
						val = sample(bg, BGW, BGH, 1450 + cs * lx + sn * ly, 900 - sn * lx + cs * ly);
					}
					if (hand) {
						const a = handCoverage(hand, x, y);
						if (a > 0)
							val =
								val * (1 - a) +
								a * sample(skin, 512, 512, (x - hand.cx + 256) & 511, (y - hand.cy + 256) & 511);
					}
					acc[y * W + x] += val;
				}
			}
		}
		// Auto-exposure drift (±7 %), sensor noise.
		const gain = 1 + 0.07 * Math.sin((2 * Math.PI * f) / 70 + 0.8);
		let np = (f * 6007) % (pool.length - W * H);
		for (let i = 0; i < W * H; i++) {
			const v = (gain * acc[i]) / times.length + pool[np++];
			buf[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
		}
	});
}

function hardTruth() {
	const corners = [];
	const holdout = [];
	for (let f = 0; f < HARD.frames; f++) {
		// The plane's position in a motion-blurred frame is the mean of its positions over the shutter (what the blurred
		// picture shows); with the shake's acceleration it differs from the shutter-centre position by up to ~0.2 px.
		const times = shutterTimes(f);
		const mean = [0, 1, 2, 3].map(() => [0, 0]);
		for (const t of times)
			hardCorners(t).forEach(([x, y], k) => {
				mean[k][0] += x / times.length;
				mean[k][1] += y / times.length;
			});
		corners.push(mean.map(([x, y]) => [round4(x), round4(y)]));
		const pts = [];
		for (const t of times) {
			const h = hardHand(t);
			if (h) pts.push(...handOutline(h));
		}
		holdout.push(pts.length ? convexHull(pts).map(([x, y]) => [round4(x), round4(y)]) : null);
	}
	return {
		version: HARD_VERSION,
		width: HARD.width,
		height: HARD.height,
		fps: { num: HARD.fps, den: 1 },
		frames: HARD.frames,
		reference: { frame: HARD.referenceFrame, corners: corners[HARD.referenceFrame] },
		occluded: Array.from(
			{ length: HARD.occluded.end - HARD.occluded.start },
			(_, i) => HARD.occluded.start + i,
		),
		/** Corners TL, TR, BR, BL per frame (mean over the shutter), media px. */
		corners,
		/** Per frame: convex outline (media px) of the area the occluder covers during the shutter, or null. */
		holdout,
	};
}

const POINT = {
	width: 1280,
	height: 720,
	fps: 30,
	frames: 90,
	referenceFrame: 45,
	radius: 22,
	patch: 33,
	search: 40,
};

function pointAt(f) {
	const t = f / POINT.fps;
	return [
		640 + 300 * Math.sin(2 * Math.PI * 0.25 * t + 0.2),
		360 + 160 * Math.sin(2 * Math.PI * 0.4 * t + 0.6),
	];
}

async function makePointVideo(out, ctx) {
	const { width: W, height: H, radius: R } = POINT;
	const bg = valueNoise(W, H, 11, [
		[64, 1],
		[16, 0.8],
		[4, 0.4],
	]);
	for (let i = 0; i < bg.length; i++) bg[i] = 70 + 110 * bg[i];
	const S = 2 * R;
	const blob = valueNoise(S, S, 23, [
		[10, 1],
		[4, 0.7],
	]);
	for (let i = 0; i < blob.length; i++) blob[i] = blob[i] < 0.5 ? 20 + 60 * blob[i] : 150 + 100 * blob[i];
	const pool = noisePool();
	await renderPlate(out, ctx, POINT, (f, buf) => {
		const [cx, cy] = pointAt(f);
		let np = (f * 104729) % (pool.length - W * H);
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				let v = bg[y * W + x];
				const lx = x - cx;
				const ly = y - cy;
				const d = Math.hypot(lx, ly);
				if (d < R + 1) {
					const alpha = Math.min(1, Math.max(0, R - d + 0.5));
					if (alpha > 0) v = v * (1 - alpha) + alpha * sample(blob, S, S, lx + R - 0.5, ly + R - 0.5);
				}
				v += pool[np++];
				buf[y * W + x] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
			}
	});
}

function pointTruth() {
	const points = [];
	for (let f = 0; f < POINT.frames; f++) points.push(pointAt(f).map(round4));
	return {
		version: VERSION,
		width: POINT.width,
		height: POINT.height,
		fps: { num: POINT.fps, den: 1 },
		frames: POINT.frames,
		reference: {
			frame: POINT.referenceFrame,
			point: points[POINT.referenceFrame],
			patch: POINT.patch,
			search: POINT.search,
		},
		radius: POINT.radius,
		/** Blob centre per frame, media px. */
		points,
	};
}

function round4(v) {
	return Math.round(v * 1e4) / 1e4;
}

export function fixtures(ctx) {
	const recipe = `${VERSION} ${ctx.h264.join(' ')}`;
	return [
		{ name: 'plate-planar.mp4', recipe, make: (out) => makePlanarVideo(out, ctx) },
		{
			name: 'plate-planar.json',
			recipe: VERSION,
			make: (out) => writeFileSync(out, `${JSON.stringify(planarTruth())}\n`),
		},
		{
			name: 'plate-planar-hard.mp4',
			recipe: `${HARD_VERSION} ${ctx.h264.join(' ')}`,
			make: (out) => makeHardVideo(out, ctx),
		},
		{
			name: 'plate-planar-hard.json',
			recipe: `${HARD_VERSION} shutter-mean`,
			make: (out) => writeFileSync(out, `${JSON.stringify(hardTruth())}\n`),
		},
		{ name: 'plate-point.mp4', recipe, make: (out) => makePointVideo(out, ctx) },
		{
			name: 'plate-point.json',
			recipe: VERSION,
			make: (out) => writeFileSync(out, `${JSON.stringify(pointTruth())}\n`),
		},
	];
}
