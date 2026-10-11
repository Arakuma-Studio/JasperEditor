// Tracking fixtures: synthetic plates with exact ground truth.
//
//   plate-planar.mp4 / .json  1920x1080, 30 fps, 150 frames. A textured plane (noise + checker + blocks inside a dark
//                             bezel-like border) warped by a known per-frame homography (translation, rotation, scale
//                             and keystone) over a moving noise background, with sensor noise. Frames 100–109 are
//                             partly covered by a solid bar (occlusion).
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
		{ name: 'plate-point.mp4', recipe, make: (out) => makePointVideo(out, ctx) },
		{
			name: 'plate-point.json',
			recipe: VERSION,
			make: (out) => writeFileSync(out, `${JSON.stringify(pointTruth())}\n`),
		},
	];
}
