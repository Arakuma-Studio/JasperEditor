// Fix Transcript routes (spec 17 SC-090; docs/wp-notes/script-correction.md "Fix job, API and MCP"):
//   POST /api/projects/:projectId/sequences/:sequenceId/transcript-fix[?wait=1]
//     body TranscriptFixRequest → 202 a `transcript-fix` job (transcript-fix/run.ts). Refused at once: an unknown
//     project or sequence (404), nothing to fix from (409 E_NO_SOURCE), no transcript in scope (409
//     E_NO_TRANSCRIPT), In–Out without marks (400 E_INVALID_PARAM), no installed speech model to propose (409
//     E_NO_SPEECH_MODEL). The same request on the same document revision while its job is queued or running returns
//     that job (dedupe).
// Registers the job runner and, on the proposals service, the refresher, the accept extension ("Fix transcript: N
// fixes" + the rejected fixes remembered in `Sequence.scriptFix`) and the reject listener of `transcript-correction`.
// Runs after the proposal and speech routes (it uses their services); the glossary service is read lazily.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { TranscriptFixRequestSchema } from '@jasper/api';
import { TRANSCRIPT_CORRECTION_FEATURE } from '@jasper/project';
import type { FastifyInstance } from 'fastify';
import type { AgentService } from '../agent/service.ts';
import { agentNameOf } from '../agent/user-approval.ts';
import { replyWithJob } from '../jobs/reply.ts';
import { isProjectId } from '../projects/store.ts';
import type { ProposalService } from '../proposals/service.ts';
import { liveDocument } from '../sound-design/plan.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';
import { FixCostStore } from '../transcript-fix/costs.ts';
import {
	type FixGlossary,
	type FixSpeech,
	prepare,
	runTranscriptFixJob,
	type TranscriptFixDeps,
	transcriptFixAcceptExtension,
	transcriptFixRefresher,
	transcriptFixRejectListener,
} from '../transcript-fix/run.ts';
import type { VoiceAnalysisService } from '../voice/service.ts';

type R = {
	Params: { projectId: string; sequenceId: string };
	Querystring: { wait?: string };
};

export default async function transcriptFixRoutes(app: FastifyInstance): Promise<void> {
	const { services } = app.jasper;
	const core = coreServices(app);
	const deps: TranscriptFixDeps = {
		agent: () => services.agent as AgentService | undefined,
		proposals: () => services.proposals as ProposalService | undefined,
		speech: () => services.speech as FixSpeech | undefined,
		glossary: () => services.speechGlossary as FixGlossary | undefined,
		voice: () => services.voiceAnalysis as VoiceAnalysisService | undefined,
		costs: new FixCostStore(join(core.config.paths.engineDir, 'transcript-fix-costs.json'), (m) =>
			app.log.warn(m),
		),
		log: (m) => app.log.warn(m),
	};
	core.queue.registerRunner('transcript-fix', (ctx) => runTranscriptFixJob(ctx, deps));
	const proposals = deps.proposals();
	if (proposals) {
		const offs = [
			proposals.registerRefresher(TRANSCRIPT_CORRECTION_FEATURE, transcriptFixRefresher(deps)),
			proposals.registerAcceptExtension(TRANSCRIPT_CORRECTION_FEATURE, transcriptFixAcceptExtension),
			proposals.registerRejectListener(TRANSCRIPT_CORRECTION_FEATURE, transcriptFixRejectListener(deps)),
		];
		app.addHook('onClose', async () => {
			for (const off of offs) off();
		});
	}

	app.post<R>(
		'/api/projects/:projectId/sequences/:sequenceId/transcript-fix',
		guarded<R>(async (req, reply) => {
			const { projectId, sequenceId } = req.params;
			if (!isProjectId(projectId)) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Unknown project');
			const body = parseOr400(TranscriptFixRequestSchema, req.body ?? {});
			const agent = deps.agent();
			if (!agent || !deps.proposals())
				throw new HttpError(503, 'NOT_AVAILABLE', 'The agent or proposal service is not running');
			if (!(await agent.projectExists(projectId)))
				throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project not found: ${projectId}`);
			const { doc, revision } = await liveDocument(agent, projectId);
			// refusals at once (the job repeats them on the document it reads)
			const p = await prepare(deps, doc, revision, sequenceId, body);
			const editor = req.jasperEditor === true;
			const who = { editor, agent: agentNameOf(req) };
			const mode = p.mode;
			const dedupe = createHash('sha256')
				.update(
					JSON.stringify([
						projectId,
						sequenceId,
						revision,
						mode,
						p.settings,
						body.device ?? null,
						editor,
						...(mode === 'rebuild' ? [body.offScript ?? 'drop'] : []),
					]),
				)
				.digest('hex')
				.slice(0, 24);
			const job = await core.queue.submit({
				kind: 'transcript-fix',
				title:
					mode === 'dryRun'
						? 'Fix Transcript (dry run)'
						: mode === 'rebuild'
							? 'Rebuild transcript from script (kept speech)'
							: 'Fix Transcript',
				priority: 'user',
				// the audio check runs the speech worker with the job's slots (as transcription: the speech thread cap)
				cpuSlots: mode === 'dryRun' ? 1 : Math.max(1, deps.speech()?.threads?.() ?? 4),
				minSlots: 1,
				origin: editor ? { type: 'user' } : { type: 'agent', agentRunId: who.agent },
				projectId,
				dedupeKey: `transcript-fix:${dedupe}`,
				input: { projectId, sequenceId, request: body, who },
				stage: 'Waiting',
			});
			return replyWithJob(core.queue, job, req.query.wait, reply, 'TRANSCRIPT_FIX_FAILED');
		}),
	);
}
