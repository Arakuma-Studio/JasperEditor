// One picture of a media or sequence range for agents (spec 18 §2.3 AF-VIEW-001/003; docs/wp-notes/agent-footage-view.md):
// stacked rows over one time axis — a header, a filmstrip of frames sampled at the centres of equal slots, the RMS
// waveform of the audio (10 ms levels, drawn on a dB scale), the transcript's words at their start times, shaded bands
// for silences of at least SILENCE_MIN_SEC and a time ruler — plus the same facts as text. Media without video get no
// filmstrip; without audio no waveform and no silence bands. Pure (no I/O); never throws on hostile data (lengths
// clamped, non-finite numbers ignored).
import { RANGE_AUDIO_CLASSES, RANGE_AUDIO_LEVEL_MIN_DB, RANGE_AUDIO_LEVEL_STEP_DB } from '@jasper/api';
import { blit, fillRect, hline, vline } from './motion-strip.ts';
import { drawText, fitText, LINE_HEIGHT, textWidth } from './pixel-font.ts';
import { canvas, type RgbaImage } from './sound-sheet.ts';

type Rgb = readonly [number, number, number];

export const VIEW_MIN_WIDTH = 480;
export const VIEW_MAX_WIDTH = 1920;
export const VIEW_DEFAULT_WIDTH = 1280;
export const VIEW_MIN_FRAMES = 2;
export const VIEW_MAX_FRAMES = 16;
export const VIEW_DEFAULT_FRAMES = 8;
/** Shortest silence drawn as a band (spec 18 §0: video-use's 0.4 s silence band, recorded in licenses/ported). */
export const SILENCE_MIN_SEC = 0.4;
/** The waveform's dB scale: bars grow from WAVE_FLOOR_DB (nothing) to 0 dBFS (full height). */
export const WAVE_FLOOR_DB = -60;
/** Tallest filmstrip (pixels). */
export const STRIP_MAX_HEIGHT = 540;
/** Words listed in the text summary at most (the rest are counted). */
export const SUMMARY_MAX_WORDS = 1000;

const PAD = 8;
const SLOT_GAP = 2;
const WORD_LANES = 3;

const BG: Rgb = [18, 18, 22];
const HEADER_BG: Rgb = [34, 34, 40];
const TEXT: Rgb = [235, 235, 240];
const DIM: Rgb = [150, 152, 165];
const GRID: Rgb = [70, 70, 82];
export const WAVE_COLOUR: Rgb = [120, 200, 240];
export const SILENCE_COLOUR: Rgb = [255, 170, 60];
const WORD_TICK: Rgb = [140, 230, 140];
const SLOT_BG: Rgb = [40, 30, 30];
const BAD: Rgb = [255, 140, 90];

/** 10 ms levels and voice classes on the view's own timeline (frame 0 at `start`). */
export type ViewAudio = { start: number; frameSec: number; level: Uint8Array; classes: Uint8Array };
export type ViewWord = { text: string; start: number; end: number };
export type ViewBand = { start: number; end: number };
/** A filmstrip frame: its picture, or null with the reason it is missing. */
export type ViewFrame = { time: number; image: RgbaImage | null; note?: string };

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Times at the centres of `n` equal slots of `[start, end)`. */
export function slotTimes(start: number, end: number, n: number): number[] {
	const k = Math.max(1, Math.floor(n));
	const d = (end - start) / k;
	return Array.from({ length: k }, (_, i) => start + (i + 0.5) * d);
}

/** The plot's x extent and each slot's box (left edge, width) for `n` frames over `width` pixels. */
export function slotLayout(
	width: number,
	n: number,
): { plotX: number; plotW: number; slots: { x: number; w: number }[] } {
	const plotW = Math.max(1, width - 2 * PAD);
	const k = Math.max(1, Math.floor(n));
	const slots = Array.from({ length: k }, (_, i) => {
		const x0 = PAD + Math.round((i * plotW) / k);
		const x1 = PAD + Math.round(((i + 1) * plotW) / k);
		return { x: x0 + SLOT_GAP, w: Math.max(1, x1 - x0 - 2 * SLOT_GAP) };
	});
	return { plotX: PAD, plotW, slots };
}

/** The frame box the engine should fit frames into for this layout. */
export function frameBox(width: number, n: number): { width: number; height: number } {
	const { slots } = slotLayout(width, n);
	return { width: Math.max(16, Math.min(960, Math.min(...slots.map((s) => s.w)))), height: STRIP_MAX_HEIGHT };
}

const levelDb = (q: number) => RANGE_AUDIO_LEVEL_MIN_DB + q * RANGE_AUDIO_LEVEL_STEP_DB;

/** Frame index range `[i0, i1)` of the audio covering `[t0, t1)` (clamped; empty when outside). */
function framesOf(a: ViewAudio, t0: number, t1: number): [number, number] {
	const n = Math.min(a.level.length, a.classes.length);
	if (!(a.frameSec > 0) || !fin(a.start)) return [0, 0];
	const i0 = Math.max(0, Math.floor((t0 - a.start) / a.frameSec + 1e-9));
	const i1 = Math.min(n, Math.max(i0 + 1, Math.ceil((t1 - a.start) / a.frameSec - 1e-9)));
	return i0 < n ? [i0, i1] : [0, 0];
}

/** RMS level (dBFS) of `[t0, t1)`: the mean power of its 10 ms frames; null where there is no audio. */
export function rmsDb(a: ViewAudio, t0: number, t1: number): number | null {
	const [i0, i1] = framesOf(a, t0, t1);
	if (i1 <= i0) return null;
	let p = 0;
	for (let i = i0; i < i1; i++) p += 10 ** (levelDb(a.level[i]!) / 10);
	return 10 * Math.log10(p / (i1 - i0));
}

/** Runs of frames that are not speech (silence or breath-like), at least `minSec` long, clipped to `[start, end)`. */
export function silenceBands(a: ViewAudio, start: number, end: number, minSec = SILENCE_MIN_SEC): ViewBand[] {
	const n = Math.min(a.level.length, a.classes.length);
	const out: ViewBand[] = [];
	if (!(a.frameSec > 0) || !fin(a.start) || !(end > start)) return out;
	const push = (i0: number, i1: number) => {
		const s = Math.max(start, a.start + i0 * a.frameSec);
		const e = Math.min(end, a.start + i1 * a.frameSec);
		if (e - s >= minSec - 1e-9) out.push({ start: round3(s), end: round3(e) });
	};
	let run = -1;
	for (let i = 0; i <= n; i++) {
		const quiet = i < n && a.classes[i] !== RANGE_AUDIO_CLASSES.speech;
		if (quiet && run < 0) run = i;
		else if (!quiet && run >= 0) {
			push(run, i);
			run = -1;
		}
	}
	return out;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Seconds as `12.34` (under a minute) or `1:02.34` / `1:02:03.4`; `decimals` digits after the point. */
export function formatTime(sec: number, decimals = 2): string {
	if (!fin(sec)) return '?';
	const neg = sec < 0;
	const f = 10 ** decimals;
	const v = Math.round(Math.abs(sec) * f) / f;
	const h = Math.floor(v / 3600);
	const m = Math.floor((v % 3600) / 60);
	const s = (v % 60).toFixed(decimals);
	const ss = m > 0 || h > 0 ? s.padStart(decimals ? decimals + 3 : 2, '0') : s;
	const body = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : m > 0 ? `${m}:${ss}` : ss;
	return neg ? `-${body}` : body;
}

/** A tick step (1, 2 or 5 × 10^k seconds) giving about `target` ticks over `span`. */
export function tickStep(span: number, target: number): number {
	const raw = Math.max(1e-3, span) / Math.max(1, target);
	const p = 10 ** Math.floor(Math.log10(raw));
	for (const m of [1, 2, 5, 10]) if (m * p >= raw - 1e-12) return m * p;
	return 10 * p;
}

export type RangeViewInput = {
	width: number;
	start: number;
	end: number;
	/** Header text (what is shown: media name or sequence). */
	title: string;
	/** Filmstrip frames (slot centres), or null for media without video. */
	frames: ViewFrame[] | null;
	/** Audio, or null for media without audio (no waveform, no silence bands). */
	audio: ViewAudio | null;
	/** Words overlapping the range, in time order; null when there is no transcript. */
	words: ViewWord[] | null;
	/** Silence bands (normally `silenceBands(audio, …)`). */
	silences: ViewBand[];
};

export type RangeViewLayout = {
	width: number;
	height: number;
	scale: number;
	plot: { x: number; width: number };
	rows: Partial<Record<'header' | 'strip' | 'wave' | 'words' | 'ruler', { y: number; height: number }>>;
	slots: { time: number; x: number; y: number; width: number; height: number; drawn: boolean }[];
	/** Words drawn in the image (the rest overlap others at this width). */
	wordsDrawn: number;
	ticks: number[];
};

/** Draws the view (see the module docs). */
export function drawRangeView(input: RangeViewInput): { image: RgbaImage; layout: RangeViewLayout } {
	const W = Math.max(
		VIEW_MIN_WIDTH,
		Math.min(VIEW_MAX_WIDTH, Math.round(fin(input.width) ? input.width : VIEW_DEFAULT_WIDTH)),
	);
	const start = fin(input.start) ? input.start : 0;
	const end = fin(input.end) && input.end > start ? input.end : start + 1;
	const span = end - start;
	const sc = W >= 960 ? 2 : 1;
	const lineH = LINE_HEIGHT * sc;
	const frames = input.frames?.slice(0, VIEW_MAX_FRAMES) ?? null;
	const { plotX, plotW, slots } = slotLayout(W, frames?.length || 1);
	const xOf = (t: number) => plotX + ((t - start) / span) * plotW;
	// rows
	const rows: RangeViewLayout['rows'] = {};
	let y = 0;
	rows.header = { y, height: lineH + 8 };
	y += rows.header.height;
	let stripH = 0;
	if (frames) {
		const tallest = Math.max(
			0,
			...frames.map((f, i) =>
				f.image ? Math.round((f.image.height * slots[i]!.w) / Math.max(1, f.image.width)) : 0,
			),
		);
		stripH = Math.max(lineH * 2 + 8, Math.min(STRIP_MAX_HEIGHT, tallest || Math.round(slots[0]!.w * 0.5625)));
		rows.strip = { y: y + 4, height: stripH };
		y += stripH + 8;
	}
	if (input.audio) {
		const h = Math.max(48, Math.min(140, Math.round(plotW * 0.075)));
		rows.wave = { y, height: h };
		y += h + 4;
	}
	if (input.audio || input.words) {
		const h = WORD_LANES * (lineH + 3) + 4;
		rows.words = { y, height: h };
		y += h + 2;
	}
	rows.ruler = { y, height: 6 + lineH + 6 };
	y += rows.ruler.height;
	const H = y;
	const img = canvas(W, H, BG);
	// header
	fillRect(img, 0, 0, W, rows.header.height, HEADER_BG);
	const range = `${formatTime(start)}-${formatTime(end)} s (${formatTime(span)} s)`;
	const rw = textWidth(range, sc);
	drawText(img, range, W - PAD - rw, 4, DIM, sc);
	drawText(img, fitText(input.title, Math.max(0, W - 3 * PAD - rw), sc), PAD, 4, TEXT, sc);
	// silence bands under everything below the strip
	const bandTop = rows.wave?.y ?? rows.words?.y ?? rows.ruler.y;
	const bandBottom = rows.ruler.y + 6;
	if (input.audio)
		for (const b of input.silences) {
			if (!fin(b.start) || !fin(b.end) || b.end <= b.start) continue;
			const x0 = Math.max(plotX, Math.round(xOf(b.start)));
			const x1 = Math.min(plotX + plotW, Math.round(xOf(b.end)));
			if (x1 <= x0) continue;
			fillRect(img, x0, bandTop, x1 - x0, bandBottom - bandTop, SILENCE_COLOUR, 0.22);
			hline(img, x0, x1 - 1, bandTop, SILENCE_COLOUR);
			const label = `${formatTime(b.end - b.start, 1)}s`;
			if (textWidth(label, 1) + 4 <= x1 - x0) drawText(img, label, x0 + 2, bandTop + 2, SILENCE_COLOUR, 1);
		}
	// filmstrip
	const slotOut: RangeViewLayout['slots'] = [];
	if (frames && rows.strip) {
		const sy = rows.strip.y;
		frames.forEach((f, i) => {
			const s = slots[i]!;
			const im = f.image;
			if (im && im.width > 0 && im.height > 0 && im.data.length >= im.width * im.height * 4) {
				const k = Math.min(s.w / im.width, stripH / im.height);
				const w = Math.max(1, Math.round(im.width * k));
				const h = Math.max(1, Math.round(im.height * k));
				const x = s.x + Math.floor((s.w - w) / 2);
				const yy = sy + Math.floor((stripH - h) / 2);
				blit(img, im, x, yy, w, h);
				slotOut.push({ time: f.time, x, y: yy, width: w, height: h, drawn: true });
			} else {
				fillRect(img, s.x, sy, s.w, stripH, SLOT_BG);
				drawText(img, fitText(f.note ?? 'no frame', s.w - 4, 1), s.x + 2, sy + lineH + 6, BAD, 1);
				slotOut.push({ time: f.time, x: s.x, y: sy, width: s.w, height: stripH, drawn: false });
			}
			const label = formatTime(f.time);
			const lw = textWidth(label, 1);
			fillRect(img, s.x, sy, Math.min(s.w, lw + 4), LINE_HEIGHT + 2, BG, 0.75);
			drawText(img, fitText(label, s.w - 2, 1), s.x + 2, sy + 1, TEXT, 1);
			// where this frame sits on the time axis
			vline(img, xOf(f.time), sy + stripH + 1, sy + stripH + 6, TEXT);
		});
	}
	// waveform
	if (input.audio && rows.wave) {
		const a = input.audio;
		const mid = rows.wave.y + rows.wave.height / 2;
		const half = rows.wave.height / 2 - 2;
		hline(img, plotX, plotX + plotW - 1, mid, GRID);
		for (let px = 0; px < plotW; px++) {
			const t0 = start + (px / plotW) * span;
			const t1 = start + ((px + 1) / plotW) * span;
			const db = rmsDb(a, t0, t1);
			if (db === null) continue;
			const amp = Math.min(1, Math.max(0, (db - WAVE_FLOOR_DB) / -WAVE_FLOOR_DB));
			const hh = amp * half;
			if (hh < 0.5) continue;
			vline(img, plotX + px, mid - hh, mid + hh, WAVE_COLOUR, false, 0.85);
		}
		const legend = `RMS dB ${WAVE_FLOOR_DB}..0`;
		fillRect(img, plotX, rows.wave.y, textWidth(legend, 1) + 4, LINE_HEIGHT + 1, BG, 0.75);
		drawText(img, legend, plotX + 2, rows.wave.y + 1, DIM, 1);
	}
	// words: greedy lanes, each word at its start time
	let wordsDrawn = 0;
	if (rows.words) {
		const laneEnd = new Array<number>(WORD_LANES).fill(Number.NEGATIVE_INFINITY);
		const words = input.words ?? [];
		if (!words.length)
			drawText(
				img,
				input.words ? 'no words in this range' : 'no transcript',
				plotX + 2,
				rows.words.y + 3,
				DIM,
				1,
			);
		for (const w of words) {
			if (!fin(w.start) || w.start >= end || (fin(w.end) && w.end <= start)) continue;
			const x = Math.round(xOf(Math.max(start, w.start)));
			const text = w.text.trim();
			if (!text) continue;
			const tw = textWidth(text, sc);
			if (x + 2 + tw > plotX + plotW) continue;
			const lane = laneEnd.findIndex((e) => x >= e + 4 * sc);
			if (lane < 0) continue;
			const ly = rows.words.y + 2 + lane * (lineH + 3);
			vline(img, x, ly, ly + lineH, WORD_TICK);
			drawText(img, text, x + 2, ly, TEXT, sc);
			laneEnd[lane] = x + 2 + tw;
			wordsDrawn++;
		}
	}
	// ruler
	const ry = rows.ruler.y;
	hline(img, plotX, plotX + plotW - 1, ry, GRID);
	const step = tickStep(span, Math.max(2, Math.floor(plotW / (lineH * 9))));
	const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
	const ticks: number[] = [];
	let lastLabelEnd = Number.NEGATIVE_INFINITY;
	for (let k = Math.ceil(start / step - 1e-9); k * step <= end + 1e-9 && ticks.length < 1000; k++) {
		const t = k * step + 0; // never -0
		const x = Math.round(xOf(t));
		ticks.push(round3(t));
		vline(img, Math.min(plotX + plotW - 1, x), ry, ry + 5, TEXT);
		const label = formatTime(t, decimals);
		const lw = textWidth(label, sc);
		const lx = Math.min(W - lw - 2, Math.max(0, x - lw / 2));
		if (lx > lastLabelEnd + 4) {
			drawText(img, label, lx, ry + 7, DIM, sc);
			lastLabelEnd = lx + lw;
		}
	}
	return {
		image: img,
		layout: {
			width: W,
			height: H,
			scale: sc,
			plot: { x: plotX, width: plotW },
			rows,
			slots: slotOut,
			wordsDrawn,
			ticks,
		},
	};
}

/**
 * The view as text (AF-VIEW-003): what is shown and from where, every frame time, the silence bands and the words of
 * the range with their times (at most SUMMARY_MAX_WORDS), so an agent that cannot read images gets the same facts.
 */
export function rangeSummary(o: {
	title: string;
	start: number;
	end: number;
	timeline: string;
	frames: ViewFrame[] | null;
	audio: { source: string; note?: string } | null;
	silences: ViewBand[] | null;
	words: ViewWord[] | null;
	wordsDrawn: number;
	image: { width: number; height: number };
}): string {
	const lines: string[] = [];
	lines.push(
		`${o.title}: ${formatTime(o.start)}-${formatTime(o.end)} s (${formatTime(o.end - o.start)} s, ${o.timeline})`,
	);
	lines.push(`image: ${o.image.width}x${o.image.height} PNG`);
	if (o.frames) {
		const parts = o.frames.map((f) =>
			f.image ? formatTime(f.time) : `${formatTime(f.time)} (${f.note ?? 'no frame'})`,
		);
		lines.push(`frames (${o.frames.length}, slot centres): ${parts.join(', ')}`);
	} else lines.push('frames: none (no video)');
	if (o.audio)
		lines.push(
			`audio: RMS waveform, 10 ms levels from ${o.audio.source}${o.audio.note ? `; ${o.audio.note}` : ''}`,
		);
	else lines.push('audio: none (no audio stream)');
	if (o.silences) {
		const s = o.silences.map(
			(b) => `${formatTime(b.start)}-${formatTime(b.end)} (${formatTime(b.end - b.start)} s)`,
		);
		lines.push(`silences >= ${SILENCE_MIN_SEC} s (${s.length}): ${s.length ? s.join(', ') : 'none'}`);
	}
	if (o.words === null) lines.push('words: no transcript (transcribe to get words)');
	else {
		const shown = o.words.slice(0, SUMMARY_MAX_WORDS);
		const more = o.words.length - shown.length;
		lines.push(
			`words (${o.words.length}${o.wordsDrawn < o.words.length ? `; ${o.wordsDrawn} fit in the image` : ''}): ${
				shown.length ? shown.map((w) => `[${formatTime(w.start)}] ${w.text.trim()}`).join(' ') : 'none'
			}${more > 0 ? ` ... +${more} more (get_transcript)` : ''}`,
		);
	}
	return lines.join('\n');
}
