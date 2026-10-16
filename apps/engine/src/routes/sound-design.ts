// Sound design routes (spec 12 §2.8; wp-notes "WP2.3 cue route & MCP tools", "Phase 3 → WP3.2"):
//   POST /api/sound-design/cues   cue suggestions derived from the edit (`deriveCues` of @jasper/project with the
//                                 engine's motion-graphic template registry), for an inline envelope or a project's
//                                 live document. Read-only: nothing is stored.
//   POST /api/sound-design/plan   a `sound-design` job (202): cues → rank → register → place → a proposal for review
//                                 (sound-design/plan.ts), with gains solved against the bed. Nothing is applied.
//   POST /api/sound-design/rebalance  a `sound-design` job (202): the sequence's sound effects measured against the bed
//                                 and solved by the masking solver (sound-design/rebalance.ts): a report, and one
//                                 applied transaction "Rebalance SFX Levels" or a proposal.
import {
	type EnvelopeJson,
	SfxRebalanceRequestSchema,
	type SoundCueSuggestion,
	SoundCuesRequestSchema,
	type SoundCuesResponse,
	SoundDesignPlanRequestSchema,
} from '@jasper/api';
import { mgRegistry } from '@jasper/mg-templates';
import {
	bindExpressions,
	deriveCues,
	documentHasActiveExpressions,
	loadProject,
	type ProjectDocument,
	type Rational,
	sequenceDialogueRanges,
	sequenceDuration,
	sequenceTimecode,
	soundCuesOf,
	soundDesignSettingsOf,
} from '@jasper/project';
import type { FastifyInstance } from 'fastify';
import type { AgentService } from '../agent/service.ts';
import { agentNameOf } from '../agent/user-approval.ts';
import { isProjectId } from '../projects/store.ts';
import type { ProposalService } from '../proposals/service.ts';
import { matchStoredCues } from '../sound-design/match.ts';
import {
	liveDocument,
	PlanInputError,
	planSequence,
	runSoundDesignPlan,
	unknownCueIds,
} from '../sound-design/plan.ts';
import { RebalanceInputError, rebalanceTargets, runRebalance } from '../sound-design/rebalance.ts';
import type { SoundService } from '../sounds/service.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

const round3 = (x: number) => Math.round(x * 1000) / 1000;
/** Longest curve returned per clip (frames): the 20 000 the deriver samples at most. */
const MAX_CURVE_FRAMES = 20_000;

export default async function soundDesignRoutes(app: FastifyInstance): Promise<void> {
	const { services } = app.jasper;
	const core = coreServices(app);
	const agentOf = () => services.agent as AgentService | undefined;
	// Registered by the proposal routes (after these): looked up when a job runs.
	const proposalsOf = () => services.proposals as ProposalService | undefined;
	// One job kind for both: rebalance jobs carry `rebalance` in their input.
	core.queue.registerRunner('sound-design', (ctx) =>
		(ctx.input as { rebalance?: unknown } | null)?.rebalance
			? runRebalance(ctx, {
					agent: agentOf,
					proposals: proposalsOf,
					ffmpeg: core.ffmpeg,
					registry: core.registry,
				})
			: runSoundDesignPlan(ctx, {
					agent: agentOf,
					sounds: () => services.sounds as SoundService | undefined,
					proposals: proposalsOf,
					mgTemplates: mgRegistry,
					ffmpeg: core.ffmpeg,
					registry: core.registry,
				}),
	);

	app.post(
		'/api/sound-design/rebalance',
		guarded(async (req, reply) => {
			const body = parseOr400(SfxRebalanceRequestSchema, req.body ?? {});
			if (!isProjectId(body.projectId)) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Unknown project');
			const agent = agentOf();
			if (!agent || !services.proposals)
				throw new HttpError(503, 'NOT_AVAILABLE', 'The sound design services are not running');
			if (!(await agent.projectExists(body.projectId)))
				throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project not found: ${body.projectId}`);
			// Refused at once rather than as a failed job: an unknown sequence, unknown or non-SFX clips.
			const { doc } = await liveDocument(agent, body.projectId);
			try {
				rebalanceTargets(doc, planSequence(doc, body.sequenceId), body);
			} catch (e) {
				if (e instanceof PlanInputError) throw new HttpError(404, e.code, e.message);
				if (e instanceof RebalanceInputError) throw new HttpError(e.status, e.code, e.message);
				throw e;
			}
			const editor = req.jasperEditor === true;
			const who = { editor, agent: agentNameOf(req) };
			reply.code(202);
			return core.queue.submit({
				kind: 'sound-design',
				title: 'Rebalance SFX levels',
				priority: 'user',
				cpuSlots: 1,
				origin: editor ? { type: 'user' } : { type: 'agent', agentRunId: who.agent },
				projectId: body.projectId,
				input: { rebalance: body, who },
				stage: 'Waiting',
			});
		}),
	);

	app.post(
		'/api/sound-design/plan',
		guarded(async (req, reply) => {
			const body = parseOr400(SoundDesignPlanRequestSchema, req.body ?? {});
			if (!isProjectId(body.projectId)) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Unknown project');
			const agent = agentOf();
			if (!agent || !services.sounds || !services.proposals)
				throw new HttpError(503, 'NOT_AVAILABLE', 'The sound design services are not running');
			if (!(await agent.projectExists(body.projectId)))
				throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project not found: ${body.projectId}`);
			// Refused at once rather than as a failed job: an unknown sequence or cue.
			const { doc } = await liveDocument(agent, body.projectId);
			try {
				const seq = planSequence(doc, body.sequenceId);
				if (Array.isArray(body.cues)) {
					const unknown = unknownCueIds(seq, body.cues);
					if (unknown.length)
						throw new PlanInputError(
							'CUE_NOT_FOUND',
							`Sound cue not found: ${unknown.slice(0, 5).join(', ')}`,
						);
				}
			} catch (e) {
				if (e instanceof PlanInputError) throw new HttpError(404, e.code, e.message);
				throw e;
			}
			const editor = req.jasperEditor === true;
			const who = { editor, agent: agentNameOf(req) };
			reply.code(202);
			return core.queue.submit({
				kind: 'sound-design',
				title: body.label ? `Sound design: ${body.label}`.slice(0, 200) : 'Sound design plan',
				priority: 'user',
				cpuSlots: 1,
				origin: editor ? { type: 'user' } : { type: 'agent', agentRunId: who.agent },
				projectId: body.projectId,
				input: { request: body, who },
				stage: 'Waiting',
			});
		}),
	);

	app.post(
		'/api/sound-design/cues',
		guarded(async (req) => {
			const body = parseOr400(SoundCuesRequestSchema, req.body ?? {});
			let doc: ProjectDocument;
			let revision: number | null = null;
			if (body.envelope) {
				try {
					doc = loadProject(body.envelope as EnvelopeJson, { mgTemplates: mgRegistry }).document;
				} catch (e) {
					throw new HttpError(400, 'VALIDATION_FAILED', `Invalid project: ${(e as Error).message}`);
				}
				revision = body.envelope.revision;
			} else {
				const agent = app.jasper.services.agent as AgentService | undefined;
				if (!agent) throw new HttpError(503, 'NOT_AVAILABLE', 'The agent service is not running');
				// The live document: the open editor's when one holds the project, else the saved one.
				const r = await agent.query({ projectId: body.projectId!, query: 'doc.get', args: {} });
				const d = r.result as ProjectDocument | undefined;
				if (!d || typeof d !== 'object' || !d.sequences || typeof d.sequences !== 'object')
					throw new HttpError(422, 'VALIDATION_FAILED', 'The project has no readable document');
				doc = d;
				revision = typeof r.revision === 'number' ? r.revision : null;
			}
			const seqId = body.sequenceId ?? Object.keys(doc.sequences)[0];
			const seq =
				seqId !== undefined && Object.hasOwn(doc.sequences, seqId) ? doc.sequences[seqId] : undefined;
			if (!seq || !seqId)
				throw new HttpError(
					404,
					'SEQUENCE_NOT_FOUND',
					body.sequenceId ? `Sequence not found: ${body.sequenceId}` : 'The project has no sequence',
				);
			// Expression-driven motion moves like the renderer shows it (deriveCues samples resolved properties).
			if (documentHasActiveExpressions(doc)) doc = bindExpressions(doc);
			const opts = body.opts ?? {};
			const density = opts.density ?? soundDesignSettingsOf(seq).density;
			const respectDialogue = opts.respectDialogue ?? true;
			const out = deriveCues(doc, seqId, {
				...(opts.range ? { range: opts.range } : {}),
				...(opts.sources ? { sources: opts.sources } : {}),
				density,
				respectDialogue,
				...(opts.minGapFrames !== undefined ? { minGapFrames: opts.minGapFrames } : {}),
				...(opts.maxCues !== undefined ? { maxCues: opts.maxCues } : {}),
				mgTemplates: mgRegistry,
			});
			const rate = seq.settings.frameRate as Rational;
			const fps = rate.num / rate.den;
			const stored = matchStoredCues(seq, out.cues);
			const cues: SoundCueSuggestion[] = out.cues.map((c, i) => ({
				key: c.key,
				frame: c.frame,
				timecode: sequenceTimecode(seq, c.frame),
				seconds: round3(c.frame / fps),
				kind: c.kind,
				weight: c.weight,
				types: c.types,
				align: c.align,
				...(c.pan !== undefined ? { pan: c.pan } : {}),
				...(c.panSweep ? { panSweep: { from: c.panSweep.from, to: c.panSweep.to } } : {}),
				anchor: c.anchor,
				...(c.also?.length ? { also: c.also } : {}),
				confidence: round3(c.confidence),
				reason: c.reason,
				...(c.window ? { window: { start: c.window.start, end: c.window.end } } : {}),
				source: c.source,
				from: c.from,
				...(c.group ? { group: c.group } : {}),
				score: c.score,
				storedCueId: stored[i] ?? null,
			}));
			const res: SoundCuesResponse = {
				projectId: body.projectId ?? null,
				sequenceId: seqId,
				revision,
				frameRate: { num: rate.num, den: rate.den },
				durationFrames: Math.max(0, Math.round(sequenceDuration(seq))),
				density,
				respectDialogue,
				cues,
				stats: out.stats,
				warnings: out.warnings,
				dialogue: respectDialogue
					? sequenceDialogueRanges(doc, seq).map(([start, end]) => ({ start: Math.max(0, start), end }))
					: [],
				storedCues: soundCuesOf(seq).length,
				...(opts.curves
					? {
							curves: out.curves.map((c) => ({
								clipId: c.clipId,
								start: c.start,
								speed: Array.from(c.speed.subarray(0, MAX_CURVE_FRAMES), round3),
							})),
						}
					: {}),
			};
			return res;
		}),
	);
}
