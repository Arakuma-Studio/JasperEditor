// Warp Stabilizer ▸ the analysis stored WITH the effect instance (workstream gaps, docs/wp-notes/gaps.md §FX-6), as
// Premiere keeps it in the project: `EffectInstance.warpAnalysis`. The engine's `warp-analysis` job measures it
// (apps/engine/src/gaps/warp-analysis.ts); `effect.setWarpAnalysis` stores it (undoable). Frames are indexed by MEDIA
// time (frame 0 at `start` seconds into the media), so trimming the clip inside the analysed span needs no
// re-analysis. Compact layout: per frame 14 numbers (translation 2, similarity 4, homography 8); trajectories as
// x, y interleaved at 0.1 px.
import { z } from 'zod';
import type { FxClipInfo } from '../../registry/fx/shader.ts';
import { DEFAULT_STAB_SETTINGS, type StabPlan, type StabSettings, stabPlan, type WarpAnalysis } from './stabilize.ts';

export const WARP_STABILIZER_EFFECT_ID = 'jasper.warp-stabilizer';
/** Numbers per analysed frame. */
export const WARP_FRAME_STRIDE = 14;
/** Longest analysis (frames): 30 min at 30 fps. */
export const WARP_MAX_FRAMES = 54_000;
/** Most trajectory points kept (budget of the project file). */
export const WARP_MAX_TRACK_POINTS = 120_000;

export const WarpTrackSchema = z.looseObject({
	start: z.number().int().min(0),
	/** x, y interleaved (analysis px). */
	pts: z.array(z.number()).max(2 * WARP_MAX_FRAMES),
});

export const WarpAnalysisDataSchema = z.looseObject({
	version: z.literal(1),
	/** Identity of the contents (the engine's hash): caches key on it. */
	key: z.string().min(1).max(200),
	/** The media analysed (a clip whose media changed needs a new analysis). */
	mediaId: z.string().optional(),
	/** Media time (s) of frame 0 and the frame duration (s). */
	start: z.number().min(0),
	frameDuration: z.number().positive(),
	/** Analysis coordinates: the media's display size in px. */
	size: z.tuple([z.number().positive(), z.number().positive()]),
	detailed: z.boolean(),
	/** `WARP_FRAME_STRIDE` numbers per frame. */
	frames: z.array(z.number()).max(WARP_FRAME_STRIDE * WARP_MAX_FRAMES),
	tracks: z.array(WarpTrackSchema).max(20_000).optional(),
	/** Mean share of tracked features that agreed with the frame's homography (0..1), for the status line. */
	confidence: z.number().min(0).max(1).optional(),
	analyzedAt: z.string().optional(),
});
export type WarpAnalysisData = z.infer<typeof WarpAnalysisDataSchema>;

/** Number of frames of an analysis. */
export const warpFrameCount = (a: Pick<WarpAnalysisData, 'frames'>): number =>
	Math.floor(a.frames.length / WARP_FRAME_STRIDE);

/** Structural problem of a stored analysis (null = usable). */
export function warpAnalysisProblem(a: WarpAnalysisData): string | null {
	if (a.frames.length % WARP_FRAME_STRIDE !== 0) return 'frames is not a whole number of records';
	if (!a.frames.every(Number.isFinite)) return 'frames has non-finite numbers';
	const n = warpFrameCount(a);
	let pts = 0;
	for (const t of a.tracks ?? []) {
		if (t.pts.length % 2 !== 0 || !t.pts.every(Number.isFinite)) return 'a trajectory is malformed';
		if (t.start + t.pts.length / 2 > n) return 'a trajectory runs past the analysed frames';
		pts += t.pts.length / 2;
	}
	if (pts > WARP_MAX_TRACK_POINTS) return 'too many trajectory points';
	return null;
}

const decoded = new WeakMap<object, WarpAnalysis>();

/** The analysis in the stabiliser's shape (memoised per stored object). */
export function decodeWarpAnalysis(a: WarpAnalysisData): WarpAnalysis {
	const hit = decoded.get(a);
	if (hit) return hit;
	const n = warpFrameCount(a);
	const frames = [];
	for (let i = 0; i < n; i++) {
		const o = i * WARP_FRAME_STRIDE;
		const f = a.frames;
		frames.push({
			t: [f[o]!, f[o + 1]!] as const,
			s: [f[o + 2]!, f[o + 3]!, f[o + 4]!, f[o + 5]!] as const,
			h: f.slice(o + 6, o + 14),
		});
	}
	const tracks = (a.tracks ?? []).map((t) => {
		const pts: [number, number][] = [];
		for (let i = 0; i + 1 < t.pts.length; i += 2) pts.push([t.pts[i]!, t.pts[i + 1]!]);
		return { start: t.start, pts };
	});
	const out: WarpAnalysis = { size: [a.size[0], a.size[1]], frames, tracks };
	decoded.set(a, out);
	return out;
}

/** Media time (s) shown at a clip-local frame (the clip's in-point and speed; no clip = the analysis start). */
export function mediaTimeAtClipFrame(
	a: Pick<WarpAnalysisData, 'start'>,
	frame: number,
	fps: number,
	clip?: Pick<FxClipInfo, 'sourceInSeconds' | 'speed' | 'reverse'>,
): number {
	if (!clip) return a.start + frame / Math.max(1e-6, fps);
	const d = (frame / Math.max(1e-6, fps)) * (clip.speed || 1);
	return clip.sourceInSeconds + (clip.reverse ? -d : d);
}

/** The analysed frame at a media time (held at the ends) and whether the time is inside the analysed span. */
export function warpFrameAt(
	a: Pick<WarpAnalysisData, 'start' | 'frameDuration' | 'frames'>,
	mediaTime: number,
): { index: number; inside: boolean } {
	const n = warpFrameCount(a);
	const i = Math.round((mediaTime - a.start) / a.frameDuration);
	return { index: Math.max(0, Math.min(n - 1, i)), inside: i >= 0 && i < n };
}

/** The stabiliser's settings from the effect's params. */
export function warpSettingsOf(p: Record<string, unknown>, fps: number): StabSettings {
	const num = (k: string, d: number) => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? (p[k] as number) : d);
	const pick = <T extends string>(k: string, opts: readonly T[], d: T): T =>
		opts.includes(p[k] as T) ? (p[k] as T) : d;
	return {
		result: pick('result', ['smoothMotion', 'noMotion'] as const, DEFAULT_STAB_SETTINGS.result),
		smoothness: Math.max(0, num('smoothness', 50)),
		method: pick(
			'method',
			['position', 'positionScaleRotation', 'perspective', 'subspaceWarp'] as const,
			DEFAULT_STAB_SETTINGS.method,
		),
		preserveScale: p.preserveScale === true,
		framing: pick(
			'framing',
			['stabilizeOnly', 'stabilizeCrop', 'stabilizeCropAutoScale', 'synthesizeEdges'] as const,
			DEFAULT_STAB_SETTINGS.framing,
		),
		maxScale: Math.max(100, num('maxScale', 150)),
		actionSafe: Math.max(0, Math.min(45, num('actionSafe', 0))),
		additionalScale: Math.max(1, num('additionalScale', 100)),
		// Adobe's control is 0…100 (50 = balanced); the stabiliser's −100…100.
		cropLessSmoothMore: (Math.max(0, Math.min(100, num('cropLessSmoothMore', 50))) - 50) * 2,
		fps: Math.max(1, fps),
		ripple: pick('rollingShutterRipple', ['automatic', 'enhanced'] as const, 'automatic'),
	};
}

const PLAN_CACHE_MAX = 6;
const plans = new Map<string, StabPlan>();

/** The stabilisation plan of an analysis at settings (cached: re-planning happens when settings change). */
export function warpPlanFor(a: WarpAnalysisData, s: StabSettings): StabPlan {
	const key = `${a.key}|${JSON.stringify(s)}`;
	const hit = plans.get(key);
	if (hit) {
		plans.delete(key);
		plans.set(key, hit);
		return hit;
	}
	const plan = stabPlan(decodeWarpAnalysis(a), s);
	plans.set(key, plan);
	while (plans.size > PLAN_CACHE_MAX) plans.delete(plans.keys().next().value!);
	return plan;
}

/** Analysis frames per second from the stored frame duration. */
export const warpAnalysisFps = (a: Pick<WarpAnalysisData, 'frameDuration'>): number => 1 / a.frameDuration;
