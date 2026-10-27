// Pictures of a sequence's sound for agents that cannot hear (spec 12 §2.6 "MCP composes PNGs", §2.10
// `view_sound_timeline`, `sound_check` images; wp-note "Phase 5 → WP5.1"): the engine's visual data
// (`POST /api/sound-design/visual`) drawn as one strip — momentary loudness curves of the mix and its stems on a LUFS
// scale, the mix waveform, speech spans, the sound effect clips with their aligned points, the cue ticks, the picture's
// motion curves (keyframed, and measured where analysed) and the Sound Check's findings as flags — with a timecode axis
// and a legend. The annotated sheet (spec 12 §4 P6-E7; wp-note "Phase 6 → WP-E3") adds, when given: a picture lane of
// rendered frames at the cut, cue and event frames (≤ 12), the mix's log-frequency spectrogram, the listening
// transcript's sections band, and every cut / transition / cue / measured motion marked by whether a sound answers it
// (OK ● green, near ◇ amber, swell △ blue, none ✕ red: shape and colour, never colour alone; the cue ticks carry the
// same mark). Pure (no I/O); never throws on hostile data (lengths are clamped, non-numbers drawn as silence).
import type { SoundListenResult, SoundVisualResponse } from '@jasper/api';
import { drawText, fitText, LINE_HEIGHT, textWidth } from './pixel-font.ts';
import { canvas, type RgbaImage, ramp } from './sound-sheet.ts';

type Rgb = readonly [number, number, number];

const STEM_COLOURS: Record<'mix' | 'bed' | 'sfx' | 'music' | 'dialogue' | 'ambience', Rgb> = {
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
/** The measured picture motion (pixel analysis), drawn over the keyframed motion. */
const PIXEL_MOTION: Rgb = [255, 130, 210];
const HERO: Rgb = [255, 90, 90];
const SUPPORT: Rgb = [255, 200, 120];
const SEVERITY: Record<'error' | 'warning' | 'info', Rgb> = {
	error: [255, 60, 60],
	warning: [255, 205, 40],
	info: [150, 150, 160],
};
/** Answer marks (spec 12 P6-E7): a shape per status, so colour is never the only cue. */
const SYNC_MARKS = {
	ok: { colour: [90, 220, 120] as Rgb, shape: 'filled circle', label: 'OK' },
	near: { colour: [255, 200, 60] as Rgb, shape: 'hollow diamond', label: 'near' },
	swell: { colour: [110, 170, 255] as Rgb, shape: 'hollow triangle', label: 'swell' },
	none: { colour: [255, 70, 70] as Rgb, shape: 'cross', label: 'no sound' },
} as const;
type SyncStatus = keyof typeof SYNC_MARKS;
/** Section classes (the sections band). */
const SECTION_COLOURS: Record<string, Rgb> = {
	dialogue: [70, 170, 95],
	music: [150, 90, 210],
	ambience: [50, 160, 160],
	effects: [220, 140, 50],
	other: [110, 110, 120],
	silence: [40, 40, 48],
};
/** Most thumbnails in the picture lane. */
export const MAX_TIMELINE_THUMBS = 12;
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
/** A 1 px line (Bresenham). */
function line(img: RgbaImage, x0: number, y0: number, x1: number, y1: number, c: Rgb, a = 1): void {
	let x = Math.round(x0);
	let y = Math.round(y0);
	const xe = Math.round(x1);
	const ye = Math.round(y1);
	const dx = Math.abs(xe - x);
	const dy = -Math.abs(ye - y);
	const sx = x < xe ? 1 : -1;
	const sy = y < ye ? 1 : -1;
	let err = dx + dy;
	for (let n = 0; n < 4096; n++) {
		blend(img, x, y, c, a);
		if (x === xe && y === ye) break;
		const e2 = 2 * err;
		if (e2 >= dy) {
			err += dy;
			x += sx;
		}
		if (e2 <= dx) {
			err += dx;
			y += sy;
		}
	}
}
/** An answer mark centred on (x, y), radius `r`. */
function mark(img: RgbaImage, x: number, y: number, status: SyncStatus, r = 3): void {
	const c = SYNC_MARKS[status].colour;
	const cx = Math.round(x);
	const cy = Math.round(y);
	if (status === 'ok') {
		for (let dy = -r; dy <= r; dy++)
			for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + 1) blend(img, cx + dx, cy + dy, c);
	} else if (status === 'near') {
		for (let k = 0; k <= r; k++) {
			blend(img, cx - r + k, cy - k, c);
			blend(img, cx + r - k, cy - k, c);
			blend(img, cx - r + k, cy + k, c);
			blend(img, cx + r - k, cy + k, c);
		}
	} else if (status === 'swell') {
		line(img, cx - r, cy + r, cx + r, cy + r, c);
		line(img, cx - r, cy + r, cx, cy - r, c);
		line(img, cx + r, cy + r, cx, cy - r, c);
	} else {
		line(img, cx - r, cy - r, cx + r, cy + r, c);
		line(img, cx - r, cy + r, cx + r, cy - r, c);
		line(img, cx - r + 1, cy - r, cx + r, cy + r - 1, c);
		line(img, cx - r + 1, cy + r, cx + r, cy - r + 1, c);
	}
}
/** Copies `src` scaled (nearest) into `dst` at (x, y) with size w × h. */
function blit(dst: RgbaImage, src: RgbaImage, x: number, y: number, w: number, h: number): void {
	if (!(src.width > 0 && src.height > 0) || src.data.length < src.width * src.height * 4) return;
	for (let yy = 0; yy < h; yy++)
		for (let xx = 0; xx < w; xx++) {
			const sx = Math.min(src.width - 1, Math.floor((xx * src.width) / w));
			const sy = Math.min(src.height - 1, Math.floor((yy * src.height) / h));
			const so = (sy * src.width + sx) * 4;
			blend(dst, x + xx, y + yy, [src.data[so]!, src.data[so + 1]!, src.data[so + 2]!]);
		}
}
/** Base64 → bytes, tolerating junk (an empty array then). */
function bytesOf(b64: unknown): Uint8Array {
	if (typeof b64 !== 'string' || b64.length > 64 * 1024 * 1024) return new Uint8Array(0);
	try {
		return new Uint8Array(Buffer.from(b64, 'base64'));
	} catch {
		return new Uint8Array(0);
	}
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
		/** Whether a sound answers it (with a listening transcript). */
		status?: SyncStatus;
	}[];
	/** The picture lane's frames (rendered through the export path), each with its box. */
	thumbs: {
		frame: number;
		timecode: string;
		label: string;
		x: number;
		y: number;
		width: number;
		height: number;
	}[];
	/** The sync lane: every cut, transition, cue and measured motion with its answer mark. */
	sync: {
		key: string;
		kind: string;
		frame: number;
		x: number;
		status: SyncStatus;
		shape: string;
		label: string;
	}[];
	/** The sections band. */
	sections: { start: number; end: number; x0: number; x1: number; label: string; classes: string[] }[];
	/** The spectrogram lane (rows: low frequencies at the bottom, log-spaced fMinHz…fMaxHz), or null. */
	spectrogram: { fMinHz: number; fMaxHz: number; bands: number; rows: number } | null;
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
	/**
	 * Whether the measured picture motion (pink in the move lane) is drawn: the range was analysed (analyze_picture_motion
	 * or find_sound_cues sources ["pixel"]), partly, or not at all (only the keyframed motion is drawn then).
	 */
	pixelMotion: 'measured' | 'partly analysed' | 'not analysed';
};

/**
 * Draws the visual data of a range as one strip `width` px wide (see the module docs). Returns the picture and the
 * geometry, so an agent can map what it sees back to frames (`cells`).
 */
export type TimelineListen = Pick<SoundListenResult, 'sections' | 'pictureEvents'>;
export type TimelineThumb = { frame: number; image: RgbaImage; label: string };

export function drawSoundTimeline(
	v: SoundVisualResponse,
	opts: {
		width?: number;
		title?: string;
		listen?: TimelineListen | null;
		thumbs?: readonly TimelineThumb[];
	} = {},
): { image: RgbaImage; cells: TimelineCells } {
	const W = Math.max(480, Math.min(2400, Math.round(num(opts.width, 1200))));
	const plotX = 54;
	const plotW = W - plotX - 12;
	const headerH = LINE_HEIGHT * 2 + 6;
	const start = num(v.range?.start, 0);
	const end = Math.max(start + 1, num(v.range?.end, start + 1));
	const fps = Math.max(1e-6, num(v.fps?.num, 30) / Math.max(1, num(v.fps?.den, 1)));
	const pxPerFrame = plotW / (end - start);
	const xOf = (frame: number) => plotX + (frame - start) * pxPerFrame;
	// the optional lanes
	const thumbs = (Array.isArray(opts.thumbs) ? opts.thumbs : [])
		.filter((t) => t && Number.isFinite(t.frame) && t.image && t.image.width > 0 && t.image.height > 0)
		.slice(0, MAX_TIMELINE_THUMBS)
		.sort((a, b) => a.frame - b.frame);
	const aspect = thumbs.length ? thumbs[0]!.image.height / thumbs[0]!.image.width : 9 / 16;
	const tw = thumbs.length
		? Math.max(24, Math.min(140, Math.floor((plotW - 4 * (thumbs.length - 1)) / thumbs.length)))
		: 0;
	const th = thumbs.length ? Math.max(14, Math.min(90, Math.round(tw * aspect))) : 0;
	const pictureH = thumbs.length ? th + LINE_HEIGHT + 14 : 0;
	const spec = v.spectrogram && typeof v.spectrogram === 'object' ? v.spectrogram : null;
	const specBytes = spec ? bytesOf(spec.data) : new Uint8Array(0);
	const specBands = spec ? Math.max(1, Math.min(256, Math.floor(num(spec.bands, 96)))) : 0;
	const specFrames = spec ? Math.min(Math.floor(specBytes.length / Math.max(1, specBands)), MAX_POINTS) : 0;
	const specH = specFrames > 0 ? 72 : 0;
	const listen = opts.listen && typeof opts.listen === 'object' ? opts.listen : null;
	const sectionsH = listen ? 14 : 0;
	const syncH = listen ? 18 : 0;
	let y = headerH + 4;
	const pictureY = y;
	y += pictureH ? pictureH + 4 : 0;
	const curveY = y;
	const curveH = 170;
	y += curveH + 6;
	const specY = y;
	y += specH ? specH + 4 : 0;
	const waveY = y;
	const waveH = 44;
	y += waveH + 4;
	const sectionsY = y;
	y += sectionsH ? sectionsH + 4 : 0;
	const clipY = y;
	const clipH = 14;
	y += clipH + 4;
	const cueY = y;
	const cueH = 22;
	y += cueH + 4;
	const syncY = y;
	y += syncH ? syncH + 4 : 0;
	const motionY = y;
	const motionH = 26;
	y += motionH + 4;
	const flagY = y;
	const flagH = 22;
	const axisY = flagY + flagH + 2;
	const legendY = axisY + LINE_HEIGHT + 4;
	const H = legendY + LINE_HEIGHT * 2 + 8;
	const img = canvas(W, H);
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
	// picture lane: rendered frames in time order, each as near its frame as the others allow, a line to the frame
	const thumbCells: TimelineCells['thumbs'] = [];
	if (thumbs.length) {
		drawText(img, 'pic', 4, pictureY + Math.round(th / 2) - 3, DIM);
		const xs = thumbs.map((t) => Math.round(xOf(t.frame) - tw / 2));
		for (let i = 0; i < xs.length; i++)
			xs[i] = Math.max(plotX, i ? Math.max(xs[i]!, xs[i - 1]! + tw + 4) : xs[i]!);
		for (let i = xs.length - 1; i >= 0; i--)
			xs[i] = Math.min(xs[i]!, (i + 1 < xs.length ? xs[i + 1]! - 4 : plotX + plotW) - tw);
		thumbs.forEach((t, i) => {
			const x = Math.max(plotX, xs[i]!);
			blit(img, t.image, x, pictureY, tw, th);
			const label = fitText(String(t.label ?? ''), tw);
			drawText(img, label, x, pictureY + th + 2, TEXT);
			const fx = xOf(t.frame);
			line(img, x + tw / 2, pictureY + th + LINE_HEIGHT + 2, fx, pictureY + pictureH - 1, DIM);
			thumbCells.push({
				frame: num(t.frame, start),
				timecode: label,
				label: String(t.label ?? ''),
				x,
				y: pictureY,
				width: tw,
				height: th,
			});
		});
	}
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
	// spectrogram lane: the mix, log frequency (low at the bottom), the loudest of the columns each pixel covers
	if (specH) {
		fillRect(img, plotX, specY, plotW, specH, [10, 10, 20]);
		for (let px = 0; px < plotW; px++) {
			const a = Math.floor((px / plotW) * specFrames);
			const b = Math.max(a + 1, Math.floor(((px + 1) / plotW) * specFrames));
			for (let row = 0; row < specH; row++) {
				const b0 = Math.floor(((specH - 1 - row) * specBands) / specH);
				const b1 = Math.max(b0 + 1, Math.floor(((specH - row) * specBands) / specH));
				let m = 0;
				for (let f = a; f < Math.min(specFrames, b); f++)
					for (let band = b0; band < Math.min(specBands, b1); band++) {
						const val = specBytes[f * specBands + band]!;
						if (val > m) m = val;
					}
				if (m > 0) blend(img, plotX + px, specY + row, ramp(m / 255));
			}
		}
		drawText(img, 'spec', 4, specY + Math.round(specH / 2) - 3, DIM);
		drawText(img, `${Math.round(num(spec?.fMaxHz, 16000) / 1000)}k`, 4, specY, DIM);
		drawText(img, `${Math.round(num(spec?.fMinHz, 30))}`, 4, specY + specH - LINE_HEIGHT, DIM);
	}
	// sections band (the listening transcript)
	const sectionCells: TimelineCells['sections'] = [];
	if (listen) {
		drawText(img, 'sect', 4, sectionsY + 3, DIM);
		let lastLabel = -1;
		for (const sct of Array.isArray(listen.sections) ? listen.sections.slice(0, 400) : []) {
			const a = Math.max(plotX, xOf(num(sct.start, start)));
			const b = Math.min(plotX + plotW, xOf(num(sct.end, start)));
			if (!(b > a)) continue;
			const classes = Array.isArray(sct.classes) ? sct.classes.map(String) : [];
			const band = Math.max(1, Math.floor(sectionsH / Math.max(1, classes.length)));
			classes.forEach((c, k) => {
				fillRect(
					img,
					a,
					sectionsY + k * band,
					b - a,
					band,
					SECTION_COLOURS[c] ?? SECTION_COLOURS.other!,
					0.85,
				);
			});
			vline(img, a, sectionsY, sectionsY + sectionsH - 1, TEXT, false, 0.6);
			const label = fitText(String(sct.label ?? ''), Math.max(0, b - a - 4));
			if (label && a + 2 > lastLabel) {
				drawText(img, label, Math.round(a) + 2, sectionsY + 3, TEXT);
				lastLabel = a + 2 + textWidth(label);
			}
			sectionCells.push({
				start: num(sct.start, start),
				end: num(sct.end, start),
				x0: Math.round(a),
				x1: Math.round(b),
				label: String(sct.label ?? ''),
				classes,
			});
		}
	}
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
	// cue ticks: hero tall red, support short amber; unfilled dashed; muted dim; with a transcript, its answer mark
	drawText(img, 'cues', 4, cueY + 6, DIM);
	const pics = listen && Array.isArray(listen.pictureEvents) ? listen.pictureEvents.slice(0, 4000) : [];
	const statusOf = (st: unknown): SyncStatus =>
		st === 'ok' || st === 'near' || st === 'swell' || st === 'none' ? st : 'none';
	const cueStatus = new Map<string, SyncStatus>();
	for (const p of pics) if (p.kind === 'cue' && p.cueId) cueStatus.set(String(p.cueId), statusOf(p.status));
	const cues = (Array.isArray(v.cues) ? v.cues.slice(0, 2000) : []).map((c) => {
		const x = xOf(num(c.frame, start));
		const hero = c.weight === 'hero';
		const colour = c.muted ? DIM : hero ? HERO : SUPPORT;
		const top = hero ? cueY : cueY + cueH / 3;
		vline(img, x, top, cueY + cueH - 1, colour, !c.filled);
		if (hero) fillRect(img, x - 2, top, 5, 4, colour);
		// the cue line through the curves, faint
		vline(img, x, curveY, curveY + curveH - 1, colour, true, 0.35);
		const status = cueStatus.get(String(c.cueId));
		if (status && x >= plotX && x < plotX + plotW) mark(img, x + 5, cueY + 4, status, 3);
		return {
			cueId: String(c.cueId),
			frame: num(c.frame, start),
			timecode: String(c.timecode),
			x: Math.round(x),
			kind: String(c.kind),
			weight: String(c.weight),
			filled: c.filled === true,
			...(status ? { status } : {}),
		};
	});
	// sync lane: every picture event the transcript checked, by its answer
	const syncCells: TimelineCells['sync'] = [];
	if (listen) {
		drawText(img, 'sync', 4, syncY + 5, DIM);
		const KIND: Record<string, string> = { cut: 'C', transition: 'T', cue: 'Q', motion: 'M' };
		let lastLabel = -1;
		for (const p of pics) {
			const f = num(p.frame, Number.NaN);
			if (!Number.isFinite(f) || f < start || f >= end) continue;
			const x = xOf(f);
			const status = statusOf(p.status);
			vline(img, x, syncY, syncY + syncH - 1, GRID);
			mark(img, x, syncY + 6, status, 3);
			const letter = KIND[String(p.kind)] ?? '?';
			if (x + 5 > lastLabel) {
				drawText(img, letter, Math.round(x) - 2, syncY + 10, DIM);
				lastLabel = x + 5;
			}
			syncCells.push({
				key: String(p.key),
				kind: String(p.kind),
				frame: f,
				x: Math.round(x),
				status,
				shape: SYNC_MARKS[status].shape,
				label: String(p.label ?? '').slice(0, 200),
			});
		}
	}
	// motion: speed per frame — the keyframed layers and, where analysed, the measured picture — normalised together
	// (one unit: screen diagonals per second) to the range's fastest
	drawText(img, 'move', 4, motionY + 8, DIM);
	const speed = Array.isArray(v.motion?.speed) ? v.motion.speed.slice(0, 200_000).map((x) => num(x, 0)) : [];
	const rawPixel = (v as { pixelMotion?: unknown }).pixelMotion as
		| { startFrame?: unknown; speed?: unknown }
		| null
		| undefined;
	const pixel: (number | null)[] =
		rawPixel && typeof rawPixel === 'object' && Array.isArray(rawPixel.speed)
			? rawPixel.speed.slice(0, 200_000).map((x) => (typeof x === 'number' && Number.isFinite(x) ? x : null))
			: [];
	const pixelStart = num(rawPixel?.startFrame, start);
	let smax = 1e-6;
	for (const s of speed) if (s > smax) smax = s;
	for (const s of pixel) if (s !== null && s > smax) smax = s;
	const yOfSpeed = (s: number) => motionY + motionH - 1 - (Math.max(0, s) / smax) * (motionH - 2);
	if (speed.some((s) => s > 0))
		polyline(
			img,
			speed.map(yOfSpeed),
			Math.round(xOf(num(v.motion?.startFrame, start))),
			Math.max(1, Math.round(speed.length * pxPerFrame)),
			MOTION,
		);
	// measured runs (frames outside the analysed windows are null: not drawn)
	let measuredFrames = 0;
	for (let i = 0; i < pixel.length; ) {
		if (pixel[i] === null) {
			i++;
			continue;
		}
		let j = i;
		while (j < pixel.length && pixel[j] !== null) j++;
		measuredFrames += j - i;
		const run = pixel.slice(i, j) as number[];
		polyline(
			img,
			run.map(yOfSpeed),
			Math.round(xOf(pixelStart + i)),
			Math.max(1, Math.round(run.length * pxPerFrame)),
			PIXEL_MOTION,
		);
		i = j;
	}
	const pixelState: TimelineCells['pixelMotion'] =
		measuredFrames === 0
			? 'not analysed'
			: measuredFrames >= Math.min(pixel.length, Math.max(1, end - start))
				? 'measured'
				: 'partly analysed';
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
		['measured motion', PIXEL_MOTION],
		['error', SEVERITY.error],
		['warning', SEVERITY.warning],
	] as const) {
		if (lx + 40 > W) break;
		fillRect(img, lx, legendY + 2, 10, 4, c);
		drawText(img, name, lx + 13, legendY, TEXT);
		lx += 13 + textWidth(name) + 12;
	}
	// legend, second line: the answer marks and the section classes
	let mx = 6;
	const ly2 = legendY + LINE_HEIGHT + 3;
	if (listen) {
		for (const st of ['ok', 'near', 'swell', 'none'] as const) {
			mark(img, mx + 4, ly2 + 3, st, 3);
			const label = `${SYNC_MARKS[st].label} (${SYNC_MARKS[st].shape})`;
			drawText(img, label, mx + 11, ly2, TEXT);
			mx += 11 + textWidth(label) + 12;
		}
		for (const [name, c] of Object.entries(SECTION_COLOURS)) {
			if (mx + 60 > W) break;
			fillRect(img, mx, ly2 + 1, 10, 6, c);
			drawText(img, name, mx + 13, ly2, TEXT);
			mx += 13 + textWidth(name) + 12;
		}
	}
	if (specH && mx + 120 < W) {
		for (let k = 0; k < 40; k++) vline(img, mx + k, ly2 + 1, ly2 + 6, ramp(k / 39));
		drawText(img, 'spectrogram level', mx + 44, ly2, TEXT);
	}
	const extraLanes: TimelineCells['lanes'] = [];
	if (pictureH)
		extraLanes.push({
			name: 'picture',
			y: pictureY,
			height: pictureH,
			what: 'frames rendered through the export path at the cut, cue and event frames, each with a line to its frame',
		});
	if (specH)
		extraLanes.push({
			name: 'spectrogram',
			y: specY,
			height: specH,
			what: `the mix's spectrogram: log frequency ${Math.round(num(spec?.fMinHz, 30))} Hz (bottom) to ${Math.round(num(spec?.fMaxHz, 16000))} Hz (top), 10 ms columns, dark = quiet, yellow = loud`,
		});
	if (listen)
		extraLanes.push(
			{
				name: 'sections',
				y: sectionsY,
				height: sectionsH,
				what: 'sections of the listening transcript: dialogue green, music purple, ambience teal, effects orange, other grey, silence dark',
			},
			{
				name: 'sync',
				y: syncY,
				height: syncH,
				what: 'each cut (C), transition (T), cue (Q) and measured motion (M) by its answer: OK filled green circle, near hollow amber diamond, swell hollow blue triangle, no sound red cross',
			},
		);
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
					what: 'cue ticks: hero tall red, support short amber, dashed = unfilled, grey = muted; with a transcript, a mark beside each: OK filled green circle, near amber diamond, swell blue triangle, no sound red cross',
				},
				{
					name: 'move',
					y: motionY,
					height: motionH,
					what: 'picture motion speed, normalised together: the fastest keyframed layer (yellow) and, where analysed, the measured picture (pink)',
				},
				{
					name: 'check',
					y: flagY,
					height: flagH,
					what: 'Sound Check findings: red error, yellow warning, grey info',
				},
				...extraLanes,
			].sort((a, b) => a.y - b.y),
			cues,
			thumbs: thumbCells,
			sync: syncCells,
			sections: sectionCells,
			spectrogram: specH
				? {
						fMinHz: num(spec?.fMinHz, 30),
						fMaxHz: num(spec?.fMaxHz, 16000),
						bands: specBands,
						rows: specH,
					}
				: null,
			issues,
			peaks,
			normalization: v.normalization,
			pixelMotion: pixelState,
		},
	};
}
