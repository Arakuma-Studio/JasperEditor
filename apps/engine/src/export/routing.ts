// Per-span routing (docs/wp-notes/export-span-routing.md): an `auto` export whose native blockers belong to clips
// renders the frames those clips are drawn on through Remotion (the whole stack, as a Remotion export draws it) and the
// rest natively; the pieces are joined frame-exactly (service.ts `renderRoutes`). The same split serves the layers whose
// bake failed (`renderAroundFailedLayers`).
import type { RenderSnapshot } from '@jasper/project';
import { layerSpan } from './native-ext.ts';
import type { ExportRun } from './use-previews.ts';

/** A stretch of the range that must render on the Remotion path, and the item (clip / transition) and reason. */
export type RemotionSpan = { start: number; end: number; itemId?: string; reason?: string };

/**
 * What a piece costs (≈): the two paths' frame rates and the fixed seconds of one more piece on each. Only their
 * ratios decide the split. Basis (docs/wp-notes/export-span-routing.md "Cost model"): the video team's measurements on
 * the user's PC for the 56,199-frame project (Remotion 2.2–3.3 f/s, hybrid ≈ 8 f/s, 1080p60) and the per-piece set-up
 * measured in this branch's tests (plan + prepare + encoder start; Remotion's bundle, browser page and composition).
 */
export type RouteCost = {
	remotionFps: number;
	nativeFps: number;
	nativeRunSec: number;
	remotionRunSec: number;
	/** Pieces of one export at most (bounds the processes and the files of the join). */
	maxRuns: number;
};

export const ROUTE_COST: RouteCost = {
	remotionFps: 2.5,
	nativeFps: 8,
	nativeRunSec: 4,
	remotionRunSec: 8,
	maxRuns: 400,
};

/**
 * The runs of `range` when `spans` must render on the Remotion path and the rest may render natively. Spans closer than
 * the distance at which one more pair of pieces costs more than drawing the gap through Remotion are merged (and a
 * native stretch at an edge shorter than one native piece's cost); past `maxRuns` the smallest gaps are merged too.
 * Null when the split does not pay: nothing to split, Remotion would cover the range, or rendering the whole range on
 * the Remotion path is estimated cheaper.
 */
export function spanRuns(
	range: { start: number; end: number },
	spans: readonly { start: number; end: number }[],
	cost: RouteCost = ROUTE_COST,
): { runs: ExportRun[]; remotionFrames: number; seconds: number; wholeSeconds: number } | null {
	const frames = range.end - range.start;
	const delta = 1 / cost.remotionFps - 1 / cost.nativeFps;
	if (frames <= 0 || !(delta > 0)) return null;
	const merged: { start: number; end: number }[] = [];
	for (const s of spans
		.map((s) => ({ start: Math.max(range.start, s.start), end: Math.min(range.end, s.end) }))
		.filter((s) => s.end > s.start)
		.sort((a, b) => a.start - b.start)) {
		const last = merged.at(-1);
		if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
		else merged.push({ ...s });
	}
	if (merged.length === 0) return null;
	// a gap drawn by Remotion costs `gap × delta`; keeping it native costs one native and one Remotion piece more
	const pairGap = (cost.nativeRunSec + cost.remotionRunSec) / delta;
	const edgeGap = cost.nativeRunSec / delta;
	const stretches: { start: number; end: number }[] = [];
	for (const s of merged) {
		const last = stretches.at(-1);
		if (last && s.start - last.end < pairGap) last.end = s.end;
		else stretches.push({ ...s });
	}
	if (stretches[0]!.start - range.start < edgeGap) stretches[0]!.start = range.start;
	if (range.end - stretches.at(-1)!.end < edgeGap) stretches.at(-1)!.end = range.end;
	const count = () =>
		stretches.length * 2 +
		1 -
		(stretches[0]!.start === range.start ? 1 : 0) -
		(stretches.at(-1)!.end === range.end ? 1 : 0);
	while (stretches.length > 1 && count() > cost.maxRuns) {
		let at = 1;
		for (let i = 2; i < stretches.length; i++)
			if (stretches[i]!.start - stretches[i - 1]!.end < stretches[at]!.start - stretches[at - 1]!.end) at = i;
		stretches[at - 1]!.end = stretches[at]!.end;
		stretches.splice(at, 1);
	}
	const runs: ExportRun[] = [];
	let pos = range.start;
	for (const s of stretches) {
		if (s.start > pos) runs.push({ kind: 'render', start: pos, end: s.start });
		runs.push({ kind: 'render', start: s.start, end: s.end, engine: 'remotion' });
		pos = s.end;
	}
	if (pos < range.end) runs.push({ kind: 'render', start: pos, end: range.end });
	if (runs.length < 2) return null;
	const remotionFrames = stretches.reduce((n, s) => n + s.end - s.start, 0);
	const nativeRuns = runs.length - stretches.length;
	const seconds =
		remotionFrames / cost.remotionFps +
		(frames - remotionFrames) / cost.nativeFps +
		nativeRuns * cost.nativeRunSec +
		stretches.length * cost.remotionRunSec;
	const wholeSeconds = frames / cost.remotionFps + cost.remotionRunSec;
	if (seconds >= wholeSeconds) return null;
	return { runs, remotionFrames, seconds, wholeSeconds };
}

/** Every clip and transition id of a snapshot (nested ones under their top-level clip), with its top-level frames. */
function topLevelSpans(
	snap: RenderSnapshot,
	range: { start: number; end: number },
): Map<string, { start: number; end: number; top: string }> {
	const out = new Map<string, { start: number; end: number; top: string }>();
	const under = (s: RenderSnapshot, span: { start: number; end: number; top: string }, depth: number) => {
		// (nesting is bounded by the snapshot builder's cycle checks; the depth guard keeps this walk bounded too)
		if (depth > 64) return;
		for (const t of s.videoTracks) {
			for (const tr of t.transitions ?? []) out.set(tr.id, span);
			for (const c of t.clips) {
				out.set(c.clipId, span);
				if ('nest' in c.source) under(c.source.nest.snapshot, span, depth + 1);
			}
		}
	};
	for (const t of snap.videoTracks) {
		for (const tr of t.transitions ?? [])
			out.set(tr.id, {
				start: Math.max(range.start, tr.start),
				end: Math.min(range.end, tr.start + tr.duration),
				top: tr.id,
			});
		for (const c of t.clips) {
			const [start, end] = layerSpan(c, range);
			const span = { start, end, top: c.clipId };
			out.set(c.clipId, span);
			if ('nest' in c.source) under(c.source.nest.snapshot, span, 1);
		}
	}
	return out;
}

/**
 * The Remotion spans of native blockers: each blocker's item drawn over its frames (a nested clip or transition over
 * its top-level nest clip's). Null when a blocker names no drawn item (the whole export: an encoder, memory or a
 * sequence-wide setting).
 */
export function blockerSpans(
	snap: RenderSnapshot,
	range: { start: number; end: number },
	blockers: readonly { itemId?: string; reason: string }[],
): RemotionSpan[] | null {
	const spans = topLevelSpans(snap, range);
	const out: RemotionSpan[] = [];
	for (const b of blockers) {
		const s = b.itemId ? spans.get(b.itemId) : undefined;
		if (!s) return null;
		if (s.end > s.start) out.push({ start: s.start, end: s.end, itemId: b.itemId!, reason: b.reason });
	}
	return out;
}

/** The ids of the clips and transitions (nested ones included) drawn in the Remotion runs. */
export function remotionItems(
	snap: RenderSnapshot,
	range: { start: number; end: number },
	runs: readonly ExportRun[],
): Set<string> {
	const stretches = runs.filter((r) => r.kind === 'render' && r.engine === 'remotion');
	const out = new Set<string>();
	for (const [id, s] of topLevelSpans(snap, range))
		if (stretches.some((r) => s.start < r.end && s.end > r.start)) out.add(id);
	return out;
}

/** `100–160, 300–410` (the first `max`, then how many more). */
export function spanList(
	runs: readonly { start: number; end: number }[],
	max = Number.POSITIVE_INFINITY,
): string {
	const shown = runs.slice(0, max).map((r) => `${r.start}–${r.end}`);
	return `${shown.join(', ')}${runs.length > max ? ` and ${runs.length - max} more` : ''}`;
}
