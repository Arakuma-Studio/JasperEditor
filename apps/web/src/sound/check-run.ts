// What the Sound Check panel does (spec 12 §2.6 / §2.7 "Sound Check panel", P5-R3; wp-note "Phase 5 → WP5.2"), shared
// by the panel, Sequence ▸ Sound Design ▸ Run Sound Check and the Export dialog's "Run Sound Check before export":
//
// - Run: the engine's `sound-check` job (`POST /api/sound-design/check`, `store: true`) against the chosen delivery
//   target. The editor's request carries the editor key, so the engine writes the summary into the sequence as the
//   user's own edit ("Sound Check Result", one undo step, WP5.1). The job shows in the Jobs panel; its progress and
//   stage show in the panel (aria-live), and it can be cancelled.
// - The last report per session (and sequence) lives in a store; a reopened project gets it back from the stored
//   summary's job while the engine keeps that job.
// - Fix: a finding's fix as the engine described it — commands as ONE transaction (`session.apply`, the user's edit),
//   a sound swap through the panel's swap path (register the library sound → `media.register` → `soundDesign.swap`,
//   what the Sound Library's Swap does, also for "the same sound again"), an engine job (rebalance / delivery: the
//   user's edit too). Fix all safe: every safe command fix and swap in ONE transaction (each fix on its own when that
//   is refused), then the safe engine jobs one after another, then the check runs again.
// - Jump: a finding's or listen-here moment's timecode → the playhead, the clips / cue selected, the Timeline scrolled.
// - Listen here: ▶ plays 4 s around the moment through the Program transport (`playTimelineWindow`), Play all chains
//   the rows (the next one starts when a window plays to its end; a key or click stops the chain), and a verdict is a
//   user `comment` marker (`verdictCommands`).
import {
	type EngineJob,
	type SoundCheckIssue,
	type SoundCheckResult,
	SoundCheckResultSchema,
} from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { type Command, type Sequence, sequenceDuration, soundCheckStatus } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { t } from '../i18n/runtime.ts';
import {
	choiceRequest,
	type DeliveryChoice,
	defaultChoice,
	type FixPlan,
	type FixUnit,
	issueFrame,
	type ListenRow,
	messageText,
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
>;

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
		const jobId = store.getState().running?.jobId ?? null;
		store.setState({ result, jobId, running: null, error: null, fixed: [] });
		announce(session, verdictSentence(result.report.verdict, result.report.counts));
		return { ok: true, result };
	} catch (e) {
		if (aborts.get(session) === ac) aborts.delete(session);
		const err = e instanceof SoundJobError ? e : new SoundJobError('E_ENGINE', String(e));
		const cancelled = err.code === 'E_CANCELLED';
		// a newer run replaced this one: it owns the state
		if (ac.signal.aborted && aborts.get(session)) return { ok: false, code: err.code, message: err.message, cancelled };
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
 * Loads the report of the sequence's stored summary from its job (while the engine keeps it), when the store has none
 * for that sequence. Resolves whether it did. Never rejects.
 */
export async function loadStoredReport(
	session: EditorSession,
	engine: Pick<EngineClient, 'getJob'>,
	sequenceId: string,
): Promise<boolean> {
	const store = soundCheckStore(session);
	if (reportFor(session, sequenceId) || store.getState().running) return false;
	const status = soundCheckStatus(session.getCommitted(), sequenceId);
	const jobId = status.summary?.jobId;
	if (!jobId) return false;
	try {
		const job = (await engine.getJob(jobId)) as EngineJob;
		if (job.state !== 'succeeded') return false;
		const parsed = SoundCheckResultSchema.safeParse(job.result);
		if (!parsed.success || parsed.data.sequenceId !== sequenceId) return false;
		if (reportFor(session, sequenceId) || store.getState().running) return false;
		store.setState({ result: parsed.data, jobId, fixed: [] });
		return true;
	} catch {
		return false; // the job is gone (engine restarted): the summary chips stay, Run gets the details
	}
}

// ── fixes ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export type FixOutcome = { ok: boolean; message: string; applied: string[]; failed: string[] };

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

/** Applies one finding's fix (the user's edit; one undo step). Never rejects. */
export async function applyCheckFix(
	session: EditorSession,
	engine: CheckEngine,
	issue: SoundCheckIssue,
): Promise<FixOutcome> {
	const store = soundCheckStore(session);
	const result = store.getState().result;
	if (!result || !issue.fix) return { ok: false, message: t('Nothing to fix'), applied: [], failed: [issue.id] };
	if (session.getState().readOnly)
		return { ok: false, message: t('The project is read-only'), applied: [], failed: [issue.id] };
	const plan = planFixes([issue], { safeOnly: false });
	const unit = plan.units[0];
	if (!unit) return { ok: false, message: t('This fix cannot be applied here'), applied: [], failed: [issue.id] };
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
	const reasons: string[] = [];
	store.setState({ fixing: 'all' });
	announce(session, t('Applying {0} safe fixes', plan.units.length));
	try {
		const docUnits = plan.units.filter((u) => u.kind !== 'job');
		if (docUnits.length) {
			let joined: Command[] | null = null;
			try {
				joined = [...(await swapCommands(session, engine, seqId, plan.swaps)), ...plan.commands];
			} catch (e) {
				reasons.push(e instanceof Error ? e.message : String(e));
			}
			const n = docUnits.length;
			const label = n === 1 ? t('Fix 1 Sound Check Finding') : t('Fix {0} Sound Check Findings', n);
			// the media registrations first, then the command fixes, then the swaps (an align before a swap of the
			// same clip: the swap keeps the aligned frame)
			const r = joined ? applyTx(session, seqId, label, reorder(joined, plan)) : null;
			if (r?.ok) for (const u of docUnits) applied.push(...u.issueIds);
			else {
				if (r) reasons.push(errorsText(r));
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
		for (const u of plan.units) {
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
	const message = failed.length
		? t('Applied {0} safe fixes; {1} could not be applied: {2}', applied.length, failed.length, reasons.join('; '))
		: t('Applied {0} safe fixes', applied.length);
	announce(session, message);
	const rerun = opts.rerun === false || !applied.length ? null : await runSoundCheck(session, engine, { sequenceId: seqId });
	return { ok: failed.length === 0 && applied.length > 0, message, applied, failed, rerun };
}

/** Media registrations first, then the command fixes, then the swaps. */
function reorder(commands: Command[], plan: FixPlan): Command[] {
	const fixSet = new Set(plan.commands);
	const media = commands.filter((c) => !fixSet.has(c) && c.type !== 'soundDesign.swap');
	const swaps = commands.filter((c) => !fixSet.has(c) && c.type === 'soundDesign.swap');
	return [...media, ...plan.commands, ...swaps];
}

// ── jump ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Moves the playhead to a finding (or listen moment), selects its clips (else its cue) and scrolls the Timeline there.
 */
export function jumpTo(
	session: EditorSession,
	target: { frame?: number | null; range?: { start: number } | undefined; clipIds?: readonly string[]; cueId?: string },
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
export function jumpToIssue(session: EditorSession, issue: SoundCheckIssue, reveal?: (f: number) => void): boolean {
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
		onEnd: (how) => {
			const now = store.getState().playing;
			if (!now || now.index !== index || now.sequenceId !== sequenceId) return;
			if (how === 'window' && now.all && index + 1 < rows.length) {
				// the next row, after this window has handed the transport back
				setTimeout(() => {
					const still = store.getState().playing;
					if (still && still.index === index && still.all) playListen(session, sequenceId, rows, index + 1, opts);
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

/** Stops a listen-here window or Play all. */
export function stopListen(session: EditorSession): void {
	stopPlaying(session);
	playingReturn.delete(session);
}

/** Records the user's verdict on a listen-here moment (a `comment` marker; one undo step). */
export function recordVerdict(
	session: EditorSession,
	sequenceId: string,
	row: Pick<ListenRow, 'frame' | 'timecode'>,
	verdict: 'ok' | 'flag',
	note: string,
): { ok: boolean; message: string } {
	const seq = seqOf(session, sequenceId);
	if (!seq) return { ok: false, message: t('The sequence was closed') };
	const label = verdict === 'ok' ? t('Sounds Right at {0}', row.timecode) : t('Flag Sound at {0}', row.timecode);
	const r = applyTx(session, sequenceId, label, verdictCommands(seq, row.frame, verdict, note));
	const message = r.ok
		? verdict === 'ok'
			? t('Marked {0} as sounding right', row.timecode)
			: t('Flagged {0}', row.timecode)
		: errorsText(r);
	announce(session, message);
	return { ok: r.ok, message };
}
