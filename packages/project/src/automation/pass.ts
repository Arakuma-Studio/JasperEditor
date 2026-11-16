// One entry point per pass for producers (the engine's `edit-automation` job, tests, the accuracy harness, recipes):
// plan → which decorations need a sound → items → summary / draft. Pure.
import type { ProjectDocument } from '../schema/document.ts';
import type { VoiceActivity } from '../sound/cues/dialogue.ts';
import type { VisualKind } from '../sound/taxonomy.ts';
import type { FolderAsset } from './assets.ts';
import { AutomationInputError, automationSequence, fpsValue, frameGeometry } from './common.ts';
import { type DecoratePlan, planDecorateCuts } from './decorate-cuts.ts';
import { type KenBurnsPlan, planKenBurns } from './ken-burns.ts';
import { type MusicPlan, planMusicBed } from './music.ts';
import { musicItems, reactionItems, slideItems, stingerItems } from './overlay-items.ts';
import {
	AUTOMATION_PARAM_SCHEMAS,
	type AutomationPass,
	type AutomationSfx,
	type WhooshMedia,
} from './params.ts';
import {
	automationDraft,
	decorateCutsItems,
	kenBurnsItems,
	type PassItems,
	type PassSfx,
	punchInItems,
} from './proposal.ts';
import { type PunchContext, type PunchPlan, planPunchIns } from './punch-ins.ts';
import { planReactions, type ReactionPlan } from './reactions.ts';
import { assignWhooshSlices, type ResolvedSfx, resolveSfx, type WhooshSlice } from './sfx.ts';
import type { LoudnessCurve } from './signals.ts';
import { planSlides, type SlidePlan } from './slides.ts';
import { planStingers, STINGER_SYNTH_RECIPE, type StingerPlan } from './stingers.ts';
import {
	type AutomationSummary,
	decorateSummary,
	kenBurnsSummary,
	musicSummary,
	punchSummary,
	reactionSummary,
	slideSummary,
	stingerSummary,
	summaryLine,
} from './summary.ts';

export type AutomationPlan =
	| DecoratePlan
	| PunchPlan
	| KenBurnsPlan
	| ReactionPlan
	| SlidePlan
	| MusicPlan
	| StingerPlan;

/** What the engine measured or listed for a pass (all optional; the planners are pure). */
export type PassContext = PunchContext & {
	/** Files of the folder an asset source names (reactions, music). */
	folder?: readonly FolderAsset[];
	/** Voice activity of dialogue clips without words (music ducking). */
	voice?: VoiceActivity | null;
	/** Momentary loudness of the dialogue (stingers). */
	loudness?: LoudnessCurve | null;
};

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
	ctx: PassContext = {},
): AutomationPlan {
	if (pass === 'decorate-cuts') return planDecorateCuts(doc, sequenceId, params);
	if (pass === 'punch-ins') return planPunchIns(doc, sequenceId, params, ctx);
	if (pass === 'reactions')
		return planReactions(doc, sequenceId, params, ctx.folder ? { folder: ctx.folder } : {});
	if (pass === 'slides') return planSlides(doc, sequenceId, params);
	if (pass === 'music')
		return planMusicBed(doc, sequenceId, params, {
			...(ctx.folder ? { folder: ctx.folder } : {}),
			...(ctx.voice !== undefined ? { voice: ctx.voice } : {}),
		});
	if (pass === 'stingers')
		return planStingers(
			doc,
			sequenceId,
			params,
			ctx.loudness !== undefined ? { loudness: ctx.loudness } : {},
		);
	return planKenBurns(doc, sequenceId, params);
}

/** What the sound of a pass needs from the library: the role, the decorations (with seeds) and their window. */
export type SfxNeeds = {
	sfx: ResolvedSfx;
	items: { id: string; seed: number }[];
	windowSec: number;
	visualKind: VisualKind;
	/** Only Jasper Synth sounds of this recipe (the stingers' generated noise). */
	recipe?: string;
};

/** Null when the pass places no sound (Ken Burns, sfx off, nothing planned). */
export function sfxNeeds(
	doc: ProjectDocument,
	plan: AutomationPlan,
	params: { sfx?: AutomationSfx },
): SfxNeeds | null {
	if (plan.pass === 'stingers') {
		if (plan.sound === 'none' || !plan.stingers.length) return null;
		const fps = fpsValue(frameGeometry(automationSequence(doc, plan.sequenceId)).fps);
		const generated = plan.sound === 'generated';
		const base = generated
			? resolveSfx({ type: 'glitch', sources: ['synth'], variety: 8 }, true)
			: resolveSfx({ type: 'glitch', ...plan.sfx }, true);
		const sfx = {
			...base,
			enabled: true,
			gainDb: generated ? plan.gainDb : (plan.sfx?.gainDb ?? plan.gainDb),
		};
		return {
			sfx,
			items: plan.stingers.map((x) => ({ id: x.id, seed: x.seed })),
			windowSec: plan.frames / fps,
			visualKind: 'emphasis',
			...(generated ? { recipe: STINGER_SYNTH_RECIPE } : {}),
		};
	}
	if (plan.pass !== 'decorate-cuts' && plan.pass !== 'punch-ins') return null;
	const sfx = resolveSfx(params.sfx, true);
	if (!sfx.enabled) return null;
	// whooshes cut from a project media need no library sounds (`whooshNeeds`)
	if (plan.pass === 'decorate-cuts' && whooshMediaOf(params)) return null;
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

const whooshMediaOf = (params: { sfx?: unknown }): WhooshMedia | null =>
	((params.sfx as { media?: WhooshMedia } | undefined)?.media ?? null) as WhooshMedia | null;

/** What Decorate Cuts' whooshes cut from a project media need: the media, its slices (or `auto`) and the kits. */
export type WhooshNeeds = {
	media: WhooshMedia;
	items: { id: string; frames: number }[];
	sfx: ResolvedSfx;
};

/** Null unless a Decorate Cuts plan with kits takes its whooshes from `sfx.media` (and sounds are on). */
export function whooshNeeds(plan: AutomationPlan, params: { sfx?: unknown }): WhooshNeeds | null {
	if (plan.pass !== 'decorate-cuts' || !plan.kits.length) return null;
	const media = whooshMediaOf(params);
	const sfx = resolveSfx(params.sfx as AutomationSfx | undefined, true);
	if (!media || !sfx.enabled) return null;
	return { media, items: plan.kits.map((k) => ({ id: k.id, frames: k.end - k.start })), sfx };
}

/** The pass's sounds from the measured slices of the whoosh media (assigned per `media.match`). */
export function whooshPassSfx(
	doc: ProjectDocument,
	plan: AutomationPlan,
	needs: WhooshNeeds,
	slices: readonly WhooshSlice[],
): PassSfx {
	const fps = fpsValue(frameGeometry(automationSequence(doc, plan.sequenceId)).fps);
	const m = doc.media?.[needs.media.mediaId];
	return {
		media: [],
		assign: new Map(),
		type: needs.sfx.type,
		...(needs.sfx.gainDb !== undefined ? { gainDb: needs.sfx.gainDb } : {}),
		slices: {
			mediaId: needs.media.mediaId,
			title: (m?.originalName || needs.media.mediaId).slice(0, 80),
			slices,
			assign: assignWhooshSlices(needs.items, slices, { match: needs.media.match ?? 'length', fps }),
		},
	};
}

export function passItems(doc: ProjectDocument, plan: AutomationPlan, sfx?: PassSfx): PassItems {
	const seq = automationSequence(doc, plan.sequenceId);
	if (plan.pass === 'decorate-cuts') return decorateCutsItems(doc, seq, plan, sfx);
	if (plan.pass === 'punch-ins') return punchInItems(doc, seq, plan, sfx);
	if (plan.pass === 'reactions') return reactionItems(seq, plan);
	if (plan.pass === 'slides') return slideItems(seq, plan);
	if (plan.pass === 'music') return musicItems(seq, plan);
	if (plan.pass === 'stingers') return stingerItems(doc, seq, plan, sfx);
	return kenBurnsItems(seq, plan);
}

export function passSummary(plan: AutomationPlan, items: PassItems): AutomationSummary {
	if (plan.pass === 'decorate-cuts') return decorateSummary(plan, items.cost);
	if (plan.pass === 'punch-ins') return punchSummary(plan, items.cost);
	if (plan.pass === 'reactions') return reactionSummary(plan, items.cost);
	if (plan.pass === 'slides') return slideSummary(plan, items.cost);
	if (plan.pass === 'music') return musicSummary(plan, items.cost);
	if (plan.pass === 'stingers') return stingerSummary(plan, items.cost);
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
