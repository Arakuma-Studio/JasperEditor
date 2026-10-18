// Sound design routes (spec 12 §2.8; wp-notes "WP2.3 cue route & MCP tools", "Phase 3 → WP3.2"):
//   POST /api/sound-design/cues   cue suggestions derived from the edit (`deriveCues` of @jasper/project with the
//                                 engine's motion-graphic template registry), for an inline envelope or a project's
//                                 live document. Read-only: nothing is stored.
//   POST /api/sound-design/plan   a `sound-design` job (202): cues → rank → register → place → a proposal for review
//                                 (sound-design/plan.ts), with gains solved against the bed. Nothing is applied.
//   POST /api/sound-design/rebalance  a `sound-design` job (202): the sequence's sound effects measured against the bed
//                                 and solved by the masking solver (sound-design/rebalance.ts): a report, and one
//                                 applied transaction "Rebalance SFX Levels" or a proposal.
//   POST /api/sound-design/delivery  a `sound-design` job (202): a delivery preset measured and applied as ONE
//                                 transaction "Apply Delivery Preset", or proposed (sound-design/delivery.ts).
//   POST /api/sound-design/check  a `sound-check` job (202): Sound Check (sound-design/check.ts): findings with fixes,
//                                 listen-here moments, the per-event table and a verdict; `store` writes the summary.
//   POST /api/sound-design/check/last  the sequence's last full Sound Check report, kept across restarts
//                                 (sound-design/report-store.ts), with whether it is stale against the live document.
//   POST /api/sound-design/visual the curves, cue ticks, motion, findings and (asked) the spectrogram over ≤ 120 s
//                                 (sound-design/visual.ts).
//   POST /api/sound-design/listen a `sound-listen` job (202): the listening transcript of ≤ 10 min (sound-design/listen.ts):
//                                 events attributed to their clips and cues, sections, sync with chance levels, lines.
//   POST /api/sound-design/motion a `motion-analysis` job (202): the picture rendered small and measured per frame
//                                 (sound-design/motion.ts), cached by the picture's fingerprint.
// The cue route also runs the engine's cue sources (scene, beat, pixel: sound-design/engine-cues.ts) when asked; what is
// still being analysed comes back as `W_ANALYSIS_PENDING` with the job ids, never silently left out.

import { join } from 'node:path';
import {
	type EngineCue,
	type EnvelopeJson,
	MotionAnalysisRequestSchema,
	SfxRebalanceRequestSchema,
	SoundCheckLastRequestSchema,
	type SoundCheckLastResponse,
	SoundCheckRequestSchema,
	type SoundCheckResult,
	type SoundCueSuggestion,
	SoundCuesRequestSchema,
	type SoundCuesResponse,
	SoundDeliveryRequestSchema,
	SoundDesignPlanRequestSchema,
	SoundListenRequestSchema,
	SoundVisualRequestSchema,
} from '@jasper/api';
import { mgRegistry } from '@jasper/mg-templates';
import {
	bindExpressions,
	defaultRegistries,
	deriveCues,
	dialogueSpans,
	documentHasActiveExpressions,
	ENGINE_CUE_SOURCES,
	loadProject,
	mixFingerprint,
	type ProjectDocument,
	personalityDensity,
	type Rational,
	SOUND_CHECK_THRESHOLDS,
	sequenceDuration,
	sequenceTimecode,
	soundCheckInputsHash,
	soundCuesOf,
	soundDesignSettingsOf,
} from '@jasper/project';
import type { FastifyInstance } from 'fastify';
import type { AgentService } from '../agent/service.ts';
import { agentNameOf } from '../agent/user-approval.ts';
import type { BeatService } from '../audio/beats.ts';
import { isProjectId } from '../projects/store.ts';
import type { ProposalService } from '../proposals/service.ts';
import { runSoundCheck } from '../sound-design/check.ts';
import { mixAnalysis, planDelivery, runDelivery } from '../sound-design/delivery.ts';
import { type EngineCueSource, EngineCueSources } from '../sound-design/engine-cues.ts';
import { ListenInputError, listenRange, runSoundListen } from '../sound-design/listen.ts';
import { matchStoredCues } from '../sound-design/match.ts';
import { closeSoundDesignMeasurer, soundDesignMeasurer } from '../sound-design/measure-pool.ts';
import { MotionInputError, MotionService, planMotion } from '../sound-design/motion.ts';
import {
	liveDocument,
	PlanInputError,
	planSequence,
	runSoundDesignPlan,
	unknownCueIds,
} from '../sound-design/plan.ts';
import { RebalanceInputError, rebalanceTargets, runRebalance } from '../sound-design/rebalance.ts';
import { SoundCheckReportStore } from '../sound-design/report-store.ts';
import { soundVisual, VisualInputError, visualRange } from '../sound-design/visual.ts';
import { registerVoiceService, VoiceActivityService } from '../sound-design/voice.ts';
import type { SoundService } from '../sounds/service.ts';
import type { SceneService } from '../time/scenes.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const ENGINE_SOURCES: ReadonlySet<string> = new Set(ENGINE_CUE_SOURCES);
/** Longest curve returned per clip (frames): the 20 000 the deriver samples at most. */
const MAX_CURVE_FRAMES = 20_000;

export default async function soundDesignRoutes(app: FastifyInstance): Promise<void> {
	const { services } = app.jasper;
	const core = coreServices(app);
	const agentOf = () => services.agent as AgentService | undefined;
	// Picture motion (P6): its own job kind and cache; the engine cue sources share it with scene detection and beats.
	const motion = new MotionService(core, join(app.jasper.config.paths.soundsDir, 'analysis', 'motion'));
	motion.registerRunner();
	services.motion = motion;
	const engineCues = new EngineCueSources({
		queue: core.queue,
		scenes: () => services.scenes as SceneService | undefined,
		beats: () => services.beats as BeatService | undefined,
		motion: () => motion,
	});
	services.engineCues = engineCues;
	// Voice activity of dialogue clips (P6-R3): one disk-cached service for the cue route, the plan job, the solver's
	// bed measurement and Sound Check (`voiceServiceFor` finds it by the engine's ffmpeg).
	const voice = new VoiceActivityService(
		core.ffmpeg,
		core.registry,
		join(app.jasper.config.paths.soundsDir, 'analysis', 'voice'),
	);
	registerVoiceService(core.ffmpeg, voice);
	services.voice = voice;
	// The solo / bed renders and their band analysis run on worker threads (WP6.5b; in-thread without them): started on
	// first use, stopped when idle and when the engine closes.
	soundDesignMeasurer((m) => app.log.warn(m));
	app.addHook('onClose', async () => closeSoundDesignMeasurer());
	// Registered by the proposal routes (after these): looked up when a job runs.
	const proposalsOf = () => services.proposals as ProposalService | undefined;
	// One job kind for all three: rebalance jobs carry `rebalance` in their input, delivery jobs `delivery`.
	core.queue.registerRunner('sound-design', (ctx) =>
		(ctx.input as { delivery?: unknown } | null)?.delivery
			? runDelivery(ctx, {
					agent: agentOf,
					proposals: proposalsOf,
					ffmpeg: core.ffmpeg,
					registry: core.registry,
					registries: defaultRegistries(mgRegistry),
				})
			: (ctx.input as { rebalance?: unknown } | null)?.rebalance
				? runRebalance(ctx, {
						agent: agentOf,
						proposals: proposalsOf,
						ffmpeg: core.ffmpeg,
						registry: core.registry,
					})
				: runSoundDesignPlan(ctx, {
						agent: agentOf,
						engineCues: () => engineCues,
						sounds: () => services.sounds as SoundService | undefined,
						proposals: proposalsOf,
						mgTemplates: mgRegistry,
						ffmpeg: core.ffmpeg,
						registry: core.registry,
						planDelivery,
						mixAnalysis,
					}),
	);

	// The last full report per sequence outlives the job (and the engine): the panel reloads it after a restart.
	const savedSequences = async (pid: string): Promise<Set<string> | null> => {
		const g = await core.projects.get(pid).catch(() => null);
		const seqs = (g?.envelope.document as { sequences?: unknown } | undefined)?.sequences;
		return g ? new Set(seqs && typeof seqs === 'object' ? Object.keys(seqs) : []) : null;
	};
	const reports = new SoundCheckReportStore({
		projectDir: (pid) => app.jasper.config.paths.projectDir(pid),
		log: (m) => app.log.warn(m),
		exists: async (pid) => (await core.projects.revision(pid).catch(() => null)) !== null,
		// a sequence missing from the saved project is kept while an editor holds it (it may be unsaved, or its delete
		// undone), else it is gone
		keep: async (pid, sequenceId) =>
			!!core.leases.get(pid) || ((await savedSequences(pid))?.has(sequenceId) ?? false),
	});
	// A kept report goes with its sequence (WP6.5b): when no editing session could bring a deleted sequence back — a
	// save or restore with no editor holding the project, the end of the editor's session, the start of a new one (a
	// fresh History) — the reports of sequences the saved project no longer has are deleted. While an editor holds the
	// project its History can undo the delete: the report stays until then.
	const prune = (pid: string, force: boolean) => {
		void (async () => {
			if (!force && core.leases.get(pid)) return;
			const seqs = await savedSequences(pid);
			if (!seqs) return; // deleted: its folder went with it
			const gone = await reports.prune(pid, seqs);
			if (gone.length)
				app.log.info(`[sound-check] reports of deleted sequences removed: ${pid} ${gone.join(', ')}`);
		})().catch((e) => app.log.warn(`[sound-check] reports of ${pid} not pruned: ${(e as Error).message}`));
	};
	const offStore = core.projects.onChange((c) => {
		if (c.kind !== 'deleted') prune(c.projectId, false);
	});
	const offLeases = core.leases.onChange((c) => prune(c.projectId, c.kind === 'acquired'));
	app.addHook('onClose', async () => {
		offStore();
		offLeases();
	});
	core.queue.registerRunner('sound-check', async (ctx) => {
		const result: SoundCheckResult = await runSoundCheck(ctx, {
			agent: agentOf,
			engineCues: () => engineCues,
			sounds: () => services.sounds as SoundService | undefined,
			ffmpeg: core.ffmpeg,
			registry: core.registry,
			registries: defaultRegistries(mgRegistry),
			mgTemplates: mgRegistry,
		});
		if (!ctx.signal.aborted) await reports.save(result.projectId, result, ctx.job.id);
		return result;
	});

	// The listening transcript (spec 12 §4 P6-E6): read-only for the project.
	core.queue.registerRunner('sound-listen', (ctx) =>
		runSoundListen(ctx, {
			agent: agentOf,
			ffmpeg: core.ffmpeg,
			registry: core.registry,
			engineCues: () => engineCues,
			lastCheckReport: async (pid, sequenceId) => (await reports.get(pid, sequenceId))?.result.report ?? null,
		}),
	);

	app.post(
		'/api/sound-design/listen',
		guarded(async (req, reply) => {
			const body = parseOr400(SoundListenRequestSchema, req.body ?? {});
			if (!isProjectId(body.projectId)) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Unknown project');
			const agent = agentOf();
			if (!agent) throw new HttpError(503, 'NOT_AVAILABLE', 'The sound design services are not running');
			if (!(await agent.projectExists(body.projectId)))
				throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project not found: ${body.projectId}`);
			// Refused at once rather than as a failed job: an unknown sequence, a range outside it or over 10 min.
			const { doc } = await liveDocument(agent, body.projectId);
			let seq: ReturnType<typeof planSequence>;
			try {
				seq = planSequence(doc, body.sequenceId);
				listenRange(seq, body);
			} catch (e) {
				if (e instanceof PlanInputError) throw new HttpError(404, e.code, e.message);
				if (e instanceof ListenInputError) throw new HttpError(400, e.code, e.message);
				throw e;
			}
			const editor = req.jasperEditor === true;
			reply.code(202);
			return core.queue.submit({
				kind: 'sound-listen',
				title: 'Listen to the mix',
				priority: 'user',
				cpuSlots: 1,
				origin: editor ? { type: 'user' } : { type: 'agent', agentRunId: agentNameOf(req) },
				projectId: body.projectId,
				input: { request: { ...body, sequenceId: seq.id } },
				stage: 'Waiting',
			});
		}),
	);

	app.post(
		'/api/sound-design/check/last',
		guarded(async (req) => {
			const body = parseOr400(SoundCheckLastRequestSchema, req.body ?? {});
			if (!isProjectId(body.projectId)) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Unknown project');
			const agent = agentOf();
			if (!agent) throw new HttpError(503, 'NOT_AVAILABLE', 'The sound design services are not running');
			if (!(await agent.projectExists(body.projectId)))
				throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project not found: ${body.projectId}`);
			const { doc } = await liveDocument(agent, body.projectId);
			let seq: ReturnType<typeof planSequence>;
			try {
				seq = planSequence(doc, body.sequenceId);
			} catch (e) {
				if (e instanceof PlanInputError) throw new HttpError(404, e.code, e.message);
				throw e;
			}
			const stored = await reports.get(body.projectId, seq.id);
			if (!stored)
				throw new HttpError(
					404,
					'SOUND_CHECK_NOT_FOUND',
					`No Sound Check report of sequence ${seq.id} is kept: run the check`,
				);
			const report = stored.result.report;
			const reasons: SoundCheckLastResponse['reasons'] = [];
			if (report.mixHash !== mixFingerprint(doc, seq.id)) reasons.push('mix');
			// the numbers the check hashed (a custom target's are the report preset's)
			const target = report.preset.custom
				? { integratedLufs: report.preset.integratedLufs, truePeakDb: report.preset.truePeakDb }
				: null;
			if (report.inputsHash !== soundCheckInputsHash(doc, seq.id, report.preset.id, target))
				reasons.push('inputs');
			const out: SoundCheckLastResponse = {
				projectId: body.projectId,
				sequenceId: seq.id,
				jobId: stored.jobId,
				savedAt: stored.savedAt,
				state: reasons.length ? 'stale' : 'current',
				reasons,
				result: stored.result,
			};
			return out;
		}),
	);

	app.post(
		'/api/sound-design/check',
		guarded(async (req, reply) => {
			const body = parseOr400(SoundCheckRequestSchema, req.body ?? {});
			if (!isProjectId(body.projectId)) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Unknown project');
			const agent = agentOf();
			if (!agent) throw new HttpError(503, 'NOT_AVAILABLE', 'The sound design services are not running');
			if (!(await agent.projectExists(body.projectId)))
				throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project not found: ${body.projectId}`);
			// Refused at once rather than as a failed job: an unknown sequence, a range outside it or over 4 h.
			const { doc } = await liveDocument(agent, body.projectId);
			let seq: ReturnType<typeof planSequence>;
			try {
				seq = planSequence(doc, body.sequenceId);
			} catch (e) {
				if (e instanceof PlanInputError) throw new HttpError(404, e.code, e.message);
				throw e;
			}
			const rate = seq.settings.frameRate as Rational;
			const fps = rate.num / rate.den;
			const duration = Math.max(0, Math.ceil(sequenceDuration(seq)));
			if (body.range && body.range.start >= Math.max(1, duration))
				throw new HttpError(400, 'RANGE_EMPTY', `The range is outside the sequence (0–${duration} frames)`);
			const span = body.range ? Math.min(body.range.end, duration) - body.range.start : duration;
			if (span / fps > SOUND_CHECK_THRESHOLDS.maxRangeSec)
				throw new HttpError(
					400,
					'RANGE_TOO_LONG',
					'Sound Check takes at most 4 hours at once: check a range',
				);
			const editor = req.jasperEditor === true;
			const who = { editor, agent: agentNameOf(req) };
			reply.code(202);
			return core.queue.submit({
				kind: 'sound-check',
				title: 'Sound Check',
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
		'/api/sound-design/visual',
		guarded(async (req) => {
			const body = parseOr400(SoundVisualRequestSchema, req.body ?? {});
			if (!isProjectId(body.projectId)) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Unknown project');
			const agent = agentOf();
			if (!agent) throw new HttpError(503, 'NOT_AVAILABLE', 'The sound design services are not running');
			if (!(await agent.projectExists(body.projectId)))
				throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project not found: ${body.projectId}`);
			const { doc } = await liveDocument(agent, body.projectId);
			let seq: ReturnType<typeof planSequence>;
			try {
				seq = planSequence(doc, body.sequenceId);
				visualRange(seq, body);
			} catch (e) {
				if (e instanceof PlanInputError) throw new HttpError(404, e.code, e.message);
				if (e instanceof VisualInputError) throw new HttpError(400, e.code, e.message);
				throw e;
			}
			let checkJob = null;
			if (body.checkJobId) {
				checkJob = core.queue.get(body.checkJobId);
				if (checkJob?.kind !== 'sound-check' || checkJob.projectId !== body.projectId)
					throw new HttpError(404, 'JOB_NOT_FOUND', `No Sound Check job ${body.checkJobId} of this project`);
			}
			const ac = new AbortController();
			req.raw.on('close', () => {
				if (!req.raw.complete || req.raw.destroyed) ac.abort();
			});
			return soundVisual(doc, seq, body, {
				ff: core.ffmpeg,
				registry: core.registry,
				mgTemplates: mgRegistry,
				checkJob,
				signal: ac.signal,
				pixelCurves: (range) => motion.cachedCurves(doc, seq, range),
			});
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
		'/api/sound-design/delivery',
		guarded(async (req, reply) => {
			const body = parseOr400(SoundDeliveryRequestSchema, req.body ?? {});
			if (!isProjectId(body.projectId)) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Unknown project');
			const agent = agentOf();
			if (!agent || !services.proposals)
				throw new HttpError(503, 'NOT_AVAILABLE', 'The sound design services are not running');
			if (!(await agent.projectExists(body.projectId)))
				throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project not found: ${body.projectId}`);
			// Refused at once rather than as a failed job: an unknown sequence.
			const { doc } = await liveDocument(agent, body.projectId);
			try {
				planSequence(doc, body.sequenceId);
			} catch (e) {
				if (e instanceof PlanInputError) throw new HttpError(404, e.code, e.message);
				throw e;
			}
			const editor = req.jasperEditor === true;
			const who = { editor, agent: agentNameOf(req) };
			reply.code(202);
			return core.queue.submit({
				kind: 'sound-design',
				title: `Delivery preset: ${body.delivery}`,
				priority: 'user',
				cpuSlots: 1,
				origin: editor ? { type: 'user' } : { type: 'agent', agentRunId: who.agent },
				projectId: body.projectId,
				input: { delivery: body, who },
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
		'/api/sound-design/motion',
		guarded(async (req, reply) => {
			const body = parseOr400(MotionAnalysisRequestSchema, req.body ?? {});
			if (!isProjectId(body.projectId)) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Unknown project');
			const agent = agentOf();
			if (!agent) throw new HttpError(503, 'NOT_AVAILABLE', 'The sound design services are not running');
			if (!(await agent.projectExists(body.projectId)))
				throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project not found: ${body.projectId}`);
			const live = await liveDocument(agent, body.projectId);
			let plan: ReturnType<typeof planMotion>;
			try {
				plan = planMotion(live.doc, planSequence(live.doc, body.sequenceId), body.range);
			} catch (e) {
				if (e instanceof PlanInputError) throw new HttpError(404, e.code, e.message);
				if (e instanceof MotionInputError) throw new HttpError(400, e.code, e.message);
				throw e;
			}
			const editor = req.jasperEditor === true;
			reply.code(202);
			return motion.submit(live.doc, plan, {
				projectId: body.projectId,
				origin: editor ? { type: 'user' } : { type: 'agent', agentRunId: agentNameOf(req) },
				...(live.revision !== null ? { revision: live.revision } : {}),
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
			const opts = body.opts ?? {};
			// Engine sources (scene, beat, pixel) measure media: run (or join) their analyses; the ones still running are
			// reported as pending with their jobs, the measured ones become extra cues. Measured on the document as saved
			// (the renderer evaluates expressions itself).
			const engineSources = (opts.sources ?? []).filter((x): x is EngineCueSource => ENGINE_SOURCES.has(x));
			const measured =
				engineSources.length || opts.snapToBeats
					? await engineCues.collect(doc, seq, {
							sources: engineSources,
							...(opts.snapToBeats ? { snapToBeats: true } : {}),
							...(opts.timeSignature !== undefined ? { timeSignature: opts.timeSignature } : {}),
							...(opts.range ? { range: opts.range } : {}),
							mode:
								opts.analyze === false
									? { kind: 'cached' }
									: {
											kind: 'submit',
											projectId:
												body.projectId ??
												(typeof doc.projectId === 'string' && isProjectId(doc.projectId)
													? doc.projectId
													: null),
											origin:
												req.jasperEditor === true
													? { type: 'user' }
													: { type: 'agent', agentRunId: agentNameOf(req) },
											...(revision !== null ? { revision } : {}),
										},
						})
					: null;
			// Expression-driven motion moves like the renderer shows it (deriveCues samples resolved properties).
			if (documentHasActiveExpressions(doc)) doc = bindExpressions(doc);
			// a personality named by the request brings its default density (P6-E10)
			const density =
				opts.density ??
				(opts.personality
					? personalityDensity(opts.personality, soundDesignSettingsOf(seq).density)
					: soundDesignSettingsOf(seq).density);
			const respectDialogue = opts.respectDialogue ?? true;
			// where dialogue clips without a transcript actually speak (measured on their media; cached)
			const spoken = respectDialogue
				? await voice.forSequence(doc, seq, { mode: opts.voiceActivity === false ? 'cached' : 'compute' })
				: null;
			const out = deriveCues(doc, seqId, {
				...(opts.range ? { range: opts.range } : {}),
				...(opts.sources ? { sources: opts.sources } : {}),
				density,
				respectDialogue,
				...(opts.minGapFrames !== undefined ? { minGapFrames: opts.minGapFrames } : {}),
				...(opts.maxCues !== undefined ? { maxCues: opts.maxCues } : {}),
				mgTemplates: mgRegistry,
				...(spoken ? { voiceActivity: spoken.voice } : {}),
				...(measured ? { extraCues: measured.extraCues } : {}),
				...(opts.snapToBeats ? { snapToBeats: true, beatFrames: measured?.beatFrames ?? [] } : {}),
				// P6-E10 cue grammar (absent: the sequence's style)
				...(opts.typing ? { typing: opts.typing } : {}),
				...(opts.musicCarriesCuts !== undefined ? { musicCarriesCuts: opts.musicCarriesCuts } : {}),
				...(opts.personality !== undefined ? { personality: opts.personality } : {}),
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
				...(c.anchorOffset ? { anchorOffset: c.anchorOffset } : {}),
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
				...(out.carried?.length
					? {
							carried: out.carried.map((c) => ({
								key: c.key,
								frame: c.frame,
								timecode: sequenceTimecode(seq, c.frame),
								confidence: c.confidence,
								minConfidence: c.minConfidence,
								reason: c.reason,
							})),
						}
					: {}),
				warnings: [...out.warnings, ...(measured?.warnings ?? [])],
				...(measured
					? {
							analysis: measured.analysis,
							engineCues: measured.extraCues
								.filter((c) => engineSources.includes(c.from as EngineCueSource))
								.slice(0, 10_000)
								.map(
									(c): EngineCue => ({
										key: c.key ?? `${c.from}:${c.frame}`,
										frame: c.frame,
										kind: c.kind,
										weight: c.weight,
										types: c.types,
										align: c.align,
										...(c.pan !== undefined ? { pan: c.pan } : {}),
										...(c.panSweep ? { panSweep: { ...c.panSweep } } : {}),
										anchor: c.anchor,
										confidence: round3(c.confidence),
										reason: c.reason,
										...(c.window ? { window: { ...c.window } } : {}),
										from: c.from as EngineCueSource,
										...(c.size !== undefined ? { size: round3(c.size) } : {}),
									}),
								),
						}
					: {}),
				dialogue: respectDialogue
					? dialogueSpans(doc, seq, { voice: spoken?.voice ?? null }).map((d) => ({
							start: Math.max(0, d.start),
							end: d.end,
							clipIds: d.clipIds,
							trackIds: d.trackIds,
							sources: d.sources,
						}))
					: [],
				...(spoken
					? {
							voiceActivity: spoken.voice as Record<string, [number, number][]>,
							voice: {
								state: spoken.state,
								measured: spoken.measured,
								missing: spoken.missing,
								...(spoken.message ? { message: spoken.message } : {}),
							},
						}
					: {}),
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
