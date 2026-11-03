// What an open text entry holds, checkpointed to this tab's sessionStorage when typing pauses (spec 19 TL-085, AGENTS §0).
// A renderer that is killed reaches no `pagehide`, error boundary or unmount, so nothing commits what was typed; the
// crash-recovery journal holds transactions, and an entry is not one until it commits. sessionStorage outlives a reload
// of the tab, so the next Program monitor of the project in this tab offers the text back (TextEntryEditor.tsx). One
// checkpoint per project per tab; a commit or an entry that changes nothing clears it. Read through zod: the storage is
// the page's, and anything there may be stale or foreign.
import { TextContentSchema, type TextRun, type Vec2 } from '@jasper/project';
import { z } from 'zod';
import { createStore } from 'zustand/vanilla';

/** How long typing must pause before the draft is written. */
export const CHECKPOINT_IDLE_MS = 400;
/** Longest text kept (a title is far shorter; this bounds what the page stores and parses back). */
const MAX_CHECKPOINT_TEXT = 20_000;
const MAX_CHECKPOINT_RUNS = 2_000;

const CheckpointSchema = z.object({
	v: z.literal(1),
	sequenceId: z.string().min(1).max(128),
	clipId: z.string().min(1).max(128).nullable(),
	point: z.tuple([z.number().finite(), z.number().finite()]),
	frame: z.number().int().min(0).max(1e9),
	text: z.string().min(1).max(MAX_CHECKPOINT_TEXT),
	runs: TextContentSchema.shape.runs.unwrap().max(MAX_CHECKPOINT_RUNS),
	savedAt: z.string().max(64),
});
export type TextEntryCheckpoint = {
	sequenceId: string;
	clipId: string | null;
	point: Vec2;
	frame: number;
	text: string;
	runs: TextRun[];
	savedAt: string;
};

const key = (projectId: string) => `jasper:text-entry:${projectId}`;

/** Bumped on every write and clear, so an offer on screen reads again. */
export const checkpointEpoch = createStore<{ n: number }>(() => ({ n: 0 }));
const bump = () => checkpointEpoch.setState((s) => ({ n: s.n + 1 }));

function storage(): Storage | null {
	try {
		return typeof sessionStorage === 'undefined' ? null : sessionStorage;
	} catch {
		return null;
	}
}

export function writeCheckpoint(projectId: string, c: Omit<TextEntryCheckpoint, 'savedAt'>): void {
	const s = storage();
	if (!s || !c.text || c.text.length > MAX_CHECKPOINT_TEXT) return;
	try {
		s.setItem(key(projectId), JSON.stringify({ v: 1, ...c, savedAt: new Date().toISOString() }));
		bump();
	} catch (e) {
		// Storage full or refused: the entry still commits as usual; only a killed renderer would lose it.
		console.warn('[text entry] the draft could not be checkpointed', e);
	}
}

export function readCheckpoint(projectId: string): TextEntryCheckpoint | null {
	let raw: string | null = null;
	try {
		raw = storage()?.getItem(key(projectId)) ?? null;
	} catch {
		return null;
	}
	if (!raw || raw.length > 4 * MAX_CHECKPOINT_TEXT + 1_000_000) return null;
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return null;
	}
	const r = CheckpointSchema.safeParse(json);
	if (!r.success) return null;
	const { v: _v, ...c } = r.data;
	return { ...c, point: [c.point[0], c.point[1]], runs: c.runs as TextRun[] };
}

export function clearCheckpoint(projectId: string): void {
	const s = storage();
	try {
		if (s?.getItem(key(projectId)) === null) return;
		s?.removeItem(key(projectId));
		bump();
	} catch {
		// unavailable storage holds nothing to clear
	}
}
