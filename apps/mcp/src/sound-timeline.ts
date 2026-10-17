// Pictures of a sequence's sound for agents that cannot hear (spec 12 §2.6 "MCP composes PNGs", §2.10
// `view_sound_timeline`, `sound_check` images; wp-note "Phase 5 → WP5.1"): the engine's visual data
// (`POST /api/sound-design/visual`) drawn as one strip — momentary loudness curves of the mix and its stems on a LUFS
// scale, the mix waveform, speech spans, the sound effect clips with their aligned points, the cue ticks, the picture's
// motion curve and the Sound Check's findings as flags — with a timecode axis and a legend. Pure (no I/O); never throws
// on hostile data (lengths are clamped, non-numbers drawn as silence).
import type { SoundVisualResponse } from '@jasper/api';
import { drawText, fitText, LINE_HEIGHT, textWidth } from './pixel-font.ts';
import { canvas, type RgbaImage } from './sound-sheet.ts';

type Rgb = readonly [number, number, number];

export const STEM_COLOURS: Record<'mix' | 'bed' | 'sfx' | 'music' | 'dialogue' | 'ambience', Rgb> = {
	mix: [240, 240, 245],
	bed: [90, 150, 255],
	sfx: [255, 160, 50],
	music: [190, 110, 255],
	dialogue: [90, 220, 120],
	ambience: [60, 200, 200],
};
const TEXT: Rgb = [235, 235, 240];
const DIM: Rgb = [150, 152, 165];
const GRID: Rgb = [60, 60, 72];
const SPEECH: Rgb = [40, 90, 50];
const WAVE: Rgb = [120, 200, 240];
const MOTION: Rgb = [230, 230, 120];
const HERO: Rgb = [255, 90, 90];
const SUPPORT: Rgb = [255, 200, 120];
const SEVERITY: Record<'error' | 'warning' | 'info', Rgb> = {
	error: [255, 60, 60],
	warning: [255, 205, 40],
	info: [150, 150, 160],
};
/** LUFS shown by the curve plot. */
const TOP_LUFS = 0;
const BOTTOM_LUFS = -60;
const MAX_POINTS = 120 * 100 + 1;

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function blend(img: RgbaImage, x: number, y: number, c: Rgb, a = 1): void {
	if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
	const o = (y * img.width + x) * 4;
	img.data[o] = Math.round(img.data[o]! * (1 - a) + c[0] * a);
	img.data[o + 1] = Math.round(img.data[o + 1]! * (1 - a) + c[1] * a);
	img.data[o + 2] = Math.round(img.data[o + 2]! * (1 - a) + c[2] * a);
}
function fillRect(img: RgbaImage, x: number, y: number, w: number, h: number, c: Rgb, a = 1): void {
	for (let yy = Math.max(0, Math.round(y)); yy < Math.min(img.height, Math.round(y + h)); yy++)
		for (let xx = Math.max(0, Math.round(x)); xx < Math.min(img.width, Math.round(x + w)); xx++)
			blend(img, xx, yy, c, a);
}
function vline(img: RgbaImage, x: number, y0: number, y1: number, c: Rgb, dashed = false, a = 1): void {
	const xi = Math.round(x);
	for (let y = Math.round(Math.min(y0, y1)); y <= Math.round(Math.max(y0, y1)); y++) {
		if (dashed && Math.floor(y / 3) % 2 === 1) continue;
		blend(img, xi, y, c, a);
	}
}
function hline(img: RgbaImage, x0: number, x1: number, y: number, c: Rgb, a = 1): void {
	for (let x = Math.round(x0); x <= Math.round(x1); x++) blend(img, x, Math.round(y), c, a);
}
/** A polyline through (x, y) points (1 px, connected vertically). */
function polyline(img: RgbaImage, ys: readonly number[], x0: number, w: number, c: Rgb): void {
	const n = ys.length;
	if (n === 0) return;
	let prev: number | null = null;
	for (let px = 0; px < w; px++) {
		// the loudest value over the points this pixel covers (peaks survive downsampling)
		const a = Math.floor((px / w) * n);
		const b = Math.max(a + 1, Math.floor(((px + 1) / w) * n));
		let y = Number.POSITIVE_INFINITY;
		for (let i = a; i < Math.min(n, b); i++) y = Math.min(y, ys[i]!);
		if (!Number.isFinite(y)) continue;
		if (prev !== null) vline(img, x0 + px, prev, y, c);
		else blend(img, x0 + px, Math.round(y), c);
		prev = y;
	}
}

export type TimelineCells = {
	/** Pixel x of a sequence frame: x = plotX + (frame − range.start) · pxPerFrame. */
	plotX: number;
	plotWidth: number;
	pxPerFrame: number;
	lanes: { name: string; y: number; height: number; what: string }[];
	cues: {
		cueId: string;
		frame: number;
		timecode: string;
		x: number;
		kind: string;
		weight: string;
		filled: boolean;
	}[];
	issues: {
		id: string;
		code: string;
		severity: string;
		frame: number | null;
		x: number | null;
		text: string;
	}[];
	peaks: Record<string, number | null>;
	normalization: SoundVisualResponse['normalization'];
};

/**
 * Draws the visual data of a range as one strip `width` px wide (see the module docs). Returns the picture and the
 * geometry, so an agent can map what it sees back to frames (`cells`).
 */
export function drawSoundTimeline(
	v: SoundVisualResponse,
	opts: { width?: number; title?: string } = {},
): { image: RgbaImage; cells: TimelineCells } {
	const W = Math.max(480, Math.min(2400, Math.round(num(opts.width, 1200))));
	const plotX = 54;
	const plotW = W - plotX - 12;
	const headerH = LINE_HEIGHT * 2 + 6;
	const curveY = headerH + 4;
	const curveH = 170;
	const waveY = curveY + curveH + 6;
	const waveH = 44;
	const clipY = waveY + waveH + 4;
	const clipH = 14;
	const cueY = clipY + clipH + 4;
	const cueH = 22;
	const motionY = cueY + cueH + 4;
	const motionH = 26;
	const flagY = motionY + motionH + 4;
	const flagH = 22;
	const axisY = flagY + flagH + 2;
	const legendY = axisY + LINE_HEIGHT + 4;
	const H = legendY + LINE_HEIGHT + 6;
	const img = canvas(W, H);
	const start = num(v.range?.start, 0);
	const end = Math.max(start + 1, num(v.range?.end, start + 1));
	const fps = Math.max(1e-6, num(v.fps?.num, 30) / Math.max(1, num(v.fps?.den, 1)));
	const pxPerFrame = plotW / (end - start);
	const xOf = (frame: number) => plotX + (frame - start) * pxPerFrame;
	const yOf = (lufs: number) =>
		curveY +
		((TOP_LUFS - Math.max(BOTTOM_LUFS, Math.min(TOP_LUFS, lufs))) / (TOP_LUFS - BOTTOM_LUFS)) * curveH;
	// header
	drawText(
		img,
		fitText(opts.title ?? `Sound ${v.rangeTimecode?.start ?? ''} - ${v.rangeTimecode?.end ?? ''}`, W - 12),
		6,
		4,
		TEXT,
	);
	const norm = v.normalization;
	drawText(
		img,
		fitText(
			norm?.applied
				? `As delivered (normalisation ${num(norm.gainDb, 0) >= 0 ? '+' : ''}${num(norm.gainDb, 0).toFixed(1)} dB). Curves: momentary loudness, LUFS.`
				: `As mixed (${norm?.reason ?? 'no normalisation'}). Curves: momentary loudness, LUFS.`,
			W - 12,
		),
		6,
		4 + LINE_HEIGHT,
		DIM,
	);
	// curve plot: grid at −14, −23, −40 LUFS
	fillRect(img, plotX, curveY, plotW, curveH, [24, 24, 30]);
	for (const g of [-6, -14, -23, -40, -60]) {
		const y = yOf(g);
		hline(img, plotX, plotX + plotW - 1, y, GRID);
		drawText(img, `${g}`, 4, Math.round(y - 3), DIM);
	}
	// speech spans (shaded)
	for (const s of Array.isArray(v.speech) ? v.speech.slice(0, 2000) : []) {
		const a = xOf(num(s[0], 0) * fps);
		const b = xOf(num(s[1], 0) * fps);
		fillRect(
			img,
			Math.max(plotX, a),
			curveY,
			Math.min(plotX + plotW, b) - Math.max(plotX, a),
			curveH,
			SPEECH,
			0.5,
		);
	}
	const curves = v.curves ?? ({} as SoundVisualResponse['curves']);
	const peaks: Record<string, number | null> = {};
	for (const name of ['bed', 'music', 'dialogue', 'ambience', 'sfx', 'mix'] as const) {
		const raw = curves[name]?.momentary;
		const vals = Array.isArray(raw) ? raw.slice(0, MAX_POINTS).map((x) => num(x, -120)) : [];
		const max = vals.length ? Math.max(...vals) : -120;
		peaks[name] = max > -119 ? Math.round(max * 10) / 10 : null;
		if (max <= -119) continue;
		polyline(img, vals.map(yOf), plotX, plotW, STEM_COLOURS[name]);
	}
	// waveform: the mix's 10 ms sample peaks, mirrored, −60…0 dBFS
	fillRect(img, plotX, waveY, plotW, waveH, [20, 20, 26]);
	const wave = Array.isArray(v.waveformPeakDb) ? v.waveformPeakDb.slice(0, MAX_POINTS) : [];
	const mid = waveY + waveH / 2;
	for (let px = 0; px < plotW && wave.length; px++) {
		const a = Math.floor((px / plotW) * wave.length);
		const b = Math.max(a + 1, Math.floor(((px + 1) / plotW) * wave.length));
		let m = -120;
		for (let i = a; i < Math.min(wave.length, b); i++) m = Math.max(m, num(wave[i], -120));
		const amp = Math.max(0, Math.min(1, (m + 60) / 60)) * (waveH / 2 - 1);
		vline(img, plotX + px, mid - amp, mid + amp, WAVE);
	}
	drawText(img, 'wave', 4, Math.round(mid - 3), DIM);
	// sound effect clips and their aligned points
	drawText(img, 'sfx', 4, clipY + 3, DIM);
	for (const c of Array.isArray(v.clips) ? v.clips.slice(0, 500) : []) {
		const a = Math.max(plotX, xOf(num(c.start, start)));
		const b = Math.min(plotX + plotW, xOf(num(c.end, start)));
		if (b > a) fillRect(img, a, clipY, b - a, clipH, STEM_COLOURS.sfx, 0.45);
		if (c.alignedFrame !== null && Number.isFinite(c.alignedFrame)) {
			const x = xOf(c.alignedFrame);
			if (x >= plotX && x < plotX + plotW) vline(img, x, clipY, clipY + clipH - 1, TEXT);
		}
	}
	// cue ticks: hero tall red, support short amber; unfilled dashed; muted dim
	drawText(img, 'cues', 4, cueY + 6, DIM);
	const cues = (Array.isArray(v.cues) ? v.cues.slice(0, 2000) : []).map((c) => {
		const x = xOf(num(c.frame, start));
		const hero = c.weight === 'hero';
		const colour = c.muted ? DIM : hero ? HERO : SUPPORT;
		const top = hero ? cueY : cueY + cueH / 3;
		vline(img, x, top, cueY + cueH - 1, colour, !c.filled);
		if (hero) fillRect(img, x - 2, top, 5, 4, colour);
		// the cue line through the curves, faint
		vline(img, x, curveY, curveY + curveH - 1, colour, true, 0.35);
		return {
			cueId: String(c.cueId),
			frame: num(c.frame, start),
			timecode: String(c.timecode),
			x: Math.round(x),
			kind: String(c.kind),
			weight: String(c.weight),
			filled: c.filled === true,
		};
	});
	// motion: speed per frame, normalised to the range's fastest
	drawText(img, 'move', 4, motionY + 8, DIM);
	const speed = Array.isArray(v.motion?.speed) ? v.motion.speed.slice(0, 200_000).map((x) => num(x, 0)) : [];
	const smax = Math.max(1e-6, ...speed);
	if (speed.some((s) => s > 0))
		polyline(
			img,
			speed.map((s) => motionY + motionH - 1 - (s / smax) * (motionH - 2)),
			Math.round(xOf(num(v.motion?.startFrame, start))),
			Math.max(1, Math.round(speed.length * pxPerFrame)),
			MOTION,
		);
	// findings as flags
	drawText(img, 'check', 4, flagY + 7, DIM);
	let labelEnd = -1;
	const issues = (Array.isArray(v.issues) ? v.issues.slice(0, 500) : []).map((i) => {
		const sev = (
			['error', 'warning', 'info'].includes(i.severity) ? i.severity : 'info'
		) as keyof typeof SEVERITY;
		const f = i.frame ?? i.range?.start;
		let x: number | null = null;
		if (i.range) {
			const a = Math.max(plotX, xOf(i.range.start));
			const b = Math.min(plotX + plotW, xOf(i.range.end));
			if (b > a) fillRect(img, a, flagY + flagH - 5, b - a, 4, SEVERITY[sev], 0.8);
		}
		if (f !== undefined) {
			x = xOf(f);
			if (x >= plotX && x < plotX + plotW) {
				vline(img, x, flagY, flagY + flagH - 1, SEVERITY[sev]);
				fillRect(img, x, flagY, 6, 5, SEVERITY[sev]);
				const label = i.code.replace(/_/g, ' ').slice(0, 14);
				// labels never overlap: a flag too close to the previous label keeps its mark only
				if (x + 8 + textWidth(label) < W && x + 8 > labelEnd) {
					drawText(img, label, x + 8, flagY + 1, SEVERITY[sev]);
					labelEnd = x + 8 + textWidth(label) + 4;
				}
				vline(img, x, curveY, curveY + curveH - 1, SEVERITY[sev], true, 0.5);
			}
		}
		return {
			id: String(i.id),
			code: String(i.code),
			severity: sev,
			frame: f ?? null,
			x: x === null ? null : Math.round(x),
			text: String(i.text).slice(0, 300),
		};
	});
	// time axis: a tick per second (or per 5 / 10 s on long ranges), timecodes every few ticks
	const seconds = (end - start) / fps;
	const step = seconds <= 12 ? 1 : seconds <= 40 ? 5 : 10;
	let lastLabel = -1e9;
	for (let s = Math.ceil(start / fps / step) * step; s * fps < end; s += step) {
		const x = xOf(s * fps);
		vline(img, x, axisY, axisY + 3, DIM);
		const hh = Math.floor(s / 3600);
		const mm = Math.floor((s % 3600) / 60);
		const ss = Math.floor(s % 60);
		const label = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
		if (x - lastLabel > textWidth(label) + 8 && x + textWidth(label) < W) {
			drawText(img, label, x + 2, axisY + 1, DIM);
			lastLabel = x;
		}
	}
	// legend
	let lx = 6;
	for (const [name, c] of Object.entries(STEM_COLOURS)) {
		fillRect(img, lx, legendY + 2, 10, 4, c);
		drawText(img, name, lx + 13, legendY, TEXT);
		lx += 13 + textWidth(name) + 12;
	}
	for (const [name, c] of [
		['speech', SPEECH],
		['hero cue', HERO],
		['support cue', SUPPORT],
		['motion', MOTION],
		['error', SEVERITY.error],
		['warning', SEVERITY.warning],
	] as const) {
		if (lx + 40 > W) break;
		fillRect(img, lx, legendY + 2, 10, 4, c);
		drawText(img, name, lx + 13, legendY, TEXT);
		lx += 13 + textWidth(name) + 12;
	}
	return {
		image: img,
		cells: {
			plotX,
			plotWidth: plotW,
			pxPerFrame: Math.round(pxPerFrame * 1000) / 1000,
			lanes: [
				{
					name: 'curves',
					y: curveY,
					height: curveH,
					what: 'momentary loudness (LUFS, 0 at top, −60 at bottom; grid −6, −14, −23, −40, −60); green shading = speech',
				},
				{ name: 'wave', y: waveY, height: waveH, what: 'mix sample peaks per 10 ms (−60…0 dBFS), mirrored' },
				{
					name: 'sfx',
					y: clipY,
					height: clipH,
					what: 'sound effect clips (orange) and where their aligned point plays (white line)',
				},
				{
					name: 'cues',
					y: cueY,
					height: cueH,
					what: 'cue ticks: hero tall red, support short amber, dashed = unfilled, grey = muted',
				},
				{
					name: 'move',
					y: motionY,
					height: motionH,
					what: 'picture motion speed (the fastest keyframed layer), normalised',
				},
				{
					name: 'check',
					y: flagY,
					height: flagH,
					what: 'Sound Check findings: red error, yellow warning, grey info',
				},
			],
			cues,
			issues,
			peaks,
			normalization: v.normalization,
		},
	};
}
