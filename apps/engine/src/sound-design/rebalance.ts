// Rebalance SFX levels (spec 12 §2.4, §2.10 `rebalance_sfx`, P4-R2; wp-note "Phase 4 → WP4.1b"): the sound effects of a
// sequence (or the ones asked for) are measured against the bed (`bed.ts`) and solved by the masking solver; the
// report says per clip its gain, target and achieved lift, what limited it and why. `mode: 'apply'` commits every
// change as ONE undoable transaction "Rebalance SFX Levels" (`soundDesign.applyGains`); `mode: 'propose'` (the default)
// stores a proposal with one item per changed clip for the user to review.
//
// Which clips: every sound effect (`isSfxClip`) of the sequence overlapping `range`, or `clipIds` (explicit ids must be
// sound effects). A clip on a locked track is skipped (LOCKED); a gain the user set by hand is kept (USER_GAIN) unless
// `userGains: 'replace'` or the clip is named; a clip the mix does not play is NOT_IN_MIX / OFFLINE.
import type {
	SfxLevelConflict,
	SfxRebalanceEvent,
	SfxRebalanceReport,
	SfxRebalanceRequest,
	SfxRebalanceResult,
} from '@jasper/api';
import { SFX_REBALANCE_LIMITS, SfxRebalanceRequestSchema } from '@jasper/api';
import {
	flicksPerFrame,
	isSfxClip,
	type ProjectDocument,
	type ProposalDraft,
	type Rational,
	readClipSfx,
	type Sequence,
	SOUND_DESIGN_FEATURE,
	type SoundDelivery,
	sequenceTimecode,
	soundDesignSettingsOf,
} from '@jasper/project';
import type { AgentService } from '../agent/service.ts';
import type { JobContext } from '../jobs/types.ts';
import { JobError } from '../jobs/types.ts';
import type { MediaRegistry } from '../media/registry.ts';
import type { ProposalService, Requester } from '../proposals/service.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { HttpError } from '../tools/reply.ts';
import { applyMeasuredMix } from './apply-guard.ts';
import { type MeasureCache, measureSfxEvents } from './bed.ts';
import {
	conflictsOf,
	fmtDb,
	gainReport,
	levelOptions,
	type SfxInfo,
	sfxInfoOf,
	solveAt,
	solvedLevel,
	solverEventOf,
} from './levels.ts';
import { liveDocument, PlanInputError, planSequence } from './plan.ts';

export const REBALANCE_LABEL = 'Rebalance SFX Levels';
/** Gains closer than this (dB) count as unchanged. */
const SAME_DB = 0.005;
/** A proposal report larger than this keeps the first events only (the proposal's report must stay under 1 MB). */
const REPORT_SOFT_BYTES = 900 * 1024;

type Skip = SfxRebalanceReport['skipped'][number];

export class RebalanceInputError extends Error {
	constructor(
		readonly status: 400 | 404,
		readonly code: 'CLIP_NOT_FOUND' | 'NOT_SFX',
		message: string,
	) {
		super(message);
	}
}

/**
 * The clips a rebalance solves, and the ones it leaves out with why. Throws `RebalanceInputError` for explicit ids that
 * are not clips of the sequence or not sound effects. Pure.
 */
export function rebalanceTargets(
	doc: ProjectDocument,
	seq: Sequence,
	req: Pick<SfxRebalanceRequest, 'clipIds' | 'range' | 'userGains' | 'delivery'>,
): { targets: SfxInfo[]; skipped: Skip[]; delivery: SoundDelivery } {
	const delivery = req.delivery ?? soundDesignSettingsOf(seq).delivery;
	const explicit = req.clipIds ? [...new Set(req.clipIds)] : null;
	if (explicit) {
		const unknown = explicit.filter((id) => !Object.hasOwn(seq.clips, id));
		if (unknown.length)
			throw new RebalanceInputError(
				404,
				'CLIP_NOT_FOUND',
				`Not clips of the sequence: ${unknown.slice(0, 5).join(', ')}`,
			);
		const notSfx = explicit.filter((id) => !isSfxClip(seq.clips[id]));
		if (notSfx.length)
			throw new RebalanceInputError(
				400,
				'NOT_SFX',
				`Not sound effects (Essential Sound type SFX, or placed sounds): ${notSfx.slice(0, 5).join(', ')}`,
			);
	}
	const ids = explicit ?? Object.keys(seq.clips).filter((id) => isSfxClip(seq.clips[id]));
	const range = req.range ?? null;
	const locked = new Set(seq.audioTracks.filter((t) => t.locked).map((t) => t.id));
	const targets: SfxInfo[] = [];
	const skipped: Skip[] = [];
	const ordered = ids
		.map((id) => seq.clips[id]!)
		.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	for (const c of ordered) {
		if (range && !(c.start < range.end && c.start + c.duration > range.start)) continue;
		const info = sfxInfoOf(doc, seq, c.id, delivery);
		if (!info) continue;
		if (locked.has(c.trackId)) {
			skipped.push({ clipId: c.id, code: 'LOCKED', reason: 'its track is locked' });
			continue;
		}
		if (info.owner === 'user' && !explicit && req.userGains !== 'replace') {
			skipped.push({
				clipId: c.id,
				code: 'USER_GAIN',
				reason: `its gain (${fmtDb(info.gainDb)} dB) was set by hand: kept (userGains "replace" or naming the clip solves it)`,
			});
			continue;
		}
		if (targets.length >= SFX_REBALANCE_LIMITS.maxEvents) {
			skipped.push({
				clipId: c.id,
				code: 'LIMIT',
				reason: `over ${SFX_REBALANCE_LIMITS.maxEvents} clips: rebalance a range`,
			});
			continue;
		}
		targets.push(info);
	}
	return { targets, skipped, delivery };
}

/** Where a sound effect plays: its aligned point (peak / start / end on its cue), else its first frame. */
function eventFrame(seq: Sequence, clipId: string): number {
	const c = seq.clips[clipId] as {
		start: number;
		sourceIn: number;
		speed?: { rate?: number };
		sfx?: unknown;
	};
	const sfx = c.sfx !== undefined ? readClipSfx(c.sfx) : null;
	const F = flicksPerFrame(seq.settings.frameRate as Rational);
	if (!sfx?.placement || !(F > 0)) return c.start;
	const f =
		c.start +
		((sfx.placement.peakFlicks - c.sourceIn) / (c.speed?.rate || 1) - sfx.placement.errorFlicks) / F;
	return Number.isFinite(f) ? Math.max(0, Math.round(f)) : c.start;
}

const trackLabel = (seq: Sequence, trackId: string) => {
	const i = seq.audioTracks.findIndex((t) => t.id === trackId);
	return i >= 0 ? `A${i + 1}` : trackId;
};

export type RebalanceDeps = {
	agent: () => AgentService | undefined;
	proposals: () => ProposalService | undefined;
	ffmpeg: Ffmpeg;
	registry: Pick<MediaRegistry, 'get' | 'resolvePath'>;
	cache?: MeasureCache;
};

/** The job input (the route validated it; a journaled input is checked again). */
export type RebalanceJobInput = { rebalance: SfxRebalanceRequest; who: Requester };

function parseInput(raw: unknown): RebalanceJobInput {
	const r = raw as { rebalance?: unknown; who?: { editor?: unknown; agent?: unknown } } | null;
	const parsed = SfxRebalanceRequestSchema.safeParse(r?.rebalance);
	if (!parsed.success) throw new JobError('VALIDATION_FAILED', 'The rebalance request is invalid', false);
	return {
		rebalance: parsed.data,
		who: {
			editor: r?.who?.editor === true,
			agent: typeof r?.who?.agent === 'string' ? r.who.agent.slice(0, 64) : 'An agent',
		},
	};
}

/** The `sound-design` job runner for rebalance requests. */
export async function runRebalance(ctx: JobContext, deps: RebalanceDeps): Promise<SfxRebalanceResult> {
	try {
		return await rebalance(ctx, deps);
	} catch (e) {
		if (e instanceof HttpError)
			throw new JobError(e.code, e.message, e.status === 503 || e.code === 'PROPOSAL_LIMIT', e.detail);
		if (e instanceof PlanInputError) throw new JobError(e.code, e.message, false);
		if (e instanceof RebalanceInputError) throw new JobError(e.code, e.message, false);
		throw e;
	}
}

async function rebalance(ctx: JobContext, deps: RebalanceDeps): Promise<SfxRebalanceResult> {
	const t0 = Date.now();
	const { rebalance: req, who } = parseInput(ctx.input);
	const agent = deps.agent();
	if (!agent) throw new JobError('NOT_AVAILABLE', 'The agent service is not running', true);
	const mode = req.mode ?? 'propose';
	ctx.progress(0.02, { stage: 'Reading the edit' });
	const live = await liveDocument(agent, req.projectId);
	const doc = live.doc;
	const seq = planSequence(doc, req.sequenceId);
	const picked = rebalanceTargets(doc, seq, req);
	const { delivery } = picked;
	const opts = levelOptions(delivery);
	const skipped = [...picked.skipped];
	ctx.progress(0.05, { stage: `Measuring ${picked.targets.length} sound effects against the bed` });
	const measured = await measureSfxEvents(
		{
			bedDoc: doc,
			sequenceId: seq.id,
			targets: picked.targets.map((t) => ({ doc, clipId: t.clipId, weight: t.weight })),
		},
		{
			ff: deps.ffmpeg,
			registry: deps.registry,
			signal: ctx.signal,
			onSpawn: ctx.trackChild,
			...(deps.cache ? { cache: deps.cache } : {}),
			onProgress: (f, stage) => ctx.progress(0.05 + 0.8 * f, { stage }),
		},
	);
	for (const m of measured.missing)
		skipped.push({
			clipId: m.clipId,
			code: /offline/.test(m.reason) ? 'OFFLINE' : 'NOT_IN_MIX',
			reason: m.reason,
		});
	const solvable = picked.targets.filter((t) => measured.sounds.has(t.clipId));
	const solved = solveAt(
		solvable.map((t) => solverEventOf(t, measured.sounds.get(t.clipId)!)),
		delivery,
	);
	const events: SfxRebalanceEvent[] = [];
	const conflicts: SfxLevelConflict[] = [];
	solved.events.forEach((r, i) => {
		const info = solvable[i]!;
		const m = measured.sounds.get(info.clipId)!;
		const level = solvedLevel(r, m, opts.truePeakCeilingDb);
		const frame = eventFrame(seq, info.clipId);
		events.push({
			...level,
			clipId: info.clipId,
			itemId: null,
			title: info.title,
			soundId: info.librarySoundId,
			track: trackLabel(seq, info.trackId),
			frame,
			timecode: sequenceTimecode(seq, frame),
			role: info.role,
			weight: info.weight,
			fromDb: info.gainDb,
			owner: info.owner,
			changeDb: Math.round((r.gainDb - info.gainDb) * 100) / 100,
		});
		conflicts.push(...conflictsOf(r));
	});
	const changes = events.filter((e, i) => {
		const info = solvable[i]!;
		return Math.abs(e.gainDb - e.fromDb) >= SAME_DB || info.owner !== 'solver';
	});
	const measure = {
		delivery,
		programLufs: opts.programLufs,
		truePeakCeilingDb: opts.truePeakCeilingDb,
		clusters: measured.clusters.length,
		clusterSeconds: Math.round(measured.clusters.reduce((n, c) => n + (c.end - c.start), 0) * 1000) / 1000,
		renders: measured.renders,
		ms: Date.now() - t0,
	};
	const report: SfxRebalanceReport = {
		version: 1,
		sequenceId: seq.id,
		events,
		skipped,
		conflicts,
		warnings: solved.warnings
			.filter((w) => w.code !== 'W_CONFLICT')
			.map((w) => ({ code: w.code, message: w.message, ...(w.clipId ? { clipId: w.clipId } : {}) })),
		counts: {
			clips: picked.targets.length + picked.skipped.length,
			solved: events.length,
			changed: events.filter((e) => Math.abs(e.gainDb - e.fromDb) >= SAME_DB).length,
			limited: events.filter((e) => e.limitedBy.length > 0).length,
			skipped: skipped.length,
		},
		levels: measure,
	};
	if (ctx.signal.aborted) throw new JobError('CANCELLED', 'Cancelled', false);
	const base = { projectId: req.projectId, sequenceId: seq.id, mode } as const;
	if (changes.length === 0) {
		ctx.progress(1, { stage: 'Nothing to change' });
		return { ...base, applied: false, revision: live.revision, proposalId: null, report };
	}
	const command = (list: SfxRebalanceEvent[]) => ({
		type: 'soundDesign.applyGains',
		sequenceId: seq.id,
		gains: Object.fromEntries(list.map((e) => [e.clipId, e.gainDb])),
		report: Object.fromEntries(list.map((e) => [e.clipId, gainReport(e)])),
	});
	if (mode === 'apply') {
		ctx.progress(0.9, { stage: 'Applying' });
		const revision = await applyMeasuredMix(agent, {
			projectId: req.projectId,
			sequenceId: seq.id,
			measured: doc,
			label: REBALANCE_LABEL,
			agentName: who.agent,
			editor: who.editor,
			commands: [command(changes)],
			what: 'The gains were not applied',
		});
		ctx.progress(1, { stage: 'Applied' });
		return { ...base, applied: true, revision, proposalId: null, report };
	}
	const proposals = deps.proposals();
	if (!proposals) throw new JobError('NOT_AVAILABLE', 'The proposal service is not running', true);
	const width = Math.max(3, String(changes.length).length);
	changes.forEach((e, i) => {
		e.itemId = `gain:${String(i + 1).padStart(width, '0')}`;
	});
	// each conflict names the item that carries its clip's gain (a clip whose gain does not change has none)
	const itemOf = new Map(changes.map((e) => [e.clipId, e.itemId!]));
	for (const c of conflicts) {
		const itemId = itemOf.get(c.clipId);
		if (itemId) c.itemId = itemId;
	}
	const name = Object.values(doc.items ?? {}).find(
		(it) => it?.kind === 'sequence' && (it as { sequenceId?: unknown }).sequenceId === seq.id,
	)?.name;
	let stored: SfxRebalanceReport = report;
	if (JSON.stringify(report).length > REPORT_SOFT_BYTES) {
		const keep = Math.max(
			1,
			Math.floor((report.events.length * REPORT_SOFT_BYTES) / JSON.stringify(report).length),
		);
		stored = {
			...report,
			events: report.events.slice(0, keep),
			warnings: [
				...report.warnings,
				{
					code: 'W_REPORT_TRIMMED',
					message: `The first ${keep} of ${report.events.length} events are listed`,
				},
			],
		};
	}
	const draft: ProposalDraft = {
		sequenceId: seq.id,
		feature: SOUND_DESIGN_FEATURE,
		title: (req.label ?? `${REBALANCE_LABEL}: ${typeof name === 'string' && name ? name : seq.id}`).slice(
			0,
			200,
		),
		summary:
			`${changes.length} sound effect${changes.length === 1 ? '' : 's'} rebalanced against the bed · ` +
			`${report.counts.limited} limited · ${delivery}`,
		items: changes.map((e) => ({
			id: e.itemId!,
			label: `${e.title} ${fmtDb(e.fromDb)} → ${fmtDb(e.gainDb)} dB · ${e.timecode}`.slice(0, 200),
			group: e.weight,
			commands: [command([e])],
			meta: {
				feature: SOUND_DESIGN_FEATURE,
				kind: 'gain',
				clipId: e.clipId,
				frame: e.frame,
				timecode: e.timecode,
				track: e.track,
				fromDb: e.fromDb,
				gainDb: e.gainDb,
				targetLiftDb: e.targetLiftDb,
				achievedLiftDb: e.achievedLiftDb,
				limitedBy: e.limitedBy,
				why: `${e.title} at ${e.timecode}: ${e.reason}`.slice(0, 1000),
			},
		})),
		report: stored,
	};
	ctx.progress(0.9, { stage: `Checking ${changes.length} proposal items` });
	const created = await proposals.create(req.projectId, draft as unknown as Record<string, unknown>, who);
	if (ctx.signal.aborted) {
		await proposals.delete(req.projectId, created.proposal.id).catch(() => undefined);
		throw new JobError('CANCELLED', 'Cancelled', false);
	}
	ctx.progress(1, { stage: 'Proposal ready for review' });
	return { ...base, applied: false, revision: created.revision, proposalId: created.proposal.id, report };
}
