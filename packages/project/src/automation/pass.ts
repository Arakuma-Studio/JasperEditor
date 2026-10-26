// One entry point per pass for producers (the engine's `edit-automation` job, tests, the accuracy harness, recipes):
// plan → which decorations need a sound → items → summary / draft. Pure.
import type { ProjectDocument } from '../schema/document.ts';
import { AutomationInputError, automationSequence, fpsValue, frameGeometry } from './common.ts';
import { type DecoratePlan, planDecorateCuts } from './decorate-cuts.ts';
import { type KenBurnsPlan, planKenBurns } from './ken-burns.ts';
import { AUTOMATION_PARAM_SCHEMAS, type AutomationPass, type AutomationSfx } from './params.ts';
import {
	automationDraft,
	decorateCutsItems,
	kenBurnsItems,
	type PassItems,
	type PassSfx,
	punchInItems,
} from './proposal.ts';
import { type PunchContext, type PunchPlan, planPunchIns } from './punch-ins.ts';
import { type ResolvedSfx, resolveSfx } from './sfx.ts';
import {
	type AutomationSummary,
	decorateSummary,
	kenBurnsSummary,
	punchSummary,
	summaryLine,
} from './summary.ts';

export type AutomationPlan = DecoratePlan | PunchPlan | KenBurnsPlan;

/** Validates a pass's parameters (strict); throws `AutomationInputError` naming the bad field. */
export function parsePassParams(pass: AutomationPass, raw: unknown): Record<string, unknown> {
	const r = AUTOMATION_PARAM_SCHEMAS[pass].safeParse(raw ?? {});
	if (!r.success)
		throw new AutomationInputError(
			'E_INVALID_PARAM',
			r.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; '),
		);
	return r.data as Record<string, unknown>;
}

export function planPass(
	doc: ProjectDocument,
	pass: AutomationPass,
	sequenceId: string | null | undefined,
	params: unknown,
	ctx: PunchContext = {},
): AutomationPlan {
	if (pass === 'decorate-cuts') return planDecorateCuts(doc, sequenceId, params);
	if (pass === 'punch-ins') return planPunchIns(doc, sequenceId, params, ctx);
	return planKenBurns(doc, sequenceId, params);
}

/** What the sound of a pass needs from the library: the role, the decorations (with seeds) and their window. */
export type SfxNeeds = {
	sfx: ResolvedSfx;
	items: { id: string; seed: number }[];
	windowSec: number;
	visualKind: 'transition' | 'move';
};

/** Null when the pass places no sound (Ken Burns, sfx off, nothing planned). */
export function sfxNeeds(
	doc: ProjectDocument,
	plan: AutomationPlan,
	params: { sfx?: AutomationSfx },
): SfxNeeds | null {
	if (plan.pass === 'ken-burns') return null;
	const sfx = resolveSfx(params.sfx, true);
	if (!sfx.enabled) return null;
	const fps = fpsValue(frameGeometry(automationSequence(doc, plan.sequenceId)).fps);
	if (plan.pass === 'decorate-cuts') {
		if (!plan.kits.length) return null;
		// the run-up into the cut is what a whoosh's lead must fill (its peak lands on the cut)
		const before = plan.kits.reduce((s, k) => s + k.before, 0) / plan.kits.length;
		return {
			sfx,
			items: plan.kits.map((k) => ({ id: k.id, seed: k.seed })),
			windowSec: before / fps,
			visualKind: 'transition',
		};
	}
	if (!plan.punches.length) return null;
	return {
		sfx,
		items: plan.punches.map((p) => ({ id: p.id, seed: p.seed })),
		windowSec: plan.punches[0]!.rampFrames / fps,
		visualKind: 'move',
	};
}

export function passItems(doc: ProjectDocument, plan: AutomationPlan, sfx?: PassSfx): PassItems {
	const seq = automationSequence(doc, plan.sequenceId);
	if (plan.pass === 'decorate-cuts') return decorateCutsItems(doc, seq, plan, sfx);
	if (plan.pass === 'punch-ins') return punchInItems(doc, seq, plan, sfx);
	return kenBurnsItems(seq, plan);
}

export function passSummary(plan: AutomationPlan, items: PassItems): AutomationSummary {
	if (plan.pass === 'decorate-cuts') return decorateSummary(plan, items.cost);
	if (plan.pass === 'punch-ins') return punchSummary(plan, items.cost);
	return kenBurnsSummary(plan, items.cost);
}

/**
 * The proposal draft of a planned pass (null when it planned nothing): the items, the summary line and a report with
 * the parameters (the refresher re-plans with them) and the summary.
 */
export function passDraft(
	plan: AutomationPlan,
	items: PassItems,
	params: Record<string, unknown>,
	extra: { warnings?: { code: string; message: string }[]; sfx?: Record<string, unknown> } = {},
) {
	const summary = passSummary(plan, items);
	if (!items.items.some((it) => (it.meta as { setup?: unknown } | undefined)?.setup !== true)) return null;
	const warnings = [...summary.warnings, ...(extra.warnings ?? [])];
	return automationDraft(plan.pass, plan.sequenceId, items.items, summaryLine(summary), {
		params,
		sequenceId: plan.sequenceId,
		summary: { ...summary, warnings },
		...(extra.sfx ? { sfx: extra.sfx } : {}),
		...(items.unsounded.length ? { unsounded: items.unsounded.slice(0, 500) } : {}),
	});
}
