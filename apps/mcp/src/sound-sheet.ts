// Pictures of library sounds for agents that cannot hear (spec 12 §1, §2.10 view_sounds): the engine's visual data
// (`GET /api/sounds/:id/visual`: peaks per 10 ms and a 64-band log spectrogram) drawn as a waveform over its
// spectrogram, with the peak (`descriptors.peakSec`) as a vertical line and the end of the decay (peak + `decayMs`,
// −20 dB) as a dashed one, plus the sound's number, id and key numbers printed above. Pure (no I/O).
import type { SoundEntry, SoundVisual } from '@jasper/api';
import { drawText, fitText, LINE_HEIGHT, textWidth } from './pixel-font.ts';

export type RgbaImage = { width: number; height: number; data: Uint8Array };
type Rgb = readonly [number, number, number];

const BG: Rgb = [18, 18, 22];
const HEADER_BG: Rgb = [34, 34, 40];
const TEXT: Rgb = [235, 235, 240];
const DIM: Rgb = [170, 172, 182];
const WAVE: Rgb = [120, 220, 255];
const PEAK: Rgb = [255, 70, 70];
const DECAY: Rgb = [255, 210, 60];
const ONSET: Rgb = [120, 255, 140];
const GRID: Rgb = [90, 90, 100];
const BAD: Rgb = [255, 140, 90];
const OK: Rgb = [140, 230, 140];

/** Spectrogram colours: dark blue-black → violet → orange → pale yellow (level 0…1). */
const RAMP: readonly (readonly [number, Rgb])[] = [
	[0, [10, 10, 20]],
	[0.35, [70, 20, 110]],
	[0.6, [190, 55, 80]],
	[0.82, [250, 150, 40]],
	[1, [255, 250, 190]],
];

function ramp(v: number): Rgb {
	const x = Math.min(1, Math.max(0, v));
	for (let i = 1; i < RAMP.length; i++) {
		const [p1, c1] = RAMP[i]!;
		const [p0, c0] = RAMP[i - 1]!;
		if (x <= p1) {
			const t = (x - p0) / (p1 - p0 || 1);
			return [
				Math.round(c0[0] + (c1[0] - c0[0]) * t),
				Math.round(c0[1] + (c1[1] - c0[1]) * t),
				Math.round(c0[2] + (c1[2] - c0[2]) * t),
			];
		}
	}
	return RAMP.at(-1)![1];
}

export function canvas(width: number, height: number, bg: Rgb = BG): RgbaImage {
	const data = new Uint8Array(width * height * 4);
	for (let i = 0; i < data.length; i += 4) {
		data[i] = bg[0];
		data[i + 1] = bg[1];
		data[i + 2] = bg[2];
		data[i + 3] = 255;
	}
	return { width, height, data };
}

function blend(img: RgbaImage, x: number, y: number, c: Rgb, a = 1): void {
	if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
	const o = (y * img.width + x) * 4;
	img.data[o] = Math.round(img.data[o]! * (1 - a) + c[0] * a);
	img.data[o + 1] = Math.round(img.data[o + 1]! * (1 - a) + c[1] * a);
	img.data[o + 2] = Math.round(img.data[o + 2]! * (1 - a) + c[2] * a);
}

function fillRect(img: RgbaImage, x: number, y: number, w: number, h: number, c: Rgb, a = 1): void {
	for (let yy = Math.max(0, y); yy < Math.min(img.height, y + h); yy++)
		for (let xx = Math.max(0, x); xx < Math.min(img.width, x + w); xx++) blend(img, xx, yy, c, a);
}

/** Vertical line at x from y0 to y1 (inclusive); dashed = 3 on, 3 off. */
function vline(img: RgbaImage, x: number, y0: number, y1: number, c: Rgb, width = 1, dashed = false): void {
	for (let y = y0; y <= y1; y++) {
		if (dashed && Math.floor((y - y0) / 3) % 2 === 1) continue;
		for (let w = 0; w < width; w++) blend(img, x + w, y, c);
	}
}

function decodeU8(b64: string, expected: number): Uint8Array {
	const raw = Buffer.from(b64, 'base64');
	// Never trust the declared size: short data reads as silence, extra data is ignored.
	const out = new Uint8Array(Math.max(0, expected));
	out.set(raw.subarray(0, out.length));
	return out;
}

/** The decoded visual data, bounded (hostile or damaged responses never allocate more than the caps). */
export type DecodedVisual = {
	coveredSec: number;
	peaksPerSecond: number;
	peaks: Uint8Array;
	bins: number;
	frames: number;
	framesPerSecond: number;
	minHz: number;
	maxHz: number;
	spectrogram: Uint8Array;
};

const MAX_PEAKS = 100 * 60 * 10;
const MAX_FRAMES = 6000;
const MAX_BINS = 256;

const posInt = (v: unknown, max: number) =>
	typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(max, Math.floor(v)) : 0;
const posNum = (v: unknown, fallback: number) =>
	typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;

export function decodeVisual(v: SoundVisual): DecodedVisual {
	const peaksCount = posInt(v.peaks?.count, MAX_PEAKS);
	const bins = posInt(v.spectrogram?.bins, MAX_BINS);
	const frames = posInt(v.spectrogram?.frames, MAX_FRAMES);
	const peaksPerSecond = posNum(v.peaks?.perSecond, 100);
	return {
		// 1 ms … a day: keeps the axis arithmetic finite (tick steps, pixel → time).
		coveredSec: Math.min(
			86_400,
			Math.max(0.001, posNum(v.coveredSec, posNum(v.durationSec, peaksCount / peaksPerSecond || 0.001))),
		),
		peaksPerSecond,
		peaks: decodeU8(v.peaks?.data ?? '', peaksCount),
		bins,
		frames,
		framesPerSecond: posNum(v.spectrogram?.framesPerSecond, 100),
		minHz: posNum(v.spectrogram?.minHz, 20),
		maxHz: posNum(v.spectrogram?.maxHz, 20_000),
		spectrogram: decodeU8(v.spectrogram?.data ?? '', bins * frames),
	};
}

type Plot = { x: number; y: number; w: number; h: number };

/** The markers drawn on a plot, in seconds from the file start. */
export type SoundMarks = { peakSec: number; decayEndSec: number | null; onsetSec?: number | null };

/** The marks of an entry: its peak and, when it decays, the end of the decay (peak + decayMs). */
export function marksOf(entry: Pick<SoundEntry, 'descriptors'>, withOnset = false): SoundMarks {
	const d = entry.descriptors;
	return {
		peakSec: d.peakSec,
		decayEndSec: d.decays && d.decayMs > 0 ? d.peakSec + d.decayMs / 1000 : null,
		...(withOnset ? { onsetSec: d.onsetSec } : {}),
	};
}

/** Spectrogram (bottom = minHz, top = maxHz, log), waveform envelope over it, then the marks. */
function drawPlot(img: RgbaImage, p: Plot, v: DecodedVisual, marks: SoundMarks): void {
	const span = v.coveredSec;
	// Spectrogram.
	for (let px = 0; px < p.w; px++) {
		const t = ((px + 0.5) / p.w) * span;
		const f = Math.min(v.frames - 1, Math.max(0, Math.floor(t * v.framesPerSecond)));
		for (let py = 0; py < p.h; py++) {
			let level = 0;
			if (v.frames > 0 && v.bins > 0) {
				const bin = Math.min(v.bins - 1, Math.floor(((p.h - 1 - py) / p.h) * v.bins));
				level = v.spectrogram[f * v.bins + bin]! / 255;
			}
			const c = ramp(level);
			blend(img, p.x + px, p.y + py, c);
		}
	}
	// Waveform: max |sample| per pixel column, normalised to the sound's own maximum, mirrored about the centre.
	let max = 0;
	for (const s of v.peaks) if (s > max) max = s;
	const mid = p.y + p.h / 2;
	if (max > 0)
		for (let px = 0; px < p.w; px++) {
			const t0 = (px / p.w) * span;
			const t1 = ((px + 1) / p.w) * span;
			const i0 = Math.min(v.peaks.length - 1, Math.max(0, Math.floor(t0 * v.peaksPerSecond)));
			const i1 = Math.min(v.peaks.length - 1, Math.max(i0, Math.ceil(t1 * v.peaksPerSecond) - 1));
			let a = 0;
			for (let i = i0; i <= i1; i++) a = Math.max(a, v.peaks[i]!);
			const half = (a / max) * (p.h / 2 - 1);
			if (half < 0.5) {
				blend(img, p.x + px, Math.round(mid), WAVE, 0.7);
				continue;
			}
			for (let y = Math.round(mid - half); y <= Math.round(mid + half); y++)
				blend(img, p.x + px, y, WAVE, 0.55);
			blend(img, p.x + px, Math.round(mid - half), WAVE, 1);
			blend(img, p.x + px, Math.round(mid + half), WAVE, 1);
		}
	const xOf = (sec: number) => p.x + Math.min(p.w - 1, Math.max(0, Math.round((sec / span) * p.w)));
	if (marks.onsetSec !== undefined && marks.onsetSec !== null && marks.onsetSec <= span)
		vline(img, xOf(marks.onsetSec), p.y, p.y + p.h - 1, ONSET, 1, true);
	if (marks.decayEndSec !== null && marks.decayEndSec <= span)
		vline(img, xOf(marks.decayEndSec), p.y, p.y + p.h - 1, DECAY, 1, true);
	if (marks.peakSec <= span) vline(img, xOf(marks.peakSec), p.y, p.y + p.h - 1, PEAK, 2);
}

const ms = (sec: number) => `${Math.round(sec * 1000)}ms`;
const secs = (sec: number) => (sec < 1 ? ms(sec) : `${Math.round(sec * 100) / 100}s`);
const hz = (f: number) => (f >= 1000 ? `${Math.round(f / 100) / 10}k` : `${Math.round(f)}`);

/** One contact-sheet cell: "#n snd_…" (large), the title, then length, peak, decay, centroid and the judge. */
export function drawSoundCell(
	entry: SoundEntry,
	visual: SoundVisual | null,
	n: number,
	size: { width: number; plotHeight: number },
): RgbaImage {
	const W = size.width;
	const header = 2 * LINE_HEIGHT * 2 - 2 + 2 * LINE_HEIGHT + 6;
	const img = canvas(W, header + size.plotHeight + 4);
	fillRect(img, 0, 0, W, header, HEADER_BG);
	drawText(img, fitText(`#${n} ${entry.id}`, W - 8, 2), 4, 4, TEXT, 2);
	drawText(img, fitText(entry.title || '(untitled)', W - 8, 2), 4, 4 + LINE_HEIGHT * 2, DIM, 2);
	const d = entry.descriptors;
	const line = `${entry.types.join('+') || 'untyped'} ${secs(entry.format.durationSec)} pk ${ms(d.peakSec)} dec ${
		d.decays ? ms(d.decayMs / 1000) : 'none'
	} ${hz(d.centroidHz)}Hz`;
	drawText(img, fitText(line, W - 8), 4, 4 + LINE_HEIGHT * 4, TEXT);
	const judge = entry.judge;
	const verdict = judge
		? judge.ok
			? `judge ok ${judge.score.toFixed(2)}`
			: `judge: ${judge.reasons.join(', ') || 'rejected'}`
		: 'not judged';
	drawText(img, fitText(verdict, W - 8), 4, 4 + LINE_HEIGHT * 5, judge && !judge.ok ? BAD : OK);
	const plot: Plot = { x: 2, y: header + 2, w: W - 4, h: size.plotHeight };
	if (visual) drawPlot(img, plot, decodeVisual(visual), marksOf(entry));
	else {
		fillRect(img, plot.x, plot.y, plot.w, plot.h, [40, 30, 30]);
		drawText(img, 'no visual data', plot.x + 6, plot.y + 6, BAD);
	}
	return img;
}

/** A tick step (1, 2 or 5 × 10^k) giving about `target` ticks over `span`. */
function tickStep(span: number, target: number): number {
	const raw = span / Math.max(1, target);
	const p = 10 ** Math.floor(Math.log10(raw));
	for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
	return 10 * p;
}

/**
 * The large picture of one sound (get_sound): title, time axis in ms with ticks, frequency labels, the waveform over
 * the spectrogram with the onset (green, dashed), peak (red) and decay end (yellow, dashed), and a legend.
 */
export function drawSoundDetail(
	entry: SoundEntry,
	visual: SoundVisual,
	size: { width: number; height: number },
): RgbaImage {
	const { width: W, height: H } = size;
	const img = canvas(W, H);
	const left = 44;
	const top = 2 * LINE_HEIGHT * 2 + 8;
	const bottom = 2 * LINE_HEIGHT + 10;
	const plot: Plot = { x: left, y: top, w: W - left - 8, h: H - top - bottom };
	drawText(img, fitText(`${entry.id}  ${entry.title}`, W - 8, 2), 4, 4, TEXT, 2);
	const d = entry.descriptors;
	const info = `${entry.types.join('+') || 'untyped'}  ${secs(entry.format.durationSec)}  peak ${ms(d.peakSec)}  rise ${Math.round(
		d.riseMs,
	)}ms  decay ${d.decays ? ms(d.decayMs / 1000) : 'none'}  centroid ${hz(d.centroidHz)}Hz  ${entry.license}`;
	drawText(img, fitText(info, W - 8), 4, 6 + LINE_HEIGHT * 2, DIM);
	const v = decodeVisual(visual);
	drawPlot(img, plot, v, marksOf(entry, true));
	// Time ticks (ms below 2 s, else s).
	const step = tickStep(v.coveredSec, 8);
	for (let t = 0; t <= v.coveredSec + 1e-9; t += step) {
		const x = plot.x + Math.min(plot.w - 1, Math.round((t / v.coveredSec) * plot.w));
		vline(img, x, plot.y + plot.h, plot.y + plot.h + 4, GRID);
		const label = v.coveredSec < 2 ? `${Math.round(t * 1000)}` : `${Math.round(t * 100) / 100}`;
		const lw = textWidth(label);
		drawText(img, label, Math.min(W - lw - 2, Math.max(0, x - lw / 2)), plot.y + plot.h + 6, DIM);
	}
	drawText(img, v.coveredSec < 2 ? 'ms' : 's', 4, plot.y + plot.h + 6, DIM);
	// Frequency labels at decades inside the band range (log axis, bottom = minHz).
	const lo = Math.log(v.minHz);
	const hi = Math.log(v.maxHz);
	for (const f of [100, 1000, 10_000]) {
		if (f <= v.minHz || f >= v.maxHz || hi <= lo) continue;
		const y = Math.round(plot.y + plot.h - ((Math.log(f) - lo) / (hi - lo)) * plot.h);
		for (let x = plot.x - 4; x < plot.x; x++) blend(img, x, y, GRID);
		drawText(img, hz(f), 2, y - 3, DIM);
	}
	const legendY = H - LINE_HEIGHT - 2;
	let x = 4;
	for (const [c, label] of [
		[PEAK, 'peak'],
		[DECAY, 'decay end (-20 dB)'],
		[ONSET, 'onset'],
		[WAVE, 'waveform (normalised)'],
	] as const) {
		fillRect(img, x, legendY + 1, 8, 6, c);
		drawText(img, label, x + 11, legendY, DIM);
		x += 11 + textWidth(label) + 12;
	}
	if (v.coveredSec + 1e-3 < entry.format.durationSec)
		drawText(img, `first ${secs(v.coveredSec)} shown`, x, legendY, BAD);
	return img;
}
