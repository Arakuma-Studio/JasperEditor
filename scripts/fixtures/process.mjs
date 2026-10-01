// Clip-processing fixtures (wp-m2-process, S07 §8 tests 3-5), loaded by `pnpm fixtures`:
//   shaky.mp4       1080p30, 90 frames: a static test chart panned by a seeded random walk of ±24 px (stabilise)
//   judder.mp4      640x360 30 fps, 60 frames: a 50 fps pan decimated 2-2-1 to 30 fps (de-judder)
//   steady-pan.mp4  640x360 30 fps, 60 frames: an even pan (de-judder must leave it alone)
//   noisy.mkv       1280x720 25 fps, 50 frames: flat grey patches with temporal noise, sigma ≈ 4.8 levels (denoise)
//   blocky.mp4      1280x720 25 fps, 50 frames: the test pattern over-compressed with MPEG-4 part 2 at q 31,
//                   strong 8x8 blocking (deblock)
// Only LGPL filters (lavfi sources, noise, scale, crop, select, blend); H.264 through the shared encoder args.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

/** Deterministic random walk (LCG), clamped to ±limit, as integer offsets. */
export function randomWalk(n, limit = 24, seed = 1234567, step = 6) {
	let s = seed >>> 0;
	const rnd = () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
	const xs = [];
	const ys = [];
	let x = 0;
	let y = 0;
	for (let i = 0; i < n; i++) {
		x = Math.max(-limit, Math.min(limit, x + Math.round((rnd() * 2 - 1) * step)));
		y = Math.max(-limit, Math.min(limit, y + Math.round((rnd() * 2 - 1) * step)));
		xs.push(x);
		ys.push(y);
	}
	return { xs, ys };
}

/** A per-frame lookup expression for crop: if(eq(n,0),v0,if(eq(n,1),v1,…)). */
function table(values, offset) {
	let e = String(values[values.length - 1] + offset);
	for (let i = values.length - 2; i >= 0; i--) e = `if(eq(n\\,${i})\\,${values[i] + offset}\\,${e})`;
	return e;
}

export async function fixtures({ ffmpeg, base, h264 }) {
	const run = (args) => {
		const r = spawnSync(ffmpeg, [...base, ...args], { encoding: 'utf8' });
		if (r.error || r.status !== 0)
			throw new Error(r.stderr || r.error?.message || `ffmpeg exited ${r.status}`);
	};
	// Smooth two-octave noise texture (trackable by optical flow at several px/frame).
	const octave = (w, h, W, H, tag) =>
		`color=gray:s=${w}x${h},noise=alls=100:allf=u,scale=${W}:${H}:flags=bicubic[${tag}]`;
	const texture = (W, H) =>
		`${octave(W / 8, H / 8, W, H, 'a')};${octave(W / 2, H / 2, W, H, 'b')};[a][b]blend=all_mode=average`;
	/** The test pattern with the noise texture blended in: detail everywhere (motion estimation, blocking). */
	const chart = (W, H) =>
		`${texture(W, H)}[n];testsrc2=size=${W}x${H}:rate=1:duration=1,format=rgb24[t];[n]format=rgb24[m];[t][m]blend=all_mode=average`;
	const walk = randomWalk(90);
	return [
		{
			name: 'shaky.mp4',
			recipe: `shaky-v2:${h264.join(' ')}:${walk.xs.join(',')}:${walk.ys.join(',')}`,
			make: async (out) => {
				const still = `${out}.still.png`;
				try {
					run(['-f', 'lavfi', '-i', chart(1968, 1128), '-frames:v', '1', still]);
					run([
						...['-loop', '1', '-framerate', '30', '-i', still],
						...['-vf', `crop=1920:1080:'${table(walk.xs, 24)}':'${table(walk.ys, 24)}',format=yuv420p`],
						...['-frames:v', '90', ...h264, '-an', '-f', 'mp4', '-movflags', '+faststart', out],
					]);
				} finally {
					rmSync(still, { force: true });
				}
			},
		},
		{
			name: 'judder.mp4',
			recipe: `judder-v1:${h264.join(' ')}`,
			make: async (out) => {
				const still = `${out}.still.png`;
				try {
					run(['-f', 'lavfi', '-i', texture(2400, 360), '-frames:v', '1', still]);
					// 50 fps pan at 6 px/frame keeping source frames 0,2,4,5,7,9,… (steps 2-2-1) → 30 fps.
					run([
						...['-loop', '1', '-framerate', '50', '-i', still],
						...[
							'-vf',
							"crop=640:360:'n*6':0,select='eq(mod(n\\,5)\\,0)+eq(mod(n\\,5)\\,2)+eq(mod(n\\,5)\\,4)',setpts=N/(30*TB),format=yuv420p",
						],
						...['-r', '30', '-frames:v', '60', ...h264, '-an', '-f', 'mp4', '-movflags', '+faststart', out],
					]);
				} finally {
					rmSync(still, { force: true });
				}
			},
		},
		{
			name: 'steady-pan.mp4',
			recipe: `steady-pan-v1:${h264.join(' ')}`,
			make: async (out) => {
				const still = `${out}.still.png`;
				try {
					run(['-f', 'lavfi', '-i', texture(2400, 360), '-frames:v', '1', still]);
					run([
						...['-loop', '1', '-framerate', '30', '-i', still],
						...['-vf', "crop=640:360:'n*10':0,format=yuv420p"],
						...['-frames:v', '60', ...h264, '-an', '-f', 'mp4', '-movflags', '+faststart', out],
					]);
				} finally {
					rmSync(still, { force: true });
				}
			},
		},
		{
			name: 'noisy.mkv',
			steps: (out) => [
				[
					...[
						'-f',
						'lavfi',
						'-i',
						'color=c=0x808080:size=1280x720:rate=25:duration=2,drawbox=x=0:y=0:w=640:h=720:color=0x404040:t=fill,noise=alls=8:allf=t,format=yuv420p',
					],
					...['-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'yuv420p', '-an', '-f', 'matroska', out],
				],
			],
		},
		{
			name: 'blocky.mp4',
			recipe: 'blocky-v2',
			make: async (out) => {
				const still = `${out}.still.png`;
				try {
					run(['-f', 'lavfi', '-i', chart(1344, 720), '-frames:v', '1', still]);
					// Intra-only MPEG-4 part 2 at the worst quantiser: every frame shows 8x8 blocks.
					run([
						...['-loop', '1', '-framerate', '25', '-i', still],
						...['-vf', "crop=1280:720:'n*1':0,format=yuv420p"],
						...['-frames:v', '50', '-c:v', 'mpeg4', '-q:v', '31', '-g', '1', '-an', '-f', 'mp4', out],
					]);
				} finally {
					rmSync(still, { force: true });
				}
			},
		},
	];
}
