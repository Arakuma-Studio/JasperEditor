// What the Sound Check panel does (spec 12 §2.6 / §2.7 "Sound Check panel", P5-R3; wp-note "Phase 5 → WP5.2"), shared
// by the panel, Sequence ▸ Sound Design ▸ Run Sound Check and the Export dialog's "Run Sound Check before export":
//
// - Run: the engine's `sound-check` job (`POST /api/sound-design/check`, `store: true`) against the chosen delivery
//   target. The editor's request carries the editor key, so the engine writes the summary into the sequence as the
//   user's own edit ("Sound Check Result", one undo step, WP5.1). The job shows in the Jobs panel; its progress and
//   stage show in the panel (aria-live), and it can be cancelled.
// - The last report per session (and sequence) lives in a store; a reopened project gets it back from the stored
//   summary's job while the engine keeps that job, else from the report the engine keeps per sequence across restarts.
// - Fix: a finding's fix as the engine described it — commands as ONE transaction (`session.apply`, the user's edit),
//   a sound swap through the panel's swap path (register the library sound → `media.register` → `soundDesign.swap`,
//   what the Sound Library's Swap does, also for "the same sound again"), an engine job (rebalance / delivery: the
//   user's edit too). Fix all safe: the safe fixes judged together on the current document (`planSoundCheckFixes`:
//   applied in sequence on a dry run, each re-validated after the ones before it — a fix that is no longer safe is left
//   for the next check, with why), the accepted command fixes and swaps in ONE transaction, then the accepted engine
//   jobs one after another, then the check runs again. A fix that is not safe — or no longer safe on the current
//   document — asks first, naming what it will change (`fixConfirmation`).
// - Jump: a finding's or listen-here moment's timecode → the playhead, the clips / cue selected, the Timeline scrolled.
// - Listen here: ▶ plays 4 s around the moment through the Program transport (`playTimelineWindow`), Play all chains
//   the rows (the next one starts when a window plays to its end; a key or click stops the chain), and a verdict is a
//   user `comment` marker bound to the moment (`verdictCommands` → `soundDesign.setVerdict`); Play all keeps playing
//   while the verdict buttons and the note field are used.
import {
	type EngineJob,
	type SoundCheckIssue,
	type SoundCheckResult,
	SoundCheckResultSchema,
} from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	type Command,
	defaultRegistries,
	planSoundCheckFixes,
	type SoundCheckFixCandidate,
	type SoundCheckLevelGuard,
	type Sequence,
	sequenceDuration,
	soundCheckFixTargets,
	soundCheckStatus,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { confirmDialog } from '@jasper/ui';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { t } from '../i18n/runtime.ts';
import {
	choiceRequest,
	type DeliveryChoice,
	defaultChoice,
	type FixPlan,
	type FixUnit,
	fixChangeSummary,
	fixWhyText,
	hasSyncStrip,
	issueFrame,
	type ListenRow,
	messageText,
	orderedIssues,
	planFixes,
	safeFixable,
	verdictCommands,
	verdictSentence,
} from './check-model.ts';
import { playTimelineWindow, stopInContext } from './in-context.ts';
import { registerLibrarySounds, soundMediaCommands } from './library-media.ts';
import { runDelivery, runRebalance, runSoundJob, SoundJobError } from './mix-jobs.ts';

export type CheckEngine = Pick<
	EngineClient,
	'soundCheck' | 'getJob' | 'cancelJob' | 'registerSound' | 'rebalanceSfx' | 'applyDelivery'
> &
	Partial<Pick<EngineClient, 'lastSoundCheck'>>;

export type SoundCheckState = {
	/** The report shown (the last run in this window, or the stored summary's job), with its sequence. */
	result: SoundCheckResult | null;
	/** The job of `result`. */
	jobId: string | null;
	/** A run in progress. */
	running: { sequenceId: string; jobId: string | null; progress: number | null; stage: string | null } | null;
	error: string | null;
	/** Fixing: an issue id, or 'all'. */
	fixing: string | null;
	/** Issues fixed since the report (until the next run): "Fixed — run again to confirm". */
	fixed: readonly string[];
	/** The delivery target chosen per sequence (absent: `defaultChoice`). */
	choice: Readonly<Record<string, DeliveryChoice>>;
	/** Play all: the listen row playing (its index), or null. */
	playing: { sequenceId: string; index: number; all: boolean } | null;
	/** The last thing done, for screen readers (aria-live), with a counter so the same text is announced again. */
	announcement: { message: string; n: number };
	/** The findings list's current row (an issue id) and the rows whose sync strip is open (keyboard commands). */
	cursor: string | null;
	openStrips: readonly string[];
};

const stores = new WeakMap<EditorSession, StoreApi<SoundCheckState>>();
const aborts = new WeakMap<EditorSession, AbortController>();

/** The Sound Check state of a session (created on first use). */
export function soundCheckStore(session: EditorSession): StoreApi<SoundCheckState> {
	let s = stores.get(session);
	if (!s) {
		s = createStore<SoundCheckState>(() => ({
			result: null,
			jobId: null,
			running: null,
			error: null,
			fixing: null,
			fixed: [],
			choice: {},
			playing: null,
			announcement: { message: '', n: 0 },
			cursor: null,
			openStrips: [],
		}));
		stores.set(session, s);
	}
	return s;
}

function announce(session: EditorSession, message: string): void {
	soundCheckStore(session).setState((s) => ({ announcement: { message, n: s.announcement.n + 1 } }));
}

function seqOf(session: EditorSession, sequenceId?: string | null): Sequence | undefined {
	const doc = session.getCommitted();
	const id = sequenceId ?? session.getState().activeSequenceId;
	return id ? (doc.sequences[id] as Sequence | undefined) : undefined;
}

/** The delivery target of a sequence: the user's choice in this window, else the default. */
export function choiceOf(session: EditorSession, sequenceId: string): DeliveryChoice {
	return soundCheckStore(session).getState().choice[sequenceId] ?? defaultChoice(seqOf(session, sequenceId));
}

export function setChoice(session: EditorSession, sequenceId: string, choice: DeliveryChoice): void {
	soundCheckStore(session).setState((s) => ({ choice: { ...s.choice, [sequenceId]: choice } }));
}

/** The report of a sequence, when the store has one for it. */
export function reportFor(session: EditorSession, sequenceId: string | null): SoundCheckResult | null {
	const r = soundCheckStore(session).getState().result;
	return r && sequenceId && r.sequenceId === sequenceId ? r : null;
}

export type RunOutcome =
	| { ok: true; result: SoundCheckResult }
	| { ok: false; code: string; message: string; cancelled?: boolean };

/**
 * Runs the Sound Check of a sequence (the active one by default) against its chosen target and stores the summary.
 * A run already going for the session is cancelled first. Never rejects.
 */
export async function runSoundCheck(
	session: EditorSession,
	engine: CheckEngine,
	opts: { sequenceId?: string; choice?: DeliveryChoice; sleep?(ms: number): Promise<void> } = {},
): Promise<RunOutcome> {
	const store = soundCheckStore(session);
	const seq = seqOf(session, opts.sequenceId);
	if (!seq) return { ok: false, code: 'E_NO_SEQUENCE', message: t('Open a sequence first') };
	aborts.get(session)?.abort();
	const ac = new AbortController();
	aborts.set(session, ac);
	// cancel the engine job at once (a poll in flight would otherwise finish it first)
	ac.signal.addEventListener('abort', () => {
		const id = store.getState().running?.jobId;
		if (id) void engine.cancelJob(id).catch(() => undefined);
	});
	const choice = opts.choice ?? choiceOf(session, seq.id);
	if (opts.choice) setChoice(session, seq.id, opts.choice);
	const req = choiceRequest(choice, seq);
	stopPlaying(session);
	store.setState({
		running: { sequenceId: seq.id, jobId: null, progress: null, stage: t('Starting') },
		error: null,
	});
	announce(session, t('Sound Check running'));
	try {
		const result = await runSoundJob(
			engine,
			(signal) =>
				engine.soundCheck(
					{
						projectId: session.projectId,
						sequenceId: seq.id,
						preset: req.preset,
						...(req.target ? { target: req.target } : {}),
						store: !session.getState().readOnly,
					},
					signal,
				),
			SoundCheckResultSchema,
			{
				signal: ac.signal,
				failure: t('The Sound Check failed'),
				onJob: (j: EngineJob) =>
					store.setState((s) =>
						s.running
							? {
									running: {
										sequenceId: seq.id,
										jobId: j.id,
										progress: typeof j.progress === 'number' ? j.progress : null,
										stage: j.stage ?? null,
									},
								}
							: {},
					),
				...(opts.sleep ? { sleep: opts.sleep } : {}),
			},
		);
		if (aborts.get(session) === ac) aborts.delete(session);
		if (ac.signal.aborted) throw new SoundJobError('E_CANCELLED', t('Cancelled'));
		const jobId = store.getState().running?.jobId ?? null;
		store.setState({ result, jobId, running: null, error: null, fixed: [] });
		announce(session, verdictSentence(result.report.verdict, result.report.counts));
		return { ok: true, result };
	} catch (e) {
		if (aborts.get(session) === ac) aborts.delete(session);
		const err = e instanceof SoundJobError ? e : new SoundJobError('E_ENGINE', String(e));
		const cancelled = err.code === 'E_CANCELLED' || ac.signal.aborted;
		// a newer run replaced this one: it owns the state
		if (ac.signal.aborted && aborts.get(session))
			return { ok: false, code: err.code, message: err.message, cancelled };
		store.setState({ running: null, error: cancelled ? null : err.message });
		announce(session, cancelled ? t('Sound Check cancelled') : t('Sound Check failed: {0}', err.message));
		return { ok: false, code: err.code, message: err.message, cancelled };
	}
}

/** Cancels the run in progress (the job is cancelled too). */
export function cancelSoundCheck(session: EditorSession): void {
	aborts.get(session)?.abort();
}

/**
 * Loads the last report of a sequence when the store has none for it: the stored summary's job while the engine keeps
 * it, else the report the engine kept for the sequence (`POST /api/sound-design/check/last`, across engine restarts;
 * the panel marks it stale by its own hashes). Resolves whether it did. Never rejects.
 */
export async function loadStoredReport(
	session: EditorSession,
	engine: Pick<EngineClient, 'getJob'> & Partial<Pick<EngineClient, 'lastSoundCheck'>>,
	sequenceId: string,
): Promise<boolean> {
	const store = soundCheckStore(session);
	if (reportFor(session, sequenceId) || store.getState().running) return false;
	const status = soundCheckStatus(session.getCommitted(), sequenceId);
	const jobId = status.summary?.jobId;
	const take = (result: SoundCheckResult, id: string | null): boolean => {
		if (result.sequenceId !== sequenceId || reportFor(session, sequenceId) || store.getState().running)
			return false;
		store.setState({ result, jobId: id, fixed: [] });
		return true;
	};
	if (jobId) {
		try {
			const job = (await engine.getJob(jobId)) as EngineJob;
			const parsed = job.state === 'succeeded' ? SoundCheckResultSchema.safeParse(job.result) : null;
			if (parsed?.success) return take(parsed.data, jobId);
		} catch {
			// the job is gone (engine restarted): the kept report below
		}
	}
	if (!engine.lastSoundCheck) return false;
	try {
		const kept = await engine.lastSoundCheck({ projectId: session.projectId, sequenceId });
		const parsed = SoundCheckResultSchema.safeParse((kept as { result?: unknown }).result);
		if (!parsed.success) return false;
		const keptJob =
			typeof (kept as { jobId?: unknown }).jobId === 'string' ? (kept as { jobId: string }).jobId : null;
		return take(parsed.data, keptJob);
	} catch {
		return false; // none kept (or the engine is away): the summary chips stay, Run gets the details
	}
}

// ── fixes ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export type FixOutcome = {
	ok: boolean;
	message: string;
	applied: string[];
	failed: string[];
	/** Safe fixes left for the next check: not safe with the ones applied before them (Fix all safe). */
	skipped?: string[];
};

/** The candidate `planSoundCheckFixes` judges for a fix unit (a swap's commands once its sound is registered). */
function candidateOf(
	unit: FixUnit,
	issues: readonly SoundCheckIssue[],
	swapCommand?: Command,
): SoundCheckFixCandidate {
	const targets = unit.issueIds.flatMap((id) => {
		const i = issues.find((x) => x.id === id);
		return i ? soundCheckFixTargets(i) : [];
	});
	const base = { issueIds: [...unit.issueIds], ...(targets.length ? { targets } : {}) };
	if (unit.kind === 'commands') return { ...base, kind: 'commands', commands: unit.commands as never };
	if (unit.kind === 'swap')
		return {
			...base,
			kind: 'swap',
			commands: swapCommand ? [swapCommand as never] : null,
			swap: { clipId: unit.clipId, soundId: unit.soundId },
		};
	return { ...base, kind: 'job', commands: null, job: { route: unit.job.route } };
}

const guardOf = (result: SoundCheckResult): SoundCheckLevelGuard | null =>
	(result.report.levelGuard as SoundCheckLevelGuard | undefined) ?? null;
const registriesOf = (session: EditorSession) => session.ctx.registries ?? defaultRegistries();

/** The commands of the plan's swaps (register the sounds first) — `null` refs when there are none. */
async function swapCommands(
	session: EditorSession,
	engine: Pick<EngineClient, 'registerSound'>,
	sequenceId: string,
	swaps: FixPlan['swaps'],
): Promise<Command[]> {
	if (!swaps.length) return [];
	const sounds = await registerLibrarySounds(
		engine,
		session.projectId,
		swaps.map((s) => ({ id: s.soundId })),
	);
	const doc = session.getCommitted();
	const seq = doc.sequences[sequenceId];
	const prepared = soundMediaCommands(session, doc, sounds, { refPrefix: '$chk' });
	return [
		...prepared.commands,
		...swaps
			.filter((s) => seq?.clips[s.clipId])
			.map(
				(s) =>
					({
						type: 'soundDesign.swap',
						clipId: s.clipId,
						mediaId: prepared.media.get(s.soundId)!.ref,
					}) as Command,
			),
	];
}

function applyTx(session: EditorSession, sequenceId: string, label: string, commands: Command[]) {
	return session.apply({ label, origin: 'user', sequenceId, commands });
}

const errorsText = (r: { ok: boolean; errors?: { message: string }[] }) =>
	!r.ok ? (r.errors ?? []).map((e) => e.message).join('; ') || t('Refused') : '';

async function runUnit(
	session: EditorSession,
	engine: CheckEngine,
	sequenceId: string,
	unit: FixUnit,
	label: string,
): Promise<string | null> {
	if (unit.kind === 'commands') {
		const r = applyTx(session, sequenceId, label, unit.commands);
		return r.ok ? null : errorsText(r);
	}
	if (unit.kind === 'swap') {
		const commands = await swapCommands(session, engine, sequenceId, [unit]);
		if (!commands.some((c) => c.type === 'soundDesign.swap')) return t('The clip is gone');
		const r = applyTx(session, sequenceId, label, commands);
		return r.ok ? null : errorsText(r);
	}
	const body = { ...unit.job.body } as Record<string, unknown>;
	delete body.mode;
	if (unit.job.route === 'rebalance') await runRebalance(engine, body as never);
	else await runDelivery(engine, body as never);
	return null;
}

function markFixed(session: EditorSession, ids: readonly string[]) {
	soundCheckStore(session).setState((s) => ({ fixed: [...new Set([...s.fixed, ...ids])] }));
}

/** Asks the user to confirm a fix that needs their judgement (the app's confirmation dialog by default). */
export type ConfirmFix = (opts: { title: string; body: string; confirmLabel: string }) => Promise<boolean>;

/** The confirmation of a fix that is not safe: what it will change, why it needs the user's judgement, one undo step. */
export function fixConfirmation(
	issue: SoundCheckIssue,
	seq: Sequence | undefined,
): { title: string; body: string; confirmLabel: string } {
	const changes = fixChangeSummary(issue, seq);
	const why = fixWhyText(issue.fix);
	return {
		title: t('Apply “{0}”?', messageText(issue.fix?.label)),
		body: [
			changes.length ? t('This will change: {0}.', changes.join('; ')) : '',
			why ? t('Why it needs your judgement: {0}.', why.replace(/[.\s]+$/, '')) : '',
			t('It is one undo step; listen to the result before keeping it.'),
		]
			.filter(Boolean)
			.join(' '),
		confirmLabel: t('Apply Fix'),
	};
}

/**
 * Applies one finding's fix (the user's edit; one undo step). A fix that is not safe asks first (`confirm`, the app's
 * confirmation dialog by default) naming what it will change; declining applies nothing. Never rejects.
 */
export async function applyCheckFix(
	session: EditorSession,
	engine: CheckEngine,
	issue: SoundCheckIssue,
	opts: { confirm?: ConfirmFix } = {},
): Promise<FixOutcome & { declined?: boolean }> {
	const store = soundCheckStore(session);
	const result = store.getState().result;
	if (!result || !issue.fix)
		return { ok: false, message: t('Nothing to fix'), applied: [], failed: [issue.id] };
	if (session.getState().readOnly)
		return { ok: false, message: t('The project is read-only'), applied: [], failed: [issue.id] };
	const plan = planFixes([issue], { safeOnly: false });
	const unit = plan.units[0];
	if (!unit)
		return { ok: false, message: t('This fix cannot be applied here'), applied: [], failed: [issue.id] };
	if (store.getState().fixing)
		return { ok: false, message: t('A fix is being applied'), applied: [], failed: [] };
	// a safe command fix (or one that was only unsafe together with other safe fixes) is judged again on the document
	// as it is now: other fixes applied since can make it unsafe, or safe again
	let judged = issue;
	if (unit.kind === 'commands' && (issue.fix.safe || (issue.fix.conflictsWith?.length ?? 0) > 0)) {
		const j = planSoundCheckFixes(
			session.getCommitted(),
			result.sequenceId,
			[candidateOf(unit, result.report.issues)],
			{ registries: registriesOf(session), guard: guardOf(result) },
		);
		const skip = j.skipped[0];
		judged = skip
			? { ...issue, fix: { ...issue.fix, safe: false, why: skip.reason.text, whyMessage: skip.reason } }
			: { ...issue, fix: { ...issue.fix, safe: true } };
	}
	if (!judged.fix!.safe) {
		store.setState({ fixing: issue.id });
		let yes = false;
		try {
			yes = await (opts.confirm ?? confirmDialog)(fixConfirmation(judged, seqOf(session, result.sequenceId)));
		} catch {
			yes = false;
		} finally {
			store.setState({ fixing: null });
		}
		if (!yes) {
			announce(session, t('Fix not applied'));
			return { ok: false, message: t('Fix not applied'), applied: [], failed: [], declined: true };
		}
	}
	store.setState({ fixing: issue.id });
	try {
		const label = t('Sound Check Fix: {0}', messageText(issue.fix.label));
		const err = await runUnit(session, engine, result.sequenceId, unit, label);
		if (err) {
			announce(session, t('Could not apply the fix: {0}', err));
			return { ok: false, message: err, applied: [], failed: [issue.id] };
		}
		markFixed(session, unit.issueIds);
		const message = t('Fixed: {0}. Run the check again to confirm.', messageText(issue.fix.label));
		announce(session, message);
		return { ok: true, message, applied: unit.issueIds, failed: [] };
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		announce(session, t('Could not apply the fix: {0}', message));
		return { ok: false, message, applied: [], failed: [issue.id] };
	} finally {
		store.setState({ fixing: null });
	}
}

/**
 * Fix all safe: every safe command fix and sound swap in ONE transaction ("Fix n Sound Check Findings"; when that is
 * refused — two fixes that cannot go together — each fix on its own, the refused ones reported), then the safe engine
 * jobs one after another, then the check again (`rerun`, default on). Never rejects.
 */
export async function fixAllSafe(
	session: EditorSession,
	engine: CheckEngine,
	opts: { rerun?: boolean } = {},
): Promise<FixOutcome & { rerun: RunOutcome | null }> {
	const store = soundCheckStore(session);
	const result = store.getState().result;
	const none = { ok: false, message: t('No safe fixes'), applied: [], failed: [], rerun: null };
	if (!result) return none;
	if (session.getState().readOnly) return { ...none, message: t('The project is read-only') };
	const pending = safeFixable(result.report.issues).filter((i) => !store.getState().fixed.includes(i.id));
	const plan = planFixes(pending, { safeOnly: true });
	if (!plan.units.length) return none;
	const seqId = result.sequenceId;
	const applied: string[] = [];
	const failed: string[] = [];
	const skipped: string[] = [];
	const reasons: string[] = [];
	const skipReasons: string[] = [];
	store.setState({ fixing: 'all' });
	announce(session, t('Applying {0} safe fixes', plan.units.length));
	try {
		// the swaps' sounds registered first: their commands are judged with the others
		let prelude: Command[] = [];
		const swapCmd = new Map<string, Command>();
		let swapsFailed = false;
		if (plan.swaps.length) {
			try {
				const cmds = await swapCommands(session, engine, seqId, plan.swaps);
				prelude = cmds.filter((c) => c.type !== 'soundDesign.swap');
				for (const c of cmds)
					if (c.type === 'soundDesign.swap') swapCmd.set((c as { clipId: string }).clipId, c);
			} catch (e) {
				swapsFailed = true;
				reasons.push(e instanceof Error ? e.message : String(e));
			}
		}
		const units = plan.units.filter((u) => {
			if (u.kind !== 'swap') return true;
			if (swapsFailed || !swapCmd.has(u.clipId)) {
				failed.push(...u.issueIds);
				if (!swapsFailed) reasons.push(t('The clip is gone'));
				return false;
			}
			return true;
		});
		const byCandidate = new Map<SoundCheckFixCandidate, FixUnit>();
		const candidates = units.map((u) => {
			const c = candidateOf(u, result.report.issues, u.kind === 'swap' ? swapCmd.get(u.clipId) : undefined);
			byCandidate.set(c, u);
			return c;
		});
		// judged together on the document as it is now: applied in sequence on a dry run, each re-validated
		const joint = planSoundCheckFixes(session.getCommitted(), seqId, candidates, {
			registries: registriesOf(session),
			guard: guardOf(result),
			prelude,
		});
		for (const sk of joint.skipped) {
			skipped.push(...sk.candidate.issueIds);
			skipReasons.push(messageText(sk.reason));
		}
		const accepted = joint.accepted.map((c) => byCandidate.get(c)!);
		const docUnits = accepted.filter((u) => u.kind !== 'job');
		if (docUnits.length) {
			const n = docUnits.length;
			const label = n === 1 ? t('Fix 1 Sound Check Finding') : t('Fix {0} Sound Check Findings', n);
			// ONE transaction: the media registrations, then the accepted fixes in the order they were judged
			const r = applyTx(session, seqId, label, joint.commands as Command[]);
			if (r.ok) for (const u of docUnits) applied.push(...u.issueIds);
			else {
				reasons.push(errorsText(r));
				for (const u of docUnits) {
					try {
						const err = await runUnit(session, engine, seqId, u, label);
						if (err) {
							failed.push(...u.issueIds);
							reasons.push(err);
						} else applied.push(...u.issueIds);
					} catch (e) {
						failed.push(...u.issueIds);
						reasons.push(e instanceof Error ? e.message : String(e));
					}
				}
			}
		}
		for (const u of accepted) {
			if (u.kind !== 'job') continue;
			try {
				await runUnit(session, engine, seqId, u, '');
				applied.push(...u.issueIds);
			} catch (e) {
				failed.push(...u.issueIds);
				reasons.push(e instanceof Error ? e.message : String(e));
			}
		}
	} finally {
		store.setState({ fixing: null });
	}
	markFixed(session, applied);
	const parts = [
		failed.length
			? t(
					'Applied {0} safe fixes; {1} could not be applied: {2}',
					applied.length,
					failed.length,
					reasons.join('; '),
				)
			: t('Applied {0} safe fixes', applied.length),
		...(skipped.length
			? [
					t(
						'{0} left for the next check (not safe with the fixes before them): {1}',
						skipped.length,
						skipReasons.filter(Boolean).join('; '),
					),
				]
			: []),
	];
	const message = parts.join('. ');
	announce(session, message);
	const rerun =
		opts.rerun === false || !applied.length
			? null
			: await runSoundCheck(session, engine, { sequenceId: seqId });
	return { ok: failed.length === 0 && applied.length > 0, message, applied, failed, skipped, rerun };
}

// ── jump ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Moves the playhead to a finding (or listen moment), selects its clips (else its cue) and scrolls the Timeline there.
 */
export function jumpTo(
	session: EditorSession,
	target: {
		frame?: number | null;
		range?: { start: number } | undefined;
		clipIds?: readonly string[];
		cueId?: string;
	},
	reveal?: (frame: number) => void,
): boolean {
	const frame = target.frame ?? target.range?.start ?? null;
	if (frame === null) return false;
	const seq = seqOf(session);
	const clips = (target.clipIds ?? []).filter((id) => seq?.clips[id]);
	stopInContext({ returnToAnchor: false });
	try {
		if (session.transport.getState().playing) session.transport.pause();
		session.transport.seek(frame);
	} catch {
		// no Program player: the selection still moves
	}
	if (clips.length) session.select('timeline', clips, 'replace', { primary: clips[0]!, linked: false });
	else if (target.cueId) session.select('cues', [target.cueId], 'replace');
	reveal?.(frame);
	return true;
}

/** Jump to an issue. */
export function jumpToIssue(
	session: EditorSession,
	issue: SoundCheckIssue,
	reveal?: (f: number) => void,
): boolean {
	return jumpTo(
		session,
		{
			frame: issueFrame(issue),
			...(issue.clipIds ? { clipIds: issue.clipIds } : {}),
			...(issue.cueId ? { cueId: issue.cueId } : {}),
		},
		reveal,
	);
}

// ── findings list (keyboard) ────────────────────────────────────────────────────────────────────────────────────────

/** The findings of the active sequence's report in the order the list shows them (empty without one). */
export function findingOrder(session: EditorSession): SoundCheckIssue[] {
	const r = reportFor(session, session.getState().activeSequenceId);
	return r ? orderedIssues(r.report.issues) : [];
}

/** The findings list's current finding (null when none is current or it is no longer in the report). */
export function currentFinding(session: EditorSession): SoundCheckIssue | null {
	const id = soundCheckStore(session).getState().cursor;
	return (id && findingOrder(session).find((i) => i.id === id)) || null;
}

/** Makes a finding the list's current one (null: none). */
export function setFindingCursor(session: EditorSession, issueId: string | null): void {
	soundCheckStore(session).setState({ cursor: issueId });
}

/** Moves the list's current finding: by `dir` rows (clamped), or to the first / last. Returns the new current one. */
export function stepFinding(session: EditorSession, to: number | 'first' | 'last'): SoundCheckIssue | null {
	const order = findingOrder(session);
	if (!order.length) return null;
	const cur = currentFinding(session);
	const at = cur ? order.indexOf(cur) : -1;
	const n =
		to === 'first'
			? 0
			: to === 'last'
				? order.length - 1
				: at < 0
					? 0
					: Math.max(0, Math.min(order.length - 1, at + to));
	const next = order[n]!;
	setFindingCursor(session, next.id);
	return next;
}

/** Opens (true), closes (false) or toggles the sync strip of a finding (only sync findings have one). */
export function setSyncStrip(session: EditorSession, issue: SoundCheckIssue, open?: boolean): boolean {
	const store = soundCheckStore(session);
	const has = store.getState().openStrips.includes(issue.id);
	const want = open ?? !has;
	if (want && !hasSyncStrip(issue)) return false;
	if (want === has) return true;
	store.setState((s) => ({
		openStrips: want ? [...s.openStrips, issue.id] : s.openStrips.filter((x) => x !== issue.id),
	}));
	return true;
}

/** Plays 4 s around a finding through the Program (the playhead goes there first and comes back after). */
export function playFinding(
	session: EditorSession,
	issue: SoundCheckIssue,
	reveal?: (f: number) => void,
): boolean {
	const seqId = reportFor(session, session.getState().activeSequenceId)?.sequenceId;
	const frame = issueFrame(issue);
	if (!seqId || frame === null) return false;
	jumpToIssue(session, issue, reveal);
	return playListen(
		session,
		seqId,
		[
			{
				slot: 'worst',
				frame,
				timecode: issue.timecode ?? '',
				seconds: 0,
				why: issue.message,
				slotLabel: '',
				text: messageText(issue.message),
				verdict: null,
			},
		],
		0,
	);
}

// ── listen here ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Seconds of each listen-here window either side of its moment (4 s in all). */
export const LISTEN_HALF_SEC = 2;

function stopPlaying(session: EditorSession) {
	const st = soundCheckStore(session).getState();
	if (st.playing) {
		soundCheckStore(session).setState({ playing: null });
		stopInContext();
	}
}

/**
 * Plays a listen-here moment: 2 s before to 2 s after it (cut at the end of the sequence) through the Program transport,
 * then the playhead goes back. With `all`, the rows after it follow, each when the one before has played to its end.
 */
export function playListen(
	session: EditorSession,
	sequenceId: string,
	rows: readonly ListenRow[],
	index: number,
	opts: { all?: boolean } = {},
): boolean {
	const store = soundCheckStore(session);
	const seq = seqOf(session, sequenceId);
	const row = rows[index];
	if (!seq || !row) {
		store.setState({ playing: null });
		return false;
	}
	const fps = seq.settings.frameRate.num / seq.settings.frameRate.den || 30;
	const last = Math.max(0, Math.ceil(sequenceDuration(seq)) - 2);
	const center = Math.min(row.frame, last);
	const after = Math.max(1 / fps, Math.min(LISTEN_HALF_SEC, (last - center) / fps));
	const returnTo =
		store.getState().playing?.sequenceId === sequenceId
			? (playingReturn.get(session) ?? Math.round(session.transport.getState().frame))
			: Math.round(session.transport.getState().frame);
	playingReturn.set(session, returnTo);
	store.setState({ playing: { sequenceId, index, all: !!opts.all } });
	announce(session, t('Playing {0}: {1}', row.timecode, row.slotLabel));
	playTimelineWindow(session, seq, {
		center,
		returnTo,
		title: t('Listen here: {0}', row.timecode),
		before: LISTEN_HALF_SEC,
		after,
		keepPlayingOn: keepsListening,
		onEnd: (how) => {
			const now = store.getState().playing;
			if (!now || now.index !== index || now.sequenceId !== sequenceId) return;
			if (how === 'window' && now.all && index + 1 < rows.length) {
				// the next row, after this window has handed the transport back
				setTimeout(() => {
					const still = store.getState().playing;
					if (still && still.index === index && still.all)
						playListen(session, sequenceId, rows, index + 1, opts);
				}, 0);
				return;
			}
			store.setState({ playing: null });
			playingReturn.delete(session);
			announce(session, now.all && how === 'window' ? t('Played every listen-here moment') : t('Stopped'));
		},
	});
	return true;
}
const playingReturn = new WeakMap<EditorSession, number>();

/** The attribute of the panel parts whose presses do not stop a listen-here window (the verdict buttons, the note). */
export const LISTEN_KEEP_ATTR = 'data-listen-keep';

/**
 * Whether a key or pointer press keeps a listen-here window playing: presses inside the listen-here controls
 * (`LISTEN_KEEP_ATTR`) — Sounds right, Flag, the note field and its buttons, and the ▶ / Play all buttons, whose own
 * click starts or stops playback (stopping on the press would let the click start it again) — except Escape and keys
 * that are not typing or activating a button there. Everything else stops it (the In Context rule).
 */
export function keepsListening(e: Event): boolean {
	const el = e.target as Element | null;
	if (!el || typeof (el as Element).closest !== 'function') return false;
	const zone = el.closest(`[${LISTEN_KEEP_ATTR}]`);
	if (!zone) return false;
	if (typeof KeyboardEvent !== 'undefined' && e instanceof KeyboardEvent) {
		if (e.key === 'Escape') return false;
		const field = el.closest('input,textarea,[contenteditable="true"]');
		const control = el.closest('button,[role="button"]');
		// typing in the note, or activating / tabbing between the verdict buttons
		return !!field || (!!control && ['Enter', ' ', 'Tab', 'NumpadEnter'].includes(e.key)) || e.key === 'Tab';
	}
	return true;
}

/** Stops a listen-here window or Play all. */
export function stopListen(session: EditorSession): void {
	stopPlaying(session);
	playingReturn.delete(session);
}

/**
 * Records the user's verdict on a listen-here moment (`soundDesign.setVerdict`: a `comment` marker bound to the moment —
 * its slot, clip or cue and the mix it judged; one undo step).
 */
export function recordVerdict(
	session: EditorSession,
	sequenceId: string,
	row: Pick<ListenRow, 'frame' | 'timecode'> & Partial<Pick<ListenRow, 'slot' | 'clipId' | 'cueId'>>,
	verdict: 'ok' | 'flag',
	note: string,
): { ok: boolean; message: string } {
	const seq = seqOf(session, sequenceId);
	if (!seq) return { ok: false, message: t('The sequence was closed') };
	const label =
		verdict === 'ok' ? t('Sounds Right at {0}', row.timecode) : t('Flag Sound at {0}', row.timecode);
	const report = reportFor(session, sequenceId);
	const r = applyTx(
		session,
		sequenceId,
		label,
		verdictCommands(seq, row, verdict, note, report?.report.mixHash ?? null),
	);
	const message = r.ok
		? verdict === 'ok'
			? t('Marked {0} as sounding right', row.timecode)
			: t('Flagged {0}', row.timecode)
		: errorsText(r);
	announce(session, message);
	return { ok: r.ok, message };
}
