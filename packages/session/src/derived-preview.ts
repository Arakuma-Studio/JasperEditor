// Derived preview (spec 14 TC-042 "Play result" / "Play removed"; docs/wp-notes/transcript-cleanup.md "Clean Up UI"):
// a temporary timeline the Program monitor plays instead of the sequence — the committed document with some commands
// applied (`cleanup.apply` over the plan's ranges, or over the kept pieces to hear only what goes). It is never
// committed, never saved and never in History: the session's document is not touched. It ends when asked, when the
// committed document changes (the preview would be stale), when a gesture starts drawing its own transient, or when
// the session closes.
//
// The frames of the derived sequence differ from the committed one by the `omitted` ranges (sequence frames of the
// committed sequence the commands remove) and the `inserted` frames (edge repairs: frames a clip grows by, inserted at
// a committed frame), so callers map the playhead in (`toDerivedFrame`) when it starts and back (`toOriginalFrame`)
// when it ends. Nothing here throws: `start` resolves to `{ok: true}` or `{ok: false, code, …}`.
import {
	applyTransaction,
	type Command,
	createSeededIdSource,
	type ProjectDocument,
	TX_PROTOCOL,
} from '@jasper/project';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { EditorSession } from './session.ts';

/** Sorted, disjoint `[start, end)` sequence-frame ranges. */
export type FrameRanges = ReadonlyArray<readonly [number, number]>;
/** Frames inserted into the committed sequence: `[at, frames]` — `frames` new frames before committed frame `at`. */
export type FrameInserts = ReadonlyArray<readonly [number, number]>;

export type DerivedPreview = {
	/** Bumped at every start (a new preview, even of the same commands). */
	id: number;
	/** What the Program monitor chip names, e.g. "Clean Up result". */
	label: string;
	/** Who started it (e.g. `cleanup.result`, `cleanup.removed`). */
	kind: string;
	sequenceId: string;
	/** Session revision the preview was built on. */
	baseRevision: number;
	/** The committed document it was built on (identity: stale once the session's differs). */
	base: ProjectDocument;
	/** The derived document (never committed). */
	document: ProjectDocument;
	/** Frames of the committed sequence the derived one leaves out (sorted, disjoint). */
	omitted: FrameRanges;
	/** Frames the derived one adds (sorted by `at`; empty without edge repairs). */
	inserted: FrameInserts;
};

export type DerivedPreviewState = {
	active: DerivedPreview | null;
	/** Why the last preview ended (`stopped`, `stale`, `gesture`, `closed`), or null while one plays / none ran. */
	ended: 'stopped' | 'stale' | 'gesture' | 'closed' | null;
};

export type DerivedPreviewResult =
	| { ok: true; preview: DerivedPreview }
	| { ok: false; code: string; message: string };

/** Sorts and merges ranges (touching ones join; empty or non-finite ones are dropped). */
export function normalizeFrameRanges(ranges: FrameRanges): Array<[number, number]> {
	const xs = ranges
		.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
		.map(([a, b]) => [Math.round(a), Math.round(b)] as [number, number])
		.filter(([a, b]) => b > a)
		.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
	const out: Array<[number, number]> = [];
	for (const [a, b] of xs) {
		const l = out[out.length - 1];
		if (l && a <= l[1]) l[1] = Math.max(l[1], b);
		else out.push([a, b]);
	}
	return out;
}

/**
 * The derived frame of a committed frame: minus every omitted frame before it, plus every frame inserted at or before
 * it; a frame inside an omitted range maps to where the range was (its start, minus what was omitted before it).
 */
export function toDerivedFrame(omitted: FrameRanges, frame: number, inserted: FrameInserts = []): number {
	let removed = 0;
	let lo = 0;
	let hi = omitted.length;
	// ranges ending at or before `frame` are removed whole
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (omitted[mid]![1] <= frame) lo = mid + 1;
		else hi = mid;
	}
	// prefix sums would be O(1) per call; ranges are few hundred at most, and this runs at start / stop only
	for (let i = 0; i < lo; i++) removed += omitted[i]![1] - omitted[i]![0];
	const r = omitted[lo];
	const at = r && r[0] <= frame ? r[0] : frame;
	let added = 0;
	for (const [p, n] of inserted) if (p <= at) added += n;
	return at - removed + added;
}

/**
 * The committed frame a derived frame plays (inverse of `toDerivedFrame`): the last committed frame that maps at or
 * before it — after an omitted range its end, inside inserted frames the committed frame before them (the clip they
 * extend).
 */
export function toOriginalFrame(omitted: FrameRanges, derived: number, inserted: FrameInserts = []): number {
	if (!inserted.length) {
		let f = derived;
		for (const [a, b] of omitted) {
			if (a <= f) f += b - a;
			else break;
		}
		return f;
	}
	// toDerivedFrame is non-decreasing: the largest frame mapping at or before `derived`
	let lo = 0;
	let hi = Math.max(0, derived) + omitted.reduce((n, [a, b]) => n + b - a, 0) + 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (toDerivedFrame(omitted, mid, inserted) <= derived) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

export class DerivedPreviewController {
	readonly store: StoreApi<DerivedPreviewState>;
	private seq = 0;
	private readonly offs: Array<() => void> = [];

	constructor(private readonly session: EditorSession) {
		this.store = createStore<DerivedPreviewState>(() => ({ active: null, ended: null }));
		this.offs.push(
			session.on('doc.changed', () => this.end('stale')),
			session.on('gesture.changed', (e) => {
				if (e.active) this.end('gesture');
			}),
			session.on('closed', () => this.end('closed')),
		);
	}

	getState(): DerivedPreviewState {
		return this.store.getState();
	}

	/**
	 * Builds the derived document: `commands` applied to the committed document as a dry transaction (seeded ids, the
	 * session's registries and invariant checks). Replaces a running preview.
	 */
	start(input: {
		label: string;
		kind: string;
		sequenceId: string;
		commands: Command[];
		omitted: FrameRanges;
		inserted?: FrameInserts;
	}): DerivedPreviewResult {
		const s = this.session.getState();
		if (this.session.gestureActive)
			return { ok: false, code: 'E_BUSY', message: 'Finish the current drag or edit first' };
		const base = s.document;
		if (!base.sequences[input.sequenceId])
			return { ok: false, code: 'E_NOT_FOUND', message: `Sequence not found: ${input.sequenceId}` };
		let out: ReturnType<typeof applyTransaction>;
		try {
			out = applyTransaction(
				base,
				{
					protocol: TX_PROTOCOL,
					label: input.label,
					origin: 'user',
					sequenceId: input.sequenceId,
					commands: input.commands,
				},
				{
					ids: createSeededIdSource(`derived-preview:${input.kind}:${this.seq + 1}`),
					now: this.session.ctx.now ?? (() => new Date().toISOString()),
					registries: this.session.ctx.registries,
					revision: s.revision,
					invariants: 'incremental',
				},
			);
		} catch (e) {
			return { ok: false, code: 'E_INTERNAL', message: e instanceof Error ? e.message : String(e) };
		}
		if (!out.result.ok) {
			const first = out.result.errors[0];
			return {
				ok: false,
				code: first?.code ?? 'E_INTERNAL',
				message: first?.message ?? 'The preview could not be built',
			};
		}
		const preview: DerivedPreview = {
			id: ++this.seq,
			label: input.label,
			kind: input.kind,
			sequenceId: input.sequenceId,
			baseRevision: s.revision,
			base,
			document: out.document,
			omitted: normalizeFrameRanges(input.omitted),
			inserted: (input.inserted ?? [])
				.filter(([at, n]) => Number.isFinite(at) && Number.isFinite(n) && n > 0)
				.map(([at, n]) => [Math.round(at), Math.round(n)] as const)
				.sort((x, y) => x[0] - y[0]),
		};
		this.store.setState({ active: preview, ended: null });
		return { ok: true, preview };
	}

	/** Ends the preview (nothing to undo: the session never saw it). */
	stop(): void {
		this.end('stopped');
	}

	private end(why: NonNullable<DerivedPreviewState['ended']>): void {
		if (!this.store.getState().active) return;
		this.store.setState({ active: null, ended: why });
	}

	dispose(): void {
		this.end('closed');
		for (const off of this.offs.splice(0)) off();
	}
}

const controllers = new WeakMap<EditorSession, DerivedPreviewController>();

/** The derived-preview controller of a session (one per session, created on first use). */
export function derivedPreviewFor(session: EditorSession): DerivedPreviewController {
	let c = controllers.get(session);
	if (!c) {
		c = new DerivedPreviewController(session);
		controllers.set(session, c);
	}
	return c;
}

/**
 * The document the Program monitor plays for a derived preview, or null: none running, a gesture draws its own
 * transient, or the committed document moved on (the controller ends it on the next event anyway).
 */
export function derivedPreviewDocument(
	state: Pick<DerivedPreviewState, 'active'>,
	session: Pick<EditorSession, 'gestureActive' | 'getCommitted'>,
): ProjectDocument | null {
	const a = state.active;
	if (!a || session.gestureActive) return null;
	if (session.getCommitted() !== a.base) return null;
	return a.document;
}
