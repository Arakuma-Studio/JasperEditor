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
// paused, then Play). Any other action ends it: a key, a pointer press, the transport stopping, another audition.
//
// Also `playTimelineWindow` (Audition on swap): plays the committed timeline around a frame and returns.
import type { EngineClient } from '@jasper/engine-client';
import type { Command, Rational, Sequence, SoundAlignRequest, SoundCue } from '@jasper/project';
import type { EditorSession, Gesture } from '@jasper/session';
import { createStore } from 'zustand/vanilla';
import { t } from '../i18n/runtime.ts';
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

type Running = {
	session: EditorSession;
	gesture: Gesture | null;
	returnTo: number;
	end: number;
	offTransport: () => void;
	offInput: () => void;
	token: number;
};

let running: Running | null = null;
let token = 0;

function set(patch: Partial<InContextState>): void {
	inContextStore.setState(patch);
}

/** Stops whatever plays in context (the gesture is cancelled: nothing was written). */
export function stopInContext(opts: { returnToAnchor?: boolean } = {}): void {
	token++;
	const r = running;
	running = null;
	if (r) {
		r.offTransport();
		r.offInput();
		const transport = r.session.transport;
		if (transport.getState().playing) transport.pause();
		r.gesture?.cancel();
		if (opts.returnToAnchor !== false) transport.seek(r.returnTo);
	}
	const st = inContextStore.getState();
	if (st.active || st.loading)
		set({ active: false, loading: false, soundId: null, title: null, epoch: st.epoch + 1 });
}

/** Ends the audition on the next key or pointer press anywhere (installed after the gesture that started it). */
function endOnInput(stop: () => void): () => void {
	if (typeof window === 'undefined') return () => undefined;
	let on = false;
	const handler = (e: Event) => {
		// modifier keys alone (holding Shift of Shift+Space) do not end it
		if (e instanceof KeyboardEvent && ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
		stop();
	};
	const timer = setTimeout(() => {
		on = true;
		window.addEventListener('keydown', handler, true);
		window.addEventListener('pointerdown', handler, true);
	}, 0);
	return () => {
		clearTimeout(timer);
		if (on) {
			window.removeEventListener('keydown', handler, true);
			window.removeEventListener('pointerdown', handler, true);
		}
	};
}

function fpsOf(seq: Pick<Sequence, 'settings'>): number {
	const r = seq.settings.frameRate as Rational;
	return r.den > 0 && r.num > 0 ? r.num / r.den : 30;
}

/** Plays [start, end) of the drawn timeline, then pauses and seeks to `returnTo` (unless something else took over). */
function playWindow(r: Running, start: number): void {
	const transport = r.session.transport;
	if (transport.getState().playing) transport.pause();
	transport.seek(Math.max(0, start));
	let started = false;
	r.offTransport = transport.subscribe((st, prev) => {
		if (running !== r) return;
		if (st.playing && !prev.playing) started = true;
		// the user (or the end of the sequence) stopped it, or the window is over
		if ((started && !st.playing) || st.frame >= r.end) stopInContext();
	});
	transport.play(1);
}

/**
 * Plays a candidate sound in context (see the module comment). Resolves when playback starts (or fails: the message
 * is in the store and returned). Never changes the document or history.
 */
export async function auditionInContext(
	session: EditorSession,
	engine: Pick<EngineClient, 'registerSound'>,
	entry: LibraryEntryLike,
	opts: { sequenceId?: string; anchor?: InContextAnchor } = {},
): Promise<{ ok: true } | { ok: false; message: string }> {
	stopInContext({ returnToAnchor: false });
	auditionPlayer().stop();
	const my = ++token;
	const fail = (message: string) => {
		if (my === token) set({ loading: false, active: false, error: message });
		return { ok: false as const, message };
	};
	const state = session.getState();
	const seqId = opts.sequenceId ?? state.activeSequenceId;
	const seq0 = seqId ? state.document.sequences[seqId] : undefined;
	if (!seq0) return fail(t('Open a sequence first'));
	if (session.gestureActive) return fail(t('Finish the current edit first'));
	set({ loading: true, error: null, soundId: entry.id, title: entry.title ?? entry.id });
	let sounds: Awaited<ReturnType<typeof registerLibrarySounds>>;
	try {
		sounds = await registerLibrarySounds(engine, state.document.projectId, [entry]);
	} catch (e) {
		return fail(e instanceof Error ? e.message : String(e));
	}
	if (my !== token) return { ok: false, message: t('Cancelled') };
	const doc = session.getCommitted();
	const seq = doc.sequences[seq0.id];
	if (!seq) return fail(t('The sequence was closed'));
	if (session.gestureActive) return fail(t('Finish the current edit first'));
	const anchor = opts.anchor ?? inContextAnchor(session, seq);
	const prepared = soundMediaCommands(session, doc, sounds, { refPrefix: '$audition' });
	const media = prepared.media.get(entry.id)!;
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
	const gesture = session.beginGesture(t('Audition in Context'));
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
	const run: Running = {
		session,
		gesture,
		returnTo: anchor.frame,
		end,
		offTransport: () => undefined,
		offInput: () => undefined,
		token: my,
	};
	running = run;
	run.offInput = endOnInput(() => {
		if (running === run) stopInContext();
	});
	set({
		active: true,
		loading: false,
		soundId: entry.id,
		title: media.title,
		error: null,
		epoch: inContextStore.getState().epoch + 1,
	});
	playWindow(run, start);
	return { ok: true };
}

/**
 * Plays the committed timeline from `center − before` to `center + after` seconds and returns the playhead to
 * `returnTo` (Audition on swap: the 2 s around the swapped sound). Ends like an In Context audition.
 */
export function playTimelineWindow(
	session: EditorSession,
	seq: Pick<Sequence, 'settings'>,
	opts: { center: number; returnTo: number; title: string; before?: number; after?: number },
): void {
	stopInContext({ returnToAnchor: false });
	auditionPlayer().stop();
	const my = ++token;
	const fps = fpsOf(seq);
	const run: Running = {
		session,
		gesture: null,
		returnTo: opts.returnTo,
		end: Math.round(opts.center + (opts.after ?? 1) * fps),
		offTransport: () => undefined,
		offInput: () => undefined,
		token: my,
	};
	running = run;
	run.offInput = endOnInput(() => {
		if (running === run) stopInContext();
	});
	set({
		active: true,
		loading: false,
		soundId: null,
		title: opts.title,
		error: null,
		epoch: inContextStore.getState().epoch + 1,
	});
	playWindow(run, Math.round(opts.center - (opts.before ?? 1) * fps));
}

/** Whether an In Context audition (or a swap window) is playing. */
export function inContextActive(): boolean {
	return inContextStore.getState().active;
}
