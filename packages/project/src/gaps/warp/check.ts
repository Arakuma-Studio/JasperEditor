// INV-WARP (workstream gaps, docs/wp-notes/gaps.md §FX-6): a stored Warp Stabilizer analysis sits on a Warp Stabilizer
// instance of a clip and is well formed. Repair drops unusable analyses (the effect re-analyses in the background).
import type { ProjectDocument } from '../../schema/document.ts';
import { registerGapsCheck } from '../settings.ts';
import { WARP_STABILIZER_EFFECT_ID, WarpAnalysisDataSchema, warpAnalysisProblem } from './analysis.ts';

type Fx = { id: string; effectId: string; warpAnalysis?: unknown };

function problemOf(fx: Fx): string | null {
	if (fx.warpAnalysis === undefined) return null;
	if (fx.effectId !== WARP_STABILIZER_EFFECT_ID) return 'an analysis on an effect that is not a Warp Stabilizer';
	const parsed = WarpAnalysisDataSchema.safeParse(fx.warpAnalysis);
	if (!parsed.success) return 'an unreadable Warp Stabilizer analysis';
	return warpAnalysisProblem(parsed.data);
}

function clipWarpIssues(doc: Pick<ProjectDocument, 'media' | 'sequences'>) {
	const out: { invariant: string; message: string; path: string[] }[] = [];
	for (const seq of Object.values(doc.sequences))
		for (const c of Object.values(seq.clips))
			for (const fx of ((c as { effects?: Fx[] }).effects ?? []) as Fx[]) {
				const why = problemOf(fx);
				if (why)
					out.push({
						invariant: 'INV-WARP',
						message: `effect ${fx.id}: ${why}`,
						path: ['sequences', seq.id, 'clips', c.id, 'effects', fx.id, 'warpAnalysis'],
					});
			}
	return out;
}

function trackLists(doc: ProjectDocument): Fx[][] {
	const lists: Fx[][] = [];
	for (const seq of Object.values(doc.sequences)) {
		for (const kind of ['videoTracks', 'audioTracks', 'submixTracks'] as const)
			for (const t of ((seq as Record<string, unknown>)[kind] ?? []) as { effects?: Fx[] }[])
				if (t.effects) lists.push(t.effects);
		const m = (seq as { master?: { effects?: Fx[] } }).master;
		if (m?.effects) lists.push(m.effects);
	}
	return lists;
}

registerGapsCheck({
	clipIssues: clipWarpIssues,
	issues(doc) {
		const out = clipWarpIssues(doc);
		for (const list of trackLists(doc))
			for (const fx of list)
				if (fx.warpAnalysis !== undefined)
					out.push({
						invariant: 'INV-WARP',
						message: `effect ${fx.id}: a Warp Stabilizer analysis outside a clip`,
						path: ['effects', fx.id, 'warpAnalysis'],
					});
		return out;
	},
	repair(doc, note) {
		for (const seq of Object.values(doc.sequences))
			for (const c of Object.values(seq.clips))
				for (const fx of ((c as { effects?: Fx[] }).effects ?? []) as Fx[])
					if (problemOf(fx)) {
						delete fx.warpAnalysis;
						note('drop-warp-analysis', fx.id, 'unusable Warp Stabilizer analysis removed (it is re-analysed)');
					}
		for (const list of trackLists(doc))
			for (const fx of list)
				if (fx.warpAnalysis !== undefined) {
					delete fx.warpAnalysis;
					note('drop-warp-analysis', fx.id, 'Warp Stabilizer analysis outside a clip removed');
				}
	},
});
