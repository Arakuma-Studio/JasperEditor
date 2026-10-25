// Dry-run summaries of the editing-automation passes (spec 15 EA-033, EA-040/EA-041): what a pass would do — counts,
// coverage of the cuts / clips it considered, why the others were left out, kit families, and the export cost class —
// without creating anything. The same summary is the proposal's report (with the parameters for the refresher). Pure.
import type { DecoratePlan } from './decorate-cuts.ts';
import type { KenBurnsPlan } from './ken-burns.ts';
import type { AutomationPass } from './params.ts';
import type { AutomationCost } from './proposal.ts';
import type { PunchPlan } from './punch-ins.ts';

/** Skips listed in a summary (the rest are counted). */
export const SUMMARY_SKIP_LIST = 200;

export type AutomationSummary = {
	pass: AutomationPass;
	sequenceId: string;
	seed: number;
	/** Decorations planned. */
	count: number;
	/** Cuts (Decorate Cuts) or clips (punch-ins, Ken Burns) considered. */
	considered: number;
	/** count ÷ considered (0 when nothing was considered). */
	coverage: number;
	skipped: {
		count: number;
		byCode: Record<string, number>;
		first: { frame: number; timecode: string; code: string; reason: string; clipId?: string }[];
	};
	/** Decorate Cuts: kits per family. */
	families?: Record<string, number>;
	cost: AutomationCost;
	/** Where the new adjustment clips go (a track label, or "new track <name>"). */
	track?: string;
	warnings: { code: string; message: string }[];
};

function skips(list: readonly { frame: number; timecode: string; code: string; reason: string; clipId?: string }[]) {
	const byCode: Record<string, number> = {};
	for (const s of list) byCode[s.code] = (byCode[s.code] ?? 0) + 1;
	return { count: list.length, byCode, first: list.slice(0, SUMMARY_SKIP_LIST) };
}

const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : 0);

export function decorateSummary(plan: DecoratePlan, cost: AutomationCost): AutomationSummary {
	return {
		pass: 'decorate-cuts',
		sequenceId: plan.sequenceId,
		seed: plan.seed,
		count: plan.kits.length,
		considered: plan.considered,
		coverage: ratio(plan.kits.length, plan.considered),
		skipped: skips(plan.skipped),
		families: plan.families,
		cost,
		track: plan.fxTrack.create ? `new track ${plan.fxTrack.name}` : plan.fxTrack.label,
		warnings: plan.warnings,
	};
}

export function punchSummary(plan: PunchPlan, cost: AutomationCost): AutomationSummary {
	return {
		pass: 'punch-ins',
		sequenceId: plan.sequenceId,
		seed: plan.seed,
		count: plan.punches.length,
		considered: plan.candidates,
		coverage: ratio(plan.punches.length, plan.candidates),
		skipped: skips(plan.skipped),
		cost,
		...(plan.zoomTrack
			? { track: plan.zoomTrack.create ? `new track ${plan.zoomTrack.name}` : plan.zoomTrack.label }
			: {}),
		warnings: plan.warnings,
	};
}

export function kenBurnsSummary(plan: KenBurnsPlan, cost: AutomationCost): AutomationSummary {
	return {
		pass: 'ken-burns',
		sequenceId: plan.sequenceId,
		seed: plan.seed,
		count: plan.moves.length,
		considered: plan.candidates,
		coverage: ratio(plan.moves.length, plan.candidates),
		skipped: skips(plan.skipped),
		cost,
		warnings: plan.warnings,
	};
}

/** "214 cut kits on 225 cuts (95 %); 11 left out; export: Remotion path" — the proposal's summary line (English). */
export function summaryLine(s: AutomationSummary): string {
	const noun = s.pass === 'decorate-cuts' ? 'cut kits' : s.pass === 'punch-ins' ? 'punch-ins' : 'Ken Burns moves';
	const of = s.pass === 'decorate-cuts' ? 'cuts' : 'candidate clips';
	const pct = Math.round(s.coverage * 100);
	const cost =
		s.cost.class === 'native'
			? 'exports natively'
			: `the export renders through the Remotion path (${s.cost.effects.join(', ')})`;
	return `${s.count} ${noun} on ${s.considered} ${of} (${pct} %)${s.skipped.count ? `; ${s.skipped.count} left out` : ''}; ${cost}`;
}
