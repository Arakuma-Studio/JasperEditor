// The text of an open in-place entry, outside React (spec 19 TL-085): a crash boundary, a page closing or the overlay
// unmounting must still find what was typed (AGENTS §0). While text changes the entry holds a session gesture: the
// Program monitor draws the transient document, so a look renders the letters as they are typed; committing makes the
// whole entry one History step and cancelling leaves nothing. An entry that changes nothing holds no gesture.
import {
	type Clip,
	type Command,
	contentTimeAt,
	type Keyframe,
	remapParagraphs,
	remapTextRuns,
	sourceTextContentAt,
	type TextContent,
	type TextRun,
} from '@jasper/project';
import type { EditorSession, Gesture } from '@jasper/session';
import { t } from '../i18n/runtime.ts';
import { activeSequence, textPlacement } from '../panels/program/edits.ts';
import { CHECKPOINT_IDLE_MS, clearCheckpoint, writeCheckpoint } from './checkpoint.ts';
import type { TextEntry } from './store.ts';

type TextClip = Extract<Clip, { kind: 'text' }>;

/** Editor-local undo states kept per entry. */
const MAX_LOCAL_UNDO = 200;

export type DraftValue = { text: string; runs: TextRun[] };
export type DraftState = DraftValue & { undo: DraftValue[]; redo: DraftValue[]; error: string | null };
export type CommitResult = { ok: true; clipId: string | null } | { ok: false; error: string };

/** The clip in the committed document: a transient one is this entry's own drawing. */
function clipOf(session: EditorSession, id: string | null): TextClip | null {
	const st = session.getState();
	const c = id && st.activeSequenceId ? st.document.sequences[st.activeSequenceId]?.clips[id] : undefined;
	return c?.kind === 'text' ? (c as TextClip) : null;
}

const keysOf = (c: TextClip) => (c.sourceTextKeyframes ?? []) as Keyframe<TextContent>[];

/** The content an edit starts from: what is drawn at the frame, for a clip with Source Text keys. */
export function storedContent(session: EditorSession, clip: TextClip, frame: number): TextContent {
	const seq = activeSequence(session);
	if (!seq || keysOf(clip).length === 0) return clip.content;
	const t0 = contentTimeAt(
		clip,
		Math.max(clip.start, Math.min(clip.start + clip.duration - 1, frame)),
		seq.settings.frameRate,
	);
	return sourceTextContentAt({ text: clip.content, sourceTextKeyframes: keysOf(clip) }, t0);
}

export class EntryDraft {
	readonly entry: TextEntry;
	private state: DraftState;
	private readonly listeners = new Set<() => void>();
	/** What the entry started from: an unchanged entry writes nothing. */
	private readonly base: DraftValue;
	private readonly paragraphsBase: TextContent['paragraphs'];
	private gesture: Gesture | null = null;
	/** The clip an unfinished new text is drawn as: new ids per gesture update. */
	private drawnId: string | null;
	private placement: ReturnType<typeof textPlacement> = null;
	private checkpointTimer: ReturnType<typeof setTimeout> | null = null;
	closed = false;

	constructor(entry: TextEntry) {
		this.entry = entry;
		const clip = clipOf(entry.session, entry.clipId);
		const stored = clip ? storedContent(entry.session, clip, entry.frame) : null;
		this.base = { text: stored?.text ?? '', runs: [...(stored?.runs ?? [])] };
		this.paragraphsBase = stored?.paragraphs;
		this.drawnId = entry.clipId;
		const first = entry.recovered ?? this.base;
		this.state = { ...first, undo: [], redo: [], error: null };
		if (!entry.clipId) this.placement = textPlacement(entry.session, entry.frame);
	}

	/** The clip the Program monitor draws for this entry, if any. */
	get clipId(): string | null {
		return this.drawnId;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	getState = (): DraftState => this.state;

	private set(next: Partial<DraftState>) {
		this.state = { ...this.state, ...next };
		if ('text' in next || 'runs' in next) this.scheduleCheckpoint();
		for (const l of [...this.listeners]) l();
	}

	/** Checkpoints what was typed to the tab once typing pauses (checkpoint.ts): only a killed renderer needs it. */
	private scheduleCheckpoint(): void {
		if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
		this.checkpointTimer = setTimeout(() => this.checkpointNow(), CHECKPOINT_IDLE_MS);
	}

	/** Writes the checkpoint now: an unchanged entry has none. */
	checkpointNow(): void {
		if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
		this.checkpointTimer = null;
		const { session, clipId, point, frame } = this.entry;
		const sequenceId = session.getState().activeSequenceId;
		const { text, runs } = this.state;
		if (!sequenceId || !text.trim() || !this.changed()) {
			clearCheckpoint(session.projectId);
			return;
		}
		writeCheckpoint(session.projectId, {
			sequenceId,
			clipId,
			point: [point[0], point[1]],
			frame,
			text,
			runs: [...runs],
		});
	}

	/** The entry is over: what it wrote is in the document, so its checkpoint goes. */
	private endCheckpoint(): void {
		if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
		this.checkpointTimer = null;
		clearCheckpoint(this.entry.session.projectId);
	}

	/** New text and runs (typed, pasted, restyled). `record: false` keeps the local undo stack (composition). */
	update(value: DraftValue, opts: { record?: boolean } = {}): void {
		const { text, runs, undo } = this.state;
		if (value.text === text && value.runs === runs) return;
		this.set({
			...value,
			undo: opts.record === false ? undo : [...undo, { text, runs }].slice(-MAX_LOCAL_UNDO),
			redo: opts.record === false ? this.state.redo : [],
			error: null,
		});
		this.push();
	}

	/** Text typed over the current text: the runs follow it. */
	typed(text: string): void {
		const s = this.state;
		this.update({ text, runs: remapTextRuns(s.text, text, s.runs) });
	}

	undoLocal(redo: boolean): boolean {
		const s = this.state;
		const stack = redo ? s.redo : s.undo;
		const value = stack[stack.length - 1];
		if (!value) return false;
		const now: DraftValue = { text: s.text, runs: s.runs };
		this.set({
			...value,
			undo: redo ? [...s.undo, now] : s.undo.slice(0, -1),
			redo: redo ? s.redo.slice(0, -1) : [...s.redo, now],
			error: null,
		});
		this.push();
		return true;
	}

	private changed(): boolean {
		const s = this.state;
		return s.text !== this.base.text || JSON.stringify(s.runs) !== JSON.stringify(this.base.runs);
	}

	/** The commands of the entry as it stands. `final`: the entry ends, and an empty one leaves nothing behind. */
	private commands(final: boolean): Command[] {
		const { session, clipId, frame, point } = this.entry;
		const { text, runs } = this.state;
		if (!clipId) return text.trim() ? this.addCommands(text, runs, point) : [];
		if (!this.changed()) return [];
		const clip = clipOf(session, clipId);
		const seq = activeSequence(session);
		// The clip went while it was edited (another window, an agent): what was typed becomes a new text.
		if (!clip || !seq) return text.trim() ? this.addCommands(text, runs, point) : [];
		if (final && !text.trim()) return [{ type: 'clip.lift', clipIds: [clip.id] } as Command];
		const paragraphs = remapParagraphs(this.base.text, text, this.paragraphsBase);
		if (keysOf(clip).length > 0) {
			const at = Math.max(clip.start, Math.min(clip.start + clip.duration - 1, frame));
			return [
				{
					type: 'param.set',
					target: ['clip', clip.id, 'text', 'sourceText'],
					value: { ...storedContent(session, clip, frame), text, runs, paragraphs },
					at: { sequenceFrame: at },
					sequenceId: seq.id,
				} as Command,
			];
		}
		return [
			{
				type: 'clip.update',
				clipId: clip.id,
				patch: {
					content: {
						text,
						runs,
						...(this.paragraphsBase?.length ? { paragraphs } : {}),
					},
				},
			} as Command,
		];
	}

	private addCommands(text: string, runs: readonly TextRun[], point: readonly number[]): Command[] {
		this.placement ??= textPlacement(this.entry.session, this.entry.frame);
		const p = this.placement;
		if (!p) return [];
		return [
			{
				type: 'clip.addText',
				ref: '$text',
				sequenceId: p.sequenceId,
				at: p.at,
				duration: p.duration,
				track: p.track,
				content: { text, ...(runs.length ? { runs } : {}) },
				transform: { position: [Math.round(point[0]!), Math.round(point[1]!)] },
			} as Command,
		];
	}

	/** Draws the entry as it stands, as a transient document. A refusal shows when the entry is committed. */
	push(): void {
		const { session } = this.entry;
		if (this.closed || session.getState().readOnly) return;
		const commands = this.commands(false);
		try {
			if (commands.length === 0) {
				if (this.gesture?.active) this.gesture.cancel();
				this.gesture = null;
				if (!this.entry.clipId) this.drawnId = null;
				return;
			}
			if (!this.gesture?.active) {
				if (session.gestureActive) return;
				this.gesture = session.beginGesture(this.label());
			}
			const r = this.gesture.update(commands);
			if (r.ok && !this.entry.clipId) this.drawnId = r.refs.$text ?? r.created[0] ?? null;
		} catch (e) {
			console.warn('[program] drawing the text entry failed', e);
		}
	}

	private label(): string {
		return this.entry.clipId ? t('Edit Text') : t('Add Text');
	}

	/** Writes the entry as one History step. A refusal leaves the entry open with the reason: nothing is lost. */
	commit(): CommitResult {
		if (this.closed) return { ok: true, clipId: this.drawnId };
		const { session, clipId } = this.entry;
		const commands = this.commands(true);
		if (commands.length === 0) {
			this.cancel();
			return { ok: true, clipId };
		}
		const fail = (error: string): CommitResult => {
			this.set({ error });
			// Refused: the text is only here now, so the tab keeps it at once.
			this.checkpointNow();
			return { ok: false, error };
		};
		if (session.getState().readOnly) return fail(t('The project is read-only'));
		let r: ReturnType<EditorSession['apply']> | null;
		try {
			if (this.gesture?.active) {
				const u = this.gesture.update(commands);
				if (!u.ok) return fail(u.errors.map((x) => x.message).join('; '));
				r = this.gesture.commit();
				this.gesture = null;
			} else r = session.apply({ label: this.label(), origin: 'user', commands: commands as never });
		} catch (e) {
			return fail(e instanceof Error ? e.message : String(e));
		}
		if (!r) return fail(t('The text could not be written'));
		if (!r.ok)
			return fail(
				r.errors[0]?.code === 'E_TRACK_LOCKED'
					? t('The clip’s track is locked')
					: r.errors.map((x) => x.message).join('; '),
			);
		this.closed = true;
		this.endCheckpoint();
		const id = r.refs.$text ?? (commands[0]?.type === 'clip.lift' ? null : clipId);
		if (id) session.select('timeline', [id], 'replace', { primary: id });
		return { ok: true, clipId: id };
	}

	/**
	 * Ends the entry without writing. `keepText`: what was typed lives on elsewhere (a new editor, the message), so the
	 * tab's checkpoint stays as the last copy until that ends.
	 */
	cancel(opts: { keepText?: boolean } = {}): void {
		if (opts.keepText) this.checkpointNow();
		else this.endCheckpoint();
		this.closed = true;
		if (this.gesture?.active) this.gesture.cancel();
		this.gesture = null;
	}
}

let live: EntryDraft | null = null;

/** The draft of the open entry (what a crash boundary and the page closing commit). */
export function liveDraft(): EntryDraft | null {
	return live;
}

export function setLiveDraft(d: EntryDraft | null): void {
	live = d;
}
