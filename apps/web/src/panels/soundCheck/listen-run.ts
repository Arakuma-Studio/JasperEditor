// The Sound Check panel's Log tab (spec 12 §4 P6-E6 / P6-E7; wp-note "Phase 6 → WP-E3"): the listening transcript of the
// active sequence — the engine's `sound-listen` job (`POST /api/sound-design/listen`), the same lines MCP
// `listen_to_sequence` returns — its run (progress, cancel), the line the user is on, and jumping to a line (the
// playhead moves there and the clip that plays the sound, or the cue, is selected). Never rejects.
import {
	type EngineJob,
	SOUND_LISTEN_LIMITS,
	type SoundListenDetail,
	type SoundListenLine,
	type SoundListenResult,
	SoundListenResultSchema,
} from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { type Rational, type Sequence, sequenceDuration } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { t } from '../../i18n/runtime.ts';
import { jumpTo } from '../../sound/check-run.ts';
import { runSoundJob, SoundJobError } from '../../sound/mix-jobs.ts';

export type ListenEngine = Pick<EngineClient, 'soundListen' | 'getJob' | 'cancelJob'> &
	Partial<Pick<EngineClient, 'soundVisual'>>;

export type ListenTab = 'findings' | 'log';

export type ListenState = {
	/** The panel's tab. */
	tab: ListenTab;
	detail: SoundListenDetail;
	/** P6-E14: name what each event sounds like (the optional Describe-it search model). */
	tags: boolean;
	result: SoundListenResult | null;
	jobId: string | null;
	running: { sequenceId: string; jobId: string | null; progress: number | null; stage: string | null } | null;
	error: string | null;
	/** The line the user is on (index into `result.lines`). */
	cursor: number | null;
	/** Show the spectrogram strip. */
	spectrogram: boolean;
	announcement: { message: string; n: number };
};

const stores = new WeakMap<EditorSession, StoreApi<ListenState>>();
const aborts = new WeakMap<EditorSession, AbortController>();

/** The Log tab's state of a session (created on first use). */
export function listenStore(session: EditorSession): StoreApi<ListenState> {
	let s = stores.get(session);
	if (!s) {
		s = createStore<ListenState>(() => ({
			tab: 'findings',
			detail: 'normal',
			tags: false,
			result: null,
			jobId: null,
			running: null,
			error: null,
			cursor: null,
			spectrogram: false,
			announcement: { message: '', n: 0 },
		}));
		stores.set(session, s);
	}
	return s;
}

function announce(session: EditorSession, message: string): void {
	listenStore(session).setState((s) => ({ announcement: { message, n: s.announcement.n + 1 } }));
}

export function setListenTab(session: EditorSession, tab: ListenTab): void {
	listenStore(session).setState({ tab });
}

export function setListenDetail(session: EditorSession, detail: SoundListenDetail): void {
	listenStore(session).setState({ detail });
}

export function setListenTags(session: EditorSession, tags: boolean): void {
	listenStore(session).setState({ tags });
}

export function setListenSpectrogram(session: EditorSession, on: boolean): void {
	listenStore(session).setState({ spectrogram: on });
}

/**
 * The range a listen of `seq` covers: the whole sequence when it is at most 10 minutes long, else the 10 minutes from
 * the playhead (clamped to the end), with a note saying so.
 */
export function listenRangeFor(
	seq: Pick<Sequence, 'clips' | 'settings'>,
	playhead: number,
): { range?: { start: number; end: number }; note: string | null } {
	const rate = seq.settings.frameRate as Rational;
	const fps = rate.num / rate.den;
	const duration = Math.max(0, Math.ceil(sequenceDuration(seq)));
	const max = Math.floor(SOUND_LISTEN_LIMITS.maxSeconds * fps);
	if (duration <= max) return { note: null };
	const start = Math.max(0, Math.min(duration - max, Math.round(Number.isFinite(playhead) ? playhead : 0)));
	return {
		range: { start, end: start + max },
		note: t('The sequence is longer than 10 minutes: the 10 minutes from the playhead are listened to'),
	};
}

export type ListenOutcome =
	| { ok: true; result: SoundListenResult }
	| { ok: false; code: string; message: string; cancelled?: boolean };

/** Listens to the active sequence (or `sequenceId`); a listen already going is cancelled first. Never rejects. */
export async function runListen(
	session: EditorSession,
	engine: ListenEngine,
	opts: { sequenceId?: string; detail?: SoundListenDetail; sleep?(ms: number): Promise<void> } = {},
): Promise<ListenOutcome> {
	const store = listenStore(session);
	const id = opts.sequenceId ?? session.getState().activeSequenceId;
	const seq = id ? (session.getCommitted().sequences[id] as Sequence | undefined) : undefined;
	if (!seq) return { ok: false, code: 'E_NO_SEQUENCE', message: t('Open a sequence first') };
	aborts.get(session)?.abort();
	const ac = new AbortController();
	aborts.set(session, ac);
	ac.signal.addEventListener('abort', () => {
		const job = store.getState().running?.jobId;
		if (job) void engine.cancelJob(job).catch(() => undefined);
	});
	const detail = opts.detail ?? store.getState().detail;
	if (opts.detail) store.setState({ detail: opts.detail });
	const tags = store.getState().tags;
	let playhead = 0;
	try {
		playhead = session.transport.getState().frame;
	} catch {
		// no Program player
	}
	const { range } = listenRangeFor(seq, playhead);
	store.setState({
		tab: 'log',
		running: { sequenceId: seq.id, jobId: null, progress: null, stage: t('Starting') },
		error: null,
	});
	announce(session, t('Listening to the sequence'));
	try {
		const result = await runSoundJob(
			engine,
			(signal) =>
				engine.soundListen(
					{
						projectId: session.projectId,
						sequenceId: seq.id,
						detail,
						...(range ? { range } : {}),
						...(tags ? { tags: true } : {}),
					},
					signal,
				),
			SoundListenResultSchema,
			{
				signal: ac.signal,
				failure: t('The listen failed'),
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
		store.setState({ result, jobId, running: null, error: null, cursor: null });
		announce(
			session,
			t(
				'Listened: {0} sound events, {1} picture events with no sound',
				result.counts.events,
				result.counts.unanswered,
			),
		);
		return { ok: true, result };
	} catch (e) {
		if (aborts.get(session) === ac) aborts.delete(session);
		const err = e instanceof SoundJobError ? e : new SoundJobError('E_ENGINE', String(e));
		const cancelled = err.code === 'E_CANCELLED' || ac.signal.aborted;
		if (ac.signal.aborted && aborts.get(session))
			return { ok: false, code: err.code, message: err.message, cancelled };
		store.setState({ running: null, error: cancelled ? null : err.message });
		announce(session, cancelled ? t('Listen cancelled') : t('The listen failed: {0}', err.message));
		return { ok: false, code: err.code, message: err.message, cancelled };
	}
}

/** Cancels the listen in progress (the job is cancelled too). */
export function cancelListen(session: EditorSession): void {
	aborts.get(session)?.abort();
}

/** What a line points at: its frame, the clip that plays its sound, the cue it fills or names. */
export function lineTarget(
	r: Pick<SoundListenResult, 'events' | 'pictureEvents'>,
	line: SoundListenLine,
): { frame: number; clipIds: string[]; cueId?: string } {
	const e = line.event !== undefined ? r.events[line.event] : undefined;
	if (e)
		return { frame: line.frame, clipIds: e.clipId ? [e.clipId] : [], ...(e.cueId ? { cueId: e.cueId } : {}) };
	const p = line.key ? r.pictureEvents.find((x) => x.key === line.key) : undefined;
	return { frame: line.frame, clipIds: [], ...(p?.cueId ? { cueId: p.cueId } : {}) };
}

/** Moves the cursor to a line and the playhead to its frame (selecting its clip, else its cue). */
export function jumpToLine(session: EditorSession, index: number, reveal?: (frame: number) => void): boolean {
	const s = listenStore(session).getState();
	const r = s.result;
	const line = r?.lines[index];
	if (!r || !line) return false;
	listenStore(session).setState({ cursor: index });
	// a result of another sequence: only the cursor moves
	if (r.sequenceId !== session.getState().activeSequenceId) return false;
	return jumpTo(session, lineTarget(r, line), reveal);
}

/** Moves the cursor (keyboard): ±n lines, or to the first / last. Returns the new index. */
export function stepLine(session: EditorSession, to: number | 'first' | 'last'): number | null {
	const s = listenStore(session).getState();
	const n = s.result?.lines.length ?? 0;
	if (!n) return null;
	const next =
		to === 'first'
			? 0
			: to === 'last'
				? n - 1
				: Math.max(0, Math.min(n - 1, (s.cursor ?? (to > 0 ? -1 : n)) + to));
	listenStore(session).setState({ cursor: next });
	return next;
}

/**
 * The ≤ 120 s window of the spectrogram strip: the whole listened range when it fits, else 120 s centred on the
 * line the cursor is on (the start of the range without one).
 */
export function spectrogramWindow(
	r: Pick<SoundListenResult, 'range' | 'fps' | 'lines'>,
	cursor: number | null,
): { start: number; end: number } {
	const fps = r.fps.num / Math.max(1, r.fps.den);
	const max = Math.floor(120 * fps);
	if (r.range.end - r.range.start <= max) return { start: r.range.start, end: r.range.end };
	const at = cursor !== null && r.lines[cursor] ? r.lines[cursor]!.frame : r.range.start;
	const start = Math.max(r.range.start, Math.min(r.range.end - max, at - Math.floor(max / 2)));
	return { start, end: start + max };
}

/** The copyable report: the transcript with its range in a heading line. */
export function transcriptText(r: Pick<SoundListenResult, 'text' | 'rangeTimecode'>): string {
	return `${t('Listening transcript {0}–{1}', r.rangeTimecode.start, r.rangeTimecode.end)}\n${r.text}\n`;
}
