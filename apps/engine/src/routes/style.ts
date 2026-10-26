// Style recipes, Apply Style and Style Check routes (spec 15 EA-010…EA-013, EA-041; route table in @jasper/api
// `style.ts`). The library lives in `<appdir>/style-recipes/` (style-recipes/library.ts); Apply Style's job kind
// `apply-style` plans the recipe into one proposal (automation/style.ts). This plugin runs after the proposal,
// cleanup, subtitle-template and automation routes (it uses their services).
import {
	ApplyStyleRequestSchema,
	StyleCheckRequestSchema,
	StyleRecipeCreateRequestSchema,
	StyleRecipeDuplicateRequestSchema,
	StyleRecipeUpdateRequestSchema,
} from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import type { AgentService } from '../agent/service.ts';
import { agentNameOf, requireUserApproval } from '../agent/user-approval.ts';
import type { AudioService } from '../audio/service.ts';
import type { AutomationDeps } from '../automation/run.ts';
import { dryRunStyle, resolveRecipe, runStyleCheck, runStyleJob, type StyleDeps } from '../automation/style.ts';
import type { CleanupAnalysisService } from '../cleanup/service.ts';
import { isLoopbackHost } from '../context.ts';
import type { ReframeService } from '../gaps/reframe.ts';
import { replyWithJob } from '../jobs/reply.ts';
import { isProjectId } from '../projects/store.ts';
import type { ProposalService } from '../proposals/service.ts';
import { liveDocument } from '../sound-design/plan.ts';
import type { VoiceActivityService } from '../sound-design/voice.ts';
import type { SoundService } from '../sounds/service.ts';
import { StyleRecipeLibrary } from '../style-recipes/library.ts';
import type { SubtitleTemplateLibrary } from '../subtitle-templates/library.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type RecipeParams = { Params: { recipeId: string } };
type ProjectParams = { Params: { projectId: string }; Querystring: { wait?: string } };

export default async function styleRoutes(app: FastifyInstance): Promise<void> {
	const { services } = app.jasper;
	const core = coreServices(app);
	const library = new StyleRecipeLibrary(core.config.paths.styleRecipesDir, {
		onChange: (revision) => core.broadcaster.publish('styleRecipes.changed', { revision }),
		log: (m) => app.log.warn(m),
	});
	services.styleRecipes = library;
	const automation: AutomationDeps = {
		agent: () => services.agent as AgentService | undefined,
		proposals: () => services.proposals as ProposalService | undefined,
		sounds: () => services.sounds as SoundService | undefined,
		reframe: () => services.reframe as ReframeService | undefined,
		media: () => core.media,
		localPaths: () => core.config.dev || isLoopbackHost(core.config.host),
		voice: () => services.voice as VoiceActivityService | undefined,
		audio: () => services.audio as AudioService | undefined,
	};
	const deps: StyleDeps = {
		...automation,
		recipes: () => library,
		cleanup: () => services.cleanupAnalysis as CleanupAnalysisService | undefined,
		templates: () => services.subtitleTemplates as SubtitleTemplateLibrary | undefined,
		queue: () => core.queue,
	};
	core.queue.registerRunner('apply-style', (ctx) => runStyleJob(ctx, deps));

	// ---- the library
	app.get(
		'/api/style-recipes',
		guarded(async () => library.list()),
	);
	app.get<RecipeParams>(
		'/api/style-recipes/:recipeId',
		guarded<RecipeParams>(async (req) => library.entry(req.params.recipeId)),
	);
	app.post(
		'/api/style-recipes',
		guarded(async (req, reply) => {
			const body = parseOr400(StyleRecipeCreateRequestSchema, req.body ?? {});
			reply.code(201);
			return library.create(body.recipe);
		}),
	);
	app.put<RecipeParams>(
		'/api/style-recipes/:recipeId',
		guarded<RecipeParams>(async (req) =>
			library.update(req.params.recipeId, parseOr400(StyleRecipeUpdateRequestSchema, req.body ?? {})),
		),
	);
	app.post<RecipeParams>(
		'/api/style-recipes/:recipeId/duplicate',
		guarded<RecipeParams>(async (req, reply) => {
			const body = parseOr400(StyleRecipeDuplicateRequestSchema, req.body ?? {});
			reply.code(201);
			return library.duplicate(req.params.recipeId, body.name);
		}),
	);
	// The library is the user's, shared by every project, and has no undo: an agent's delete is approved in the editor.
	app.delete<RecipeParams>(
		'/api/style-recipes/:recipeId',
		guarded<RecipeParams>(async (req) => {
			const e = await library.entry(req.params.recipeId);
			if (e.source === 'builtin')
				throw new HttpError(409, 'RECIPE_READ_ONLY', 'Built-in style recipes cannot be deleted', {
					code: 'E_READ_ONLY',
				});
			await requireUserApproval(app, req, {
				label: 'Delete style recipe',
				summary: `delete the style recipe "${e.name}" from your recipe library`,
				reasons: ['deletes a recipe of your library; this cannot be undone (projects keep their own copies)'],
			});
			return { ok: true as const, ...(await library.remove(req.params.recipeId)) };
		}),
	);

	// ---- Apply Style
	app.post<ProjectParams>(
		'/api/projects/:projectId/style/apply',
		guarded<ProjectParams>(async (req, reply) => {
			const projectId = req.params.projectId;
			if (!isProjectId(projectId)) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Unknown project');
			const body = parseOr400(ApplyStyleRequestSchema, req.body ?? {});
			const agent = deps.agent();
			if (!agent || !deps.proposals())
				throw new HttpError(503, 'NOT_AVAILABLE', 'The automation services are not running');
			if (!(await agent.projectExists(projectId)))
				throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project not found: ${projectId}`);
			const { doc } = await liveDocument(agent, projectId);
			const recipe = await resolveRecipe(deps, doc, body);
			if (body.sequenceId && !doc.sequences[body.sequenceId])
				throw new HttpError(404, 'NOT_FOUND', `Sequence not found: ${body.sequenceId}`, { code: 'E_NOT_FOUND' });
			const input = {
				projectId,
				recipe,
				...(body.sequenceId ? { sequenceId: body.sequenceId } : {}),
				...(body.range ? { range: body.range } : {}),
				...(body.seed !== undefined ? { seed: body.seed } : {}),
				...(body.passes ? { passes: body.passes } : {}),
			};
			if (body.mode === 'dryRun') return dryRunStyle(deps, input);
			const editor = req.jasperEditor === true;
			const job = await core.queue.submit({
				kind: 'apply-style',
				title: `Apply Style: ${recipe.name}`.slice(0, 120),
				priority: 'user',
				cpuSlots: 1,
				origin: editor ? { type: 'user' } : { type: 'agent', agentRunId: agentNameOf(req) },
				projectId,
				input: { ...input, who: { editor, agent: agentNameOf(req) } },
				stage: 'Waiting',
			});
			return replyWithJob(core.queue, job, req.query.wait, reply, 'APPLY_STYLE_FAILED');
		}),
	);

	// ---- Style Check
	app.post<ProjectParams>(
		'/api/projects/:projectId/style/check',
		guarded<ProjectParams>(async (req) => {
			const projectId = req.params.projectId;
			if (!isProjectId(projectId)) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Unknown project');
			const body = parseOr400(StyleCheckRequestSchema, req.body ?? {});
			const agent = deps.agent();
			if (!agent) throw new HttpError(503, 'NOT_AVAILABLE', 'The agent service is not running');
			if (!(await agent.projectExists(projectId)))
				throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project not found: ${projectId}`);
			return runStyleCheck(deps, projectId, body);
		}),
	);
}
