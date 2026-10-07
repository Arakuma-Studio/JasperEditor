// 3D Camera Tracker fixtures (parity workstream `three-d`): a ray-cast plate filmed by an exactly known camera.
//
//   camtrack-dolly.mp4 / .json  640x360, 30 fps, 60 frames. A camera (focal length 560 px, horizontal angle of view
//                               ≈ 59.5°) dollies sideways and forwards while turning toward a point of interest, over a
//                               noise-textured ground, a back wall and three floating cards at different depths. The
//                               JSON holds the camera per frame: `r` (world → camera rotation, rows = camera x right,
//                               y down, z forward), `c` (centre) and `f` (pixels; principal point at the centre).
//
// Deterministic (seeded value noise with distance-faded octaves against aliasing), rendered in Node and piped as rgb24
// rawvideo into ffmpeg (H.264).
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';

const VERSION = 'camtrack-fixtures v1';
const W = 640;
const H = 360;
const N = 60;
const F = 560;

function hash(x, y, s) {
	let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s, 2246822519)) >>> 0;
	h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
	return ((h ^ (h >>> 16)) & 1023) / 1023;
}

function valueNoise(u, v, s) {
	const x = Math.floor(u);
	const y = Math.floor(v);
	const fx = u - x;
	const fy = v - y;
	const sx = fx * fx * (3 - 2 * fx);
	const sy = fy * fy * (3 - 2 * fy);
	const a = hash(x, y, s);
	const b = hash(x + 1, y, s);
	const c = hash(x, y + 1, s);
	const d = hash(x + 1, y + 1, s);
	return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

const smooth = (a, b, x) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

/** Texture of surface `s` at (u, v) seen at `dist` (octaves fade out below ~3 px per period). */
function texture(u, v, s, dist) {
	let sum = 0.5;
	let amp = 0.5;
	for (const freq of [2.5, 6, 14]) {
		const period = F / (dist * freq);
		const w = smooth(2, 4, period);
		sum += (valueNoise(u * freq, v * freq, s * 7 + freq) - 0.5) * amp * 2 * w;
		amp *= 0.7;
	}
	return Math.min(1, Math.max(0, sum));
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
	const l = Math.hypot(a[0], a[1], a[2]);
	return [a[0] / l, a[1] / l, a[2] / l];
};

export function cameraAt(k) {
	const t = k / (N - 1);
	const c = [-1.2 + 2.4 * t, -0.2 - 0.1 * t, -2 + 1.5 * t];
	const target = [0.3 * t, 0.3, 8];
	const z = norm(sub(target, c));
	const x = norm(cross([0, 1, 0], z));
	const y = cross(z, x);
	return { r: [x, y, z], c, f: F };
}

/** Axis-aligned textured rectangles: `axis` fixed at `at`, bounded on the other two axes. */
const SURFACES = [
	{ axis: 1, at: 1.2, lo: [-30, 0, -10], hi: [30, 0, 40], tint: [0.55, 0.5, 0.42] },
	{ axis: 2, at: 14, lo: [-30, -20, 0], hi: [30, 1.2, 0], tint: [0.45, 0.5, 0.6] },
	{ axis: 2, at: 5, lo: [-2.2, -1.4, 0], hi: [-0.9, -0.2, 0], tint: [0.7, 0.45, 0.35] },
	{ axis: 2, at: 7, lo: [0.6, -0.8, 0], hi: [2.2, 0.6, 0], tint: [0.4, 0.65, 0.45] },
	{ axis: 2, at: 9.5, lo: [-0.6, -2.4, 0], hi: [0.8, -1.0, 0], tint: [0.65, 0.6, 0.35] },
];

function shade(o, d) {
	let best = Number.POSITIVE_INFINITY;
	let hit = null;
	for (let i = 0; i < SURFACES.length; i++) {
		const s = SURFACES[i];
		const den = d[s.axis];
		if (Math.abs(den) < 1e-9) continue;
		const t = (s.at - o[s.axis]) / den;
		if (t <= 0 || t >= best) continue;
		const p = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
		let inside = true;
		for (let a = 0; a < 3; a++) if (a !== s.axis && (p[a] < s.lo[a] || p[a] > s.hi[a])) inside = false;
		if (!inside) continue;
		best = t;
		hit = { s, i, p };
	}
	if (!hit) return [20, 24, 30];
	const [u, v] = hit.s.axis === 1 ? [hit.p[0], hit.p[2]] : [hit.p[0], hit.p[1]];
	const g = texture(u, v, hit.i + 1, best);
	return hit.s.tint.map((k) => Math.round(255 * Math.min(1, 0.15 + g * k * 1.4)));
}

async function makeVideo(out, ctx) {
	const ff = spawn(
		ctx.ffmpeg,
		[
			'-y',
			'-v',
			'error',
			...['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', '30', '-i', 'pipe:0'],
			...ctx.h264,
			...['-pix_fmt', 'yuv420p', '-f', 'mp4', out],
		],
		{ stdio: ['pipe', 'inherit', 'inherit'] },
	);
	for (let k = 0; k < N; k++) {
		const cam = cameraAt(k);
		const [rx, ry, rz] = cam.r;
		const b = Buffer.alloc(W * H * 3);
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const px = (x + 0.5 - W / 2) / F;
				const py = (y + 0.5 - H / 2) / F;
				const d = [0, 1, 2].map((a) => rx[a] * px + ry[a] * py + rz[a]);
				const c = shade(cam.c, d);
				b[(y * W + x) * 3] = c[0];
				b[(y * W + x) * 3 + 1] = c[1];
				b[(y * W + x) * 3 + 2] = c[2];
			}
		if (!ff.stdin.write(b)) await once(ff.stdin, 'drain');
	}
	ff.stdin.end();
	const [code] = await once(ff, 'close');
	if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
}

function truth() {
	return {
		version: VERSION,
		width: W,
		height: H,
		fps: { num: 30, den: 1 },
		frames: Array.from({ length: N }, (_, k) => cameraAt(k)),
	};
}

export function fixtures(ctx) {
	const recipe = `${VERSION} ${ctx.h264.join(' ')}`;
	return [
		{ name: 'camtrack-dolly.mp4', recipe, make: (out) => makeVideo(out, ctx) },
		{
			name: 'camtrack-dolly.json',
			recipe: VERSION,
			make: (out) => writeFileSync(out, `${JSON.stringify(truth())}\n`),
		},
	];
}
