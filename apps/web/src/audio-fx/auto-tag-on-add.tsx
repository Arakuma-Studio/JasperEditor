// Preferences ▸ Audio ▸ "Auto-tag audio types in the timeline" (Premiere; WP6.5a): when on, audio clips the user adds to
// a sequence (placing, dropping, pasting, inserting, recording — not undo / redo, not agents, not the parts a Razor or
// an insert edit splits off, not the clips of a new or duplicated sequence) are classified on the engine and tagged
// through the same route and command as Essential Sound ▸ Auto Tag (`autoTagClips`: one `audio-classify` job, one
// "Auto Tag Audio Types" History entry). Clips the user typed, deleted or locked meanwhile are left out. Mounted
// invisibly through the Program monitor overlay registry, like the automatic transcription.
import type { EngineClient } from '@jasper/engine-client';
import { type AudioClip, type ProjectDocument, readEssentialSound, type Sequence } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { toast } from '@jasper/ui';
import { useEffect } from 'react';
import { audioPrefs } from '../audio/prefs.ts';
import type { ProgramOverlayHostProps } from '../extensions/index.ts';
import { t } from '../i18n/runtime.ts';
import { useEngineOrNull } from '../state/engine.tsx';
import { autoTagClips } from './ops.ts';

const end = (c: { start: number; duration: number }) => c.start + c.duration;

function trackLocked(seq: Sequence, trackId: string): boolean {
	return !!seq.audioTracks.find((tr) => tr.id === trackId)?.locked;
}

/** An audio clip Auto Tag may tag now: in the sequence, untyped, on an unlocked track. */
export function autoTaggable(seq: Sequence | undefined, clipId: string): boolean {
	const c = seq?.clips[clipId];
	return !!seq && c?.kind === 'audio' && !readEssentialSound(c.essential) && !trackLocked(seq, c.trackId);
}

/**
 * The right part of a split (Razor, Add Edit, an insert or overwrite edit through a clip): the clip before it on its
 * track plays the same media up to its start and covered its range before the edit.
 */
function splitPart(before: Sequence, after: Sequence, c: AudioClip): boolean {
	for (const l of Object.values(after.clips)) {
		if (l.id === c.id || l.kind !== 'audio' || l.trackId !== c.trackId || l.mediaId !== c.mediaId) continue;
		if (end(l) !== c.start) continue;
		const was = before.clips[l.id];
		if (was && was.start <= l.start && end(was) > c.start) return true;
	}
	return false;
}

/** The audio clips a transaction added that auto-tagging should listen to, by sequence. */
export function addedClipsToTag(
	before: ProjectDocument,
	after: ProjectDocument,
	created: readonly string[],
): Map<string, string[]> {
	const out = new Map<string, string[]>();
	if (!created.length) return out;
	const ids = new Set(created);
	for (const [seqId, seq] of Object.entries(after.sequences)) {
		const prev = before.sequences[seqId];
		// a new or duplicated sequence is not "adding clips to a sequence"; unchanged clips added nothing
		if (!prev || prev.clips === seq.clips) continue;
		for (const id of ids) {
			const c = seq.clips[id];
			if (!c || c.kind !== 'audio' || prev.clips[id] || !autoTaggable(seq, id)) continue;
			if (splitPart(prev, seq, c)) continue;
			const list = out.get(seqId) ?? [];
			list.push(id);
			out.set(seqId, list);
		}
	}
	return out;
}

/** Resolves when the editor holds no gesture (a drag in progress), or when the session closes. */
function gestureFree(session: EditorSession): Promise<void> {
	if (!session.getState().gesture) return Promise.resolve();
	return new Promise((resolve) => {
		const offs: (() => void)[] = [];
		const done = () => {
			for (const off of offs) off();
			resolve();
		};
		offs.push(session.on('gesture.changed', (e) => !e.active && done()));
		offs.push(session.on('closed', done));
	});
}

const FAILURE_TOAST_MS = 60_000;

/**
 * Watches `session` and tags what the user adds while the preference is on. Batches the clips of edits made within
 * `debounceMs`, one engine job at a time. Returns the stop function.
 */
export function watchAutoTagOnAdd(
	session: EditorSession,
	engine: EngineClient,
	opts: { debounceMs?: number; enabled?: () => boolean } = {},
): () => void {
	const enabled = opts.enabled ?? (() => audioPrefs.get().autoTagInTimeline);
	let prev = session.getCommitted();
	const queue = new Map<string, Set<string>>();
	let timer: ReturnType<typeof setTimeout> | null = null;
	let running = false;
	let stopped = false;
	let lastFailure = Number.NEGATIVE_INFINITY;
	const abort = new AbortController();

	const flush = async () => {
		timer = null;
		if (running || stopped) return;
		const first = queue.entries().next();
		if (first.done) return;
		const [seqId, set] = first.value;
		queue.delete(seqId);
		running = true;
		try {
			await autoTagClips(session, engine, seqId, [...set], {
				signal: abort.signal,
				beforeApply: () => gestureFree(session),
				keep: (doc, id) => !stopped && !session.getState().readOnly && autoTaggable(doc.sequences[seqId], id),
			});
		} catch (e) {
			if (!stopped && Date.now() - lastFailure > FAILURE_TOAST_MS) {
				lastFailure = Date.now();
				toast({
					kind: 'warning',
					title: t('Auto-tag in the timeline failed'),
					detail: (e as Error).message,
				});
			}
		} finally {
			running = false;
			if (!stopped && queue.size) void flush();
		}
	};

	const off = session.on('doc.changed', (ev) => {
		const before = prev;
		prev = session.getCommitted();
		if (stopped || ev.isUndo || ev.isRedo || ev.origin !== 'user' || !ev.created.length) return;
		if (session.getState().readOnly || !enabled()) return;
		const added = addedClipsToTag(before, prev, ev.created);
		if (!added.size) return;
		for (const [seqId, ids] of added) {
			const set = queue.get(seqId) ?? new Set<string>();
			for (const id of ids) set.add(id);
			queue.set(seqId, set);
		}
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => void flush(), opts.debounceMs ?? 400);
	});
	return () => {
		stopped = true;
		abort.abort();
		off();
		if (timer) clearTimeout(timer);
		queue.clear();
	};
}

export function AutoTagOnAddHost({ session }: Pick<ProgramOverlayHostProps, 'session'>) {
	const engine = useEngineOrNull();
	const client = engine?.status === 'connected' ? engine.client : null;
	useEffect(() => {
		if (!session || !client) return;
		return watchAutoTagOnAdd(session, client);
	}, [session, client]);
	return null;
}
