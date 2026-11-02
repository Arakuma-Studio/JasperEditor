// Spec 19 TL-102: the measurements behind `title_check`, pure: rendered frames in, verify-style rows out. Nothing here
// renders or judges taste. Four renders of a frame make its measurement:
//   with    the Program frame                     what the viewer sees
//   behind  the same frame with the title off     the real background
//   black, white  the title alone over each       difference matting: its real alpha, on any render path
// Formulas, sources and the assumptions among the thresholds: docs/wp-notes/title-looks-agents.md.
import { contentTimeAt } from '../derive/index.ts';
import type { DeliveryTargetId } from '../delivery/targets.ts';
import { evaluate, isAnimated } from '../keyframes.ts';
import type { Animatable } from '../schema/common.ts';
import type { Clip, TextAnimation } from '../schema/sequence.ts';
import { resolveTextAnimationWindows } from '../text-animations.ts';
import type { Rational } from '../time.ts';

export type TitleImage = { width: number; height: number; data: Uint8Array };
export type TitleCheckStatus = 'pass' | 'warn' | 'fail' | 'unverified';
/** `format`: what you may fix unasked. `judgement`: tell the user what was measured and ask. As in `verify_export`. */
export type TitleCheckKind = 'format' | 'judgement';
export type TitleCheckAt = { frame: number; sec: number; timecode: string };
/** A mechanical repair: commands for `apply_commands`, or only what to do when none can be written. */
export type TitleCheckFix = { label: string; commands?: Record<string, unknown>[] };
export type TitleCheckRow = {
	id: string;
	kind: TitleCheckKind;
	status: TitleCheckStatus;
	measured: unknown;
	expected: unknown;
	at: TitleCheckAt | null;
	message: string;
	fix?: TitleCheckFix;
};

/** The Program monitor's margins (`TransformOverlay`), percent of the frame per side. */
export const TITLE_SAFE_MARGINS = { action: 5, title: 10 } as const;

export const TITLE_CHECK_THRESHOLDS = {
	/** WCAG 2.x SC 1.4.3 (AA): large text, and everything else. */
	contrastLarge: 3,
	contrastNormal: 4.5,
	/** WCAG's "large" 24 CSS px, on a 1080-line frame (assumption: the frame is the page). */
	largeSizeAt1080: 24,
	/** Assumption: 36 px on a 1080-line frame, a size a phone still shows. Fraction of the shorter side. */
	minSizeFraction: 1 / 30,
	/** BBC subtitle guidelines: 180 words a minute, ≈ 15 characters a second in English. */
	readCps: 15,
	/** Netflix's Chinese guides allow 9 a second; applied to every CJK script (assumption). */
	readCpsCjk: 9,
	/** Assumption: a title shorter than this is a flash, however few letters it has. */
	minReadSec: 1.5,
	/** Alpha that counts as the title's ink, and as a faint glow reaching the frame edge. */
	inkAlpha: 0.5,
	faintAlpha: 8 / 255,
	solidAlpha: 0.9,
} as const;

/**
 * Where a vertical platform's own interface covers the picture, percent per side. No platform publishes one canonical
 * table and sources disagree, so these are assumptions and only ever warn: basis in the wp-note.
 */
export const TITLE_PLATFORM_ZONES: Partial<
	Record<DeliveryTargetId, { top: number; bottom: number; left: number; right: number }>
> = {
	tiktok: { top: 11, bottom: 16, left: 6, right: 11 },
	'instagram-reels': { top: 14, bottom: 23, left: 6, right: 11 },
	'youtube-shorts': { top: 11, bottom: 23, left: 6, right: 11 },
};

/** Sequence px, `x1`/`y1` exclusive. */
export type TitleBounds = { x0: number; y0: number; x1: number; y1: number };

export type TitleContrast = {
	/** Median contrast ratio across the tiles of the title, and the ratio of its worst tenth. */
	ratio: number;
	worst: number;
	/** What keeps most tiles readable: the inside of the title against the background, its outer edge, or its own contrast. */
	carriedBy: 'face' | 'edge' | 'own-contrast';
	face: string;
	background: string;
	tiles: number;
	worstTile: TitleBounds;
};

export type TitleFrameMeasure = {
	frame: number;
	/** Bounds of the title's ink and of everything it draws, null when nothing is drawn there. */
	ink: TitleBounds | null;
	faint: TitleBounds | null;
	contrast: TitleContrast | null;
	/** Mean CIE L* of the rendered picture just outside the title (the style lint's `rendered` seam), null when none. */
	backdropL: number | null;
};

export type TitleFrameRenders = { with: TitleImage; behind: TitleImage; black: TitleImage; white: TitleImage };

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

const channelLinear = (c: number) => {
	const s = c / 255;
	return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const LINEAR = Float64Array.from({ length: 256 }, (_, i) => channelLinear(i));

/** WCAG relative luminance of an 8-bit sRGB colour. */
export function relativeLuminance(r: number, g: number, b: number): number {
	return 0.2126 * LINEAR[r]! + 0.7152 * LINEAR[g]! + 0.0722 * LINEAR[b]!;
}

/** WCAG contrast ratio, 1…21. */
export function contrastRatio(a: number, b: number): number {
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Alpha per pixel from the title over black and over white: `over = c + (1 − a)·background` gives
 * `white − black = (1 − a)·255`. Exact for any render path, and the title's colour does not matter.
 */
export function matteAlpha(black: TitleImage, white: TitleImage): Float32Array {
	const n = black.width * black.height;
	const a = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const p = i * 4;
		const d =
			white.data[p]! -
			black.data[p]! +
			(white.data[p + 1]! - black.data[p + 1]!) +
			(white.data[p + 2]! - black.data[p + 2]!);
		a[i] = Math.min(1, Math.max(0, 1 - d / 765));
	}
	return a;
}

/** Pixel box of the alpha at or above `threshold`, or null. */
function alphaBox(alpha: Float32Array, w: number, h: number, threshold: number): TitleBounds | null {
	let x0 = w;
	let y0 = h;
	let x1 = -1;
	let y1 = -1;
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			if (alpha[y * w + x]! < threshold) continue;
			if (x < x0) x0 = x;
			if (x > x1) x1 = x;
			if (y < y0) y0 = y;
			if (y > y1) y1 = y;
		}
	return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

const scaled = (b: TitleBounds, k: number): TitleBounds => ({
	x0: Math.round(b.x0 * k),
	y0: Math.round(b.y0 * k),
	x1: Math.round(b.x1 * k),
	y1: Math.round(b.y1 * k),
});

const hex = (r: number, g: number, b: number) =>
	`#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

function percentile(sorted: readonly number[], q: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))] ?? 0;
}

const medianOf = (v: number[]) => percentile(v.sort((a, b) => a - b), 0.5);

/** Per-channel median colour of the pixels `at`, as hex. */
function medianColor(img: TitleImage, at: readonly number[]): string {
	const c: number[][] = [[], [], []];
	for (const i of at) for (let k = 0; k < 3; k++) c[k]!.push(img.data[i * 4 + k]!);
	return hex(medianOf(c[0]!), medianOf(c[1]!), medianOf(c[2]!));
}

/**
 * Contrast of the title with what is really behind it, tile by tile, so a title half over sky and half over sand is not
 * averaged into a pass. A tile counts as readable by whichever carries it: the face against the background, the outer
 * edge against it (a dark rim on a light picture), or the title's own contrast (letters on their plate).
 */
export function measureContrast(withImg: TitleImage, behind: TitleImage, alpha: Float32Array): TitleContrast | null {
	const w = withImg.width;
	const h = withImg.height;
	const box = alphaBox(alpha, w, h, TITLE_CHECK_THRESHOLDS.inkAlpha);
	if (!box) return null;
	const size = Math.max(8, Math.round(w / 40));
	const ink = (x: number, y: number) =>
		x >= 0 && y >= 0 && x < w && y < h && alpha[y * w + x]! >= TITLE_CHECK_THRESHOLDS.inkAlpha;
	const lum = (img: TitleImage, i: number) =>
		relativeLuminance(img.data[i * 4]!, img.data[i * 4 + 1]!, img.data[i * 4 + 2]!);
	const tiles: { ratio: number; by: TitleContrast['carriedBy']; box: TitleBounds }[] = [];
	const inkAt: number[] = [];
	const behindAt: number[] = [];
	for (let ty = box.y0; ty < box.y1; ty += size)
		for (let tx = box.x0; tx < box.x1; tx += size) {
			const xEnd = Math.min(box.x1, tx + size);
			const yEnd = Math.min(box.y1, ty + size);
			const interior: number[] = [];
			const edge: number[] = [];
			const solid: number[] = [];
			const back: number[] = [];
			for (let y = ty; y < yEnd; y++)
				for (let x = tx; x < xEnd; x++) {
					const i = y * w + x;
					back.push(lum(behind, i));
					behindAt.push(i);
					if (!ink(x, y)) continue;
					inkAt.push(i);
					const l = lum(withImg, i);
					if (ink(x - 1, y) && ink(x + 1, y) && ink(x, y - 1) && ink(x, y + 1)) interior.push(l);
					else edge.push(l);
					if (alpha[i]! >= TITLE_CHECK_THRESHOLDS.solidAlpha) solid.push(l);
				}
			// Solid ink only: a sliver of soft shadow or glow in the box's corner is not a part of the title to read.
			if (solid.length < Math.max(4, (xEnd - tx) * (yEnd - ty) * 0.1)) continue;
			const bg = medianOf(back);
			const face = interior.length ? contrastRatio(medianOf(interior), bg) : 1;
			const rim = edge.length ? contrastRatio(medianOf(edge), bg) : 1;
			solid.sort((a, b) => a - b);
			const own = solid.length >= 4 ? contrastRatio(percentile(solid, 0.95), percentile(solid, 0.05)) : 1;
			const ratio = Math.max(face, rim, own);
			tiles.push({
				ratio,
				by: ratio === face ? 'face' : ratio === rim ? 'edge' : 'own-contrast',
				box: { x0: tx, y0: ty, x1: xEnd, y1: yEnd },
			});
		}
	if (!tiles.length) return null;
	tiles.sort((a, b) => a.ratio - b.ratio);
	const count = { face: 0, edge: 0, 'own-contrast': 0 };
	for (const t of tiles) count[t.by]++;
	const carriedBy = (Object.keys(count) as TitleContrast['carriedBy'][]).sort((a, b) => count[b] - count[a])[0]!;
	return {
		ratio: round(percentile(tiles.map((t) => t.ratio), 0.5)),
		worst: round(percentile(tiles.map((t) => t.ratio), 0.1)),
		carriedBy,
		face: medianColor(withImg, inkAt),
		background: medianColor(behind, behindAt),
		tiles: tiles.length,
		worstTile: tiles[0]!.box,
	};
}

/** CIE L* of a relative luminance. */
function lightness(y: number): number {
	return 116 * (y > 216 / 24389 ? Math.cbrt(y) : ((24389 / 27) * y + 16) / 116) - 16;
}

/** Mean L* of `behind` in a ring of about 1/64 of the width around the ink, ink excluded. */
export function measureBackdropL(behind: TitleImage, alpha: Float32Array): number | null {
	const { width: w, height: h } = behind;
	const box = alphaBox(alpha, w, h, TITLE_CHECK_THRESHOLDS.inkAlpha);
	if (!box) return null;
	const r = Math.max(2, Math.round(w / 64));
	// Dilate the ink by r: along rows into `rows`, then along columns into `ring`.
	const rows = new Uint8Array(w * h);
	const ring = new Uint8Array(w * h);
	for (let y = box.y0; y < box.y1; y++)
		for (let x = box.x0; x < box.x1; x++)
			if (alpha[y * w + x]! >= TITLE_CHECK_THRESHOLDS.inkAlpha)
				rows.fill(1, y * w + Math.max(0, x - r), y * w + Math.min(w, x + r + 1));
	const yEnd = Math.min(h, box.y1 + r);
	for (let y = box.y0; y < box.y1; y++)
		for (let x = Math.max(0, box.x0 - r); x < Math.min(w, box.x1 + r); x++)
			if (rows[y * w + x])
				for (let v = Math.max(0, y - r); v < Math.min(yEnd, y + r + 1); v++) ring[v * w + x] = 1;
	let sum = 0;
	let n = 0;
	for (let i = 0; i < ring.length; i++) {
		if (!ring[i] || alpha[i]! >= TITLE_CHECK_THRESHOLDS.inkAlpha) continue;
		const p = i * 4;
		sum += lightness(relativeLuminance(behind.data[p]!, behind.data[p + 1]!, behind.data[p + 2]!));
		n++;
	}
	return n ? round(sum / n, 1) : null;
}

/** One frame's measurement. `sequenceWidth` turns image px into sequence px. Throws when the renders do not match. */
export function measureTitleFrame(
	frame: number,
	r: TitleFrameRenders,
	sequenceWidth: number,
): TitleFrameMeasure {
	const { width: w, height: h } = r.with;
	for (const img of [r.behind, r.black, r.white])
		if (img.width !== w || img.height !== h)
			throw new Error(`The renders of frame ${frame} differ in size (${w}×${h}, ${img.width}×${img.height})`);
	const alpha = matteAlpha(r.black, r.white);
	const k = sequenceWidth / Math.max(1, w);
	const ink = alphaBox(alpha, w, h, TITLE_CHECK_THRESHOLDS.inkAlpha);
	const faint = alphaBox(alpha, w, h, TITLE_CHECK_THRESHOLDS.faintAlpha);
	const contrast = measureContrast(r.with, r.behind, alpha);
	return {
		frame,
		ink: ink && scaled(ink, k),
		faint: faint && scaled(faint, k),
		contrast: contrast && { ...contrast, worstTile: scaled(contrast.worstTile, k) },
		backdropL: measureBackdropL(r.behind, alpha),
	};
}

export type TitleTiming = {
	inFrames: number;
	outFrames: number;
	/** Sequence frames: mid-intro, mid-hold, mid-outro (the sheet), first and last frame at rest. */
	intro: number;
	hold: number;
	outro: number;
	holdStart: number;
	holdEnd: number;
};

/** When a clip's title is coming in, at rest and going out, from its text animators. */
export function titleTiming(
	clip: Pick<Clip, 'start' | 'duration'> & { textAnimation?: TextAnimation | null },
): TitleTiming {
	const w = resolveTextAnimationWindows(clip);
	const d = Math.max(1, clip.duration);
	const inFrames = w.in?.frames ?? 0;
	const outFrames = w.out?.frames ?? 0;
	const holdStart = clip.start + Math.min(d - 1, inFrames);
	const holdEnd = clip.start + Math.max(Math.min(d - 1, inFrames), d - 1 - outFrames);
	return {
		inFrames,
		outFrames,
		intro: clip.start + Math.floor(inFrames / 2),
		hold: Math.floor((holdStart + holdEnd) / 2),
		outro: clip.start + d - 1 - Math.floor(outFrames / 2),
		holdStart,
		holdEnd,
	};
}

/** Frames `title_check` measures: the title at rest, first, middle and last, without repeats. */
export function titleCheckFrames(t: TitleTiming): number[] {
	return [...new Set([t.holdStart, t.hold, t.holdEnd])];
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Seconds a reader needs for `text`. Spaces do not count; a CJK character weighs its slower reading speed. */
export function titleReadSeconds(text: string): number {
	const t = TITLE_CHECK_THRESHOLDS;
	let sec = 0;
	for (const ch of text.replace(/\s+/gu, '')) sec += 1 / (CJK.test(ch) ? t.readCpsCjk : t.readCps);
	return Math.max(t.minReadSec, sec);
}

type Size = { width: number; height: number };

function overflow(b: TitleBounds, rect: TitleBounds): number {
	return Math.max(rect.x0 - b.x0, rect.y0 - b.y0, b.x1 - rect.x1, b.y1 - rect.y1, 0);
}

const inset = (s: Size, m: { top: number; bottom: number; left: number; right: number }): TitleBounds => ({
	x0: (s.width * m.left) / 100,
	y0: (s.height * m.top) / 100,
	x1: s.width - (s.width * m.right) / 100,
	y1: s.height - (s.height * m.bottom) / 100,
});
const even = (p: number) => ({ top: p, bottom: p, left: p, right: p });

function worstFrame(frames: readonly TitleFrameMeasure[], score: (f: TitleFrameMeasure) => number) {
	let best = frames[0]!;
	for (const f of frames) if (score(f) > score(best)) best = f;
	return best;
}

/** The safe-area, off-frame and contrast rows of the measured frames. */
export function titleRenderedRows(o: {
	frames: readonly TitleFrameMeasure[];
	size: Size;
	/** The text's size in sequence px, null for other clips (their contrast uses the normal threshold). */
	sizePx: number | null;
	target?: DeliveryTargetId | null | undefined;
	atOf: (frame: number) => TitleCheckAt;
	/** Commands that move or scale the title; absent for a proposal, or when the Motion is animated. */
	moveFix?: ((dx: number, dy: number, scale: number) => Record<string, unknown>[]) | null;
	/** Commands that add a separating rim; absent when there is no look to add it to. */
	rimFix?: ((color: [number, number, number, number]) => Record<string, unknown>[]) | null;
}): TitleCheckRow[] {
	const { frames, size, atOf } = o;
	const seen = frames.filter((f) => f.ink);
	if (!seen.length) {
		const at = frames[0] ? atOf(frames[0].frame) : null;
		const nothing = 'Nothing of the title is drawn at the frames it should be at rest: it is off, covered or empty.';
		return ['safe-area', 'off-frame', 'contrast'].map((id) => ({
			id,
			kind: 'format' as const,
			status: 'fail' as const,
			measured: { drawn: false },
			expected: 'a visible title',
			at,
			message: nothing,
		}));
	}
	const titleRect = inset(size, even(TITLE_SAFE_MARGINS.title));
	const actionRect = inset(size, even(TITLE_SAFE_MARGINS.action));
	const worstSafe = worstFrame(seen, (f) => overflow(f.ink!, titleRect));
	const ink = worstSafe.ink!;
	const overTitle = overflow(ink, titleRect);
	const overAction = overflow(ink, actionRect);
	const safe: TitleCheckRow = {
		id: 'safe-area',
		kind: 'format',
		status: overAction > 0 ? 'fail' : overTitle > 0 ? 'warn' : 'pass',
		measured: { bounds: ink, overTitleSafePx: Math.ceil(overTitle), overActionSafePx: Math.ceil(overAction) },
		expected: { titleSafe: titleRect, actionSafe: actionRect },
		at: atOf(worstSafe.frame),
		message:
			overTitle === 0
				? 'The title is inside the title-safe area on every frame measured.'
				: `The title leaves the ${overAction > 0 ? 'action' : 'title'}-safe area by ${Math.ceil(overAction || overTitle)} px.`,
	};
	if (overTitle > 0 && o.moveFix) {
		const w = ink.x1 - ink.x0;
		const h = ink.y1 - ink.y0;
		const roomW = titleRect.x1 - titleRect.x0;
		const roomH = titleRect.y1 - titleRect.y0;
		const scale = Math.min(1, roomW / w, roomH / h);
		const cx = (ink.x0 + ink.x1) / 2;
		const cy = (ink.y0 + ink.y1) / 2;
		const halfW = (w * scale) / 2;
		const halfH = (h * scale) / 2;
		const dx = Math.min(titleRect.x1 - halfW, Math.max(titleRect.x0 + halfW, cx)) - cx;
		const dy = Math.min(titleRect.y1 - halfH, Math.max(titleRect.y0 + halfH, cy)) - cy;
		safe.fix = {
			label: scale < 1 ? 'Scale the title into the title-safe area' : 'Move the title into the title-safe area',
			commands: o.moveFix(Math.round(dx), Math.round(dy), scale),
		};
	}
	const rows: TitleCheckRow[] = [safe];

	const zone = o.target ? TITLE_PLATFORM_ZONES[o.target] : undefined;
	if (zone) {
		const rect = inset(size, zone);
		const worst = worstFrame(seen, (f) => overflow(f.ink!, rect));
		const over = overflow(worst.ink!, rect);
		rows.push({
			id: 'target-safe-area',
			kind: 'judgement',
			status: over > 0 ? 'warn' : 'pass',
			measured: { bounds: worst.ink, overPx: Math.ceil(over) },
			expected: { zone: rect, basis: 'unofficial: platforms publish no single table' },
			at: atOf(worst.frame),
			message:
				over > 0
					? `The title reaches ${Math.ceil(over)} px into where ${o.target} usually draws its own interface (an estimate, not a platform figure).`
					: `The title is clear of where ${o.target} usually draws its own interface (an estimate, not a platform figure).`,
		});
	}

	const edge = (b: TitleBounds) =>
		[
			b.x0 <= 0 ? 'left' : null,
			b.y0 <= 0 ? 'top' : null,
			b.x1 >= size.width ? 'right' : null,
			b.y1 >= size.height ? 'bottom' : null,
		].filter((s) => s !== null);
	const clipped = seen.find((f) => edge(f.ink!).length);
	const glowing = frames.find((f) => f.faint && edge(f.faint).length);
	const offAt = clipped ?? glowing ?? seen[0]!;
	rows.push({
		id: 'off-frame',
		kind: 'format',
		status: clipped ? 'fail' : glowing ? 'warn' : 'pass',
		measured: {
			inkTouches: clipped ? edge(clipped.ink!) : [],
			faintTouches: glowing?.faint ? edge(glowing.faint) : [],
		},
		expected: 'no ink on the frame edge while the title is at rest',
		at: atOf(offAt.frame),
		message: clipped
			? `The frame cuts the title off on the ${edge(clipped.ink!).join(' and ')}.`
			: glowing
				? `A glow or shadow of the title reaches the ${edge(glowing.faint!).join(' and ')} of the frame.`
				: 'Everything the title draws stays inside the frame.',
	});

	const t = TITLE_CHECK_THRESHOLDS;
	const large = o.sizePx !== null && (o.sizePx * 1080) / Math.min(size.width, size.height) >= t.largeSizeAt1080;
	const min = large ? t.contrastLarge : t.contrastNormal;
	const measured = seen.filter((f) => f.contrast);
	if (!measured.length)
		rows.push({
			id: 'contrast',
			kind: 'format',
			status: 'unverified',
			measured: null,
			expected: { minRatio: min },
			at: atOf(seen[0]!.frame),
			message: 'The title is too small in the rendered frames to measure its contrast.',
		});
	else {
		const worst = worstFrame(measured, (f) => -f.contrast!.ratio);
		const c = worst.contrast!;
		const status = c.ratio < min ? 'fail' : c.worst < min ? 'warn' : 'pass';
		const row: TitleCheckRow = {
			id: 'contrast',
			kind: 'format',
			status,
			measured: { ...c, frames: measured.map((f) => ({ frame: f.frame, ratio: f.contrast!.ratio })) },
			expected: { minRatio: min, standard: large ? 'WCAG AA, large text' : 'WCAG AA' },
			at: atOf(worst.frame),
			message:
				status === 'pass'
					? `Contrast ${c.ratio}:1 against the rendered background (worst tenth ${c.worst}:1).`
					: status === 'warn'
						? `Contrast is ${c.ratio}:1 overall but ${c.worst}:1 on the worst tenth of the title, around x ${c.worstTile.x0}, y ${c.worstTile.y0}.`
						: `Contrast is ${c.ratio}:1 against the rendered background, under ${min}:1.`,
		};
		if (status !== 'pass') {
			const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(c.background.slice(i, i + 2), 16)) as [
				number,
				number,
				number,
			];
			const light = relativeLuminance(r, g, b) > 0.18;
			const color: [number, number, number, number] = light ? [0, 0, 0, 1] : [1, 1, 1, 1];
			row.fix = o.rimFix
				? { label: `Add a ${light ? 'dark' : 'light'} rim`, commands: o.rimFix(color) }
				: { label: `Use a colourway with more contrast, or add a ${light ? 'dark' : 'light'} rim to the look` };
		}
		rows.push(row);
	}
	return rows;
}

type TextClipLike = {
	id: string;
	start: number;
	duration: number;
	sourceIn?: number;
	transform?: { scale?: Animatable<number>; scaleWidth?: Animatable<number> };
	content: { text: string; style: { sizePx: number } & Record<string, unknown> };
};

/** The text's size in sequence px at a frame, Motion's scale included. */
export function titleSizePx(clip: TextClipLike, frame: number, rate: Rational): number {
	const s = clip.transform?.scale;
	const scale = s ? evaluate(s, contentTimeAt(clip as never, frame, rate)) : 100;
	return clip.content.style.sizePx * (Number.isFinite(scale) ? scale : 100) * 0.01;
}

/** The min-size and read-time rows of a text clip. */
export function titleTextRows(o: {
	clip: TextClipLike;
	timing: TitleTiming;
	size: Size;
	rate: Rational;
	atOf: (frame: number) => TitleCheckAt;
	/** Write repairs as commands (off for a proposal: its clip has no id yet). */
	fixes: boolean;
}): TitleCheckRow[] {
	const { clip, timing, size, rate } = o;
	const t = TITLE_CHECK_THRESHOLDS;
	const fps = rate.num / rate.den;
	const px = titleSizePx(clip, timing.hold, rate);
	const min = Math.ceil(Math.min(size.width, size.height) * t.minSizeFraction);
	const animated = isAnimated(clip.transform?.scale);
	const small: TitleCheckRow = {
		id: 'min-size',
		kind: 'format',
		status: px >= min ? 'pass' : 'fail',
		measured: { sizePx: round(px, 1) },
		expected: { minSizePx: min, basis: 'one thirtieth of the shorter frame side' },
		at: o.atOf(timing.hold),
		message: px >= min ? `The text is ${round(px, 1)} px.` : `The text is ${round(px, 1)} px, under ${min} px.`,
	};
	if (px < min)
		small.fix = {
			label: `Set the text size to ${min} px`,
			...(o.fixes && !animated
				? {
						commands: [
							{
								type: 'clip.update',
								clipId: clip.id,
								patch: {
									content: {
										style: {
											...clip.content.style,
											sizePx: Math.ceil((clip.content.style.sizePx * min) / px),
										},
									},
								},
							},
						],
					}
				: {}),
		};
	// The animations count half: a title coming in can be read partly (assumption).
	const readable = (clip.duration - (timing.inFrames + timing.outFrames) / 2) / fps;
	const need = titleReadSeconds(clip.content.text);
	const read: TitleCheckRow = {
		id: 'read-time',
		kind: 'judgement',
		status: readable >= need ? 'pass' : 'warn',
		measured: { readableSec: round(readable), characters: [...clip.content.text.replace(/\s+/gu, '')].length },
		expected: { minSec: round(need) },
		at: o.atOf(clip.start),
		message:
			readable >= need
				? `${round(readable)} s to read it, ${round(need)} s needed.`
				: `The title stays ${round(readable)} s; reading it takes about ${round(need)} s.`,
	};
	if (readable < need) {
		const frames = Math.ceil((need - readable) * fps);
		read.fix = {
			label: `Lengthen the title by ${frames} frames`,
			...(o.fixes
				? { commands: [{ type: 'clip.trim', clipId: clip.id, edge: 'out', deltaFrames: frames }] }
				: {}),
		};
	}
	return [small, read];
}

/** What the rows cannot say, returned with every check so an agent never reports more than was measured. */
export const TITLE_NOT_CHECKED = [
	'Taste: whether the look suits the film, the brand or the moment.',
	'The title while it animates in and out: rows measure it at rest.',
	'Spelling, wording and whether the text is true.',
] as const;

export function summarizeTitleRows(rows: readonly TitleCheckRow[]) {
	const counts = { pass: 0, warn: 0, fail: 0, unverified: 0 };
	for (const r of rows) counts[r.status]++;
	return {
		counts,
		verified: counts.fail === 0 && !rows.some((r) => r.status === 'unverified' && r.kind === 'format'),
	};
}
