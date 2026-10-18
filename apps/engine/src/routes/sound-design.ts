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
//                                 listen-here moments, the per-event table and a verdict; `store` writes the summary;
//                                 `proposalId` checks a proposal's preview against the document (check-proposal.ts).
//   POST /api/sound-design/check/last  the sequence's last full Sound Check report, kept across restarts
//                                 (sound-design/report-store.ts), with whether it is stale against the live document.
//   POST /api/sound-design/visual the curves, cue ticks, motion, findings and (asked) the spectrogram over ≤ 120 s
//                                 (sound-design/visual.ts).
//   POST /api/sound-design/listen a `sound-listen` job (202): the listening transcript of ≤ 10 min (sound-design/listen.ts):
//                                 events attributed to their clips and cues, sections, sync with chance levels, lines.
//   POST /api/sound-design/beds[/plan], /room-tone[/plan]  ambience beds per scene and room tone in dialogue gaps
//                                 (spec 12 §4 P6-E12; sound-design/beds.ts): the plan (read-only), or a `sound-design`
//                                 job that proposes (default) or applies ONE transaction of `soundDesign.layBed`.
//   POST /api/sound-design/motion a `motion-analysis` job (202): the picture rendered small and measured per frame
//                                 (sound-design/motion.ts), cached by the picture's fingerprint.
//   GET|POST /api/sound-design/profiles, GET|DELETE …/profiles/:profileId, PUT …/:profileId/name, POST …/import
//                                 reference sound profiles (P6-E8, sound-design/profile.ts): the per-user library under
//                                 `<appdir>/sounds/profiles`, the `sound-profile` job, rename, delete (an agent's request
//                                 asks the user: their data) and import of a profile file.
// The cue route also runs the engine's cue sources (scene, beat, pixel: sound-design/engine-cues.ts) when asked; what is
// still being analysed comes back as `W_ANALYSIS_PENDING` with the job ids, never silently left out.

import { join } from 'node:path';
import {
	type EngineCue,
	type EnvelopeJson,
	MotionAnalysisRequestSchema,
	SfxRebalanceRequestSchema,
	SoundBedsRequestSchema,
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
	SoundProfileBuildRequestSchema,
	SoundProfileImportRequestSchema,
	SoundProfileRenameRequestSchema,
	type SoundProfilesResponse,
	SoundRoomToneRequestSchema,
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
import { agentNameOf, requireUserApproval } from '../agent/user-approval.ts';
import type { BeatService } from '../audio/beats.ts';
import { isLoopbackHost } from '../context.ts';
import { isProjectId } from '../projects/store.ts';
import type { ProposalService } from '../proposals/service.ts';
import { type BedDeps, BedInputError, planBeds, planRoomTone, runBedJob } from '../sound-design/beds.ts';
import { runSoundCheck } from '../sound-design/check.ts';
import { runProposalCheckJob } from '../sound-design/check-proposal.ts';
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
import {
	importedProfile,
	profileSummaryOf,
	runSoundProfileJob,
	SoundProfileStore,
} from '../sound-design/profile.ts';
import { RebalanceInputError, rebalanceTargets, runRebalance } from '../sound-design/rebalance.ts';
import { SoundCheckReportStore } from '../sound-design/report-store.ts';
import { soundVisual, VisualInputError, visualRange } from '../sound-design/visual.ts';
import { registerVoiceService, VoiceActivityService } from '../sound-design/voice.ts';
import type { SoundService } from '../sounds/service.ts';
import type { SceneService } from '../time/scenes.ts';
import { clientGoneSignal, guarded, HttpError, parseOr400 } from '../tools/reply.ts';
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
	// Ambience beds and room tone (spec 12 §4 P6-E12): their own inputs (`beds`, `roomTone`) on the same job kind.
	const bedDeps: BedDeps = {
		agent: agentOf,
		proposals: proposalsOf,
		sounds: () => services.sounds as SoundService | undefined,
		engineCues: () => engineCues,
		ffmpeg: core.ffmpeg,
		registry: core.registry,
	};
	core.queue.registerRunner('sound-design', (ctx) =>
		(ctx.input as { beds?: unknown; roomTone?: unknown } | null)?.beds !== undefined ||
		(ctx.input as { roomTone?: unknown } | null)?.roomTone !== undefined
			? runBedJob(ctx, bedDeps)
			: (ctx.input as { delivery?: unknown } | null)?.delivery
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
	// Reference sound profiles (P6-E8): the per-user library and its job.
	const soundsDir = app.jasper.config.paths.soundsDir;
	const profiles = new SoundProfileStore(join(soundsDir, 'profiles'), (m) => app.log.warn(m));
	services.soundProfiles = profiles;
	const localMode = core.config.dev || isLoopbackHost(core.config.host);
	const profilesChanged = (id: string, change: 'created' | 'imported' | 'renamed' | 'deleted') =>
		core.broadcaster.publish('soundProfiles.changed', { id, change });
	core.queue.registerRunner('sound-profile', async (ctx) => {
		const out = await runSoundProfileJob(ctx, {
			store: profiles,
			ffmpeg: core.ffmpeg,
			registry: core.registry,
			agent: agentOf,
			framesDir: join(soundsDir, 'analysis', 'frametimes'),
		});
		profilesChanged(out.profile.id, 'created');
		return out;
	});

	core.queue.registerRunner('sound-check', async (ctx) => {
		const proposalCheck = !!(ctx.input as { request?: { proposalId?: unknown } } | null)?.request?.proposalId;
		const result: SoundCheckResult = await (proposalCheck ? runProposalCheckJob : runSoundCheck)(ctx, {
			agent: agentOf,
			engineCues: () => engineCues,
			sounds: () => services.sounds as SoundService | undefined,
			ffmpeg: core.ffmpeg,
			registry: core.registry,
			registries: defaultRegistries(mgRegistry),
			mgTemplates: mgRegistry,
			proposals: proposalsOf,
			profiles: () => profiles,
			keptReport: async (pid, sequenceId) => {
				const r = await reports.get(pid, sequenceId);
				return r ? { result: r.result, jobId: r.jobId } : null;
			},
		});
		// a proposal check is of a document that does not exist (P6-E5): it never replaces the kept report
		if (!ctx.signal.aborted && !result.proposal) await reports.save(result.projectId, result, ctx.job.id);
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
			// P6-E14: the sound library's Describe-it search model names the events (`tags`)
			nameWindows: () => {
				const sounds = app.jasper.services.sounds as SoundService | undefined;
				return sounds ? (items, signal) => sounds.semantic.nameWindows(items, signal) : null;
			},
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

	type ProfileP = { Params: { profileId: string } };
	const profileOr404 = async (id: string) => {
		const p = await profiles.get(String(id));
		if (!p)
			throw new HttpError(404, 'SOUND_PROFILE_NOT_FOUND', `No reference profile ${String(id).slice(0, 40)}`);
		return p;
	};
	app.get(
		'/api/sound-design/profiles',
		guarded(async () => {
			const { profiles: list, unreadable } = await profiles.list();
			const out: SoundProfilesResponse = {
				profiles: list.map(profileSummaryOf),
				unreadable,
				paths: localMode,
			};
			return out;
		}),
	);
	app.get<ProfileP>(
		'/api/sound-design/profiles/:profileId',
		guarded<ProfileP>(async (req) => profileOr404(req.params.profileId)),
	);
	app.post(
		'/api/sound-design/profiles',
		guarded(async (req, reply) => {
			const body = parseOr400(SoundProfileBuildRequestSchema, req.body ?? {});
			if (body.paths?.length && !localMode)
				throw new HttpError(
					403,
					'PATHS_NOT_ALLOWED',
					'This engine is not local: choose project media or sequences as references',
				);
			if (body.projectId) {
				if (!isProjectId(body.projectId)) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Unknown project');
				const agent = agentOf();
				if (!agent) throw new HttpError(503, 'NOT_AVAILABLE', 'The sound design services are not running');
				if (!(await agent.projectExists(body.projectId)))
					throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project not found: ${body.projectId}`);
				// refused at once rather than as skipped references: ids the project does not have
				const { doc } = await liveDocument(agent, body.projectId);
				for (const id of body.mediaIds ?? [])
					if (!Object.hasOwn(doc.media ?? {}, id))
						throw new HttpError(404, 'MEDIA_NOT_FOUND', `Media not found: ${id.slice(0, 64)}`);
				for (const id of body.sequenceIds ?? [])
					if (!Object.hasOwn(doc.sequences ?? {}, id))
						throw new HttpError(404, 'SEQUENCE_NOT_FOUND', `Sequence not found: ${id.slice(0, 64)}`);
			}
			const n = (body.mediaIds?.length ?? 0) + (body.sequenceIds?.length ?? 0) + (body.paths?.length ?? 0);
			const editor = req.jasperEditor === true;
			reply.code(202);
			return core.queue.submit({
				kind: 'sound-profile',
				title: `Reference profile “${body.name.slice(0, 60)}” (${n} reference${n === 1 ? '' : 's'})`,
				priority: 'user',
				cpuSlots: 2,
				minSlots: 1,
				origin: editor ? { type: 'user' } : { type: 'agent', agentRunId: agentNameOf(req) },
				...(body.projectId ? { projectId: body.projectId } : {}),
				input: { request: body, local: localMode },
				stage: 'Waiting',
			});
		}),
	);
	app.put<ProfileP>(
		'/api/sound-design/profiles/:profileId/name',
		guarded<ProfileP>(async (req) => {
			const body = parseOr400(SoundProfileRenameRequestSchema, req.body ?? {});
			await profileOr404(req.params.profileId);
			const p = await profiles.rename(req.params.profileId, body.name);
			profilesChanged(p.id, 'renamed');
			return profileSummaryOf(p);
		}),
	);
	app.delete<ProfileP>(
		'/api/sound-design/profiles/:profileId',
		guarded<ProfileP>(async (req) => {
			const p = await profileOr404(req.params.profileId);
			// the user's data: an agent asks first (security review AGT-3, like removing a sound pack)
			await requireUserApproval(app, req, {
				label: 'Delete a reference profile',
				summary: `delete the reference profile "${p.name.slice(0, 120)}" (${p.n} reference${p.n === 1 ? '' : 's'}) from this computer's sound library`,
				reasons: [
					'it was measured from your own reference media; building it again needs them again',
					'sequences that compare with it lose the Reference rows until another profile is chosen',
				],
			});
			await profiles.remove(p.id);
			profilesChanged(p.id, 'deleted');
			return { deleted: true as const, id: p.id };
		}),
	);
	app.post(
		'/api/sound-design/profiles/import',
		guarded(async (req) => {
			const body = parseOr400(SoundProfileImportRequestSchema, req.body ?? {});
			const incoming = importedProfile(body.profile, body.name);
			// a second copy of a shared profile gets a distinct name ("My channel (2)")
			const names = new Set((await profiles.list()).profiles.map((x) => x.name));
			let name = incoming.name;
			for (let n = 2; names.has(name) && n < 1000; n++) name = `${incoming.name.slice(0, 110)} (${n})`;
			const p = await profiles.save(name === incoming.name ? incoming : { ...incoming, name });
			profilesChanged(p.id, 'imported');
			return profileSummaryOf(p);
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
			// Refused at once rather than as a failed job: an unknown sequence or proposal, a range outside it or over 4 h.
			const { doc } = await liveDocument(agent, body.projectId);
			let wanted = body.sequenceId;
			if (body.proposalId) {
				// P6-E5: the proposal must exist (and be about this sequence when one is named); its sequence by default
				const proposals = proposalsOf();
				if (!proposals) throw new HttpError(503, 'NOT_AVAILABLE', 'The proposal service is not running');
				const { proposal } = await proposals.get(body.projectId, body.proposalId);
				if (body.sequenceId && proposal.sequenceId && proposal.sequenceId !== body.sequenceId)
					throw new HttpError(
						400,
						'VALIDATION_FAILED',
						`The proposal is about sequence ${proposal.sequenceId}, not ${body.sequenceId}`,
					);
				wanted = body.sequenceId ?? proposal.sequenceId ?? undefined;
				const known = new Set(proposal.items.map((it) => it.id));
				const missing = (body.itemIds ?? []).find((id) => !known.has(id));
				if (missing)
					throw new HttpError(404, 'NOT_FOUND', `No item ${missing} in proposal ${body.proposalId}`, {
						code: 'E_NOT_FOUND',
					});
			}
			let seq: ReturnType<typeof planSequence>;
			try {
				seq = planSequence(doc, wanted);
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
				title: body.proposalId ? 'Sound Check of a proposal' : 'Sound Check',
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
		guarded(async (req, reply) => {
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
			// stops when the client goes away: the RESPONSE's 'close' (the request stream's fires once its body is read,
			// before this handler's awaits end — the client leaving was never noticed; test/route-client-gone.test.ts)
			const signal = clientGoneSignal(reply);
			return soundVisual(doc, seq, body, {
				ff: core.ffmpeg,
				registry: core.registry,
				mgTemplates: mgRegistry,
				checkJob,
				signal,
				pixelCurves: (range) => motion.cachedCurves(doc, seq, range),
			});
		}),
	);

	// Ambience beds and room tone (spec 12 §4 P6-E12; sound-design/beds.ts): a read-only plan, or a job that proposes /
	// applies. The plan routes register the library sounds they measure for the project (as the plan job does).
	type BedBody = { projectId: string; sequenceId?: string | undefined };
	const bedRoute = (
		schema: typeof SoundBedsRequestSchema | typeof SoundRoomToneRequestSchema,
		kind: 'beds' | 'roomTone',
	) => ({
		plan: guarded(async (req, reply) => {
			const body = parseOr400(schema, req.body ?? {}) as BedBody;
			if (!isProjectId(body.projectId)) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Unknown project');
			const agent = agentOf();
			if (!agent) throw new HttpError(503, 'NOT_AVAILABLE', 'The sound design services are not running');
			if (!(await agent.projectExists(body.projectId)))
				throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project not found: ${body.projectId}`);
			const { doc } = await liveDocument(agent, body.projectId);
			const signal = clientGoneSignal(reply);
			try {
				const seq = planSequence(doc, body.sequenceId);
				const r =
					kind === 'beds'
						? await planBeds(bedDeps, doc, seq, body.projectId, body as never, { signal })
						: await planRoomTone(bedDeps, doc, seq, body.projectId, body as never, { signal });
				return r.plan;
			} catch (e) {
				if (e instanceof PlanInputError) throw new HttpError(404, e.code, e.message);
				if (e instanceof BedInputError) throw new HttpError(e.status, e.code, e.message);
				throw e;
			}
		}),
		job: guarded(async (req, reply) => {
			const body = parseOr400(schema, req.body ?? {}) as BedBody;
			if (!isProjectId(body.projectId)) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Unknown project');
			const agent = agentOf();
			if (!agent || !services.proposals)
				throw new HttpError(503, 'NOT_AVAILABLE', 'The sound design services are not running');
			if (!(await agent.projectExists(body.projectId)))
				throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project not found: ${body.projectId}`);
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
				title: kind === 'beds' ? 'Lay ambience beds' : 'Fill room tone',
				priority: 'user',
				cpuSlots: 1,
				origin: editor ? { type: 'user' } : { type: 'agent', agentRunId: who.agent },
				projectId: body.projectId,
				input: { [kind]: body, who },
				stage: 'Waiting',
			});
		}),
	});
	const beds = bedRoute(SoundBedsRequestSchema, 'beds');
	const roomTone = bedRoute(SoundRoomToneRequestSchema, 'roomTone');
	app.post('/api/sound-design/beds/plan', beds.plan);
	app.post('/api/sound-design/beds', beds.job);
	app.post('/api/sound-design/room-tone/plan', roomTone.plan);
	app.post('/api/sound-design/room-tone', roomTone.job);

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
