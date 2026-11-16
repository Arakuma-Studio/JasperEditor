// Occlusion matte of a planar track (S09 hold-out work; a validation aid, not yet a job): white where something in
// front of the tracked plane hides it (hands passing over a screen), black elsewhere, for the media's whole length.
//
//   pnpm --filter @jasper/engine exec tsx scripts/track-occlusion.ts --file plate.mp4 --track result.json \
//     --ref 176 --out matte.mp4 [--sheet sheet.png]
//
// `result.json` is a TrackResult (`track-file.ts --json`). Per frame (at half resolution): the reference frame's
// plane is warped onto the frame through the tracked quads, the frame's exposure is fitted to it (gain/bias, trimmed
// least squares), and plane pixels whose difference exceeds 4σ (robust scale) plus what a 1 px misalignment of the
// local gradient explains are foreground; an opening/closing removes specks and fills fingers, the edge is softened.
// Lost frames get no matte. Import the result and use it as a Track Matte (Luma Inverted on the screen replacement,
// or Luma on a copy of the plate above it).
//
// Limits: the plane must look like the reference frame (a static screen); a screen playing video, strong reflections
// or exposure changes beyond gain/bias show up as false foreground. Gray only (no colour model of the occluder).
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import type { TrackResult } from '@jasper/api';
import type { Mat } from '@techstark/opencv-js';
import { Ffmpeg, resolveBinaries } from '../src/tools/ffmpeg.ts';
import { loadOpenCv } from '../src/tools/opencv.ts';
import { decodeSpan } from '../src/tracking/decode.ts';
import * as G from '../src/tracking/geometry.ts';

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}
const file = arg('file');
const trackPath = arg('track');
const out = arg('out');
if (!file || !trackPath || !out || !arg('ref')) {
	console.error(
		'usage: track-occlusion.ts --file <video> --track <TrackResult.json> --ref <frame> --out <matte.mp4>',
	);
	process.exit(2);
}
const result = JSON.parse(readFileSync(trackPath, 'utf8')) as TrackResult;
if (result.stride !== 8) throw new Error('A planar TrackResult is needed');
const ref = Number(arg('ref'));
const ff = new Ffmpeg(resolveBinaries());
const probe = await ff.probeJson([
	'-select_streams',
	'v:0',
	'-count_packets',
	'-show_entries',
	'stream=width,height,nb_read_packets',
	file,
]);
const st = (probe.streams as { width: number; height: number; nb_read_packets: string }[])[0]!;
const MW = st.width;
const MH = st.height;
const total = Number(st.nb_read_packets);
const w = Math.round(MW / 2 / 2) * 2;
const h = Math.round(MH / 2 / 2) * 2;
const sx = MW / w;
const sy = MH / h;
const frames = await decodeSpan(ff, {
	file,
	start: 0,
	count: total,
	fps: result.fps,
	width: w,
	height: h,
	scale: true,
});
const { cv } = await loadOpenCv();
const n = result.data.length / 8;
const quadAt = (f: number): number[] | null => {
	const i = f - result.startFrame;
	if (i < 0 || i >= n || result.lost.includes(f)) return null;
	return G.toTrackingPx(result.data.slice(i * 8, i * 8 + 8), sx, sy);
};
const smooth = (img: Uint8Array): Mat => {
	const m = new cv.Mat(h, w, cv.CV_8UC1);
	m.data.set(img);
	const b = new cv.Mat();
	cv.GaussianBlur(m, b, new cv.Size(5, 5), 1.5);
	m.delete();
	return b;
};
const qRef = quadAt(ref);
if (!qRef || !frames[ref]) throw new Error(`The track has no geometry at the reference frame ${ref}`);
const refM = smooth(frames[ref]!);
const kOpen = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
const kClose = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(11, 11));

/** Matte (0..255, `w`×`h`) of frame `f`, or null when the frame has no geometry. */
function matteOf(f: number): Uint8Array | null {
	const qf = quadAt(f);
	if (!qf || !G.quadIsConvex(qf)) return null;
	const fm = smooth(frames[f]!);
	const from = cv.matFromArray(4, 1, cv.CV_32FC2, qRef!);
	const to = cv.matFromArray(4, 1, cv.CV_32FC2, qf);
	const Hm = cv.getPerspectiveTransform(from, to);
	const T = new cv.Mat();
	cv.warpPerspective(refM, T, Hm, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0));
	const gx = new cv.Mat();
	const gy = new cv.Mat();
	cv.Sobel(T, gx, cv.CV_32F, 1, 0, 3, 0.125);
	cv.Sobel(T, gy, cv.CV_32F, 0, 1, 3, 0.125);
	const inner = G.quadInwardLines(qf);
	const b = G.quadBounds(qf);
	const idx: number[] = [];
	for (let y = Math.max(0, Math.floor(b.y0)); y <= Math.min(h - 1, Math.ceil(b.y1)); y++)
		for (let x = Math.max(0, Math.floor(b.x0)); x <= Math.min(w - 1, Math.ceil(b.x1)); x++)
			if (G.quadInsideDistance(inner, x, y) >= 2) idx.push(y * w + x);
	const Td = T.data;
	const Id = fm.data;
	const fit = (sel: number[]) => {
		let c = 0;
		let st0 = 0;
		let si = 0;
		let stt = 0;
		let sti = 0;
		for (const i of sel) {
			const t = Td[i]!;
			const v = Id[i]!;
			c++;
			st0 += t;
			si += v;
			stt += t * t;
			sti += t * v;
		}
		const vt = stt / c - (st0 / c) ** 2;
		const a = vt > 1e-6 ? (sti / c - (st0 / c) * (si / c)) / vt : 1;
		return { a, b: si / c - (a * st0) / c };
	};
	const mask = new cv.Mat(h, w, cv.CV_8UC1, new cv.Scalar(0));
	if (idx.length > 100) {
		let p = fit(idx);
		let sigma = 8;
		for (let k = 0; k < 3; k++) {
			const r = idx.map((i) => Math.abs(Id[i]! - p.a * Td[i]! - p.b));
			const sorted = r.slice().sort((x, y) => x - y);
			sigma = Math.max(1.5, 1.4826 * sorted[sorted.length >> 1]!);
			p = fit(idx.filter((_, j) => r[j]! < 3 * sigma + 2));
		}
		for (const i of idx) {
			const g = Math.hypot(gx.data32F[i]!, gy.data32F[i]!);
			if (Math.abs(Id[i]! - p.a * Td[i]! - p.b) > 4 * sigma + Math.abs(p.a) * g + 6) mask.data[i] = 255;
		}
		cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kOpen);
		cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kClose);
		cv.GaussianBlur(mask, mask, new cv.Size(5, 5), 1.2);
	}
	const data = mask.data.slice();
	for (const m of [fm, from, to, Hm, T, gx, gy, mask]) m.delete();
	return data;
}

// Encoder: OpenH264 (LGPL builds), libx264 when allowed, else lossless FFV1.
const encoders = await new Promise<string>((resolve) => {
	const c = spawn(ff.bins.ffmpeg!, ['-hide_banner', '-encoders']);
	let s = '';
	c.stdout.on('data', (d) => {
		s += d;
	});
	c.on('close', () => resolve(s));
});
const lgplOnly = process.env.JASPER_FFMPEG_LGPL_ONLY === '1';
const venc = /\blibopenh264\b/.test(encoders)
	? ['-c:v', 'libopenh264', '-b:v', '6M', '-pix_fmt', 'yuv420p']
	: !lgplOnly && /\blibx264\b/.test(encoders)
		? ['-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p']
		: ['-c:v', 'ffv1', '-pix_fmt', 'gray'];
const rate = `${result.fps.num}/${result.fps.den}`;
const enc = spawn(
	ff.bins.ffmpeg!,
	[
		...['-hide_banner', '-loglevel', 'error', '-y'],
		...['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-r', rate, '-i', 'pipe:0'],
		...['-vf', `scale=${MW}:${MH}:flags=bicubic`, ...venc, out],
	],
	{ stdio: ['pipe', 'inherit', 'inherit'] },
);
const closed = once(enc, 'close');
const black = new Uint8Array(w * h);
const sheet: { f: number; img: Uint8Array; matte: Uint8Array }[] = [];
let covered = 0;
for (let f = 0; f < frames.length; f++) {
	const m = matteOf(f) ?? black;
	if (m !== black && m.some((v) => v > 127)) covered++;
	if (arg('sheet') && f % Math.max(1, Math.floor(frames.length / 12)) === 0)
		sheet.push({ f, img: frames[f]!, matte: m });
	if (!enc.stdin.write(m)) await once(enc.stdin, 'drain');
}
enc.stdin.end();
const [code] = await closed;
if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
console.log(`${frames.length} frames, ${w}x${h} → ${MW}x${MH} ${out}; foreground found on ${covered} frames`);

if (arg('sheet')) {
	// Contact sheet: frames with the matte in red, 4 per row at quarter size.
	const tw = w / 2;
	const th = h / 2;
	const cols = 4;
	const rows = Math.ceil(sheet.length / cols);
	const rgb = new Uint8Array(cols * tw * rows * th * 3);
	sheet.forEach(({ img, matte }, k) => {
		const ox = (k % cols) * tw;
		const oy = Math.floor(k / cols) * th;
		for (let y = 0; y < th; y++)
			for (let x = 0; x < tw; x++) {
				const i = 2 * y * w + 2 * x;
				const v = img[i]!;
				const a = matte[i]! / 255;
				const o = ((oy + y) * cols * tw + ox + x) * 3;
				rgb[o] = Math.round(v * (1 - a) + 255 * a);
				rgb[o + 1] = Math.round(v * (1 - a * 0.7));
				rgb[o + 2] = Math.round(v * (1 - a * 0.7));
			}
	});
	const raw = `${arg('sheet')}.rgb`;
	writeFileSync(raw, rgb);
	const c = spawn(ff.bins.ffmpeg!, [
		...['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24'],
		...['-s', `${cols * tw}x${rows * th}`, '-i', raw, arg('sheet')!],
	]);
	await once(c, 'close');
}
process.exit(0);
