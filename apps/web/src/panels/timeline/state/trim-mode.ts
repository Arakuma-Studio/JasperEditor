// edit-ux: keyboard trim mode (Premiere "Trim Mode" / "Trim Monitor", helpx.adobe.com "Trimming clips"):
// selected edit points live in the Timeline's ui-store; this module holds the trim session shown by the Trim
// Monitor (shift counters, dynamic J/K/L trimming, Play Around the Edit, numeric entry) and the operations the
// trim commands run.
//
// Semantics ported from FilmCraft crates/engine/src/trim.rs (MIT OR Apache-2.0, Copyright (c) 2026 ArtCraft Team
// and the FilmCraft contributors): counters count how far the outgoing Out / incoming In moved since the edit
// point was selected (a roll moves both); dynamic trimming re-applies the whole offset to the document as it was
// before the trim on every tick (a session gesture: never cumulative), stops at limits, and K commits it as ONE
// undo step labelled "Dynamic Rolling Edit" / "Dynamic Ripple Trim" / "Dynamic Trim"; Esc cancels.
import {
	type EditPoint,
	editPointFrame,
	type NearestKind,
	nearestEditPoints,
	nextTrimType,
	type Sequence,
	type TrimType,
} from '@jasper/project';
import type { EditorSession, Gesture } from '@jasper/session';
import { createStore } from 'zustand/vanilla';
import { gapsPrefs } from '../../../gaps/app-prefs.ts';
import type { TimelineHandle } from '../env.tsx';
import type { EditPointSel, TimelineUiStore } from './ui-store.ts';

export const largeTrimOffset = (): number => gapsPrefs.get().trim.largeTrimOffset;
export const prerollSeconds = (): number => gapsPrefs.get().playback.prerollSeconds;
export const postrollSeconds = (): number => gapsPrefs.get().playback.postrollSeconds;
const MAX_DYNAMIC_SPEED = 8;
const SLOW_DYNAMIC_SPEED = 0.25;

type DynamicTrimInfo = { speed: number; offset: number; atLimit: boolean };

type TrimModeState = {
	/** Trim mode is on (the Program monitor shows the Trim Monitor while edit points are selected). */
	active: boolean;
	sequenceId: string | null;
	/** Frames the outgoing clip's Out / the incoming clip's In moved since the edit points were selected. */
	outShift: number;
	inShift: number;
	dynamic: DynamicTrimInfo | null;
	/** Looping playback around the edit (Space in trim mode). */
	playAround: boolean;
	/** Numeric trim entry in progress ("+12", "-3"), or null. */
	numeric: string | null;
};

export const trimMode = createStore<TrimModeState>(() => ({
	active: false,
	sequenceId: null,
	outShift: 0,
	inShift: 0,
	dynamic: null,
	playAround: false,
	numeric: null,
}));

// ---------------------------------------------------------------- edit points ↔ ui-store

function toEditPoint(p: EditPointSel): EditPoint {
	return { clipId: p.clipId, edge: p.side, mode: p.type };
}

export function editPointsOf(ui: TimelineUiStore | null | undefined): EditPoint[] {
	return (ui?.getState().editPoints ?? []).map(toEditPoint);
}

function toSel(seq: Sequence, p: EditPoint): EditPointSel | null {
	const c = seq.clips[p.clipId];
	const frame = editPointFrame(seq, p);
	if (!c || frame === null) return null;
	return { trackId: c.trackId, frame, side: p.edge, clipId: p.clipId, type: p.mode };
}

/** Writes edit points to the ui-store (frames from the document). */
export function setEditPoints(ui: TimelineUiStore, seq: Sequence, points: readonly EditPoint[]): void {
	ui.setState({ editPoints: points.map((p) => toSel(seq, p)).filter((p): p is EditPointSel => !!p) });
}

/** Re-reads the edit point frames after an edit (clips keep their ids through trims). */
export function refreshEditPoints(ui: TimelineUiStore, seq: Sequence): void {
	const cur = ui.getState().editPoints;
	if (cur.length === 0) return;
	const next = cur.map((p) => toSel(seq, toEditPoint(p))).filter((p): p is EditPointSel => !!p);
	if (
		next.length !== cur.length ||
		next.some((p, i) => p.frame !== cur[i]!.frame || p.trackId !== cur[i]!.trackId)
	)
		ui.setState({ editPoints: next });
}

/** Starts a trim session (new selection → counters reset, FilmCraft `reset_shift`). */
export function enterTrimMode(sequenceId: string): void {
	trimMode.setState({ active: true, sequenceId, outShift: 0, inShift: 0, numeric: null });
}

export function exitTrimMode(): void {
	if (dynamic) dynamic.cancel();
	stopPlayAround();
	trimMode.setState({ active: false, numeric: null, dynamic: null, playAround: false });
}

/** Selects the nearest edit points (Shift+T as roll, or the Select Nearest Edit Point commands) and enters trim mode. */
export function selectNearest(
	handle: TimelineHandle,
	seq: Sequence,
	frame: number,
	kind: NearestKind,
	trackIds: readonly string[],
): EditPoint[] {
	const points = nearestEditPoints(seq, frame, kind, trackIds);
	setEditPoints(handle.ui, seq, points);
	if (points.length) enterTrimMode(seq.id);
	return points;
}

/** Toggle Trim Type (Ripple → Roll → Trim). Rolls need a clip on both sides; such points keep their type. */
export function cycleTrimTypes(ui: TimelineUiStore, seq: Sequence): void {
	const next = ui.getState().editPoints.map((p) => {
		let t: TrimType = nextTrimType(p.type);
		if (t === 'roll') {
			const sides = rollable(seq, p);
			if (!sides) t = nextTrimType(t);
		}
		return { ...p, type: t };
	});
	ui.setState({ editPoints: next });
}

function rollable(seq: Sequence, p: EditPointSel): boolean {
	const c = seq.clips[p.clipId];
	if (!c) return false;
	const f = p.side === 'out' ? c.start + c.duration : c.start;
	return Object.values(seq.clips).some(
		(o) =>
			o.trackId === c.trackId &&
			o.id !== c.id &&
			(p.side === 'out' ? o.start === f : o.start + o.duration === f),
	);
}

/** Adds an applied movement of the primary edit point to the counters (FilmCraft `add_shift`). */
function addShift(
	points: readonly EditPoint[],
	applied: number,
	base?: { outShift: number; inShift: number },
): void {
	const p = points[0];
	if (!p) return;
	const s = base ?? trimMode.getState();
	trimMode.setState({
		outShift: s.outShift + (p.mode === 'roll' || p.edge === 'out' ? applied : 0),
		inShift: s.inShift + (p.mode === 'roll' || p.edge === 'in' ? applied : 0),
	});
}

export function trimCommand(points: readonly EditPoint[], delta: number, clamp = false) {
	return {
		type: 'clip.trimEdits',
		edits: points.map((p) => ({ clipId: p.clipId, edge: p.edge, mode: p.mode })),
		deltaFrames: delta,
		...(clamp ? { clampToSyncLock: true } : {}),
	};
}

function labelFor(points: readonly EditPoint[], dynamicTrim: boolean): string {
	const kind = points[0]?.mode;
	if (dynamicTrim)
		return kind === 'roll'
			? 'Dynamic Rolling Edit'
			: kind === 'ripple'
				? 'Dynamic Ripple Trim'
				: 'Dynamic Trim';
	return kind === 'roll' ? 'Rolling Edit' : kind === 'ripple' ? 'Ripple Trim' : 'Trim';
}

/**
 * Trims every selected edit point by `delta` frames as one transaction (Trim Forward/Backward, Extend Edit,
 * numeric entry). Returns the applied delta, or null when refused (the error is returned for a toast).
 */
export function trimSelected(
	session: EditorSession,
	handle: TimelineHandle,
	sequenceId: string,
	delta: number,
	opts: { coalesce?: boolean; label?: string } = {},
): { applied: number } | { error: string } {
	const points = editPointsOf(handle.ui);
	if (!points.length) return { error: 'Select an edit point first' };
	if (dynamic) dynamic.commit();
	if (delta === 0) return { applied: 0 };
	const r = session.apply({
		label: opts.label ?? labelFor(points, false),
		origin: 'user',
		sequenceId,
		commands: [trimCommand(points, delta) as never],
		...(opts.coalesce ? { coalesceKey: 'trim-keys' } : {}),
	});
	if (!r.ok) return { error: r.errors[0]?.message ?? 'Trim refused' };
	const applied = (r.results[0] as { deltaFrames?: number } | undefined)?.deltaFrames ?? 0;
	const seq = session.getCommitted().sequences[sequenceId];
	if (seq) refreshEditPoints(handle.ui, seq);
	if (trimMode.getState().sequenceId !== sequenceId) enterTrimMode(sequenceId);
	addShift(points, applied);
	return { applied };
}

// ---------------------------------------------------------------- dynamic trimming (J/K/L in trim mode)

type Clock = () => number;
type Raf = { request(cb: () => void): unknown; cancel(h: unknown): void };

const defaultRaf: Raf = {
	request: (cb) =>
		typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(cb, 16),
	cancel: (h) =>
		typeof cancelAnimationFrame === 'function'
			? cancelAnimationFrame(h as number)
			: clearTimeout(h as number),
};

export class DynamicTrim {
	private gesture: Gesture;
	private readonly points: EditPoint[];
	private readonly base: { outShift: number; inShift: number };
	private offset = 0;
	private speed = 0;
	private anchorClock: number;
	private anchorOffset = 0;
	private atLimit = false;
	private handle: unknown = null;
	private done = false;

	constructor(
		private readonly session: EditorSession,
		private readonly timeline: TimelineHandle,
		private readonly sequenceId: string,
		private readonly fps: number,
		private readonly clock: Clock = () => performance.now() / 1000,
		private readonly raf: Raf = defaultRaf,
	) {
		this.points = editPointsOf(timeline.ui);
		const s = trimMode.getState();
		this.base = { outShift: s.outShift, inShift: s.inShift };
		this.gesture = session.beginGesture(labelFor(this.points, true));
		this.anchorClock = this.clock();
		this.publish();
		// A click anywhere commits first (another gesture cannot start on top of the open trim).
		if (typeof window !== 'undefined') {
			const onDown = () => this.commit();
			window.addEventListener('pointerdown', onDown, true);
			this.offPointer = () => window.removeEventListener('pointerdown', onDown, true);
		}
	}
	private offPointer: (() => void) | null = null;

	get active(): boolean {
		return !this.done;
	}

	/** J / L (and Shift for slow): start, double the speed (up to 8×) or reverse (FilmCraft `shuttle`). */
	shuttle(dir: 1 | -1, slow: boolean): void {
		this.tick();
		let speed: number;
		if (slow) speed = SLOW_DYNAMIC_SPEED * dir;
		else if (this.speed * dir > 0 && !this.atLimit)
			speed = Math.max(-MAX_DYNAMIC_SPEED, Math.min(MAX_DYNAMIC_SPEED, this.speed * 2));
		else speed = dir;
		this.speed = speed;
		this.anchorClock = this.clock();
		this.anchorOffset = this.offset;
		this.atLimit = false;
		this.publish();
		this.schedule();
	}

	/** Advances to the clock (call once per animation frame). */
	tick(): void {
		if (this.done || this.speed === 0) return;
		const secs = Math.max(0, this.clock() - this.anchorClock) * this.speed;
		const frames = Math.trunc(Math.abs(secs) * this.fps + 1e-6) * Math.sign(secs);
		const want = this.anchorOffset + frames;
		if (want === this.offset) return;
		const got = this.apply(want);
		this.offset = got;
		if (got !== want) {
			// Ran into a limit (media handle, neighbour, sync lock): hold there; K still commits.
			this.atLimit = true;
			this.speed = 0;
			this.anchorOffset = got;
			this.anchorClock = this.clock();
		}
		this.publish();
	}

	private apply(offset: number): number {
		if (offset === 0) {
			this.gesture.update([]);
			this.follow();
			return 0;
		}
		const r = this.gesture.update([trimCommand(this.points, offset, true) as never]);
		if (!r.ok) {
			// Refused outright: stay where we were.
			if (this.offset !== 0) this.gesture.update([trimCommand(this.points, this.offset, true) as never]);
			else this.gesture.update([]);
			return this.offset;
		}
		this.follow();
		return (r.results[0] as { deltaFrames?: number } | undefined)?.deltaFrames ?? 0;
	}

	/** The Program monitor follows the moving edit. */
	private follow(): void {
		const seq = this.session.getDrawn().sequences[this.sequenceId];
		const p = this.points[0];
		if (!seq || !p) return;
		refreshEditPoints(this.timeline.ui, seq);
		const f = editPointFrame(seq, p);
		if (f !== null) this.session.transport.seek(f);
	}

	private publish(): void {
		trimMode.setState({
			dynamic: this.done ? null : { speed: this.speed, offset: this.offset, atLimit: this.atLimit },
		});
		addShift(this.points, this.offset, this.base);
	}

	private schedule(): void {
		if (this.handle !== null || this.done) return;
		const loop = () => {
			this.handle = null;
			if (this.done || this.speed === 0) return;
			this.tick();
			this.handle = this.raf.request(loop);
		};
		this.handle = this.raf.request(loop);
	}

	private stopLoop(): void {
		if (this.handle !== null) this.raf.cancel(this.handle);
		this.handle = null;
		this.offPointer?.();
		this.offPointer = null;
	}

	/** K: stop and commit as one undo step. Returns the committed offset (0 = nothing recorded). */
	commit(): number {
		if (this.done) return 0;
		this.tick();
		this.done = true;
		this.stopLoop();
		const offset = this.offset;
		if (offset === 0) this.gesture.cancel();
		else this.gesture.commit();
		const seq = this.session.getCommitted().sequences[this.sequenceId];
		if (seq) refreshEditPoints(this.timeline.ui, seq);
		if (offset === 0) trimMode.setState({ ...this.base });
		trimMode.setState({ dynamic: null });
		if (dynamic === this) dynamic = null;
		return offset;
	}

	/** Esc: drop the dynamic trim, restoring the edit and the counters. */
	cancel(): void {
		if (this.done) return;
		this.done = true;
		this.stopLoop();
		this.gesture.cancel();
		const seq = this.session.getCommitted().sequences[this.sequenceId];
		if (seq) {
			refreshEditPoints(this.timeline.ui, seq);
			const f = this.points[0] ? editPointFrame(seq, this.points[0]) : null;
			if (f !== null) this.session.transport.seek(f);
		}
		trimMode.setState({ ...this.base, dynamic: null });
		if (dynamic === this) dynamic = null;
	}
}

let dynamic: DynamicTrim | null = null;

export function activeDynamicTrim(): DynamicTrim | null {
	return dynamic?.active ? dynamic : null;
}

/** J/L in trim mode. */
export function dynamicShuttle(
	session: EditorSession,
	handle: TimelineHandle,
	sequenceId: string,
	fps: number,
	dir: 1 | -1,
	slow: boolean,
	opts: { clock?: Clock; raf?: Raf } = {},
): DynamicTrim | null {
	stopPlayAround();
	if (!dynamic?.active) {
		if (!editPointsOf(handle.ui).length || session.gestureActive) return null;
		if (session.transport.getState().playing) session.transport.pause();
		dynamic = new DynamicTrim(session, handle, sequenceId, fps, opts.clock, opts.raf);
	}
	dynamic.shuttle(dir, slow);
	return dynamic;
}

/** Commits a dynamic trim in progress (K, or any other command first, FilmCraft `commit`). */
export function commitDynamicTrim(): number {
	return dynamic ? dynamic.commit() : 0;
}

export function cancelDynamicTrim(): boolean {
	if (!dynamic?.active) return false;
	dynamic.cancel();
	return true;
}

// ---------------------------------------------------------------- Play Around the Edit (Space in trim mode)

let playAroundOff: (() => void) | null = null;

export function stopPlayAround(): void {
	playAroundOff?.();
	playAroundOff = null;
	if (trimMode.getState().playAround) trimMode.setState({ playAround: false });
}

/**
 * Loops playback from the preroll before the primary edit point to the postroll after it until stopped (Space or
 * K again, any trim restarts the loop around the new edit). `playRange` plays `[from, to)` once.
 */
export function playAroundEdit(
	session: EditorSession,
	handle: TimelineHandle,
	sequenceId: string,
	fps: number,
	playRange: (from: number, toExclusive: number) => void,
): { from: number; to: number } | null {
	if (dynamic) dynamic.commit();
	if (trimMode.getState().playAround) {
		stopPlayAround();
		session.transport.pause();
		return null;
	}
	const seq = session.getCommitted().sequences[sequenceId];
	const p = editPointsOf(handle.ui)[0];
	const edit = seq && p ? editPointFrame(seq, p) : null;
	if (!seq || edit === null) return null;
	let end = 0;
	for (const c of Object.values(seq.clips)) end = Math.max(end, c.start + c.duration);
	const from = Math.max(0, edit - Math.round(prerollSeconds() * fps));
	const to = Math.max(from + 1, Math.min(end, edit + Math.round(postrollSeconds() * fps)));
	const t = session.transport;
	let restarting = false;
	const off = t.subscribe((s, prev) => {
		if (prev.playing && !s.playing && !restarting && trimMode.getState().playAround) {
			// Stopped at the postroll: loop. A user stop pauses elsewhere (stopPlayAround first).
			if (s.frame >= to - 1) {
				restarting = true;
				queueMicrotask(() => {
					restarting = false;
					if (trimMode.getState().playAround) playRange(from, to);
				});
			} else stopPlayAround();
		}
	});
	playAroundOff = off;
	trimMode.setState({ playAround: true });
	playRange(from, to);
	return { from, to };
}
