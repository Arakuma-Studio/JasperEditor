// Editing automation routes (spec 15 EA-020…EA-022, EA-033, EA-041):
//   POST /api/projects/:projectId/automation/:pass   pass = decorate-cuts | punch-ins | ken-burns
//     `mode: 'dryRun'`   200 AutomationPassResult: counts, coverage, skips, export cost, budget, sounds available
//     `mode: 'propose'`  202 an `edit-automation` job (automation/run.ts) whose result names the stored proposal
//                        (`?wait=1` waits for it); invalid parameters, an unknown sequence or track are refused at once.
// The job kind's runner and the refresher of feature `edit-automation` (Refresh proposal, Reroll) are registered here;
// this plugin runs after the proposal routes (they create the proposals service).
import { type AutomationPassId, AutomationPassIdSchema, AutomationPassRequestSchema } from '@jasper/api';
import { EDIT_AUTOMATION_FEATURE } from '@jasper/project';
import type { FastifyInstance } from 'fastify';
import type { AgentService } from '../agent/service.ts';
import { agentNameOf } from '../agent/user-approval.ts';
import {
	type AutomationDeps,
	automationRefresher,
	dryRunPass,
	planOrThrow,
	runAutomationJob,
	validParams,
} from '../automation/run.ts';
import type { ReframeService } from '../gaps/reframe.ts';
import { replyWithJob } from '../jobs/reply.ts';
import { isProjectId } from '../projects/store.ts';
import type { ProposalService } from '../proposals/service.ts';
import { liveDocument } from '../sound-design/plan.ts';
import type { SoundService } from '../sounds/service.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

const TITLES: Record<AutomationPassId, string> = {
	'decorate-cuts': 'Decorate Cuts',
	'punch-ins': 'Punch-ins',
	'ken-burns': 'Ken Burns',
};

type R = { Params: { projectId: string; pass: string }; Querystring: { wait?: string } };

export default async function automationRoutes(app: FastifyInstance): Promise<void> {
	const { services } = app.jasper;
	const core = coreServices(app);
	const deps: AutomationDeps = {
		agent: () => services.agent as AgentService | undefined,
		proposals: () => services.proposals as ProposalService | undefined,
		sounds: () => services.sounds as SoundService | undefined,
		reframe: () => services.reframe as ReframeService | undefined,
	};
	core.queue.registerRunner('edit-automation', (ctx) => runAutomationJob(ctx, deps));
	const proposals = deps.proposals();
	if (proposals) {
		const off = proposals.registerRefresher(EDIT_AUTOMATION_FEATURE, automationRefresher(deps));
		app.addHook('onClose', async () => off());
	}

	app.post<R>(
		'/api/projects/:projectId/automation/:pass',
		guarded<R>(async (req, reply) => {
			const projectId = req.params.projectId;
			if (!isProjectId(projectId)) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Unknown project');
			const passParsed = AutomationPassIdSchema.safeParse(req.params.pass);
			if (!passParsed.success)
				throw new HttpError(404, 'NOT_FOUND', `Unknown automation pass: ${String(req.params.pass).slice(0, 40)}`);
			const pass = passParsed.data;
			const body = parseOr400(AutomationPassRequestSchema, req.body ?? {});
			const agent = deps.agent();
			if (!agent || !deps.proposals())
				throw new HttpError(503, 'NOT_AVAILABLE', 'The automation services are not running');
			if (!(await agent.projectExists(projectId)))
				throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project not found: ${projectId}`);
			const params = validParams(pass, body.params ?? {});
			const input = {
				projectId,
				pass,
				...(body.sequenceId ? { sequenceId: body.sequenceId } : {}),
				params,
			};
			if (body.mode === 'dryRun') return dryRunPass(deps, input);
			// Refused at once rather than as a failed job: an unknown sequence or track, invalid parameters.
			const { doc } = await liveDocument(agent, projectId);
			planOrThrow(doc, pass, body.sequenceId, params);
			const editor = req.jasperEditor === true;
			const who = { editor, agent: agentNameOf(req) };
			const job = await core.queue.submit({
				kind: 'edit-automation',
				title: TITLES[pass],
				priority: 'user',
				cpuSlots: 1,
				origin: editor ? { type: 'user' } : { type: 'agent', agentRunId: who.agent },
				projectId,
				input: { ...input, who },
				stage: 'Waiting',
			});
			return replyWithJob(core.queue, job, req.query.wait, reply, 'AUTOMATION_FAILED');
		}),
	);
}
