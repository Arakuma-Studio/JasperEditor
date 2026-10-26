// The editing-automation producer of the engine (spec 15 EA-020…EA-022, EA-030…EA-033): the `edit-automation` job and
// the dry run of `POST /api/projects/:projectId/automation/:pass`, and the refresher of feature `edit-automation`.
// The planning is the pure `@jasper/project` automation module; this file does the I/O around it:
//   1. the live document (the open editor's when one holds the project, else the saved one);
//   2. punch-ins toward the subject: clips without a faces roto get the subject from the Auto Reframe analysis (the
//      face model when installed, else saliency), measured inline on the frames where the zoom starts;
//   3. the pass's sounds through the sound-design system: the library's sounds of the role (`whoosh`), from the allowed
//      sources / pack / folder, ranked and rotated by the pure helpers, registered for the project (setup items);
//   4. the budget (E_TOO_LARGE with a range that fits), then the proposal through the proposals service.
// Nothing is applied: the user reviews the proposal (or an allowed agent accepts it).
import {
	type AutomationPassId,
	type AutomationPassResult,
	mediaRegisterCommand,
	type RegisterSoundResponse,
	type SoundEntry,
} from '@jasper/api';
import {
	AutomationInputError,
	type AutomationPlan,
	assignSfx,
	automationReportOf,
	automationSequence,
	type ClipSubject,
	FLICKS_PER_SECOND,
	type PassSfx,
	type ProjectDocument,
	type Proposal,
	type PunchPlan,
	parsePassParams,
	passDraft,
	passItems,
	passSummary,
	planPass,
	proposalBudget,
	rankSfx,
	refreshAutomationItems,
	type SfxNeeds,
	type SoundProposalMedia,
	sfxNeeds,
	sfxPool,
} from '@jasper/project';
import type { AgentService } from '../agent/service.ts';
import type { ReframeService } from '../gaps/reframe.ts';
import { type JobContext, JobError } from '../jobs/types.ts';
import type { ProposalService, Requester } from '../proposals/service.ts';
import { liveDocument } from '../sound-design/plan.ts';
import type { SoundService } from '../sounds/service.ts';
import { HttpError } from '../tools/reply.ts';

export type AutomationDeps = {
	agent: () => AgentService | undefined;
	proposals: () => ProposalService | undefined;
	sounds: () => SoundService | undefined;
	reframe: () => ReframeService | undefined;
};

export type AutomationJobInput = {
	projectId: string;
	pass: AutomationPassId;
	sequenceId?: string;
	params: Record<string, unknown>;
	who: Requester;
};

/** Sounds registered at once (each is a probe and maybe a copy). */
const REGISTER_CONCURRENCY = 4;
/** Clips analysed for their subject per pass at most (the rest zoom to the centre, reported). */
const MAX_SUBJECT_CLIPS = 2000;

/** An input refusal as an HTTP error (the route answers it; a job turns it into a job error). */
export function inputError(e: unknown): never {
	if (e instanceof AutomationInputError)
		throw new HttpError(
			e.code === 'E_NOT_FOUND' ? 404 : e.code === 'E_TRACK_LOCKED' ? 409 : 400,
			e.code === 'E_NOT_FOUND'
				? 'NOT_FOUND'
				: e.code === 'E_TRACK_LOCKED'
					? 'TRACK_LOCKED'
					: 'VALIDATION_FAILED',
			e.message,
			{ code: e.code },
		);
	throw e;
}

/** Plans the pass (validating its parameters); `AutomationInputError` → HttpError. */
export function planOrThrow(
	doc: ProjectDocument,
	pass: AutomationPassId,
	sequenceId: string | undefined,
	params: Record<string, unknown>,
	subjects?: Readonly<Record<string, ClipSubject>>,
): AutomationPlan {
	try {
		return planPass(doc, pass, sequenceId, params, subjects ? { subjects } : {});
	} catch (e) {
		return inputError(e);
	}
}

export function validParams(pass: AutomationPassId, raw: unknown): Record<string, unknown> {
	try {
		return parsePassParams(pass, raw);
	} catch (e) {
		return inputError(e);
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Subjects (punch-ins toward the subject)

function engineKeyOf(doc: ProjectDocument, mediaId: string): string | null {
	const m = doc.media?.[mediaId];
	const l = m?.locators?.find((x) => x.type === 'engine-store') as { key?: string } | undefined;
	return typeof l?.key === 'string' ? l.key : null;
}

/**
 * The subject of each punch-in that fell back to the centre (no faces roto on its clip): the Auto Reframe analysis
 * of 3 frames from where the zoom starts. Failures leave the clip on the centre (counted in the warning).
 */
async function measureSubjects(
	doc: ProjectDocument,
	plan: PunchPlan,
	reframe: ReframeService | undefined,
	ctx: Pick<JobContext, 'signal' | 'trackChild' | 'progress'> | null,
	projectId: string,
): Promise<{ subjects: Record<string, ClipSubject>; failed: number }> {
	const subjects: Record<string, ClipSubject> = {};
	let failed = 0;
	if (!reframe || !ctx) return { subjects, failed: plan.punches.length };
	const seq = automationSequence(doc, plan.sequenceId);
	const todo = plan.punches.filter((p) => p.target.source === 'center-fallback').slice(0, MAX_SUBJECT_CLIPS);
	let done = 0;
	for (const p of todo) {
		if (ctx.signal.aborted) break;
		const clip = seq.clips[p.clipId] as {
			kind: string;
			mediaId?: string;
			sourceIn: number;
			start: number;
			speed?: { rate: number };
		};
		const key = clip?.kind === 'video' && clip.mediaId ? engineKeyOf(doc, clip.mediaId) : null;
		const media = clip?.mediaId ? doc.media?.[clip.mediaId] : undefined;
		const vs = media?.probe?.streams?.find((s) => s.type === 'video') as
			| { frameRate?: { num: number; den: number } }
			| undefined;
		if (!key || !vs?.frameRate || !(vs.frameRate.num > 0)) {
			failed++;
			continue;
		}
		const F = (FLICKS_PER_SECOND * seq.settings.frameRate.den) / seq.settings.frameRate.num;
		const t = clip.sourceIn + (p.frame - clip.start) * F * (clip.speed?.rate ?? 1);
		const startFrame = Math.max(
			0,
			Math.floor((t * vs.frameRate.num) / (vs.frameRate.den * FLICKS_PER_SECOND)),
		);
		try {
			const r = await reframe.analyze(
				{ projectId, mediaKey: key, startFrame, frameCount: 3 },
				{ signal: ctx.signal, trackChild: ctx.trackChild },
			);
			const x = r.points[0];
			const y = r.points[1];
			if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y))
				subjects[p.clipId] = { x, y, source: r.source === 'saliency' ? 'saliency' : 'faces' };
			else failed++;
		} catch {
			if (ctx.signal.aborted) break;
			failed++;
		}
		done++;
		ctx.progress(0.05 + (0.3 * done) / Math.max(1, todo.length), {
			stage: `Finding the subject (${done} of ${todo.length})`,
		});
	}
	return { subjects, failed };
}

// ---------------------------------------------------------------------------------------------------------------
// Sounds

type SfxPick = {
	needs: SfxNeeds;
	available: number;
	assign: Map<string, { soundId: string; gainOffsetDb: number }>;
	entries: Map<string, SoundEntry>;
};

async function pickSounds(
	sounds: SoundService | undefined,
	needs: SfxNeeds | null,
	sequenceId: string,
): Promise<SfxPick | null> {
	if (!needs || !sounds) return null;
	const pool = await sounds.rankingPool(needs.sfx.sources as never);
	const usable = sfxPool(pool.entries as (SoundEntry & { source: { type: string } })[], needs.sfx);
	const ranked = rankSfx(usable, needs.sfx, { windowSec: needs.windowSec, visualKind: needs.visualKind });
	const assign = assignSfx(needs.items, ranked, { sequenceId, variety: needs.sfx.variety });
	return {
		needs,
		available: ranked.ids.length,
		assign,
		entries: new Map(usable.map((e) => [e.id, e])),
	};
}

async function registerSounds(
	sounds: SoundService,
	projectId: string,
	pick: SfxPick,
	ctx: Pick<JobContext, 'signal' | 'progress' | 'log'>,
): Promise<{ media: SoundProposalMedia[]; failed: string[] }> {
	const order = [...new Set([...pick.assign.values()].map((a) => a.soundId))];
	const media: SoundProposalMedia[] = [];
	const failed: string[] = [];
	let next = 0;
	let done = 0;
	let fatal: unknown = null;
	const results: (RegisterSoundResponse | null)[] = order.map(() => null);
	const worker = async () => {
		while (next < order.length && !fatal && !ctx.signal.aborted) {
			const i = next++;
			try {
				results[i] = await sounds.register(order[i]!, projectId);
			} catch (e) {
				if (e instanceof HttpError && (e.code === 'PROJECT_NOT_FOUND' || e.status === 503)) {
					fatal ??= e;
					return;
				}
				failed.push(order[i]!);
				ctx.log(`register ${order[i]}: ${e instanceof Error ? e.message : String(e)}`);
			}
			done++;
			ctx.progress(0.4 + (0.4 * done) / Math.max(1, order.length), {
				stage: `Registering sounds (${done} of ${order.length})`,
			});
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(REGISTER_CONCURRENCY, Math.max(1, order.length)) }, worker),
	);
	if (fatal) throw fatal;
	order.forEach((soundId, i) => {
		const reg = results[i];
		if (!reg) return;
		const title = pick.entries.get(soundId)?.title || reg.library.title || reg.originalName;
		media.push({
			soundId,
			title,
			fingerprint: reg.fingerprint,
			kind: reg.kind,
			existingMediaId: reg.existingMediaId,
			library: reg.library,
			register: mediaRegisterCommand(reg, '$x', '$xi', title) as SoundProposalMedia['register'],
		});
	});
	return { media, failed };
}

// ---------------------------------------------------------------------------------------------------------------
// Dry run and job

function budgetOf(items: Parameters<typeof proposalBudget>[0]) {
	const b = proposalBudget(items);
	return b.fits
		? { fits: true, items: b.items, commands: b.commands }
		: { fits: false, items: b.items, commands: b.commands, suggestedRange: b.suggestedRange };
}

/** What a pass would do on the live document (nothing stored; sounds are counted, not registered). */
export async function dryRunPass(
	deps: AutomationDeps,
	input: Omit<AutomationJobInput, 'who'>,
): Promise<AutomationPassResult> {
	const agent = deps.agent();
	if (!agent) throw new HttpError(503, 'NOT_AVAILABLE', 'The agent service is not running');
	const { doc, revision } = await liveDocument(agent, input.projectId);
	const plan = planOrThrow(doc, input.pass, input.sequenceId, input.params);
	const needs = sfxNeeds(doc, plan, input.params as { sfx?: never });
	const pick = await pickSounds(deps.sounds(), needs, plan.sequenceId);
	// Sound commands counted as if placed (the budget of the real proposal); the picture items are exact.
	const items = passItems(doc, plan);
	const summary = passSummary(plan, items);
	const extra = pick ? pick.assign.size * 4 : 0;
	const budget = budgetOf(items.items);
	const fits = budget.fits && budget.commands + extra <= 5000;
	const warnings = [...summary.warnings];
	if (needs && !pick?.available)
		warnings.push({
			code: 'W_NO_SOUNDS',
			message: `No ${needs.sfx.type} sound in the allowed sources: the decorations would have no sound (install the starter kit or a pack, or add a folder)`,
		});
	return {
		mode: 'dryRun',
		pass: input.pass,
		projectId: input.projectId,
		sequenceId: plan.sequenceId,
		summary,
		sfx: needs
			? {
					enabled: true,
					type: needs.sfx.type,
					available: pick?.available ?? 0,
					placed: pick?.assign.size ?? 0,
					sounds: new Set([...(pick?.assign.values() ?? [])].map((a) => a.soundId)).size,
					unsounded: needs.items.length - (pick?.assign.size ?? 0),
				}
			: null,
		budget: { ...budget, fits, commands: budget.commands + extra },
		proposalId: null,
		revision,
		itemCount: items.items.length,
		invalid: [],
		warnings,
	};
}

function parseJobInput(raw: unknown): AutomationJobInput {
	const r = raw as Partial<AutomationJobInput> | null;
	if (
		!r ||
		typeof r.projectId !== 'string' ||
		typeof r.pass !== 'string' ||
		!r.params ||
		typeof r.params !== 'object'
	)
		throw new JobError('VALIDATION_FAILED', 'The automation request is invalid', false);
	return {
		projectId: r.projectId,
		pass: r.pass as AutomationPassId,
		...(typeof r.sequenceId === 'string' ? { sequenceId: r.sequenceId } : {}),
		params: r.params as Record<string, unknown>,
		who: {
			editor: r.who?.editor === true,
			agent: typeof r.who?.agent === 'string' ? r.who.agent.slice(0, 64) : 'An agent',
		},
	};
}

const asJobError = (e: unknown): unknown => {
	if (e instanceof HttpError)
		return new JobError(e.code, e.message, e.status === 503 || e.code === 'PROPOSAL_LIMIT', e.detail);
	if (e instanceof AutomationInputError) return new JobError(e.code, e.message, false);
	return e;
};

/** The `edit-automation` job runner. */
export async function runAutomationJob(ctx: JobContext, deps: AutomationDeps): Promise<AutomationPassResult> {
	try {
		return await runJob(ctx, deps);
	} catch (e) {
		throw asJobError(e);
	}
}

async function runJob(ctx: JobContext, deps: AutomationDeps): Promise<AutomationPassResult> {
	const input = parseJobInput(ctx.input);
	const agent = deps.agent();
	const proposals = deps.proposals();
	if (!agent || !proposals)
		throw new JobError('NOT_AVAILABLE', 'The agent or proposal service is not running', true);
	ctx.progress(0.02, { stage: 'Reading the edit' });
	const { doc } = await liveDocument(agent, input.projectId);
	const params = validParams(input.pass, input.params);
	let plan = planOrThrow(doc, input.pass, input.sequenceId, params);
	const warnings: { code: string; message: string }[] = [];
	if (
		plan.pass === 'punch-ins' &&
		params.target === 'subject' &&
		plan.punches.some((p) => p.target.source === 'center-fallback')
	) {
		ctx.progress(0.05, { stage: 'Finding the subject' });
		const m = await measureSubjects(doc, plan, deps.reframe(), ctx, input.projectId);
		if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
		plan = planOrThrow(doc, input.pass, input.sequenceId, params, m.subjects);
	}
	ctx.progress(0.35, { stage: 'Choosing sounds' });
	const needs = sfxNeeds(doc, plan, params as { sfx?: never });
	const sounds = deps.sounds();
	if (needs && !sounds)
		warnings.push({
			code: 'W_NO_LIBRARY',
			message: 'The sound library is not running: the decorations have no sound',
		});
	const pick = await pickSounds(sounds, needs, plan.sequenceId);
	let sfx: PassSfx | undefined;
	let registered = 0;
	if (pick && sounds && pick.assign.size) {
		const r = await registerSounds(sounds, input.projectId, pick, ctx);
		if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
		if (r.failed.length)
			warnings.push({
				code: 'W_SOUND_REGISTER_FAILED',
				message: `${r.failed.length} sound(s) could not be added to the project: their decorations have no sound`,
			});
		const ok = new Set(r.media.map((m) => m.soundId));
		const assign = new Map([...pick.assign].filter(([, a]) => ok.has(a.soundId)));
		registered = assign.size;
		sfx = {
			media: r.media,
			assign,
			type: pick.needs.sfx.type,
			...(pick.needs.sfx.gainDb !== undefined ? { gainDb: pick.needs.sfx.gainDb } : {}),
		};
	} else if (needs && sounds)
		warnings.push({
			code: 'W_NO_SOUNDS',
			message: `No ${needs.sfx.type} sound in the allowed sources: the decorations have no sound (install the starter kit or a pack, or add a folder)`,
		});
	ctx.progress(0.82, { stage: 'Building the proposal' });
	const items = passItems(doc, plan, sfx);
	const summary = passSummary(plan, items);
	const budget = proposalBudget(items.items);
	if (!budget.fits)
		throw new JobError('PROPOSAL_TOO_LARGE', budget.message, false, {
			code: 'E_TOO_LARGE',
			fit: budget.fit,
			suggestedRange: budget.suggestedRange,
		});
	const sfxReport = needs
		? {
				enabled: true,
				type: needs.sfx.type,
				available: pick?.available ?? 0,
				placed: registered,
				sounds: sfx ? sfx.media.length : 0,
				unsounded: needs.items.length - registered,
			}
		: null;
	const draft = passDraft(plan, items, params, { warnings, ...(sfxReport ? { sfx: sfxReport } : {}) });
	const base = {
		mode: 'propose' as const,
		pass: input.pass,
		projectId: input.projectId,
		sequenceId: plan.sequenceId,
		summary,
		sfx: sfxReport,
		budget: { fits: true, items: budget.items, commands: budget.commands },
		warnings: [...summary.warnings, ...warnings],
	};
	if (!draft) {
		ctx.progress(1, { stage: 'Nothing to propose' });
		return { ...base, proposalId: null, revision: null, itemCount: 0, invalid: [] };
	}
	ctx.progress(0.9, { stage: `Checking ${draft.items.length} proposal items` });
	const created = await proposals.create(
		input.projectId,
		draft as unknown as Record<string, unknown>,
		input.who,
	);
	if (ctx.signal.aborted) {
		await proposals.delete(input.projectId, created.proposal.id).catch(() => undefined);
		throw new JobError('JOB_CANCELLED', 'Cancelled');
	}
	ctx.progress(1, { stage: 'Proposal ready for review' });
	const p = created.proposal;
	return {
		...base,
		proposalId: p.id,
		revision: created.revision,
		itemCount: p.items.length,
		invalid: p.items
			.filter((it) => it.state === 'invalid')
			.map((it) => ({ itemId: it.id, reason: it.reason ?? 'does not apply' })),
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Refresh / Reroll

/** The refresher of feature `edit-automation` (registered on the proposals service). */
export function automationRefresher(deps: AutomationDeps) {
	return async (input: {
		projectId: string;
		proposal: Proposal;
		itemIds: string[];
		doc: ProjectDocument;
		revision: number;
		reroll?: boolean;
	}) => {
		const rep = automationReportOf(input.proposal);
		if (!rep)
			throw new HttpError(422, 'VALIDATION_FAILED', 'The proposal has no automation report to re-plan from');
		let subjects: Record<string, ClipSubject> | undefined;
		if (rep.pass === 'punch-ins' && rep.params.target === 'subject') {
			// re-measured for the clips being refreshed (their zoom may start elsewhere now)
			const plan = planOrThrow(
				input.doc,
				'punch-ins',
				input.proposal.sequenceId ?? undefined,
				rep.params,
			) as PunchPlan;
			const wanted = new Set(
				input.proposal.items
					.filter((it) => input.itemIds.includes(it.id))
					.map((it) => (it.meta as { clipId?: string } | undefined)?.clipId),
			);
			const part = { ...plan, punches: plan.punches.filter((p) => wanted.has(p.clipId)) };
			const ac = new AbortController();
			subjects = (
				await measureSubjects(
					input.doc,
					part,
					deps.reframe(),
					{ signal: ac.signal, trackChild: () => undefined, progress: () => undefined },
					input.projectId,
				)
			).subjects;
		}
		const r = refreshAutomationItems(input.doc, input.proposal, input.itemIds, {
			...(input.reroll ? { reroll: true } : {}),
			...(subjects ? { subjects } : {}),
		});
		if (!r.ok)
			throw new HttpError(r.code === 'E_NOT_FOUND' ? 404 : 422, 'VALIDATION_FAILED', r.message, {
				code: r.code,
			});
		return { items: r.items, dropped: r.dropped };
	};
}
