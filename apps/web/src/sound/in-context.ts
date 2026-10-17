// In Context audition (spec 12 §2.7 "Audition"): Shift+Space in the Sound Library (or Space / Auto-play / hover with
// the In Context toggle on, or hovering Fill With ▸ items) plays the TIMELINE with the candidate mixed in, its aligned
// point (peak, or start / end per the cue or the sound type) on the anchor — the selected or filling cue, else the
// clip being replaced (Replace mode, muted while auditioning), else the selected SFX clip's aligned point (muted), else
// the playhead. The window runs from the pre-roll (preference, default 2 s) before the anchor to 1 s after the
// candidate ends; then the transport stops and returns to the anchor.
//
// It never writes the document or history: the candidate is placed in a session GESTURE (the transient document the
// timeline and the Program monitor draw and play, S01:SES-006) that is always cancelled, never committed. The sound is
// registered with the engine first (managed media of the project: an engine-side copy, not a document change). The
// Program plays through its own transport and audio graph, so the Phase 0 primed start applies unchanged (a seek while
// paused, then Play). Any other action ends it: a key, a pointer press, the transport stopping, another audition (which
// starts from where this one would have returned), the project closing, another sequence becoming active, an agent's
// transaction (it would otherwise wait for the gesture), or a watchdog when the frames never move (no Program monitor).
//
// Also `playTimelineWindow` (Audition on swap): plays the committed timeline around a frame and returns.
import type { EngineClient } from '@jasper/engine-client';
import type { Command, Rational, Sequence, SoundAlignRequest, SoundCue } from '@jasper/project';
import type { EditorSession, Gesture } from '@jasper/session';
import { createStore } from 'zustand/vanilla';
import { beforeAgentTransaction } from '../agent-bridge/hooks.ts';
import { t } from '../i18n/runtime.ts';
import { onBeforeKey } from '../shell/keymap/dispatcher.ts';
import { auditionPlayer } from './audition.ts';
import { clipSoundTarget, cueFillTarget } from './controller.ts';
import { cuesOf } from './cues/model.ts';
import { alignedFrameOf, alignOf, isLibraryClip, sfxOf } from './design-model.ts';
import { type LibraryEntryLike, registerLibrarySounds, soundMediaCommands } from './library-media.ts';
import { soundLibraryPrefs } from './prefs.ts';

export type InContextState = {
	/** Something plays in context (a candidate, or the window after a swap). */
	active: boolean;
	soundId: string | null;
	/** What the Program overlay chip names. */
	title: string | null;
	/** Preparing (registering the sound, placing it). */
	loading: boolean;
	error: string | null;
	/** Bumped at every start / stop (aria-live). */
	epoch: number;
};

export const inContextStore = createStore<InContextState>(() => ({
	active: false,
	soundId: null,
	title: null,
	loading: false,
	error: null,
	epoch: 0,
}));

/** Where the candidate goes. */
export type InContextAnchor = {
	frame: number;
	align: SoundAlignRequest;
	/** A clip muted while auditioning (the one being replaced). */
	muteClipId: string | null;
	kind: 'cue' | 'clip' | 'playhead';
	cueId: string | null;
};

/** One second after the candidate's end (spec 12 §2.7). */
export const POST_ROLL_SEC = 1;

/**
 * The anchor of an In Context audition: the cue being filled (or the last selected cue), else the clip being replaced
 * (Replace mode) or the selected SFX clip (its aligned point; muted), else the playhead.
 */
export function inContextAnchor(session: EditorSession, seq: Sequence): InContextAnchor {
	const s = session.getState();
	const doc = s.document;
	const fill = cueFillTarget();
	const cues = cuesOf(seq);
	const cueId =
		fill && fill.sequenceId === seq.id && !fill.layer ? fill.cueId : (s.selection.cues?.at(-1) ?? null);
	const cue: SoundCue | undefined = cueId ? cues.find((c) => c.id === cueId) : undefined;
	if (cue)
		return { frame: cue.frame, align: cue.align ?? 'auto', muteClipId: null, kind: 'cue', cueId: cue.id };
	const target = clipSoundTarget();
	const clipId =
		target && target.sequenceId === seq.id
			? target.clipId
			: s.selection.timeline.clips.find((id) => {
					const c = seq.clips[id];
					return !!c && c.kind === 'audio' && (!!sfxOf(c) || isLibraryClip(doc, c));
				});
	const clip = clipId ? seq.clips[clipId] : undefined;
	if (clip) {
		const at = alignedFrameOf(doc, seq, clip);
		if (at !== null) {
			const layer = target?.kind === 'layer' && target.clipId === clip.id;
			return {
				frame: Math.floor(at),
				align: alignOf(clip),
				muteClipId: layer ? null : clip.id,
				kind: 'clip',
				cueId: null,
			};
		}
	}
	return {
		frame: Math.max(0, Math.round(session.transport.getState().frame)),
		align: 'auto',
		muteClipId: null,
		kind: 'playhead',
		cueId: null,
	};
}

/** The anchor of an audition on a given cue (Fill With ▸ on that cue's menu): its frame and its alignment. */
export function cueAnchor(cue: Pick<SoundCue, 'id' | 'frame' | 'align'>): InContextAnchor {
	return { frame: cue.frame, align: cue.align ?? 'auto', muteClipId: null, kind: 'cue', cueId: cue.id };
}

type Running = {
	session: EditorSession;
	gesture: Gesture | null;
	returnTo: number;
	end: number;
	/** Everything to undo when it ends: transport and input listeners, session watchers, the watchdog. */
	offs: (() => void)[];
	token: number;
	/** Told how a window ended: it played to its end (`window`), or something stopped it first (`stopped`). */
	onEnd?: ((how: 'window' | 'stopped') => void) | undefined;
	/** Inputs that do not end it (the Sound Check's verdict buttons during Play all). */
	keep?: ((e: Event) => boolean) | undefined;
};

let running: Running | null = null;
let token = 0;
/** Watchers of an audition still registering its sound (the session closing, the sequence switching). */
let preparing: (() => void) | null = null;
/** `KeyboardEvent.code` of the key press that has just ended an audition (cleared once that event is dispatched). */
let endedByKey: string | null = null;

function set(patch: Partial<InContextState>): void {
	inContextStore.setState(patch);
}

/** Stops whatever plays in context (the gesture is cancelled: nothing was written). */
export function stopInContext(opts: { returnToAnchor?: boolean; reason?: 'window' } = {}): void {
	token++;
	const watch = preparing;
	preparing = null;
	watch?.();
	const r = running;
	running = null;
	if (r) {
		for (const off of r.offs.splice(0)) off();
		// the gesture first: whatever the transport does next, the document is the committed one again
		r.gesture?.cancel();
		const transport = r.session.transport;
		try {
			if (transport.getState().playing) transport.pause();
			if (opts.returnToAnchor !== false) transport.seek(r.returnTo);
		} catch {
			// a Program player failing to pause must not keep the audition (or its gesture) alive
		}
	}
	const st = inContextStore.getState();
	if (st.active || st.loading)
		set({ active: false, loading: false, soundId: null, title: null, epoch: st.epoch + 1 });
	if (r?.onEnd) {
		try {
			r.onEnd(opts.reason ?? 'stopped');
		} catch {
			// a listener failing must not leave the transport playing
		}
	}
}

/**
 * Whether the key press being dispatched has just ended an audition, and it is one of `codes`. The key that ends it
 * reaches the panel after the audition's own capture listener stopped it: the Sound Library's toggles (Shift+Space,
 * Space, Esc) use this so that the key stops the audition instead of starting it again or also leaving Fill mode.
 */
export function inContextEndedBy(codes: readonly string[]): boolean {
	return endedByKey !== null && codes.includes(endedByKey);
}

/**
 * Ends the audition on the next key or pointer press anywhere (installed after the gesture that started it), except the
 * presses `keep` accepts.
 */
function endOnInput(stop: () => void, keep?: (e: Event) => boolean): () => void {
	if (typeof window === 'undefined') return () => undefined;
	let on = false;
	let ended = false;
	let offKey: () => void = () => undefined;
	const handler = (e: Event) => {
		if (ended) return;
		try {
			if (keep?.(e)) return;
		} catch {
			// a failing filter ends it, as any input does
		}
		if (e instanceof KeyboardEvent) {
			// modifier keys alone (holding Shift of Shift+Space) do not end it
			if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
			const code = e.code || e.key;
			endedByKey = code;
			setTimeout(() => {
				if (endedByKey === code) endedByKey = null;
			}, 0);
		}
		ended = true;
		stop();
	};
	const timer = setTimeout(() => {
		on = true;
		// the keymap's pre-key hook runs before it resolves the key, so the key's command then finds no gesture held
		// (Ctrl+Z undoes in the same press); the window listener covers keys the keymap never sees
		offKey = onBeforeKey(handler);
		window.addEventListener('keydown', handler, true);
		window.addEventListener('pointerdown', handler, true);
	}, 0);
	return () => {
		clearTimeout(timer);
		if (on) {
			offKey();
			window.removeEventListener('keydown', handler, true);
			window.removeEventListener('pointerdown', handler, true);
		}
	};
}

/** Ends it when the project closes or another sequence becomes active (the Program no longer plays its sequence). */
function watchSession(session: EditorSession, end: () => void): () => void {
	const active = session.getState().activeSequenceId;
	const offClosed = session.on('closed', end);
	const offStore = session.store.subscribe((s) => {
		if (s.activeSequenceId !== active) end();
	});
	return () => {
		offClosed();
		offStore();
	};
}

function fpsOf(seq: Pick<Sequence, 'settings'>): number {
	const r = seq.settings.frameRate as Rational;
	return r.den > 0 && r.num > 0 ? r.num / r.den : 30;
}

/** Wall-clock slack before the watchdog ends a window whose frames do not move (no Program monitor plays them). */
const WATCHDOG_SLACK_SEC = 5;
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Plays [start, end) of the drawn timeline, then pauses and seeks to `returnTo` (unless something else took over).
 * A watchdog ends it when the window has had its time and more (a transport that never reports frames would otherwise
 * hold the gesture, and with it agents' edits and autosave, until the next key press).
 */
function playWindow(r: Running, start: number, fps: number): void {
	const transport = r.session.transport;
	if (transport.getState().playing) transport.pause();
	transport.seek(Math.max(0, start));
	let started = false;
	r.offs.push(
		transport.subscribe((st, prev) => {
			if (running !== r) return;
			if (st.playing && !prev.playing) started = true;
			// the user (or the end of the sequence) stopped it, or the window is over
			if (st.frame >= r.end) stopInContext({ reason: 'window' });
			else if (started && !st.playing) stopInContext();
		}),
	);
	const windowSec = Math.max(0, r.end - Math.max(0, start)) / (fps > 0 ? fps : 30);
	const ms = Math.min(MAX_TIMEOUT_MS, (windowSec * 1.5 + WATCHDOG_SLACK_SEC) * 1000);
	const watchdog = setTimeout(() => {
		if (running === r) stopInContext();
	}, ms);
	r.offs.push(() => clearTimeout(watchdog));
	transport.play(1);
}

/** Starts a window: the run is current, input and session watchers are on, the store says what plays. */
function begin(r: Running, title: string | null, soundId: string | null): void {
	running = r;
	r.offs.push(
		endOnInput(() => {
			if (running === r) stopInContext();
		}, r.keep),
		watchSession(r.session, () => {
			if (running === r) stopInContext({ returnToAnchor: false });
		}),
	);
	set({
		active: true,
		loading: false,
		soundId,
		title,
		error: null,
		epoch: inContextStore.getState().epoch + 1,
	});
}

export type InContextResult = { ok: true } | { ok: false; message: string; cancelled?: boolean };

/**
 * Plays a candidate sound in context (see the module comment). Resolves when playback starts (or fails: the message
 * is in the store and returned; `cancelled` when another audition or a stop superseded it, which is not an error).
 * Never changes the document or history, and never rejects.
 */
export async function auditionInContext(
	session: EditorSession,
	engine: Pick<EngineClient, 'registerSound'>,
	entry: LibraryEntryLike,
	opts: { sequenceId?: string; anchor?: InContextAnchor } = {},
): Promise<InContextResult> {
	// What played before ends as it would on its own: back to its anchor, so this one's anchor (the playhead) and
	// return point are where the user was, not wherever the previous window had got to.
	stopInContext();
	auditionPlayer().stop();
	const my = ++token;
	const cancelled = () => ({ ok: false as const, message: t('Cancelled'), cancelled: true });
	const fail = (message: string) => {
		if (my === token) {
			const watch = preparing;
			preparing = null;
			watch?.();
			set({ loading: false, active: false, error: message });
		}
		return { ok: false as const, message };
	};
	const state = session.getState();
	const seqId = opts.sequenceId ?? state.activeSequenceId;
	const seq0 = seqId ? state.document.sequences[seqId] : undefined;
	if (!seq0) return fail(t('Open a sequence first'));
	if (session.gestureActive) return fail(t('Finish the current edit first'));
	set({ loading: true, error: null, soundId: entry.id, title: entry.title ?? entry.id });
	// closing the project or switching the sequence while the sound registers cancels it
	preparing = watchSession(session, () => {
		if (my === token) stopInContext({ returnToAnchor: false });
	});
	let sounds: Awaited<ReturnType<typeof registerLibrarySounds>>;
	try {
		sounds = await registerLibrarySounds(engine, state.document.projectId, [entry]);
	} catch (e) {
		if (my !== token) return cancelled();
		return fail(e instanceof Error ? e.message : String(e));
	}
	if (my !== token) return cancelled();
	const watch = preparing;
	preparing = null;
	watch?.();
	let gesture: Gesture | null = null;
	let run: Running | null = null;
	try {
		const doc = session.getCommitted();
		const seq = doc.sequences[seq0.id];
		if (!seq) return fail(t('The sequence was closed'));
		if (session.gestureActive) return fail(t('Finish the current edit first'));
		const anchor = opts.anchor ?? inContextAnchor(session, seq);
		const prepared = soundMediaCommands(session, doc, sounds, { refPrefix: '$audition' });
		const media = prepared.media.get(entry.id);
		if (!media) return fail(t('The sound cannot be placed here'));
		const commands: Command[] = [
			...prepared.commands,
			{
				type: 'soundDesign.place',
				sequenceId: seq.id,
				frame: anchor.frame,
				layers: [{ mediaId: media.ref, align: anchor.align }],
				clampStart: true,
			} as Command,
			...(anchor.muteClipId && seq.clips[anchor.muteClipId]
				? [{ type: 'clip.update', clipId: anchor.muteClipId, patch: { enabled: false } } as Command]
				: []),
		];
		gesture = session.beginGesture(t('Audition in Context'));
		const r = gesture.update(commands);
		if (!r.ok) {
			gesture.cancel();
			return fail(r.errors[0]?.message ?? t('The sound cannot be placed here'));
		}
		const placed = (
			r.results[prepared.commands.length] as { clips?: { start: number; duration: number }[] } | undefined
		)?.clips?.[0];
		const fps = fpsOf(seq);
		const preRoll = Math.round(soundLibraryPrefs.get().preRollSec * fps);
		const start = Math.max(0, anchor.frame - preRoll);
		const end = (placed ? placed.start + placed.duration : anchor.frame) + Math.round(POST_ROLL_SEC * fps);
		run = { session, gesture, returnTo: anchor.frame, end, offs: [], token: my };
		begin(run, media.title, entry.id);
		playWindow(run, start, fps);
		return { ok: true };
	} catch (e) {
		// never leave the gesture (and with it agents' edits, Undo and autosave) held by a failed start
		if (run && running === run) stopInContext({ returnToAnchor: false });
		else gesture?.cancel();
		const message = e instanceof Error ? e.message : String(e);
		set({ loading: false, active: false, error: message });
		return { ok: false, message };
	}
}

/**
 * Plays the committed timeline from `center − before` to `center + after` seconds and returns the playhead to
 * `returnTo` (Audition on swap: the 2 s around the swapped sound). Ends like an In Context audition. When it replaces
 * a window still playing, it returns to where that one would have (the playhead before the first of them).
 */
export function playTimelineWindow(
	session: EditorSession,
	seq: Pick<Sequence, 'settings'>,
	opts: {
		center: number;
		returnTo: number;
		title: string;
		before?: number;
		after?: number;
		/** Told when this window ends (it played to its end, or was stopped: a key, a click, the transport…). */
		onEnd?: (how: 'window' | 'stopped') => void;
		/** Key or pointer presses that do not stop it (every other press does). */
		keepPlayingOn?: (e: Event) => boolean;
	},
): void {
	const previous = running && running.session === session ? running.returnTo : null;
	stopInContext({ returnToAnchor: false });
	auditionPlayer().stop();
	const my = ++token;
	const fps = fpsOf(seq);
	const run: Running = {
		session,
		gesture: null,
		returnTo: previous ?? opts.returnTo,
		end: Math.round(opts.center + (opts.after ?? 1) * fps),
		offs: [],
		token: my,
		onEnd: opts.onEnd,
		keep: opts.keepPlayingOn,
	};
	try {
		begin(run, opts.title, null);
		playWindow(run, Math.round(opts.center - (opts.before ?? 1) * fps), fps);
	} catch {
		if (running === run) stopInContext({ returnToAnchor: false });
	}
}

// An agent's transaction ends an audition holding the session's gesture slot: it applies at once instead of being
// queued behind a preview (the audition never writes, so nothing of the user's is lost).
beforeAgentTransaction((session) => {
	if (running?.session === session && running.gesture) stopInContext();
});

/** Whether an In Context audition (or a swap window) is playing. */
export function inContextActive(): boolean {
	return inContextStore.getState().active;
}
