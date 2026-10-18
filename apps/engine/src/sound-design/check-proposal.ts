// Sound Check of a proposal before review (spec 12 §4 P6-E5; wp-note "Phase 6 → WP-E2"; earshot's "variants": critics
// test their fixes in a copy before one writer applies them — ours is the proposal). `POST /api/sound-design/check
// {…, proposalId, itemIds?}` runs the `sound-check` job on the proposal's preview document and compares it with the
// current document:
//
// 1. The proposal is re-validated on the live document (its stale / invalid items are recorded as such). The items
//    checked are the requested ones (default: every pending item) with what they require; a requested item that is
//    stale or invalid, or requires one, is skipped and listed, and so is one that fails in the preview.
// 2. The preview document is `previewProposal` with the session's per-item seeded ids (`<proposal>:<item>:<alternative>`):
//    every created entity is attributed to its item, the same ids every run (deterministic finding keys — and the very
//    ids the Review panel's ghosts have), and the result is checked against the invariants as Apply checks it.
//    Decision: not `composeAcceptTx`'s single transaction — it applies the same commands in the same order, but its
//    entities cannot be attributed to items and its fresh ids would change the keys of the findings it introduces.
// 3. The base: the sequence's kept report when it is current (mix and inputs hashes, the same delivery target and
//    range), else a fresh check of the live document (`base: 'run'`). Acknowledgements are applied to both from the
//    documents they describe.
// 4. The delta (`soundCheckDelta`) of the open findings: counts per code and severity before / after, the findings fixed
//    (present before, absent after) and introduced (absent before), each with the items whose changes they name.
//
// Nothing is committed: the revision is unchanged, `lastCheck` is not written and the kept report is not replaced.
// The summary is stored on the proposal (`report.check`, `ProposalService.setCheck`) for the Review panel and
// `get_proposal`.
import {
	type SoundCheckDelta,
	type SoundCheckDeltaFinding,
	type SoundCheckIssue,
	type SoundCheckProposal,
	type SoundCheckReport,
	type SoundCheckRequest,
	type SoundCheckResult,
	SOUND_CHECK_DELTA_MAX,
} from '@jasper/api';
import {
	applySoundAcknowledgements,
	createSeededIdSource,
	dependencyClosure,
	issueReason,
	mixFingerprint,
	type ProjectDocument,
	type Proposal,
	type ProposalGhost,
	type ProposalItem,
	previewProposal,
	readSoundCheckTarget,
	type SoundCheckCode,
	type SoundCheckSeverity,
	type SoundDelivery,
	sequenceDuration,
	soundCheckCounts,
	soundCheckInputsHash,
	soundDesignSettingsOf,
} from '@jasper/project';
import type { AgentService } from '../agent/service.ts';
import type { JobContext } from '../jobs/types.ts';
import { JobError } from '../jobs/types.ts';
import { HttpError } from '../tools/reply.ts';
import { checkEnvFor, checkSequence, type SoundCheckDeps } from './check.ts';
import { liveDocument, planSequence } from './plan.ts';

type Finding = Pick<
	SoundCheckIssue,
	'id' | 'code' | 'severity' | 'frame' | 'timecode' | 'message' | 'clipIds' | 'cueId'
>;

/** The entity ids an item's preview created, changed or deleted. */
export function touchedBy(ghost: ProposalGhost | undefined): Set<string> {
	return new Set(ghost ? [...ghost.created, ...ghost.changed, ...ghost.deleted] : []);
}

/**
 * What a proposal changes in the Sound Check (P6-E5): `before` = the open findings of the current document, `after` =
 * those of the proposal's preview; `items` = the checked items in proposal order with the entities each one's preview
 * touched. A finding is attributed to every item that touched one of its clips or its cue. Pure; deterministic (the
 * lists follow the reports' order).
 */
export function soundCheckDelta(
	before: readonly Finding[],
	after: readonly Finding[],
	items: readonly { itemId: string; touched: ReadonlySet<string> }[],
	verdict: SoundCheckDelta['verdict'],
): SoundCheckDelta {
	const keysBefore = new Set(before.map((f) => f.id));
	const keysAfter = new Set(after.map((f) => f.id));
	const row = (f: Finding): SoundCheckDeltaFinding => {
		const names = [...(f.clipIds ?? []), ...(f.cueId ? [f.cueId] : [])];
		const itemIds = items.filter((it) => names.some((n) => it.touched.has(n))).map((it) => it.itemId);
		return {
			key: f.id,
			code: f.code,
			severity: f.severity,
			...(f.frame !== undefined ? { frame: f.frame } : {}),
			...(f.timecode !== undefined ? { timecode: f.timecode } : {}),
			message: f.message,
			...(f.clipIds?.length ? { clipIds: [...f.clipIds] } : {}),
			...(f.cueId ? { cueId: f.cueId } : {}),
			itemId: itemIds[0] ?? null,
			itemIds,
		};
	};
	const fixed = before.filter((f) => !keysAfter.has(f.id)).map(row);
	const introduced = after.filter((f) => !keysBefore.has(f.id)).map(row);
	const cb = soundCheckCounts(before as { code: SoundCheckCode; severity: SoundCheckSeverity }[]);
	const ca = soundCheckCounts(after as { code: SoundCheckCode; severity: SoundCheckSeverity }[]);
	const counts: SoundCheckDelta['counts'] = {};
	for (const k of [...new Set([...Object.keys(cb), ...Object.keys(ca)])].sort())
		counts[k] = { before: cb[k] ?? 0, after: ca[k] ?? 0 };
	const perItem = items
		.map((it) => ({
			itemId: it.itemId,
			fixes: fixed.filter((f) => f.itemIds.includes(it.itemId)).map((f) => f.key),
			introduces: introduced.filter((f) => f.itemIds.includes(it.itemId)).map((f) => f.key),
		}))
		.filter((x) => x.fixes.length || x.introduces.length);
	return {
		verdict,
		counts,
		fixed: fixed.slice(0, SOUND_CHECK_DELTA_MAX),
		introduced: introduced.slice(0, SOUND_CHECK_DELTA_MAX),
		fixedCount: fixed.length,
		introducedCount: introduced.length,
		items: perItem,
	};
}

/** Whether a kept report describes `doc` as this check would measure it (target, range, mix, inputs). */
function keptIsCurrent(
	report: SoundCheckReport,
	doc: ProjectDocument,
	sequenceId: string,
	preset: SoundDelivery,
	target: { integratedLufs: number; truePeakDb: number } | undefined,
	range: { start: number; end: number },
	whole: boolean,
): boolean {
	if (report.sequenceId !== sequenceId || report.preset.id !== preset) return false;
	if (!!report.preset.custom !== !!target) return false;
	if (
		target &&
		(report.preset.integratedLufs !== target.integratedLufs || report.preset.truePeakDb !== target.truePeakDb)
	)
		return false;
	if (whole ? !report.wholeSequence : report.range.start !== range.start || report.range.end !== range.end)
		return false;
	if (report.mixHash !== mixFingerprint(doc, sequenceId)) return false;
	return report.inputsHash === soundCheckInputsHash(doc, sequenceId, preset, target ?? null);
}

const httpToJob = (e: unknown): never => {
	if (e instanceof HttpError) throw new JobError(e.code, e.message, e.status === 503, e.detail);
	throw e;
};

/** The `sound-check` job of a proposal (`request.proposalId`); see the module docs. */
export async function runProposalCheck(
	ctx: JobContext,
	deps: SoundCheckDeps,
	req: SoundCheckRequest,
	agent: AgentService,
): Promise<SoundCheckResult> {
	const proposals = deps.proposals?.();
	if (!proposals) throw new JobError('NOT_AVAILABLE', 'The proposal service is not running', true);
	const proposalId = req.proposalId!;
	ctx.progress(0.01, { stage: 'Reading the proposal' });
	const { proposal } = (await proposals
		.get(req.projectId, proposalId, { revalidate: true })
		.catch(httpToJob)) as { proposal: Proposal };
	const live = await liveDocument(agent, req.projectId);
	if (req.sequenceId && proposal.sequenceId && req.sequenceId !== proposal.sequenceId)
		throw new JobError(
			'VALIDATION_FAILED',
			`The proposal is about sequence ${proposal.sequenceId}, not ${req.sequenceId}`,
			false,
		);
	const seq = planSequence(live.doc, proposal.sequenceId ?? req.sequenceId);
	const byId = new Map(proposal.items.map((it) => [it.id, it]));
	const unknown = (req.itemIds ?? []).filter((id) => !byId.has(id));
	if (unknown.length)
		throw new JobError('NOT_FOUND', `No item ${unknown[0]} in proposal ${proposalId}`, false, {
			code: 'E_NOT_FOUND',
		});
	const requested = req.itemIds
		? [...new Set(req.itemIds)]
		: proposal.items.filter((it) => it.state === 'pending').map((it) => it.id);
	// stale / invalid items (and what requires them) are skipped; accepted ones are in the document already
	const skipped: SoundCheckProposal['skipped'] = [];
	const checked: string[] = [];
	for (const id of requested) {
		const it = byId.get(id)!;
		if (it.state === 'accepted') {
			skipped.push({ itemId: id, state: it.state, reason: 'Accepted already: it is in the document' });
			continue;
		}
		const bad = dependencyClosure(proposal, [id], (x: ProposalItem) => x.state === 'accepted').find(
			(x) => x.state === 'stale' || x.state === 'invalid',
		);
		if (bad) {
			skipped.push({
				itemId: id,
				state: bad.id === id ? bad.state : `requires ${bad.state}`,
				reason: bad.id === id ? (bad.reason ?? bad.state) : `It requires ${bad.id}: ${bad.reason ?? bad.state}`,
			});
			continue;
		}
		checked.push(id);
	}
	ctx.progress(0.03, { stage: 'Previewing the proposal' });
	const preview = previewProposal(
		live.doc,
		proposal,
		checked,
		{
			registries: deps.registries,
			revision: live.revision,
			now: () => new Date().toISOString(),
			invariants: 'incremental',
		},
		{
			idsFor: (it) => createSeededIdSource(`${proposal.id}:${it.id}:${it.selectedAlternative ?? 0}`),
		},
	);
	for (const [id, errors] of Object.entries(preview.failed))
		if (checked.includes(id) || preview.applied.includes(id) || byId.has(id))
			skipped.push({ itemId: id, state: 'failed', reason: issueReason(errors) });
	const applied = preview.applied.filter((id) => !Object.hasOwn(preview.failed, id));
	const previewSeq = preview.document.sequences[seq.id];
	if (!previewSeq) throw new JobError('VALIDATION_FAILED', 'The proposal removes the sequence it is about', false);

	const preset = (req.preset ?? soundDesignSettingsOf(seq).delivery) as SoundDelivery;
	const target = req.target ? (readSoundCheckTarget(req.target) ?? undefined) : undefined;
	const duration = Math.max(0, Math.ceil(sequenceDuration(seq)));
	const range = req.range
		? { start: Math.min(req.range.start, duration), end: Math.min(req.range.end, duration) }
		: { start: 0, end: duration };
	const whole = !req.range || (range.start === 0 && range.end >= duration);
	const opts = { projectId: req.projectId, revision: live.revision, preset, target, range: req.range };

	// the base: the kept report when it is current, else a fresh check of the live document
	let base: SoundCheckReport | null = null;
	let baseKind: 'kept' | 'run' = 'kept';
	let baseJobId: string | null = null;
	const kept = await deps.keptReport?.(req.projectId, seq.id).catch(() => null);
	if (kept && keptIsCurrent(kept.result.report, live.doc, seq.id, preset, target, range, whole)) {
		base = kept.result.report;
		baseJobId = kept.jobId;
	}
	if (!base) {
		baseKind = 'run';
		baseJobId = ctx.job.id;
		base = await checkSequence(
			live.doc,
			seq,
			opts,
			await checkEnvFor(ctx, deps, (f, stage) => ctx.progress(0.05 + 0.45 * f, { stage: `Current: ${stage}` })),
		);
	}
	if (ctx.signal.aborted) throw new JobError('CANCELLED', 'Cancelled', false);
	const after = await checkSequence(
		preview.document,
		previewSeq,
		opts,
		await checkEnvFor(ctx, deps, (f, stage) =>
			ctx.progress((baseKind === 'run' ? 0.5 : 0.05) + (baseKind === 'run' ? 0.45 : 0.9) * f, {
				stage: `Proposal: ${stage}`,
			}),
		),
	);
	if (ctx.signal.aborted) throw new JobError('CANCELLED', 'Cancelled', false);
	const beforeAcks = applySoundAcknowledgements(live.doc, seq.id, base.issues);
	const items = applied.map((id) => ({ itemId: id, touched: touchedBy(preview.items[id]) }));
	const delta = soundCheckDelta(beforeAcks.open as Finding[], after.issues.filter((i) => !i.acknowledged?.active), items, {
		before: beforeAcks.verdict,
		after: after.verdict,
	});
	const part: SoundCheckProposal = {
		proposalId,
		itemIds: applied,
		skipped,
		base: baseKind,
		baseJobId,
		revision: live.revision,
		baseMixHash: mixFingerprint(live.doc, seq.id),
		delta,
	};
	ctx.progress(0.97, { stage: 'Storing the result on the proposal' });
	await proposals
		.setCheck(req.projectId, proposalId, {
			...part,
			jobId: ctx.job.id,
			at: new Date().toISOString(),
			sequenceId: seq.id,
		})
		.catch(httpToJob);
	ctx.log(
		`proposal check ${proposalId}: ${delta.verdict.before} → ${delta.verdict.after}, fixes ${delta.fixedCount}, introduces ${delta.introducedCount} (${baseKind})`,
	);
	ctx.progress(1, {
		stage: `Proposal: fixes ${delta.fixedCount} · introduces ${delta.introducedCount}`,
	});
	return {
		projectId: req.projectId,
		sequenceId: seq.id,
		stored: false,
		revision: live.revision,
		report: after,
		proposal: part,
	};
}
