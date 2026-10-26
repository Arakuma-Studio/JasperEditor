// Dry-run summaries of the editing-automation passes (spec 15 EA-033, EA-040/EA-041): what a pass would do — counts,
// coverage of the cuts / clips it considered, why the others were left out, kit families, and the export cost class —
// without creating anything. The same summary is the proposal's report (with the parameters for the refresher). Pure.
import type { DecoratePlan } from './decorate-cuts.ts';
import type { KenBurnsPlan } from './ken-burns.ts';
import type { MusicPlan } from './music.ts';
import type { AutomationPass } from './params.ts';
import type { AutomationCost } from './proposal.ts';
import type { PunchPlan } from './punch-ins.ts';
import type { ReactionPlan } from './reactions.ts';
import type { SlidePlan } from './slides.ts';
import type { StingerPlan } from './stingers.ts';

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
	/**
	 * Pass-specific counts: reactions by trigger kind (`marker`, `cta`, `exclamation`, `hidden`), slides `heads` /
	 * `tails` and per direction, beds `onCut` / `intro` / `ducked`, stingers by source (`both`, `loudness`,
	 * `exclamation`).
	 */
	detail?: Record<string, number>;
	/** Reactions / music: the assets the pass draws from (count and the first names). */
	assets?: { count: number; names: string[] };
	cost: AutomationCost;
	/** Where the new adjustment clips go (a track label, or "new track <name>"). */
	track?: string;
	warnings: { code: string; message: string }[];
};

function skips(
	list: readonly { frame: number; timecode: string; code: string; reason: string; clipId?: string }[],
) {
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

const trackOf = (t: { create: true; name: string } | { create: false; label: string }) =>
	t.create ? `new track ${t.name}` : t.label;
const countBy = <T>(list: readonly T[], key: (x: T) => string) => {
	const out: Record<string, number> = {};
	for (const x of list) out[key(x)] = (out[key(x)] ?? 0) + 1;
	return out;
};
const assetsOf = (list: readonly { name: string }[]) => ({
	count: list.length,
	names: list.slice(0, 20).map((a) => a.name),
});

export function reactionSummary(plan: ReactionPlan, cost: AutomationCost): AutomationSummary {
	return {
		pass: 'reactions',
		sequenceId: plan.sequenceId,
		seed: plan.seed,
		count: plan.reactions.length,
		considered: plan.considered,
		coverage: ratio(plan.reactions.length, plan.considered),
		skipped: skips(plan.skipped),
		detail: { ...plan.triggers, onCut: plan.reactions.filter((r) => r.cut).length },
		assets: assetsOf(plan.assets),
		cost,
		track: trackOf(plan.reactionTrack),
		warnings: plan.warnings,
	};
}

export function slideSummary(plan: SlidePlan, cost: AutomationCost): AutomationSummary {
	return {
		pass: 'slides',
		sequenceId: plan.sequenceId,
		seed: plan.seed,
		count: plan.slides.length,
		considered: plan.considered,
		coverage: ratio(plan.slides.length, plan.considered),
		skipped: skips(plan.skipped),
		detail: {
			overlays: plan.overlays,
			heads: plan.slides.filter((s) => s.edge === 'in').length,
			tails: plan.slides.filter((s) => s.edge === 'out').length,
			...countBy(plan.slides, (s) => s.choice.direction),
		},
		cost,
		warnings: plan.warnings,
	};
}

export function musicSummary(plan: MusicPlan, cost: AutomationCost): AutomationSummary {
	return {
		pass: 'music',
		sequenceId: plan.sequenceId,
		seed: plan.seed,
		count: plan.beds.length,
		considered: plan.considered,
		coverage: ratio(Math.min(plan.beds.length, plan.considered), plan.considered),
		skipped: skips(plan.skipped),
		detail: {
			onCut: plan.beds.filter((b) => b.switchAt === 'cut').length,
			switches: Math.max(0, plan.beds.length - 1),
			intro: plan.beds.some((b) => b.parts.some((p) => p.intro)) ? 1 : 0,
			ducked: plan.duck.enabled ? plan.beds.filter((b) => b.duckRegions.length).length : 0,
		},
		assets: assetsOf(plan.songs),
		cost,
		track: trackOf(plan.musicTrack),
		warnings: plan.warnings,
	};
}

export function stingerSummary(plan: StingerPlan, cost: AutomationCost): AutomationSummary {
	return {
		pass: 'stingers',
		sequenceId: plan.sequenceId,
		seed: plan.seed,
		count: plan.stingers.length,
		considered: plan.considered,
		coverage: ratio(plan.stingers.length, plan.considered),
		skipped: skips(plan.skipped),
		detail: countBy(plan.stingers, (s) => s.trigger.source),
		cost,
		track: trackOf(plan.stingerTrack),
		warnings: plan.warnings,
	};
}

const NOUNS: Record<AutomationPass, [string, string]> = {
	'decorate-cuts': ['cut kits', 'cuts'],
	'punch-ins': ['punch-ins', 'candidate clips'],
	'ken-burns': ['Ken Burns moves', 'candidate clips'],
	reactions: ['reactions', 'triggers'],
	slides: ['overlay slides', 'overlay edges'],
	music: ['music beds', 'songs'],
	stingers: ['stingers', 'punchlines'],
};

/** "214 cut kits on 225 cuts (95 %); 11 left out; export: Remotion path" — the proposal's summary line (English). */
export function summaryLine(s: AutomationSummary): string {
	const [noun, of] = NOUNS[s.pass];
	const pct = Math.round(s.coverage * 100);
	const cost =
		s.cost.class === 'native'
			? 'exports natively'
			: s.cost.class === 'hybrid'
				? `the export stays native with the decorated layers baked by the Remotion renderer (${s.cost.effects.join(', ')})`
				: `the export renders through the Remotion path (${s.cost.effects.join(', ')})`;
	if (s.pass === 'music')
		return `${s.count} ${noun} from ${s.considered} ${of}${s.detail?.switches ? `, ${s.detail.onCut ?? 0} of ${s.detail.switches} switches on a cut` : ''}; ${cost}`;
	return `${s.count} ${noun} on ${s.considered} ${of} (${pct} %)${s.skipped.count ? `; ${s.skipped.count} left out` : ''}; ${cost}`;
}
