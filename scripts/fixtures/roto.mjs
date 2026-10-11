// Roto fixtures (parity workstream `roto`): a synthetic plate with an exactly known object.
//
//   roto-object.mp4 / .json  640x360, 30 fps, 45 frames. A warm, noise-textured ellipse (semi-axes 80 × 60 px)
//                            moving right and down while it slowly rotates, over a cool noise-textured gradient
//                            background; edges anti-aliased by 4x4 supersampling. The JSON holds the ellipse per frame
//                            (centre, semi-axes, angle in radians, pixel centres at +0.5).
//
// Deterministic (seeded hash noise), rendered in Node and piped as rgb24 rawvideo into ffmpeg (H.264).
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';

const VERSION = 'roto-fixtures v1';
const W = 640;
const H = 360;
const N = 45;

function hash(x, y, s) {
	let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 2246822519)) >>> 0;
	h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
	return ((h ^ (h >>> 16)) & 1023) / 1023;
}

function ellipseAt(f) {
	return { cx: 180 + 5 * f, cy: 170 + 1.5 * f, rx: 80, ry: 60, angle: 0.012 * f };
}

/** Coverage (0..1) of pixel (x, y) by the ellipse, 4x4 supersampled. */
function coverage(e, x, y) {
	const c = Math.cos(-e.angle);
	const s = Math.sin(-e.angle);
	let n = 0;
	for (let j = 0; j < 4; j++)
		for (let i = 0; i < 4; i++) {
			const px = x + (i + 0.5) / 4 - e.cx;
			const py = y + (j + 0.5) / 4 - e.cy;
			const u = px * c - py * s;
			const v = px * s + py * c;
			if ((u / e.rx) ** 2 + (v / e.ry) ** 2 <= 1) n++;
		}
	return n / 16;
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
	for (let f = 0; f < N; f++) {
		const e = ellipseAt(f);
		const b = Buffer.alloc(W * H * 3);
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const a = coverage(e, x, y);
				// Texture moves with the object (object coordinates) / stays with the background.
				const nf = hash(Math.floor(x - 5 * f), Math.floor(y - 1.5 * f), 7) * 50;
				const nb = hash(x, y, 3) * 30;
				const fg = [190 + nf * 0.6, 70 + nf, 40 + nf * 0.3];
				const bg = [40 + x / 10 + nb * 0.4, 80 + y / 5 + nb * 0.5, 150 + nb];
				for (let k = 0; k < 3; k++) b[(y * W + x) * 3 + k] = Math.round(fg[k] * a + bg[k] * (1 - a));
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
		frames: Array.from({ length: N }, (_, f) => ellipseAt(f)),
	};
}

export function fixtures(ctx) {
	const recipe = `${VERSION} ${ctx.h264.join(' ')}`;
	return [
		{ name: 'roto-object.mp4', recipe, make: (out) => makeVideo(out, ctx) },
		{
			name: 'roto-object.json',
			recipe: VERSION,
			make: (out) => writeFileSync(out, `${JSON.stringify(truth())}\n`),
		},
	];
}
