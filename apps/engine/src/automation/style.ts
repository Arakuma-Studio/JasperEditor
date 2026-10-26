// Apply Style and Style Check in the engine (spec 15 EA-012, EA-013; docs/wp-notes/edit-automation.md "Apply Style"):
// the I/O around `@jasper/project`'s `planStyle` / `styleCheck` / `refreshStyleItems`:
//   - the recipe: a whole recipe of the request, else an id (the project's copy, a built-in, the user library), else
//     the project's active recipe;
//   - the cleanup stage: a `cleanup-analysis` child job with the recipe's preset (Propose analyses missing voice;
//     the dry run plans media without a cached analysis at word timings and says so);
//   - the subtitle template from the user library when the project and the built-ins do not have it;
//   - per pass on its stage document: folder files, voice activity, loudness (`passInputs`), subjects of punch-ins
//     (`measureSubjects`) and the library sounds (ranked, rotated; registered for the proposal, counted in a dry run);
//   - the budget (E_TOO_LARGE with a range that fits), then ONE proposal of feature `edit-automation`.
// Style Check measures dead air with a cleanup analysis that cuts nothing (cached voice only).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
	ApplyStyleRequest,
	ApplyStyleResult,
	CleanupAnalysisJobResult,
	CleanupAnalyzeRequest,
	EngineJob,
	StyleCheckRequest,
	StyleCheckResponse,
} from '@jasper/api';
import { mgRegistry } from '@jasper/mg-templates';
import {
	AutomationInputError,
	activeStyleRecipe,
	automationSequence,
	cleanupFindingFrames,
	defaultRegistries,
	FINDING_KINDS,
	findStyleRecipe,
	makeEnvelope,
	type PassContext,
	type PassSfx,
	type ProjectDocument,
	type Proposal,
	type PunchPlan,
	parseStyleRecipe,
	planStyle,
	proposalBudget,
	type Registries,
	refreshStyleItems,
	type StyleCheckDeadAir,
	type StyleHooks,
	type StyleRecipe,
	styleCheck,
	styleDraft,
} from '@jasper/project';
import type { CleanupAnalysisService } from '../cleanup/service.ts';
import { type JobContext, JobError } from '../jobs/types.ts';
import type { ProposalService, Requester } from '../proposals/service.ts';
import { liveDocument } from '../sound-design/plan.ts';
import type { StyleRecipeLibrary } from '../style-recipes/library.ts';
import type { SubtitleTemplateLibrary } from '../subtitle-templates/library.ts';
import { HttpError } from '../tools/reply.ts';
import type { CoreServices } from '../tools/services.ts';
import {
	type AutomationDeps,
	budgetOf,
	type InputMode,
	measureSubjects,
	passInputs,
	pickSounds,
	registerSounds,
} from './run.ts';

export type StyleDeps = AutomationDeps & {
	recipes: () => StyleRecipeLibrary | undefined;
	cleanup: () => CleanupAnalysisService | undefined;
	templates: () => SubtitleTemplateLibrary | undefined;
	queue: () => CoreServices['queue'];
	registries?: Registries;
};

export type StyleJobInput = Omit<ApplyStyleRequest, 'mode' | 'recipeId'> & {
	projectId: string;
	recipe: StyleRecipe;
	who: Requester;
};

const registriesOf = (deps: StyleDeps) => deps.registries ?? defaultRegistries(mgRegistry);

/** The recipe of a request (see the file comment); HttpError when there is none or it is unreadable. */
export async function resolveRecipe(
	deps: StyleDeps,
	doc: ProjectDocument,
	req: { recipeId?: string; recipe?: Record<string, unknown> },
): Promise<StyleRecipe> {
	if (req.recipe) {
		const r = parseStyleRecipe(req.recipe);
		if (!r.ok)
			throw new HttpError(
				r.code === 'E_NEWER_VERSION' ? 409 : 400,
				'VALIDATION_FAILED',
				`recipe: ${r.message}`,
				{
					code: r.code === 'E_TOO_LARGE' ? 'E_LIMIT' : r.code,
				},
			);
		return r.recipe;
	}
	if (req.recipeId) {
		const local = findStyleRecipe(doc, req.recipeId);
		if (local) return local;
		const lib = deps.recipes();
		if (!lib) throw new HttpError(503, 'NOT_AVAILABLE', 'The style recipe library is not running');
		return lib.get(req.recipeId);
	}
	const active = activeStyleRecipe(doc);
	if (active) return active;
	throw new HttpError(
		400,
		'VALIDATION_FAILED',
		'Choose a style recipe (recipeId: builtin:fast-shorts, builtin:fast-long-form, builtin:clean or one of list_style_recipes): the project has no active recipe',
		{ code: 'E_INVALID_PARAM' },
	);
}

type Warning = { code: string; message: string };

/** The analysis job reads exactly the document planned on (an envelope: `loadProject` migrates and validates it). */
const envelopeOf = (doc: ProjectDocument, revision: number) =>
	makeEnvelope(doc, { revision, savedAt: new Date().toISOString(), platform: 'engine' });

/** Runs a `cleanup-analysis` child job and waits for it (cancelled with `signal`). */
async function runCleanupAnalysis(
	deps: StyleDeps,
	req: CleanupAnalyzeRequest,
	origin: EngineJob['origin'] | undefined,
	signal?: AbortSignal,
): Promise<
	| {
			result: CleanupAnalysisJobResult;
			analysis: NonNullable<ReturnType<CleanupAnalysisService['get']>>['analysis'];
	  }
	| { error: Warning }
> {
	const svc = deps.cleanup();
	if (!svc)
		return {
			error: { code: 'W_CLEANUP_UNAVAILABLE', message: 'The voice cleanup is not available in this engine' },
		};
	const queue = deps.queue();
	const job = svc.submit(req, origin);
	const onAbort = () => queue.cancel(job.id);
	signal?.addEventListener('abort', onAbort, { once: true });
	try {
		const fin = await queue.wait(job.id);
		if (signal?.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
		if (fin.state !== 'succeeded') {
			const code = fin.error?.code ?? 'FAILED';
			const msg = fin.error?.message ?? fin.state;
			const noSpeech = /speech|transcri/i.test(msg) || code === 'E_INVALID_PARAM';
			return {
				error: {
					code: noSpeech ? 'W_NO_TRANSCRIPT' : 'W_CLEANUP_FAILED',
					message: noSpeech
						? `The voice cleanup needs transcribed dialogue: transcribe the sequence first (Transcript ▸ Transcribe…), or turn the cleanup off for this run (${msg})`.slice(
								0,
								600,
							)
						: `The voice cleanup analysis failed: ${msg}`.slice(0, 600),
				},
			};
		}
		const result = fin.result as CleanupAnalysisJobResult;
		const file = svc.get(result.analysisId);
		if (!file)
			return {
				error: {
					code: 'W_CLEANUP_FAILED',
					message: 'The voice cleanup analysis was evicted before it was read',
				},
			};
		return { result, analysis: file.analysis };
	} finally {
		signal?.removeEventListener('abort', onAbort);
	}
}

type Mode = { mode: 'dry' } | { mode: 'job'; ctx: JobContext };

/** The hooks of `planStyle` for a dry run (nothing registered, voice from caches) or the job. */
function styleHooks(
	deps: StyleDeps,
	input: { projectId: string; sequenceId?: string; range?: { start: number; end: number } },
	revision: number,
	m: Mode,
	origin: EngineJob['origin'] | undefined,
	sfxReports: Map<string, PassSfx | undefined>,
): StyleHooks {
	const inputMode: InputMode = m.mode === 'job' ? { mode: 'job', ctx: m.ctx } : { mode: 'dry' };
	const signal = m.mode === 'job' ? m.ctx.signal : undefined;
	return {
		...(signal ? { signal } : {}),
		progress: (f, stage) => {
			if (m.mode === 'job') m.ctx.progress(f, { stage });
		},
		cleanup: async ({ doc, sequenceId, preset, overrides, range }) => {
			const r = await runCleanupAnalysis(
				deps,
				{
					projectId: input.projectId,
					sequenceId,
					document: envelopeOf(doc, revision),
					presetId: preset,
					...(overrides ? { overrides: overrides as CleanupAnalyzeRequest['overrides'] } : {}),
					...(range ? { range: { from: range.start, to: range.end } } : {}),
					analyzeVoice: m.mode === 'job',
				},
				origin,
				signal,
			);
			if ('error' in r) return { skip: r.error };
			const warnings: Warning[] = [];
			if (r.result.voice.missing.length)
				warnings.push({
					code: m.mode === 'dry' ? 'W_VOICE_NOT_ANALYSED' : 'W_VOICE_PARTIAL',
					message:
						m.mode === 'dry'
							? `${r.result.voice.missing.length} media have no voice analysis yet: the dry run cuts them at word timings (Propose analyses them)`
							: `${r.result.voice.missing.length} media could not be analysed: they are cut at word timings (${r.result.voice.missing[0]!.reason})`.slice(
									0,
									500,
								),
				});
			return {
				ranges: r.analysis.plan.ranges.map((x) => ({ start: x.start, end: x.end })),
				clipIds: r.analysis.plan.clipIds,
				fadeMs: r.analysis.plan.fadeMs,
				jlFrames: r.analysis.plan.jlFrames,
				stats: r.analysis.plan.stats as unknown as Record<string, unknown>,
				findings: r.analysis.findings.length,
				warnings,
			};
		},
		subtitleTemplate: async (id) => {
			const lib = deps.templates();
			if (!lib) return null;
			const t = (await lib.list()).templates.find((x) => x.id === id);
			return t ? (t as unknown as Record<string, unknown>) : null;
		},
		passInputs: async (pass, doc, sequenceId, params) => {
			const r = await passInputs(
				deps,
				{ projectId: input.projectId, pass, sequenceId, params },
				doc,
				revision,
				inputMode,
			);
			return r;
		},
		refine: async (pass, doc, plan, params) => {
			if (pass !== 'punch-ins' || params.target !== 'subject' || m.mode !== 'job') return null;
			const p = plan as PunchPlan;
			if (!p.punches.some((x) => x.target.source === 'center-fallback')) return null;
			const r = await measureSubjects(doc, p, deps.reframe(), m.ctx, input.projectId);
			return { subjects: r.subjects } as PassContext;
		},
		sounds: async (pass, _doc, plan, needs) => {
			const sounds = deps.sounds();
			const warnings: Warning[] = [];
			if (!sounds)
				return {
					report: {
						enabled: true,
						type: needs.sfx.type,
						available: 0,
						placed: 0,
						sounds: 0,
						unsounded: needs.items.length,
					},
					warnings: [
						{
							code: 'W_NO_LIBRARY',
							message: 'The sound library is not running: the decorations have no sound',
						},
					],
				};
			const pick = await pickSounds(sounds, needs, plan.sequenceId);
			if (!pick?.assign.size)
				return {
					report: {
						enabled: true,
						type: needs.sfx.type,
						available: pick?.available ?? 0,
						placed: 0,
						sounds: 0,
						unsounded: needs.items.length,
					},
					warnings,
				};
			if (m.mode === 'dry')
				return {
					report: {
						enabled: true,
						type: needs.sfx.type,
						available: pick.available,
						placed: pick.assign.size,
						sounds: new Set([...pick.assign.values()].map((a) => a.soundId)).size,
						unsounded: needs.items.length - pick.assign.size,
					},
					warnings,
				};
			const r = await registerSounds(sounds, input.projectId, pick, m.ctx);
			if (r.failed.length)
				warnings.push({
					code: 'W_SOUND_REGISTER_FAILED',
					message: `${r.failed.length} sound(s) could not be added to the project: their decorations have no sound`,
				});
			const ok = new Set(r.media.map((x) => x.soundId));
			const assign = new Map([...pick.assign].filter(([, a]) => ok.has(a.soundId)));
			const sfx: PassSfx = {
				media: r.media,
				assign,
				type: pick.needs.sfx.type,
				...(pick.needs.sfx.gainDb !== undefined ? { gainDb: pick.needs.sfx.gainDb } : {}),
			};
			sfxReports.set(pass, sfx);
			return {
				sfx,
				report: {
					enabled: true,
					type: needs.sfx.type,
					available: pick.available,
					placed: assign.size,
					sounds: r.media.length,
					unsounded: needs.items.length - assign.size,
				},
				warnings,
			};
		},
	};
}

const asInput = (e: unknown): never => {
	if (e instanceof AutomationInputError)
		throw new HttpError(
			e.code === 'E_NOT_FOUND' ? 404 : 400,
			e.code === 'E_NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION_FAILED',
			e.message,
			{
				code: e.code,
			},
		);
	throw e;
};

function resultOf(
	input: { projectId: string },
	plan: Awaited<ReturnType<typeof planStyle>>,
	mode: 'dryRun' | 'propose',
	extra: { soundCommands?: number } = {},
): Omit<ApplyStyleResult, 'proposalId' | 'revision' | 'itemCount' | 'invalid'> {
	const b = budgetOf(plan.items);
	const commands = b.commands + (extra.soundCommands ?? 0);
	const fits = b.fits && commands <= 5000;
	return {
		mode,
		projectId: input.projectId,
		sequenceId: plan.sequenceId,
		recipe: plan.report.recipe,
		stages: plan.stages as ApplyStyleResult['stages'],
		cost: plan.cost,
		budget: { ...b, fits, commands },
		warnings: [
			...plan.warnings,
			...plan.stages.flatMap((s) => s.warnings.filter((w) => !plan.warnings.includes(w))),
		].slice(0, 200),
	};
}

/** What Apply Style would do on the live document (nothing stored; sounds counted, not registered). */
export async function dryRunStyle(
	deps: StyleDeps,
	input: Omit<StyleJobInput, 'who'>,
): Promise<ApplyStyleResult> {
	const agent = deps.agent();
	if (!agent) throw new HttpError(503, 'NOT_AVAILABLE', 'The agent service is not running');
	const { doc, revision } = await liveDocument(agent, input.projectId);
	const reports = new Map<string, PassSfx | undefined>();
	const hooks = styleHooks(deps, input, revision ?? 0, { mode: 'dry' }, undefined, reports);
	let soundCommands = 0;
	const sounds = hooks.sounds!;
	hooks.sounds = async (pass, d, plan, needs) => {
		const r = await sounds(pass, d, plan, needs);
		soundCommands += r.report.placed * 4;
		return r;
	};
	const plan = await planStyle(
		doc,
		{
			recipe: input.recipe,
			...(input.sequenceId ? { sequenceId: input.sequenceId } : {}),
			...(input.range ? { range: input.range } : {}),
			...(input.seed !== undefined ? { seed: input.seed } : {}),
			...(input.passes ? { passes: input.passes } : {}),
		},
		hooks,
		{ registries: registriesOf(deps) },
	).catch(asInput);
	return {
		...resultOf(input, plan, 'dryRun', { soundCommands }),
		proposalId: null,
		revision,
		itemCount: plan.items.length,
		invalid: [],
	};
}

/** The `apply-style` job runner. */
export async function runStyleJob(ctx: JobContext, deps: StyleDeps): Promise<ApplyStyleResult> {
	try {
		return await runJob(ctx, deps);
	} catch (e) {
		if (e instanceof HttpError) throw new JobError(e.code, e.message, e.status === 503, e.detail);
		if (e instanceof AutomationInputError) throw new JobError(e.code, e.message, false);
		throw e;
	}
}

async function runJob(ctx: JobContext, deps: StyleDeps): Promise<ApplyStyleResult> {
	const input = ctx.input as StyleJobInput;
	if (!input || typeof input.projectId !== 'string' || !input.recipe)
		throw new JobError('VALIDATION_FAILED', 'The Apply Style request is invalid', false);
	const parsed = parseStyleRecipe(input.recipe);
	if (!parsed.ok) throw new JobError('VALIDATION_FAILED', parsed.message, false);
	const agent = deps.agent();
	const proposals = deps.proposals();
	if (!agent || !proposals)
		throw new JobError('NOT_AVAILABLE', 'The agent or proposal service is not running', true);
	ctx.progress(0.02, { stage: 'Reading the edit' });
	const { doc, revision } = await liveDocument(agent, input.projectId);
	const hooks = styleHooks(deps, input, revision ?? 0, { mode: 'job', ctx }, ctx.job.origin, new Map());
	const plan = await planStyle(
		doc,
		{
			recipe: parsed.recipe,
			...(input.sequenceId ? { sequenceId: input.sequenceId } : {}),
			...(input.range ? { range: input.range } : {}),
			...(input.seed !== undefined ? { seed: input.seed } : {}),
			...(input.passes ? { passes: input.passes } : {}),
		},
		hooks,
		{ registries: registriesOf(deps) },
	);
	if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
	const budget = proposalBudget(plan.items);
	if (!budget.fits)
		throw new JobError('PROPOSAL_TOO_LARGE', budget.message, false, {
			code: 'E_TOO_LARGE',
			fit: budget.fit,
			suggestedRange: budget.suggestedRange,
		});
	const base = resultOf(input, plan, 'propose');
	const draft = styleDraft(plan);
	if (!draft) {
		ctx.progress(1, { stage: 'Nothing to propose' });
		return { ...base, proposalId: null, revision: null, itemCount: 0, invalid: [] };
	}
	ctx.progress(0.94, { stage: `Checking ${draft.items.length} proposal items` });
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

/** Refresh / Reroll of an Apply Style proposal (the `edit-automation` refresher dispatches here). */
export async function refreshStyle(
	deps: StyleDeps | AutomationDeps,
	input: {
		projectId: string;
		proposal: Proposal;
		itemIds: string[];
		doc: ProjectDocument;
		revision: number;
		reroll?: boolean;
	},
) {
	let scratch: string | null = null;
	const ac = new AbortController();
	try {
		const ctx = {
			signal: ac.signal,
			trackChild: () => undefined,
			progress: () => undefined,
			scratchDir: async () => {
				scratch ??= await mkdtemp(join(tmpdir(), 'jasper-style-'));
				return scratch;
			},
		} as unknown as JobContext;
		const r = await refreshStyleItems(
			input.doc,
			input.proposal,
			input.itemIds,
			{
				registries: (deps as StyleDeps).registries ?? defaultRegistries(mgRegistry),
				...(input.reroll ? { reroll: true } : {}),
			},
			{
				passInputs: (pass, d, sequenceId, params) =>
					passInputs(deps, { projectId: input.projectId, pass, sequenceId, params }, d, input.revision, {
						mode: 'job',
						ctx,
					}),
			},
		);
		if (!r.ok)
			throw new HttpError(r.code === 'E_NOT_FOUND' ? 404 : 422, 'VALIDATION_FAILED', r.message, {
				code: r.code,
			});
		return { items: r.items, dropped: r.dropped };
	} finally {
		if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Style Check

/** Dead air of the live sequence: a cleanup analysis that cuts nothing, with the voice analyses already made. */
async function deadAirOf(
	deps: StyleDeps,
	projectId: string,
	doc: ProjectDocument,
	sequenceId: string,
	preset: string,
): Promise<{ deadAir: StyleCheckDeadAir; warnings: Warning[] }> {
	const r = await runCleanupAnalysis(
		deps,
		{
			projectId,
			sequenceId,
			document: envelopeOf(doc, 0),
			presetId: preset,
			analyzeVoice: false,
			decisions: { rejectKinds: [...FINDING_KINDS] },
		},
		undefined,
	);
	if ('error' in r)
		return { deadAir: { perMinute: null, pauses: [], note: r.error.message }, warnings: [r.error] };
	const seq = automationSequence(doc, sequenceId);
	const pauses = r.analysis.findings
		.filter((f) => f.kind === 'pause')
		.map((f) => cleanupFindingFrames(seq, r.analysis, f))
		.filter((x): x is NonNullable<typeof x> => !!x)
		.map((x) => ({ start: x.start, end: x.end }));
	const per = r.analysis.plan.stats.deadAirPerMinute;
	return {
		deadAir: {
			perMinute: per,
			pauses,
			...(per === null
				? {
						note: 'Not measured: the dialogue has no voice analysis yet (Sequence ▸ Clean Up Voice… ▸ Analyze makes it)',
					}
				: {}),
		},
		warnings: [],
	};
}

export async function runStyleCheck(
	deps: StyleDeps,
	projectId: string,
	req: StyleCheckRequest,
): Promise<StyleCheckResponse> {
	const agent = deps.agent();
	if (!agent) throw new HttpError(503, 'NOT_AVAILABLE', 'The agent service is not running');
	const { doc } = await liveDocument(agent, projectId);
	const recipe = await resolveRecipe(deps, doc, req);
	let seqId: string;
	try {
		seqId = automationSequence(doc, req.sequenceId).id;
	} catch (e) {
		return asInput(e);
	}
	let dead: StyleCheckDeadAir = null;
	const warnings: Warning[] = [];
	if (req.deadAir !== false && recipe.targets?.deadAirPerMinute) {
		const preset = recipe.passes.cleanup?.preset ?? 'builtin.fast';
		const d = await deadAirOf(deps, projectId, doc, seqId, preset);
		dead = d.deadAir;
		warnings.push(...d.warnings);
	}
	const r = styleCheck(doc, seqId, recipe, { deadAir: dead });
	return { projectId, ...r, warnings };
}
