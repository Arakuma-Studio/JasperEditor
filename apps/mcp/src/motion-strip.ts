// A picture of the picture's motion for agents (spec 12 §2.10 `analyze_picture_motion`; wp-note "Phase 6 → WP6.2"):
// the engine's measured motion curve (`motion-analysis` job) drawn as one strip — optional frame thumbnails at the
// detected events on top, then the speed of what moves (screen diagonals per second, with the MOVE_ON threshold
// dashed), the share of the frame that moves (shaded) and the change motion does not explain (cuts, flashes), with
// every move's span, every landing and cut marked and labelled, and a timecode axis. Pure (no I/O); never throws on
// hostile data (lengths are clamped, non-numbers drawn as zero).
import type { MotionAnalysisResult } from '@jasper/api';
import { MOVE_ON } from '@jasper/project';
import { drawText, fitText, LINE_HEIGHT, textWidth } from './pixel-font.ts';
import { blend, canvas, type RgbaImage } from './sound-sheet.ts';

type Rgb = readonly [number, number, number];
const TEXT: Rgb = [235, 235, 240];
const DIM: Rgb = [150, 152, 165];
const GRID: Rgb = [60, 60, 72];
const SPEED: Rgb = [240, 220, 90];
const AREA: Rgb = [90, 150, 255];
const RESIDUAL: Rgb = [255, 90, 90];
const MOVE: Rgb = [90, 200, 255];
const LAND: Rgb = [255, 160, 50];
const CUT: Rgb = [255, 70, 70];
const MAX_POINTS = 200_000;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function fillRect(img: RgbaImage, x: number, y: number, w: number, h: number, c: Rgb, a = 1): void {
	for (let yy = Math.max(0, Math.round(y)); yy < Math.min(img.height, Math.round(y + h)); yy++)
		for (let xx = Math.max(0, Math.round(x)); xx < Math.min(img.width, Math.round(x + w)); xx++)
			blend(img, xx, yy, c, a);
}
export function vline(
	img: RgbaImage,
	x: number,
	y0: number,
	y1: number,
	c: Rgb,
	dashed = false,
	a = 1,
): void {
	const xi = Math.round(x);
	for (let y = Math.round(Math.min(y0, y1)); y <= Math.round(Math.max(y0, y1)); y++) {
		if (dashed && Math.floor(y / 3) % 2 === 1) continue;
		blend(img, xi, y, c, a);
	}
}
export function hline(
	img: RgbaImage,
	x0: number,
	x1: number,
	y: number,
	c: Rgb,
	dashed = false,
	a = 1,
): void {
	for (let x = Math.round(x0); x <= Math.round(x1); x++) {
		if (dashed && Math.floor(x / 4) % 2 === 1) continue;
		blend(img, x, Math.round(y), c, a);
	}
}
/** Copies `src` scaled (nearest) into `dst` at (x, y) with size w × h. */
export function blit(dst: RgbaImage, src: RgbaImage, x: number, y: number, w: number, h: number): void {
	for (let yy = 0; yy < h; yy++)
		for (let xx = 0; xx < w; xx++) {
			const sx = Math.min(src.width - 1, Math.floor((xx * src.width) / w));
			const sy = Math.min(src.height - 1, Math.floor((yy * src.height) / h));
			const so = (sy * src.width + sx) * 4;
			blend(dst, x + xx, y + yy, [src.data[so]!, src.data[so + 1]!, src.data[so + 2]!]);
		}
}

export type MotionStripCells = {
	width: number;
	height: number;
	/** The curve plot's box (pixels). */
	plot: { x: number; y: number; width: number; height: number };
	/** Full-scale speed of the plot (screen diagonals per second). */
	speedScale: number;
	/** Each event's x pixel and label. */
	events: { kind: string; frame: number; x: number; label: string }[];
	/** Thumbnail cells (frame, box). */
	thumbs: { frame: number; x: number; y: number; width: number; height: number }[];
};

/**
 * Draws the motion strip of an analysis. `thumbs` (optional) are rendered frames shown above the plot, each labelled
 * with its frame's event; `timecode` names a sequence frame.
 */
export function drawMotionStrip(
	r: MotionAnalysisResult,
	opts: {
		width?: number;
		title?: string;
		timecode: (frame: number) => string;
		thumbs?: { frame: number; image: RgbaImage; label: string }[];
	},
): { image: RgbaImage; cells: MotionStripCells } {
	const W = Math.max(480, Math.min(2400, Math.round(opts.width ?? 1200)));
	const n = Math.max(0, Math.min(MAX_POINTS, r.curve.speed.length));
	const start = Math.round(num(r.range.start));
	const frames = Math.max(1, n);
	const pad = 8;
	const thumbs = (opts.thumbs ?? []).slice(0, 8);
	const slot = thumbs.length ? Math.floor((W - pad * (thumbs.length + 1)) / thumbs.length) : 0;
	const aspect = r.curve.width > 0 && r.curve.height > 0 ? r.curve.height / r.curve.width : 9 / 16;
	// the picture's aspect, at most 160 px high (narrower than its slot then, centred in it)
	const th = thumbs.length ? Math.min(160, Math.round(slot * aspect)) : 0;
	const tw = thumbs.length ? Math.min(slot, Math.round(th / aspect)) : 0;
	const thumbRow = thumbs.length ? th + LINE_HEIGHT + 2 * pad : 0;
	const header = LINE_HEIGHT * 2 + pad;
	const plotH = 160;
	const axisH = LINE_HEIGHT + 6;
	const legendH = LINE_HEIGHT + 4;
	const H = header + thumbRow + plotH + axisH + legendH + pad * 2;
	const img = canvas(W, H);
	const title =
		opts.title ??
		`Picture motion ${opts.timecode(start)}–${opts.timecode(start + n)} · ${n} frames · ${r.events.length} events${r.cached ? ' (cached)' : ''}`;
	drawText(img, fitText(title, W - 2 * pad), pad, pad, TEXT);
	drawText(
		img,
		fitText(
			`fingerprint ${r.fingerprint.slice(0, 12)} · analysed at ${r.curve.width}x${r.curve.height}`,
			W - 2 * pad,
		),
		pad,
		pad + LINE_HEIGHT,
		DIM,
	);
	const cells: MotionStripCells = {
		width: W,
		height: H,
		plot: { x: pad, y: 0, width: W - 2 * pad, height: plotH },
		speedScale: 1,
		events: [],
		thumbs: [],
	};
	// thumbnails
	thumbs.forEach((t, i) => {
		const x = pad + i * (slot + pad) + Math.floor((slot - tw) / 2);
		const y = header + pad;
		blit(img, t.image, x, y, tw, th);
		drawText(img, fitText(t.label, tw), x, y + th + 2, TEXT);
		cells.thumbs.push({ frame: t.frame, x, y, width: tw, height: th });
	});
	// plot
	const px = pad;
	const py = header + thumbRow;
	const pw = W - 2 * pad;
	cells.plot = { x: px, y: py, width: pw, height: plotH };
	fillRect(img, px, py, pw, plotH, [24, 24, 30]);
	let peak = 0;
	for (let i = 0; i < n; i++) peak = Math.max(peak, num(r.curve.speed[i]));
	const scale = Math.max(0.5, Math.ceil(peak * 1.15 * 4) / 4);
	cells.speedScale = scale;
	const xOf = (frame: number) => px + ((frame - start) / frames) * pw;
	// move spans
	for (const e of r.events)
		if (e.kind === 'move' && e.start !== undefined && e.end !== undefined)
			fillRect(img, xOf(e.start), py, Math.max(1, xOf(e.end) - xOf(e.start)), plotH, MOVE, 0.18);
	// area (shaded from the bottom, full scale = the whole frame)
	for (let x = 0; x < pw; x++) {
		const a = Math.floor((x / pw) * n);
		const b = Math.max(a + 1, Math.floor(((x + 1) / pw) * n));
		let v = 0;
		for (let i = a; i < Math.min(n, b); i++) v = Math.max(v, num(r.curve.area[i]));
		const h = Math.round(Math.min(1, v) * (plotH * 0.35));
		if (h > 0) vline(img, px + x, py + plotH - 1, py + plotH - h, AREA, false, 0.35);
	}
	// grid + MOVE_ON
	for (const v of [scale / 2, scale]) hline(img, px, px + pw - 1, py + plotH - (v / scale) * plotH, GRID);
	hline(img, px, px + pw - 1, py + plotH - (MOVE_ON / scale) * plotH, DIM, true);
	drawText(img, `${scale.toFixed(2)} screens/s`, px + 2, py + 2, DIM);
	drawText(img, 'move threshold', px + 2, py + plotH - (MOVE_ON / scale) * plotH - LINE_HEIGHT, DIM);
	// residual (cuts) and speed polylines (max per pixel so peaks survive)
	const series = (vals: readonly number[], full: number, c: Rgb) => {
		let prev: number | null = null;
		for (let x = 0; x < pw; x++) {
			const a = Math.floor((x / pw) * n);
			const b = Math.max(a + 1, Math.floor(((x + 1) / pw) * n));
			let v = 0;
			for (let i = a; i < Math.min(n, b); i++) v = Math.max(v, num(vals[i]));
			const y = py + plotH - 1 - Math.min(1, v / full) * (plotH - 2);
			if (prev !== null) vline(img, px + x, prev, y, c);
			else blend(img, px + x, Math.round(y), c);
			prev = y;
		}
	};
	series(r.curve.residual, 0.5, RESIDUAL);
	series(r.curve.speed, scale, SPEED);
	// events: ticks and labels (skipped when they would overlap the previous label)
	let lastLabelEnd = -1;
	for (const e of r.events) {
		const x = xOf(e.frame);
		const c = e.kind === 'move' ? MOVE : e.kind === 'land' ? LAND : CUT;
		vline(img, x, py, py + plotH - 1, c, e.kind === 'move');
		const label = `${e.kind === 'move' ? 'M' : e.kind === 'land' ? 'L' : 'C'} ${opts.timecode(e.frame)}`;
		cells.events.push({ kind: e.kind, frame: e.frame, x: Math.round(x), label });
		const lx = Math.min(px + pw - textWidth(label), Math.max(px, Math.round(x) + 2));
		if (lx > lastLabelEnd + 4) {
			drawText(img, label, lx, py + LINE_HEIGHT + 2, c);
			lastLabelEnd = lx + textWidth(label);
		}
	}
	// axis
	const ay = py + plotH + 3;
	const ticks = Math.max(2, Math.min(10, Math.floor(pw / 140)));
	for (let k = 0; k <= ticks; k++) {
		const f = start + Math.round((k / ticks) * n);
		const x = xOf(f);
		vline(img, x, py + plotH, py + plotH + 2, DIM);
		const tc = opts.timecode(f);
		drawText(
			img,
			tc,
			Math.min(px + pw - textWidth(tc), Math.max(px, Math.round(x - textWidth(tc) / 2))),
			ay,
			DIM,
		);
	}
	// legend
	const ly = ay + axisH;
	let lx = pad;
	for (const [label, c] of [
		['speed', SPEED],
		['moving area', AREA],
		['unexplained change', RESIDUAL],
		['M move span', MOVE],
		['L landing', LAND],
		['C cut', CUT],
	] as const) {
		fillRect(img, lx, ly + 2, 10, 5, c);
		drawText(img, label, lx + 14, ly, TEXT);
		lx += 14 + textWidth(label) + 14;
	}
	return { image: img, cells };
}
