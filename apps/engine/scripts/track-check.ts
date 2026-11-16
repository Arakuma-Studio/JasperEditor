// Alignment check of a planar track without ground truth (real plates; S09 validation aid).
//
//   pnpm --filter @jasper/engine exec tsx scripts/track-check.ts --file clip.mp4 --track result.json \
//     [--ref 176] [--every 1] [--csv out.csv]
//
// `result.json` is a TrackResult (`track-file.ts --json`). Every frame's tracked quad and the reference frame's quad
// are rectified to 960×600; 4×3 tiles of the reference rectification are found again in the frame's rectification by
// normalised cross-correlation (±40 px, sub-pixel parabola). The frame's misalignment is the median tile shift (px
// of the 960×600 rectification) over the tiles that match (NCC ≥ 0.6 and textured); occluders and frames with less
// than 4 matching tiles are reported as unmeasured. Independent of the tracker's own estimation.
import { readFileSync, writeFileSync } from 'node:fs';
import type { TrackResult } from '@jasper/api';
import type { Mat } from '@techstark/opencv-js';
import { Ffmpeg, resolveBinaries } from '../src/tools/ffmpeg.ts';
import { loadOpenCv } from '../src/tools/opencv.ts';
import { decodeSpan } from '../src/tracking/decode.ts';

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}
const file = arg('file');
const trackPath = arg('track');
if (!file || !trackPath) {
	console.error('usage: track-check.ts --file <video> --track <TrackResult.json> [--ref N] [--csv out.csv]');
	process.exit(2);
}
const result = JSON.parse(readFileSync(trackPath, 'utf8')) as TrackResult;
const n = result.data.length / 8;
const ff = new Ffmpeg(resolveBinaries());
const probe = await ff.probeJson(['-select_streams', 'v:0', '-show_entries', 'stream=width,height', file]);
const st = (probe.streams as { width: number; height: number }[])[0]!;
const frames = await decodeSpan(ff, {
	file,
	start: result.startFrame,
	count: n,
	fps: result.fps,
	width: st.width,
	height: st.height,
	scale: false,
});
const { cv } = await loadOpenCv();
const RW = 960;
const RH = 600;
const quadAt = (i: number) => result.data.slice(i * 8, i * 8 + 8);
const refIdx = Number(arg('ref') ?? result.startFrame + result.confidence.indexOf(1)) - result.startFrame;

function rectify(img: Uint8Array, quad: number[]): Mat {
	const src = new cv.Mat(st.height, st.width, cv.CV_8UC1);
	src.data.set(img);
	const from = cv.matFromArray(4, 1, cv.CV_32FC2, quad);
	const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, RW, 0, RW, RH, 0, RH]);
	const M = cv.getPerspectiveTransform(from, to);
	const out = new cv.Mat();
	cv.warpPerspective(src, out, M, new cv.Size(RW, RH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0));
	for (const m of [src, from, to, M]) m.delete();
	return out;
}

const ref = rectify(frames[refIdx]!, quadAt(refIdx));
const TW = 160;
const TH = 120;
const S = 40;
const tiles: { x: number; y: number; tpl: Mat }[] = [];
for (let ty = 0; ty < 3; ty++)
	for (let tx = 0; tx < 4; tx++) {
		const x = Math.round(S + 20 + tx * ((RW - 2 * S - 40 - TW) / 3));
		const y = Math.round(S + 20 + ty * ((RH - 2 * S - 40 - TH) / 2));
		const tpl = ref.roi(new cv.Rect(x, y, TW, TH));
		const mean = new cv.Mat();
		const sd = new cv.Mat();
		cv.meanStdDev(tpl, mean, sd);
		const textured = sd.data64F[0]! >= 6;
		mean.delete();
		sd.delete();
		if (textured) tiles.push({ x, y, tpl });
		else tpl.delete();
	}

const rows: string[] = ['frame,confidence,lost,shift_px,tiles'];
const shifts: number[] = [];
let unmeasured = 0;
const res = new cv.Mat();
for (let i = 0; i < n; i++) {
	const f = result.startFrame + i;
	const lost = result.lost.includes(f);
	const rect = rectify(frames[i]!, quadAt(i));
	const found: number[] = [];
	for (const t of tiles) {
		const x0 = Math.max(0, t.x - S);
		const y0 = Math.max(0, t.y - S);
		const win = rect.roi(new cv.Rect(x0, y0, Math.min(RW - x0, TW + 2 * S), Math.min(RH - y0, TH + 2 * S)));
		cv.matchTemplate(win, t.tpl, res, cv.TM_CCOEFF_NORMED);
		win.delete();
		const mm = cv.minMaxLoc(res);
		if (!(mm.maxVal >= 0.6)) continue;
		const { x, y } = mm.maxLoc;
		const at = (xx: number, yy: number) => res.data32F[yy * res.cols + xx]!;
		const sub = (a: number, b: number, c: number) => {
			const d = a - 2 * b + c;
			return d < 0 ? (0.5 * (a - c)) / d : 0;
		};
		const dx = x > 0 && x < res.cols - 1 ? sub(at(x - 1, y), at(x, y), at(x + 1, y)) : 0;
		const dy = y > 0 && y < res.rows - 1 ? sub(at(x, y - 1), at(x, y), at(x, y + 1)) : 0;
		found.push(Math.hypot(x0 + x + dx - t.x, y0 + y + dy - t.y));
	}
	rect.delete();
	found.sort((a, b) => a - b);
	const shift = found.length >= 4 ? found[Math.floor(found.length / 2)]! : null;
	if (shift === null) unmeasured++;
	else shifts.push(shift);
	rows.push(
		`${f},${result.confidence[i]},${lost ? 1 : 0},${shift === null ? '' : shift.toFixed(3)},${found.length}`,
	);
}
const sorted = shifts.slice().sort((a, b) => a - b);
const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? Number.NaN;
const mean = shifts.reduce((a, b) => a + b, 0) / Math.max(1, shifts.length);
const conf = result.confidence.reduce((a, b) => a + b, 0) / Math.max(1, n);
console.log(
	`${n} frames (${tiles.length} reference tiles): misalignment of the rectified plane (px at ${RW}x${RH}) ` +
		`mean ${mean.toFixed(2)}, median ${pct(0.5).toFixed(2)}, p90 ${pct(0.9).toFixed(2)}, max ${pct(1).toFixed(2)}; ` +
		`frames > 2 px ${shifts.filter((s) => s > 2).length}, unmeasured ${unmeasured}; ` +
		`mean confidence ${conf.toFixed(3)}, lost ${result.lost.length}`,
);
if (arg('csv')) writeFileSync(arg('csv')!, `${rows.join('\n')}\n`);
process.exit(0);
