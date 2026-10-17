// Picture-motion events (spec 12 §2.2 "pixel motion curve (engine, P6)", P6-R2): the engine's `motion-analysis` job
// measures the rendered picture frame by frame (`measureFrameMotion`); this turns that curve into events with the
// keyframe source's own rules (`speedSegments`, MOVE_ON / MOVE_OFF, ABRUPT_STOP, the 0.3 s whoosh / swish split, the
// impact bands), so footage and keyframed layers give the same kinds of cues:
//
// - `move`  a segment of motion, cue in the middle of its fastest stretch (frames within 10 % of the peak: measured
//           speeds are noisy, a keyframed linear move is exact); window = the segment;
// - `land`  where it settles: the first reversal of the motion along the peak's direction (overshoot, bounce), or the
//           arrival when it stops abruptly (the last moving frame ≥ ABRUPT_STOP of the peak); a gentle ease-out gets
//           none;
// - `cut`   a frame whose change motion does not explain (residual ≥ 0.08 and ≥ 3× the median of the surrounding
//           second): a cut or a flash inside footage, or an edit. Motion never spans a cut.
//
// Pan comes from the measured motion: a move covering ≥ half the frame (a camera pan) sweeps the way the picture
// travels (±40); a smaller one is placed at its on-screen x (±60) and sweeps from where it starts to where it ends.
// Confidence ≤ 0.5 (a measurement of pixels, not the edit's own data), weight support. Pure; never throws.
import type { CueAnchor } from '../../schema/sound.ts';
import type { SoundTypeId } from '../taxonomy.ts';
import { ABRUPT_STOP, speedSegments } from './motion.ts';
import type { ExtraCue } from './types.ts';

/** Highest confidence of a pixel cue. */
export const PIXEL_MAX_CONFIDENCE = 0.5;
/** A frame is a cut when its residual is at least this… */
export const PIXEL_CUT_RESIDUAL = 0.08;
/** …and this many times the median residual of the surrounding second. */
export const PIXEL_CUT_RATIO = 3;
/** Moves covering at least this share of the frame are camera moves (pan from the direction of travel). */
export const PIXEL_GLOBAL_AREA = 0.5;
/** A move's mean moving area must reach this (smaller is a flicker of a few blocks). */
export const PIXEL_MIN_AREA = 0.012;
/** Most frames one curve may have (bounds the analysis of hostile input). */
export const PIXEL_MAX_FRAMES = 200_000;

/** A measured motion curve of the picture: index i is sequence frame `startFrame + i`, measured against i − 1. */
export type PixelMotionCurve = {
	startFrame: number;
	fps: number;
	/** Analysis frame size (pixels; speeds are already in screen diagonals). */
	width: number;
	height: number;
	/** Speed of the moving parts (screen diagonals per second; index 0 = 0). */
	speed: ArrayLike<number>;
	/** Mean signed velocity of the moving parts (diagonals per second; x right, y down). */
	vx: ArrayLike<number>;
	vy: ArrayLike<number>;
	/** Share of the frame that moves (0…1). */
	area: ArrayLike<number>;
	/** Centre x of the moving parts (0 = left … 1 = right). */
	cx: ArrayLike<number>;
	/** Change motion does not explain (0…1): cuts and flashes. */
	residual: ArrayLike<number>;
};

export type PixelMoveEvent = {
	kind: 'move';
	/** Cue frame (middle of the fastest stretch). */
	frame: number;
	/** First frame that shows the motion … the frame after it arrives (exclusive). */
	start: number;
	end: number;
	peakSpeed: number;
	/** Mean moving share of the frame over the segment. */
	area: number;
	global: boolean;
	direction: 'left' | 'right' | 'up' | 'down';
	pan: number;
	panSweep?: { from: number; to: number };
};
export type PixelLandEvent = {
	kind: 'land';
	frame: number;
	how: 'overshoot' | 'bounce' | 'abrupt stop';
	/** √area × the highest speed in the 0.2 s before it (the keyframe source's impact measure). */
	energy: number;
	area: number;
	pan: number;
};
export type PixelCutEvent = { kind: 'cut'; frame: number; residual: number };
export type PixelMotionEvent = PixelMoveEvent | PixelLandEvent | PixelCutEvent;

const fin = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const panOf = (cx: number) => Math.round(Math.max(-60, Math.min(60, (fin(cx, 0.5) * 2 - 1) * 60)));

function median(xs: number[]): number {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[s.length >> 1]!;
}

/** Validated length of a curve (every series as long; 0 when unusable). */
function curveLength(c: PixelMotionCurve): number {
	if (!c || typeof c !== 'object') return 0;
	const series = [c.speed, c.vx, c.vy, c.area, c.cx, c.residual];
	if (series.some((s) => !s || typeof s.length !== 'number')) return 0;
	const n = Math.min(...series.map((s) => s.length));
	return Math.max(0, Math.min(PIXEL_MAX_FRAMES, Math.floor(n)));
}

/**
 * Cut frames of a curve (indices): residual spikes. `edits` are indices of known edit points (always cuts).
 */
export function pixelCutIndices(c: PixelMotionCurve, fps: number): number[] {
	const n = curveLength(c);
	const half = Math.max(2, Math.round(fps / 2));
	const out: number[] = [];
	for (let i = 1; i < n; i++) {
		const r = fin(c.residual[i]);
		if (r < PIXEL_CUT_RESIDUAL) continue;
		const around: number[] = [];
		for (let k = Math.max(1, i - half); k <= Math.min(n - 1, i + half); k++)
			if (Math.abs(k - i) > 1) around.push(fin(c.residual[k]));
		if (
			r >= PIXEL_CUT_RATIO * median(around) &&
			(i + 1 >= n || r >= fin(c.residual[i + 1])) &&
			r > fin(c.residual[i - 1])
		)
			out.push(i);
	}
	return out;
}

/**
 * Events of a measured motion curve. `opts.edits` = sequence frames of edit points (motion never spans them; they are
 * not reported as cuts here: the edits source has them).
 */
export function pixelMotionEvents(
	curve: PixelMotionCurve,
	opts: { edits?: readonly number[] } = {},
): PixelMotionEvent[] {
	try {
		return events(curve, opts);
	} catch {
		return [];
	}
}

function events(curve: PixelMotionCurve, opts: { edits?: readonly number[] }): PixelMotionEvent[] {
	const n = curveLength(curve);
	if (n < 3) return [];
	const fps = fin(curve.fps, 30) > 0 ? fin(curve.fps, 30) : 30;
	const start = Math.round(fin(curve.startFrame));
	const out: PixelMotionEvent[] = [];
	const speed = new Float64Array(n);
	for (let i = 1; i < n; i++) speed[i] = Math.max(0, Math.min(1e3, fin(curve.speed[i])));
	const edits = new Set<number>();
	for (const f of opts.edits ?? [])
		if (Number.isInteger(f) && f - start >= 0 && f - start < n) edits.add(f - start);
	const cuts = pixelCutIndices(curve, fps);
	for (const i of cuts)
		if (!edits.has(i)) out.push({ kind: 'cut', frame: start + i, residual: fin(curve.residual[i]) });
	// Motion never spans a cut (the flow across it is meaningless): the curve is cut into pieces there.
	const breaks = new Set<number>();
	for (const i of [...cuts, ...edits]) {
		speed[i] = 0;
		breaks.add(i);
		if (i + 1 < n && fin(curve.residual[i + 1]) >= PIXEL_CUT_RESIDUAL) speed[i + 1] = 0;
	}
	for (let i = 1; i < n; i++) if (fin(curve.area[i]) < PIXEL_MIN_AREA / 2) speed[i] = 0;
	const bridge = Math.max(2, Math.round(0.1 * fps));
	const bounds = [0, ...[...breaks].sort((a, b) => a - b), n];
	const segments: { a: number; b: number; peak: number }[] = [];
	for (let p = 0; p + 1 < bounds.length; p++) {
		const lo = bounds[p]!;
		const hi = bounds[p + 1]!;
		if (hi - lo < 2) continue;
		for (const sg of speedSegments(speed.subarray(lo, hi), bridge))
			segments.push({ a: sg.a + lo, b: sg.b + lo, peak: sg.peak + lo });
	}
	for (const seg of segments) {
		let areaSum = 0;
		let sx = 0;
		let sy = 0;
		for (let k = seg.a; k <= seg.b; k++) {
			areaSum += fin(curve.area[k]);
			sx += fin(curve.vx[k]);
			sy += fin(curve.vy[k]);
		}
		const len = seg.b - seg.a + 1;
		const area = areaSum / len;
		if (area < PIXEL_MIN_AREA) continue;
		const peakV = speed[seg.peak]!;
		let rs = seg.peak;
		let re = seg.peak;
		while (rs > seg.a && speed[rs - 1]! >= 0.9 * peakV) rs--;
		while (re < seg.b && speed[re + 1]! >= 0.9 * peakV) re++;
		const mid = Math.floor((rs + re) / 2);
		const global = area >= PIXEL_GLOBAL_AREA;
		const direction: PixelMoveEvent['direction'] =
			Math.abs(sx) >= Math.abs(sy) ? (sx >= 0 ? 'right' : 'left') : sy >= 0 ? 'down' : 'up';
		let pan = 0;
		let panSweep: { from: number; to: number } | undefined;
		const vlen = Math.hypot(sx, sy);
		if (global) {
			if (vlen > 0 && Math.abs(sx) >= 0.25 * vlen) {
				const s = sx >= 0 ? 1 : -1;
				panSweep = { from: -40 * s, to: 40 * s };
			}
		} else {
			pan = panOf(fin(curve.cx[mid], 0.5));
			const from = panOf(fin(curve.cx[seg.a], 0.5));
			const to = panOf(fin(curve.cx[seg.b], 0.5));
			if (Math.abs(to - from) >= 10) panSweep = { from, to };
		}
		out.push({
			kind: 'move',
			frame: start + mid,
			start: start + seg.a,
			end: start + seg.b + 1,
			peakSpeed: peakV,
			area,
			global,
			direction,
			pan,
			...(panSweep ? { panSweep } : {}),
		});
		// Landing: a reversal along the peak's direction (overshoot / bounce), else an abrupt stop.
		const px = fin(curve.vx[seg.peak]);
		const py = fin(curve.vy[seg.peak]);
		const along = (k: number) => fin(curve.vx[k]) * px + fin(curve.vy[k]) * py;
		const vPeak = along(seg.peak);
		let land = -1;
		let how: PixelLandEvent['how'] = 'abrupt stop';
		if (vPeak > 0) {
			for (let k = seg.peak + 1; k <= seg.b; k++) {
				const u = along(k);
				if (u < 0 && Math.abs(u) >= 0.02 * vPeak && speed[k]! > 0) {
					land = k - 1;
					how = 'overshoot';
					let flips = 0;
					let sign = -1;
					for (let j = k + 1; j <= seg.b; j++) {
						const sg = Math.sign(along(j));
						if (sg !== 0 && sg !== sign && speed[j]! > 0) {
							flips++;
							sign = sg;
						}
					}
					if (flips >= 1) how = 'bounce';
					break;
				}
			}
		}
		if (land < 0 && speed[seg.b]! >= ABRUPT_STOP * peakV) land = seg.b;
		if (land < 0) continue;
		let incoming = 0;
		for (let k = Math.max(seg.a, land - Math.round(0.2 * fps)); k <= land; k++)
			incoming = Math.max(incoming, speed[k]!);
		const landArea = Math.max(fin(curve.area[land]), area);
		out.push({
			kind: 'land',
			frame: start + land,
			how,
			energy: Math.sqrt(landArea) * incoming,
			area: landArea,
			pan: global ? 0 : panOf(fin(curve.cx[land], 0.5)),
		});
	}
	return out.sort((a, b) => a.frame - b.frame || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

/** What a pixel event is tied to: the footage shown there (a `scene` anchor) and a name for reasons. */
export type PixelAnchorAt = (frame: number) => { anchor: CueAnchor; where: string } | null;

const anchorKey = (a: CueAnchor): string =>
	a.type === 'scene' ? `${a.mediaId}@${Math.round(a.mediaSec * 1000)}` : JSON.stringify(a);

/**
 * The cues of picture-motion events (`from: 'pixel'`). Events with no footage under them (`anchorAt` null) are left
 * out: graphics and keyframed layers have their own sources. Returns the cues and how many were left out.
 */
export function pixelMotionCues(
	curve: PixelMotionCurve,
	evs: readonly PixelMotionEvent[],
	anchorAt: PixelAnchorAt,
): { cues: ExtraCue[]; unanchored: number } {
	const fps = fin(curve?.fps, 30) > 0 ? fin(curve?.fps, 30) : 30;
	const sec = (frames: number) => `${(frames / fps).toFixed(2).replace(/0$/, '')} s`;
	const cues: ExtraCue[] = [];
	let unanchored = 0;
	for (const e of evs) {
		let at: ReturnType<PixelAnchorAt> = null;
		try {
			at = anchorAt(e.frame);
		} catch {
			at = null;
		}
		if (!at) {
			unanchored++;
			continue;
		}
		const key = `pixel:${e.kind}:${anchorKey(at.anchor)}`;
		if (e.kind === 'cut') {
			cues.push({
				key,
				frame: e.frame,
				kind: 'cut',
				weight: 'support',
				types: ['hit', 'thump', 'transition', 'glitch', 'click'],
				align: 'peak',
				anchor: at.anchor,
				confidence: 0.4,
				reason: `Picture changes at once (cut or flash, ${Math.round(e.residual * 100)} % unexplained) in ${at.where}`,
				from: 'pixel',
				size: 1,
			});
			continue;
		}
		if (e.kind === 'move') {
			const frames = e.end - e.start;
			const long = frames >= 0.3 * fps;
			const what = e.global ? `Camera moves ${e.direction}` : `Something moves ${e.direction}`;
			cues.push({
				key,
				frame: e.frame,
				kind: 'move',
				weight: 'support',
				types: long ? ['whoosh', 'swish', 'transition'] : ['swish', 'whoosh'],
				align: 'peak',
				...(e.global ? {} : { pan: e.pan }),
				...(e.panSweep ? { panSweep: { ...e.panSweep } } : {}),
				anchor: at.anchor,
				confidence: Math.min(PIXEL_MAX_CONFIDENCE, 0.3 + 0.2 * Math.min(1, e.peakSpeed)),
				reason: `Picture motion: ${what} (peak ${e.peakSpeed.toFixed(2)} screens/s over ${sec(frames)}, ${Math.round(e.area * 100)} % of the frame) in ${at.where}`,
				window: { start: e.start, end: e.end },
				from: 'pixel',
				size: Math.max(0.02, Math.min(1, e.area)),
			});
			continue;
		}
		let types: SoundTypeId[];
		if (e.energy >= 0.5) types = ['hit', 'thump', 'tap'];
		else if (e.energy >= 0.15) types = ['thump', 'hit', 'tap'];
		else types = ['tap', 'thump', 'pop'];
		cues.push({
			key,
			frame: e.frame,
			kind: 'land',
			weight: 'support',
			types,
			align: 'peak',
			pan: e.pan,
			anchor: at.anchor,
			confidence: e.how === 'abrupt stop' ? 0.45 : PIXEL_MAX_CONFIDENCE,
			reason: `Picture motion ${e.how === 'abrupt stop' ? 'stops' : `settles (${e.how})`} in ${at.where}`,
			from: 'pixel',
			size: Math.max(0.02, Math.min(1, e.area)),
		});
	}
	return { cues, unanchored };
}
