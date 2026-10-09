// Export checks of the Warp Stabilizer (workstream gaps, docs/wp-notes/gaps.md §FX-6): an enabled stabiliser without
// its analysis would export unstabilised (the preview shows Premiere's "Analyzing" banner meanwhile), so the planner
// refuses with WARP_NOT_ANALYZED (AGENTS.md §4); frames outside the analysed span hold the nearest analysed frame's
// correction and are reported as a warning (WARP_PARTIAL).
import type { RenderSnapshot, RenderVisualClip } from '../../render/snapshot.ts';
import { FLICKS_PER_SECOND, type Rational } from '../../time.ts';
import { clipMediaTimeAt, type TimedClip } from '../../time-remap/model.ts';
import { WARP_STABILIZER_EFFECT_ID, type WarpAnalysisData, warpFrameCount } from './analysis.ts';

export type WarpExportIssue = { clipId: string; kind: 'not-analyzed' | 'partial'; message: string };

function clipsOf(snap: RenderSnapshot): RenderVisualClip[] {
	const out: RenderVisualClip[] = [];
	for (const t of snap.videoTracks)
		for (const c of t.clips) {
			out.push(c);
			if ('nest' in c.source) out.push(...clipsOf(c.source.nest.snapshot));
		}
	return out;
}

export function warpExportIssues(snap: RenderSnapshot): WarpExportIssue[] {
	const out: WarpExportIssue[] = [];
	const fps = snap.settings.fps as Rational;
	for (const c of clipsOf(snap)) {
		for (const fx of c.effects) {
			if (!fx.enabled || fx.effectId !== WARP_STABILIZER_EFFECT_ID) continue;
			const f0 = Math.max(c.start - (c.headHandle ?? 0), snap.range.start);
			const f1 = Math.min(c.start + c.duration + (c.tailHandle ?? 0), snap.range.end);
			if (f1 <= f0) continue;
			const a = (fx as { warpAnalysis?: WarpAnalysisData }).warpAnalysis;
			if (!a) {
				out.push({
					clipId: c.clipId,
					kind: 'not-analyzed',
					message: `Warp Stabilizer on clip ${c.clipId} has not been analysed yet (Effect Controls ▸ Warp Stabilizer ▸ Analyze)`,
				});
				continue;
			}
			const lo = a.start - a.frameDuration / 2;
			const hi = a.start + (warpFrameCount(a) - 0.5) * a.frameDuration;
			let outside = 0;
			for (let f = f0; f < f1; f++) {
				const t = clipMediaTimeAt(c as unknown as TimedClip, f, fps) / FLICKS_PER_SECOND;
				if (t < lo - 1e-6 || t > hi + 1e-6) outside++;
			}
			if (outside)
				out.push({
					clipId: c.clipId,
					kind: 'partial',
					message: `Warp Stabilizer on clip ${c.clipId}: ${outside} frames are outside the analysed span (re-analyse after extending the clip)`,
				});
		}
	}
	return out;
}
