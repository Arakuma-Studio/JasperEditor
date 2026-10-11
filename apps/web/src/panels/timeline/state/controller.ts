import type { Command } from '@jasper/project';
// TimelineController: pointer → tool → gesture → document commands (S02 §2, §8–§12).
// One instance per Timeline panel. Everything that changes the document goes through
// `session.beginGesture` (preview on the base document, one history entry on commit, nothing on
// cancel; S01:SES-006, S02:TL-052) or `session.apply` for clicks (razor). DOM-free so tests can drive it.
import {
	type Clip,
	findTrack,
	flicksPerFrame,
	formatTimecode,
	fpsOf,
	linkedPartners,
	type Rational,
	type Sequence,
	sequenceDuration,
	type TransactionResult,
	trackLabel,
} from '@jasper/project';
import {
	type EditorSession,
	expandClipSelection,
	type Gesture,
	type SequenceViewState,
} from '@jasper/session';
import {
	axisConstraint,
	clampTrackOffset,
	fourUpPreview,
	type MoveMode,
	marqueeHits,
	moveCommand,
	moveDelta,
	moveLabel,
	snapEdge,
	toggleAgainst,
	trackSelectClips,
	trimPreview,
	unlockedTrackIds,
} from '../model/gestures.ts';
import { type Hit, hitTest } from '../model/hit.ts';
import { clampHeight, type RegionKind, regionIndexAt, type TrackAreaLayout } from '../model/layout.ts';
import { collectSnapTargets, type SnapTarget } from '../model/snapping.ts';
import { cursorFor, type GestureKind, resolveGesture } from '../model/tools.ts';
import {
	bodyDragAlignment,
	edgeDrag,
	handleFeedback,
	type TransitionGeom,
	type TransitionIndex,
	transitionIndex,
} from '../model/transitions.ts';
import {
	autoScrollStep,
	boundaryFrameAt,
	clampScroll,
	clampZoom,
	deltaFramesFromPx,
	extentEnd,
	keyZoomAnchorX,
	minPxPerFrame,
	normalizeWheel,
	PX_PER_FRAME_MAX,
	revealFrame,
	seekFrameAt,
	type Viewport,
	wheelIntent,
	ZOOM_STEP,
	zoomAround,
	zoomToSequenceViewport,
} from '../model/viewport.ts';
import { publishPreview } from './gesture-preview.ts';
import { clearOverlays, type TimelineUiStore } from './ui-store.ts';

export type Geometry = { viewport: Viewport; layout: TrackAreaLayout };

export type PointerInfo = {
	/** Clip-area x (px from the clip area's left edge). */
	x: number;
	/** Track-area y (px from the top of the video region). */
	y: number;
	shift: boolean;
	ctrl: boolean;
	alt: boolean;
	button?: number;
};

interface ControllerEnv {
	session: EditorSession;
	sequenceId(): string | null;
	ui: TimelineUiStore;
	geometry(): Geometry;
	toast?(kind: 'info' | 'warning' | 'error', message: string): void;
	/** the Remix tool's release — remix a music clip to `targetFrames` (async, engine plan). */
	remix?(clipId: string, targetFrames: number): void;
	/** Platform flags for wheel mapping (TL-111). */
	platform?: { mac: boolean; wheelHorizontal?: boolean | null };
}

const MOVE_THRESHOLD_PX = 4;
const EDGE_THRESHOLD_PX = 1;

type DragBase = { downX: number; downY: number; downScroll: number; started: boolean; last: PointerInfo };

type MoveDrag = DragBase & {
	kind: 'move';
	gesture: Gesture | null;
	mode: MoveMode | null;
	clickedId: string | null;
	reduceOnUp: boolean;
	linked: boolean;
	moving: string[];
	grabbedKind: RegionKind;
	downIndex: number;
	starts: number[];
	ends: number[];
	targets: SnapTarget[];
};

type EdgeDrag = DragBase & {
	kind: 'trim' | 'ripple' | 'roll' | 'stretch' | 'remix';
	gesture: Gesture | null;
	/** the Remix tool's target duration (frames) while dragging. */
	remixTarget?: number;
	clip: Clip;
	edge: 'in' | 'out';
	linked: boolean;
	extras: Clip[];
	partners: Clip[];
	targets: SnapTarget[];
	ctrl: boolean;
};

type BodyDrag = DragBase & {
	kind: 'slip' | 'slide';
	gesture: Gesture | null;
	clip: Clip;
	ids: string[];
	targets: SnapTarget[];
};

type MarqueeDrag = DragBase & { kind: 'marquee'; base: string[]; shift: boolean; hit: Hit };
/** S10:TUI-012/013: transition edge (duration) and body (alignment) drags. */
type TransitionDrag = DragBase & {
	kind: 'transitionEdge' | 'transitionBody';
	gesture: Gesture | null;
	geom: TransitionGeom;
	edge: 'start' | 'end';
	targets: SnapTarget[];
	/** The last requested update equals the original transition (commit nothing). */
	unchanged: boolean;
};
type HandDrag = DragBase & { kind: 'hand'; scrollY0: number; region: RegionKind };
type ZoomDrag = DragBase & { kind: 'zoom' };

type Drag = MoveDrag | EdgeDrag | BodyDrag | MarqueeDrag | HandDrag | ZoomDrag | TransitionDrag;

const endOf = (c: { start: number; duration: number }) => c.start + c.duration;

function signed(n: number, rate: Rational, dropFrame: boolean): string {
	return `${n < 0 ? '-' : '+'}${formatTimecode(Math.abs(n), rate, { dropFrame })}`;
}

export class TimelineController {
	private drag: Drag | null = null;

	constructor(readonly env: ControllerEnv) {}

	private get session() {
		return this.env.session;
	}
	/** The drawn sequence (transient during gestures, S01:SES-007). */
	private seq(): Sequence | null {
		const id = this.env.sequenceId();
		return id ? ((this.session.getDrawn().sequences[id] as Sequence | undefined) ?? null) : null;
	}
	private committedSeq(): Sequence | null {
		const id = this.env.sequenceId();
		return id ? ((this.session.getCommitted().sequences[id] as Sequence | undefined) ?? null) : null;
	}
	private view(): SequenceViewState | null {
		const id = this.env.sequenceId();
		return id ? (this.session.getState().views[id] ?? null) : null;
	}
	get dragging(): boolean {
		return this.drag !== null;
	}

	private tool() {
		return this.session.getState().toggles.activeTool;
	}
	private snapping() {
		return this.session.getState().toggles.snapping;
	}
	private playhead() {
		return this.session.transport.getState().frame;
	}
	/** Transitions of a (drawn or committed) sequence, indexed per track (S10:TUI-004). */
	private transitions(seq: Sequence): TransitionIndex {
		return transitionIndex(seq, this.session.getDrawn().media);
	}
	/** Hit test with transitions (S10:TUI-010). */
	private hitAt(seq: Sequence, x: number, y: number): Hit {
		const { viewport, layout } = this.env.geometry();
		return hitTest(seq, layout, viewport, x, y, this.transitions(seq));
	}

	setView(patch: Partial<SequenceViewState>): void {
		const id = this.env.sequenceId();
		if (!id) return;
		this.session.setView(id, patch);
	}

	private isLocked(seq: Sequence, trackId: string): boolean {
		return findTrack(seq, trackId)?.track.locked ?? false;
	}

	hover(p: PointerInfo): void {
		if (this.drag) return;
		const seq = this.seq();
		if (!seq) return;
		const { viewport } = this.env.geometry();
		const tool = this.tool();
		let hit = this.hitAt(seq, p.x, p.y);
		const cursor = cursorFor(tool, hit, p);
		if (hit.kind === 'transition' && tool !== 'selection' && tool !== 'type') hit = hit.under;
		const razor =
			tool === 'razor' && hit.kind === 'clip'
				? { frame: this.razorFrame(seq, viewport, p.x), trackId: p.shift ? null : hit.row.trackId }
				: null;
		const s = this.env.ui.getState();
		if (s.cursor !== cursor || JSON.stringify(s.razor) !== JSON.stringify(razor))
			this.env.ui.setState({ cursor, razor });
	}

	leave(): void {
		if (!this.drag) this.env.ui.setState({ razor: null, cursor: 'default' });
	}

	private razorFrame(seq: Sequence, v: Viewport, x: number): number {
		const f = boundaryFrameAt(v, x);
		const targets = this.snapping()
			? collectSnapTargets(seq, { playhead: this.playhead() })
			: collectSnapTargets(seq, { playhead: this.playhead(), includeClips: false }).filter(
					(t) => t.kind === 'playhead',
				);
		return snapEdge(f, targets, v.pxPerFrame, true).frame;
	}

	pointerDown(p: PointerInfo): boolean {
		if (this.drag) this.cancel();
		const seq = this.seq();
		if (!seq) return false;
		const { viewport, layout } = this.env.geometry();
		if (p.button === 1) {
			this.beginHand(p, layout);
			return true;
		}
		let hit = hitTest(seq, layout, viewport, p.x, p.y, this.transitions(seq));
		const kind: GestureKind = resolveGesture(this.tool(), hit, p);
		if (hit.kind === 'transition' && kind !== 'transitionEdge' && kind !== 'transitionBody') hit = hit.under;
		if (kind !== 'marquee' && kind !== 'hand' && kind !== 'zoom' && kind !== 'none') {
			// TL-882: any gesture start stops playback first.
			if (this.session.transport.getState().playing) this.session.transport.pause();
		}
		const base = { downX: p.x, downY: p.y, downScroll: viewport.scrollFrame, started: false, last: p };
		switch (kind) {
			case 'move':
				return this.beginMove(seq, hit, p, base);
			case 'trim':
			case 'ripple':
			case 'roll':
			case 'stretch':
			case 'remix':
				return this.beginEdge(seq, hit, p, kind, base);
			case 'slip':
			case 'slide':
				return this.beginBody(seq, hit, p, kind, base);
			case 'razor':
				this.razorClick(seq, hit, p);
				return false;
			case 'select':
				if (hit.kind === 'clip') this.clickSelect(seq, hit.clip, p);
				return false;
			case 'gap':
			case 'marquee':
				if (!p.shift) this.session.select('transitions', [], 'replace');
				this.drag = {
					...base,
					kind: 'marquee',
					base: [...this.session.getState().selection.timeline.clips],
					shift: p.shift,
					hit,
				};
				return true;
			case 'trackSelect':
				return this.beginTrackSelect(seq, hit, p, base);
			case 'transitionEdge':
			case 'transitionBody':
				return this.beginTransition(seq, hit, p, kind, base);
			case 'hand':
				this.beginHand(p, layout);
				return true;
			case 'zoom':
				this.drag = { ...base, kind: 'zoom' };
				return true;
			default:
				return false;
		}
	}

	/** TL-401 click selection. Returns false when the clip cannot be selected (locked track, TL-250). */
	private clickSelect(seq: Sequence, clip: Clip, p: PointerInfo): boolean {
		if (this.isLocked(seq, clip.trackId)) return false;
		const linked = this.session.getState().toggles.linkedSelection && !p.alt;
		// edit-structure (Premiere): Alt-click selects one clip of a group.
		const groups = !p.alt;
		this.session.selectGaps([]);
		// a clip click ends a keyframe (lane) selection.
		if (this.session.getState().selection.keyframes) this.session.selectKeyframes(null);
		// S10:TUI-002: selecting a clip clears the transition selection unless Shift.
		if (!p.shift) this.session.select('transitions', [], 'replace');
		if (p.shift) this.session.select('timeline', [clip.id], 'toggle', { linked, groups, primary: clip.id });
		else this.session.select('timeline', [clip.id], 'replace', { linked, groups, primary: clip.id });
		this.env.ui.setState({ editPoints: [] });
		return true;
	}

	private movingSet(seq: Sequence): string[] {
		const sel = this.session.getState().selection.timeline.clips;
		return sel.filter((id) => seq.clips[id] && !this.isLocked(seq, seq.clips[id]!.trackId));
	}

	private beginMove(seq: Sequence, hit: Hit, p: PointerInfo, base: DragBase): boolean {
		if (hit.kind !== 'clip') return false;
		const clip = hit.clip;
		if (this.isLocked(seq, clip.trackId)) return false; // TL-481
		const selected = this.session.getState().selection.timeline.clips.includes(clip.id);
		const linked = this.session.getState().toggles.linkedSelection && !p.alt;
		let reduceOnUp = false;
		if (p.shift) {
			this.clickSelect(seq, clip, p);
			if (!this.session.getState().selection.timeline.clips.includes(clip.id)) return false;
		} else if (selected) reduceOnUp = true;
		else this.clickSelect(seq, clip, p);
		this.drag = this.makeMoveDrag(seq, base, clip.id, hit.row.kind, hit.row.index, reduceOnUp, linked);
		return true;
	}

	private makeMoveDrag(
		seq: Sequence,
		base: DragBase,
		clickedId: string | null,
		kind: RegionKind,
		index: number,
		reduceOnUp: boolean,
		linked: boolean,
	): MoveDrag {
		const moving = this.movingSet(seq);
		const set = new Set(moving);
		const clips = moving.map((id) => seq.clips[id]!);
		return {
			...base,
			kind: 'move',
			gesture: null,
			mode: null,
			clickedId,
			reduceOnUp,
			linked,
			moving,
			grabbedKind: kind,
			downIndex: index,
			starts: clips.map((c) => c.start),
			ends: clips.map(endOf),
			targets: collectSnapTargets(seq, { exclude: set, playhead: this.playhead() }),
		};
	}

	private beginEdge(
		seq: Sequence,
		hit: Hit,
		p: PointerInfo,
		kind: EdgeDrag['kind'],
		base: DragBase,
	): boolean {
		if (hit.kind !== 'clip' || hit.zone === 'body') return false;
		const clip = hit.clip;
		if (this.isLocked(seq, clip.trackId)) return false;
		const edge = hit.zone;
		const linked = !p.alt && this.session.getState().toggles.linkedSelection;
		const edgeFrame = (c: Clip) => (edge === 'in' ? c.start : endOf(c));
		const partners = linked
			? linkedPartners(seq, clip.id).filter((c) => edgeFrame(c) === edgeFrame(clip))
			: [];
		const exclude = new Set([clip.id, ...partners.map((c) => c.id)]);
		// TL-536: other selected clips whose same edge sits on the same frame trim together.
		const sel = this.session.getState().selection.timeline.clips;
		const extras =
			kind === 'roll' || kind === 'stretch' || kind === 'remix' || !sel.includes(clip.id)
				? []
				: sel
						.map((id) => seq.clips[id])
						.filter(
							(c): c is Clip =>
								!!c &&
								!exclude.has(c.id) &&
								edgeFrame(c) === edgeFrame(clip) &&
								!this.isLocked(seq, c.trackId),
						);
		for (const c of extras) exclude.add(c.id);
		this.drag = {
			...base,
			kind,
			gesture: null,
			clip,
			edge,
			linked,
			extras,
			partners,
			ctrl: p.ctrl,
			targets: collectSnapTargets(seq, { exclude, playhead: this.playhead() }),
		};
		return true;
	}

	private beginBody(
		seq: Sequence,
		hit: Hit,
		p: PointerInfo,
		kind: 'slip' | 'slide',
		base: DragBase,
	): boolean {
		if (hit.kind !== 'clip') return false;
		const clip = hit.clip;
		if (this.isLocked(seq, clip.trackId)) return false;
		this.clickSelect(seq, clip, p);
		const linked = !p.alt && this.session.getState().toggles.linkedSelection;
		const ids = [clip.id, ...(linked ? linkedPartners(seq, clip.id).map((c) => c.id) : [])];
		const exclude = new Set(ids);
		this.drag = {
			...base,
			kind,
			gesture: null,
			clip,
			ids,
			targets: collectSnapTargets(seq, { exclude, playhead: this.playhead() }),
		};
		return true;
	}

	private beginTrackSelect(seq: Sequence, hit: Hit, p: PointerInfo, base: DragBase): boolean {
		const { viewport } = this.env.geometry();
		const frame = boundaryFrameAt(viewport, p.x);
		const forward = this.tool() === 'trackSelectForward';
		const row = hit.kind === 'clip' || hit.kind === 'gap' || hit.kind === 'empty' ? hit.row : null;
		const linked = this.session.getState().toggles.linkedSelection;
		let ids: string[];
		if (p.shift && row) {
			if (this.isLocked(seq, row.trackId)) return false;
			ids = trackSelectClips(seq, frame, forward ? 'forward' : 'backward', [row.trackId]);
			ids = expandClipSelection(this.session.getDrawn(), ids, linked);
		} else ids = trackSelectClips(seq, frame, forward ? 'forward' : 'backward', unlockedTrackIds(seq));
		this.session.selectGaps([]);
		this.session.select('timeline', ids, 'replace', { linked: false });
		if (!row || ids.length === 0) return false;
		this.drag = this.makeMoveDrag(seq, base, null, row.kind, row.index, false, linked);
		return true;
	}

	/**
	 * S10:TUI-011/012/013: pointer-down on a transition selects it (Shift/Ctrl toggles, no drag) and arms an
	 * edge (duration) or body (alignment, two-sided only) drag.
	 */
	private beginTransition(
		seq: Sequence,
		hit: Hit,
		p: PointerInfo,
		kind: TransitionDrag['kind'],
		base: DragBase,
	): boolean {
		if (hit.kind !== 'transition') return false;
		const geom = hit.transition.geom;
		const id = geom.t.id;
		if (p.shift || p.ctrl) {
			this.session.select('transitions', [id], 'toggle');
			return false;
		}
		const sel = this.session.getState().selection.timeline;
		if (!sel.transitions.includes(id) || sel.transitions.length > 1 || sel.clips.length > 0) {
			this.session.select('timeline', [], 'replace');
			this.session.selectGaps([]);
			this.session.select('transitions', [id], 'replace');
			this.env.ui.setState({ editPoints: [] });
		}
		if (this.isLocked(seq, geom.trackId)) return false;
		if (kind === 'transitionBody' && geom.oneSided) return false;
		const committed = this.committedSeq();
		const g0 = committed
			? (this.transitions(committed).get(geom.trackId) ?? []).find((g) => g.t.id === id)
			: null;
		if (!g0) return false;
		this.drag = {
			...base,
			kind,
			gesture: null,
			geom: g0,
			edge: hit.transition.zone === 'start' ? 'start' : 'end',
			targets: collectSnapTargets(seq, { playhead: this.playhead() }),
			unchanged: true,
		};
		return true;
	}

	private beginHand(p: PointerInfo, layout: TrackAreaLayout): void {
		const v = this.view();
		const region: RegionKind = p.y < layout.dividerTop ? 'video' : 'audio';
		this.drag = {
			kind: 'hand',
			downX: p.x,
			downY: p.y,
			downScroll: this.env.geometry().viewport.scrollFrame,
			started: false,
			last: p,
			scrollY0: region === 'video' ? (v?.scrollYVideo ?? 0) : (v?.scrollYAudio ?? 0),
			region,
		};
	}

	private razorClick(seq: Sequence, hit: Hit, p: PointerInfo): void {
		if (hit.kind !== 'clip') return;
		const { viewport } = this.env.geometry();
		const frame = this.razorFrame(seq, viewport, p.x);
		const clip = hit.clip;
		if (p.shift) {
			const r = this.session.apply({
				label: 'Razor All Tracks',
				origin: 'user',
				sequenceId: seq.id,
				commands: [{ type: 'clip.split', at: frame, scope: 'all-unlocked' }],
			});
			this.report(r);
			return;
		}
		if (frame <= clip.start || frame >= endOf(clip)) return; // TL-621: on a boundary does nothing
		if (this.isLocked(seq, clip.trackId)) return;
		const r = this.session.apply({
			label: 'Razor',
			origin: 'user',
			sequenceId: seq.id,
			commands: [{ type: 'clip.split', at: frame, clipIds: [clip.id], linked: !p.alt }],
		});
		this.report(r);
	}

	private report(r: TransactionResult | null): void {
		if (r && !r.ok) this.env.toast?.('warning', r.errors[0]?.message ?? 'Edit refused');
	}

	pointerMove(p: PointerInfo): void {
		const d = this.drag;
		if (!d) {
			this.hover(p);
			return;
		}
		d.last = p;
		const { viewport } = this.env.geometry();
		const dxPx = p.x - d.downX + (viewport.scrollFrame - d.downScroll) * viewport.pxPerFrame;
		const dyPx = p.y - d.downY;
		if (!d.started) {
			const threshold =
				d.kind === 'move' || d.kind === 'marquee' || d.kind === 'zoom' || d.kind === 'hand'
					? MOVE_THRESHOLD_PX
					: EDGE_THRESHOLD_PX;
			if (Math.hypot(dxPx, dyPx) < threshold) return;
			d.started = true;
			this.env.ui.setState({ frozenEnd: sequenceDuration(this.committedSeq() ?? { clips: {} }) });
		}
		switch (d.kind) {
			case 'move':
				this.updateMove(d, p, dxPx, dyPx);
				break;
			case 'trim':
			case 'ripple':
			case 'roll':
			case 'stretch':
				this.updateEdge(d, p, dxPx);
				break;
			case 'remix':
				this.updateRemix(d, p, dxPx);
				break;
			case 'slip':
			case 'slide':
				this.updateBody(d, p, dxPx);
				break;
			case 'marquee':
				this.updateMarquee(d, p);
				break;
			case 'hand':
				this.updateHand(d, p);
				break;
			case 'transitionEdge':
				this.updateTransitionEdge(d, p, dxPx);
				break;
			case 'transitionBody':
				this.updateTransitionBody(d, p, dxPx);
				break;
			case 'zoom':
				this.env.ui.setState({
					marquee: { x0: d.downX, y0: 0, x1: p.x, y1: this.env.geometry().layout.height },
				});
				break;
		}
	}

	private updateMove(d: MoveDrag, p: PointerInfo, dxRaw: number, dyRaw: number): void {
		const base = this.committedSeq();
		if (!base || d.moving.length === 0) return;
		const { viewport, layout } = this.env.geometry();
		const { dx, dy } = axisConstraint(dxRaw, dyRaw, p.shift);
		const { delta, snap } = moveDelta({
			dxPx: dx,
			pxPerFrame: viewport.pxPerFrame,
			starts: d.starts,
			ends: d.ends,
			targets: d.targets,
			snapping: this.snapping(),
			pointerFrame: viewport.scrollFrame + p.x / viewport.pxPerFrame,
		});
		const rawOffset = dy === 0 ? 0 : regionIndexAt(layout, d.grabbedKind, d.downY + dy) - d.downIndex;
		const offset = clampTrackOffset(base, d.moving, d.grabbedKind, rawOffset);
		const mode: MoveMode = p.alt ? 'duplicate' : p.ctrl ? 'insert' : 'overwrite';
		if (mode !== d.mode || !d.gesture) {
			d.gesture?.cancel();
			d.gesture = this.session.beginGesture(moveLabel(mode, d.moving.length));
			d.mode = mode;
		}
		const cmd = moveCommand(base, d.moving, delta, d.grabbedKind, offset, mode);
		const r = d.gesture.update([cmd]);
		const rate = base.settings.frameRate;
		const lines = [signed(delta, rate, base.settings.dropFrame)];
		if (offset !== 0) {
			const first = base.clips[d.moving.find((id) => base.clips[id]) ?? ''];
			const label = first ? trackLabel(base, first.trackId) : null;
			if (label) {
				const n = Number(label.slice(1)) + offset;
				lines.push(`→ ${label[0]}${n}`);
			}
		}
		if (!r.ok) lines.push(r.errors[0]?.code === 'E_TRACK_LOCKED' ? 'Track is locked' : 'Not allowed');
		this.env.ui.setState({
			snapFrame: snap ? snap.target.frame : null,
			insertAt: mode === 'insert' ? Math.min(...d.starts) + delta : null,
			tooltip: { x: p.x, y: p.y, lines },
			cursor: r.ok ? 'default' : 'not-allowed',
		});
	}

	private edgeCommands(d: EdgeDrag, seq: Sequence, delta: number): Command[] {
		if (d.kind === 'stretch') return this.stretchCommands(d, seq, delta);
		const mode = d.kind === 'ripple' ? 'ripple' : d.kind === 'roll' ? 'roll' : 'regular';
		const one = (c: Clip): Command => ({
			type: 'clip.trim',
			clipId: c.id,
			edge: d.edge,
			deltaFrames: delta,
			mode,
			linked: d.linked,
			// the selection already holds the group (Alt picks one clip): no second expansion.
			group: false,
			...(mode === 'ripple' ? { clampToSyncLock: true } : {}),
		});
		return [one(d.clip), ...d.extras.map(one)];
	}

	/** Rate stretch (TL-615/616): duration changes, source range stays; speed within [0.1, 20]. */
	private stretchCommands(d: EdgeDrag, seq: Sequence, delta: number): Command[] {
		const c = d.clip;
		const members = [c, ...d.partners];
		const ids = members.map((m) => m.id);
		const srcFrames = c.duration * c.speed.rate;
		const minDur = Math.max(1, Math.ceil(srcFrames / 20));
		const maxDur = Math.floor(srcFrames / 0.1);
		if (d.edge === 'out') {
			let dur = Math.min(maxDur, Math.max(minDur, c.duration + delta));
			if (!d.ctrl) {
				for (const m of members) {
					const next = Object.values(seq.clips)
						.filter((x) => x.trackId === m.trackId && x.start >= endOf(m) && !ids.includes(x.id))
						.reduce((a, x) => Math.min(a, x.start), Number.POSITIVE_INFINITY);
					dur = Math.min(dur, next - m.start);
				}
			}
			return [{ type: 'clip.setSpeed', clipIds: ids, duration: dur, ripple: d.ctrl }];
		}
		let dd = Math.max(c.duration - maxDur, Math.min(c.duration - minDur, delta));
		for (const m of members) {
			const prev = Object.values(seq.clips)
				.filter((x) => x.trackId === m.trackId && endOf(x) <= m.start && !ids.includes(x.id))
				.reduce((a, x) => Math.max(a, endOf(x)), 0);
			dd = Math.max(dd, prev - m.start);
		}
		if (dd === 0) return [];
		const dur = c.duration - dd;
		const move: Command = { type: 'clip.move', clipIds: ids, deltaFrames: dd };
		const speed: Command = { type: 'clip.setSpeed', clipIds: ids, duration: dur, ripple: false };
		return dd < 0 ? [move, speed] : [speed, move];
	}

	/**
	 * audio-fx Remix tool: the dragged end sets the remix's target duration (from the remix's original start for a
	 * remixed clip); nothing changes until release, which plans and commits the remix (`env.remix`).
	 */
	private updateRemix(d: EdgeDrag, p: PointerInfo, dxPx: number): void {
		const base = this.committedSeq();
		if (!base) return;
		const { viewport } = this.env.geometry();
		const raw = deltaFramesFromPx(dxPx, viewport.pxPerFrame);
		const { frame, snap } = snapEdge(endOf(d.clip) + raw, d.targets, viewport.pxPerFrame, this.snapping());
		const remix = (d.clip as { remix?: { original: { start: number } } }).remix;
		const start = remix ? remix.original.start : d.clip.start;
		let target = Math.max(1, frame - start);
		const others = Object.values(base.clips).filter(
			(x) =>
				x.trackId === d.clip.trackId &&
				x.start >= start &&
				!(
					(x as { remix?: { id: string } }).remix &&
					(x as { remix?: { id: string } }).remix?.id === (remix as { id?: string } | undefined)?.id
				) &&
				x.id !== d.clip.id,
		);
		const next = others.reduce((a, x) => Math.min(a, x.start), Number.POSITIVE_INFINITY);
		const limited = start + target > next;
		if (limited) target = next - start;
		d.remixTarget = target;
		const rate = base.settings.frameRate;
		this.env.ui.setState({
			snapFrame: snap && !limited ? snap.target.frame : null,
			limit: { trackId: d.clip.trackId, frame: start + target },
			tooltip: {
				x: p.x,
				y: p.y,
				lines: [`Remix to ${formatTimecode(target, rate, { dropFrame: base.settings.dropFrame })}`],
			},
		});
	}

	private updateEdge(d: EdgeDrag, p: PointerInfo, dxPx: number): void {
		const base = this.committedSeq();
		if (!base) return;
		const { viewport } = this.env.geometry();
		const raw = deltaFramesFromPx(dxPx, viewport.pxPerFrame);
		const edge0 = d.edge === 'in' ? d.clip.start : endOf(d.clip);
		const { frame, snap } = snapEdge(edge0 + raw, d.targets, viewport.pxPerFrame, this.snapping());
		let delta = frame - edge0;
		if (!d.gesture) {
			const label =
				d.kind === 'ripple'
					? 'Ripple Trim'
					: d.kind === 'roll'
						? 'Roll'
						: d.kind === 'stretch'
							? 'Rate Stretch'
							: 'Trim';
			d.gesture = this.session.beginGesture(label);
		}
		let r = d.gesture.update(this.edgeCommands(d, base, delta));
		if (r.ok && d.kind !== 'stretch' && r.results.length > 1) {
			// TL-536: lockstep — the most restrictive clamp wins for every trimmed clip.
			const actual = r.results.map((x) => (x as { deltaFrames?: number })?.deltaFrames ?? delta);
			const common = actual.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a), delta);
			if (actual.some((a) => a !== common)) {
				delta = common;
				r = d.gesture.update(this.edgeCommands(d, base, delta));
			}
		}
		const drawn = this.seq();
		const rate = base.settings.frameRate;
		let actualDelta = delta;
		if (r.ok && d.kind !== 'stretch')
			actualDelta = (r.results[0] as { deltaFrames?: number })?.deltaFrames ?? delta;
		const clamped = r.ok && r.warnings.some((w) => w.code === 'W_DURATION_CLAMPED');
		const now = drawn?.clips[d.clip.id];
		const lines = [signed(actualDelta, rate, base.settings.dropFrame)];
		if (now)
			lines.push(`Duration ${formatTimecode(now.duration, rate, { dropFrame: base.settings.dropFrame })}`);
		if (d.kind === 'stretch' && now) lines.push(`${Math.round(now.speed.rate * 10000) / 100}%`);
		this.env.ui.setState({
			snapFrame: snap && !clamped ? snap.target.frame : null,
			limit:
				clamped && now ? { trackId: now.trackId, frame: d.edge === 'in' ? now.start : endOf(now) } : null,
			tooltip: { x: p.x, y: p.y, lines },
		});
		if (drawn && d.kind !== 'stretch') {
			const pv = trimPreview(drawn, d.clip.id, d.edge);
			publishPreview(pv ? { ...pv, sequenceId: base.id } : null);
		}
	}

	private updateBody(d: BodyDrag, p: PointerInfo, dxPx: number): void {
		const base = this.committedSeq();
		if (!base) return;
		const { viewport } = this.env.geometry();
		let delta = deltaFramesFromPx(dxPx, viewport.pxPerFrame);
		let snapFrame: number | null = null;
		if (d.kind === 'slide' && this.snapping()) {
			const a = snapEdge(d.clip.start + delta, d.targets, viewport.pxPerFrame, true);
			const b = snapEdge(endOf(d.clip) + delta, d.targets, viewport.pxPerFrame, true);
			const best = [a, b]
				.filter((x) => x.snap)
				.sort((x, y) => Math.abs(x.snap!.offset) - Math.abs(y.snap!.offset))[0];
			if (best?.snap) {
				delta += best.snap.offset;
				snapFrame = best.snap.target.frame;
			}
		}
		if (!d.gesture) d.gesture = this.session.beginGesture(d.kind === 'slip' ? 'Slip' : 'Slide');
		const cmd =
			d.kind === 'slip'
				? { type: 'clip.slip', clipIds: d.ids, deltaFrames: delta }
				: { type: 'clip.slide', clipId: d.clip.id, deltaFrames: delta, linked: d.ids.length > 1 };
		const r = d.gesture.update([cmd]);
		const rate = base.settings.frameRate;
		const actual = r.ok ? ((r.results[0] as { deltaFrames?: number })?.deltaFrames ?? delta) : 0;
		const drawn = this.seq();
		const now = drawn?.clips[d.clip.id];
		const lines = [signed(actual, rate, base.settings.dropFrame)];
		if (d.kind === 'slip' && now)
			lines.unshift(
				`In ${formatTimecode(Math.round(now.sourceIn / flicksPerFrame(rate)), rate, { dropFrame: base.settings.dropFrame })}`,
			);
		const clamped = r.ok && r.warnings.some((w) => w.code === 'W_DURATION_CLAMPED');
		this.env.ui.setState({
			snapFrame,
			tooltip: { x: p.x, y: p.y, lines },
			limit: clamped && now ? { trackId: now.trackId, frame: actual >= 0 ? now.start : endOf(now) } : null,
		});
		if (drawn) {
			const pv = fourUpPreview(drawn, d.clip.id, d.kind);
			publishPreview(pv ? { ...pv, sequenceId: base.id } : null);
		}
	}

	private transitionTooltip(base: Sequence, duration: number, clamped: boolean): string[] {
		const rate = base.settings.frameRate;
		const lines = [
			`Duration ${formatTimecode(duration, rate, { dropFrame: base.settings.dropFrame })} (${duration})`,
		];
		if (clamped) lines.push('Limited by media handles');
		return lines;
	}

	/** TUI-012: edge drag → `transition.update {duration, alignment}` (clamped by the handler). */
	private updateTransitionEdge(d: TransitionDrag, p: PointerInfo, dxPx: number): void {
		const base = this.committedSeq();
		if (!base) return;
		const { viewport } = this.env.geometry();
		const g = d.geom;
		const edge0 = d.edge === 'start' ? g.start : g.end;
		const { frame, snap } = snapEdge(
			edge0 + deltaFramesFromPx(dxPx, viewport.pxPerFrame),
			d.targets,
			viewport.pxPerFrame,
			this.snapping(),
		);
		const want = edgeDrag(g, d.edge, frame, p.alt);
		if (!d.gesture) d.gesture = this.session.beginGesture('Transition Duration');
		const r = d.gesture.update([
			{ type: 'transition.update', transitionId: g.t.id, duration: want.duration, alignment: want.alignment },
		]);
		const res = r.ok
			? (r.results[0] as { duration: number; alignment: TransitionGeom['t']['alignment'] })
			: null;
		d.unchanged = !!res && res.duration === g.t.duration && res.alignment === g.t.alignment;
		const clamped = r.ok && r.warnings.some((w) => w.code === 'W_TRANSITION_SHORTENED');
		const fb = handleFeedback({
			effectId: g.t.effectId,
			cut: g.cut,
			alignment: want.alignment,
			oneSided: g.oneSided,
			outgoing: g.outgoing,
			incoming: g.incoming,
			wanted: want.duration,
			handles: g.handles,
		});
		this.env.ui.setState({
			snapFrame: snap && !clamped ? snap.target.frame : null,
			tooltip: {
				x: p.x,
				y: p.y,
				lines: res
					? this.transitionTooltip(base, res.duration, clamped)
					: [r.ok ? '' : (r.errors[0]?.message ?? 'Not allowed')],
			},
			cursor: r.ok ? this.env.ui.getState().cursor : 'not-allowed',
			transitionGhost:
				fb.missing.length || clamped
					? {
							trackId: g.trackId,
							wanted: fb.wanted,
							fitted: fb.fitted,
							bands: fb.bands,
							missing: fb.missing,
							refused: fb.fittedDuration === 0,
						}
					: null,
		});
	}

	/** TUI-013: body drag snaps the alignment (two-sided only); the duration is kept or reduced. */
	private updateTransitionBody(d: TransitionDrag, p: PointerInfo, dxPx: number): void {
		const base = this.committedSeq();
		if (!base) return;
		const { viewport } = this.env.geometry();
		const g = d.geom;
		const alignment = bodyDragAlignment(g, deltaFramesFromPx(dxPx, viewport.pxPerFrame));
		if (!d.gesture) d.gesture = this.session.beginGesture('Transition Alignment');
		const r = d.gesture.update([
			{ type: 'transition.update', transitionId: g.t.id, alignment, duration: g.t.duration },
		]);
		const res = r.ok ? (r.results[0] as { duration: number }) : null;
		d.unchanged = alignment === g.t.alignment && (!res || res.duration === g.t.duration);
		const label =
			alignment === 'center' ? 'Center at Cut' : alignment === 'start-at-cut' ? 'Start at Cut' : 'End at Cut';
		const clamped = r.ok && r.warnings.some((w) => w.code === 'W_TRANSITION_SHORTENED');
		this.env.ui.setState({
			tooltip: {
				x: p.x,
				y: p.y,
				lines: res
					? [label, ...this.transitionTooltip(base, res.duration, clamped)]
					: [label, r.ok ? '' : (r.errors[0]?.message ?? 'Not allowed')],
			},
			cursor: r.ok ? 'grabbing' : 'not-allowed',
		});
	}

	private updateMarquee(d: MarqueeDrag, p: PointerInfo): void {
		const seq = this.seq();
		if (!seq) return;
		const { viewport, layout } = this.env.geometry();
		const rect = { x0: d.downX, y0: d.downY, x1: p.x, y1: p.y };
		const hits = marqueeHits(seq, layout, viewport, rect);
		const linked = this.session.getState().toggles.linkedSelection;
		const expanded = expandClipSelection(this.session.getDrawn(), hits, linked).filter(
			(id) => seq.clips[id] && !this.isLocked(seq, seq.clips[id]!.trackId),
		);
		const next = d.shift ? toggleAgainst(d.base, expanded) : expanded;
		this.session.selectGaps([]);
		this.session.select('timeline', next, 'replace', { linked: false });
		this.env.ui.setState({ marquee: rect });
	}

	private updateHand(d: HandDrag, p: PointerInfo): void {
		const { viewport } = this.env.geometry();
		const scrollFrame = d.downScroll - (p.x - d.downX) / viewport.pxPerFrame;
		this.setScroll(scrollFrame);
		const dy = p.y - d.downY;
		if (d.region === 'video') this.setView({ scrollYVideo: Math.max(0, d.scrollY0 + dy) });
		else this.setView({ scrollYAudio: Math.max(0, d.scrollY0 - dy) });
	}

	pointerUp(p: PointerInfo): void {
		const d = this.drag;
		if (!d) return;
		this.drag = null;
		try {
			if (!d.started) {
				this.click(d, p);
				return;
			}
			switch (d.kind) {
				case 'move':
				case 'trim':
				case 'ripple':
				case 'roll':
				case 'stretch':
				case 'slip':
				case 'slide': {
					const r = d.gesture?.commit() ?? null;
					this.report(r);
					break;
				}
				case 'transitionEdge':
				case 'transitionBody': {
					// One entry per gesture; a drag that ends where it started records nothing (TUI-012/013).
					if (d.unchanged) d.gesture?.cancel();
					else this.report(d.gesture?.commit() ?? null);
					break;
				}
				case 'remix':
					if (d.remixTarget !== undefined) this.env.remix?.(d.clip.id, d.remixTarget);
					break;
				case 'zoom': {
					const { viewport } = this.env.geometry();
					const f0 = viewport.scrollFrame + Math.min(d.downX, p.x) / viewport.pxPerFrame;
					const f1 = viewport.scrollFrame + Math.max(d.downX, p.x) / viewport.pxPerFrame;
					this.zoomToRange(f0, f1, 0);
					break;
				}
				default:
					break;
			}
		} finally {
			clearOverlays(this.env.ui);
			publishPreview(null);
		}
	}

	private click(d: Drag, p: PointerInfo): void {
		const seq = this.seq();
		if (!seq) return;
		switch (d.kind) {
			case 'move':
				// TL-401: clicking an already selected clip reduces the selection to it (and its links).
				if (d.reduceOnUp && d.clickedId && !p.shift)
					this.session.select('timeline', [d.clickedId], 'replace', {
						linked: d.linked,
						primary: d.clickedId,
					});
				break;
			case 'trim':
			case 'ripple':
			case 'roll':
			case 'stretch': {
				// TL-547: a click on an edge zone selects that edit point side.
				const frame = d.edge === 'in' ? d.clip.start : endOf(d.clip);
				const type = d.kind === 'ripple' ? 'ripple' : d.kind === 'roll' ? 'roll' : 'regular';
				const ep = { trackId: d.clip.trackId, frame, side: d.edge, clipId: d.clip.id, type } as const;
				const cur = this.env.ui.getState().editPoints.filter((e) => e.trackId !== ep.trackId);
				this.env.ui.setState({ editPoints: p.ctrl ? [...cur, ep] : [ep] });
				break;
			}
			case 'marquee':
				if (d.hit.kind === 'gap') {
					// TL-740: clicking a gap selects it; Shift adds.
					const gap = d.hit.gap;
					const gaps = p.shift ? [...this.session.getState().selection.timeline.gaps, gap] : [gap];
					this.session.select('timeline', [], 'replace');
					this.session.selectGaps(gaps);
				} else if (!p.shift) {
					// TL-402: a click on empty space deselects everything.
					this.session.select('timeline', [], 'replace');
					this.session.select('transitions', [], 'replace');
					this.session.selectGaps([]);
					this.env.ui.setState({ editPoints: [] });
				}
				break;
			case 'zoom': {
				const { viewport } = this.env.geometry();
				this.zoomBy(p.alt ? 1 / ZOOM_STEP : ZOOM_STEP, d.downX, viewport);
				break;
			}
			default:
				break;
		}
	}

	/** Escape (TL-052): cancels the active gesture with no history entry. Returns true when handled. */
	cancel(): boolean {
		const d = this.drag;
		if (!d) return false;
		this.drag = null;
		if ('gesture' in d && d.gesture) d.gesture.cancel();
		if (d.kind === 'marquee' && d.started)
			this.session.select('timeline', d.base, 'replace', { linked: false });
		clearOverlays(this.env.ui);
		publishPreview(null);
		return true;
	}

	/** Auto-scroll step during gestures (TL-117); call once per animation frame. */
	tick(): void {
		const d = this.drag;
		if (!d?.started || d.kind === 'hand' || d.kind === 'zoom') return;
		const { viewport } = this.env.geometry();
		const step = autoScrollStep(d.last.x, viewport.width);
		if (step === 0) return;
		this.setScroll(viewport.scrollFrame + step / viewport.pxPerFrame, true);
		this.pointerMove(d.last);
	}

	private fps(): number {
		const seq = this.committedSeq();
		return seq ? fpsOf(seq.settings.frameRate) : 30;
	}

	private extent(v: Viewport): number {
		const seq = this.committedSeq();
		if (!seq) return 0;
		const lastMarker = seq.markers.length ? Math.max(...seq.markers.map((m) => m.frame + m.duration)) : null;
		return extentEnd(v, {
			end: this.env.ui.getState().frozenEnd ?? sequenceDuration(seq),
			playhead: this.playhead(),
			outPoint: seq.outPoint,
			lastMarker,
		});
	}

	/** Sets scrollFrame clamped to the extent (TL-110); `grow` lets auto-scroll extend it (TL-118). */
	setScroll(scrollFrame: number, grow = false): void {
		const v = { ...this.env.geometry().viewport, scrollFrame };
		const ext = this.extent(v);
		const next = clampScroll(v, ext, grow ? scrollFrame + v.width / v.pxPerFrame : Number.NEGATIVE_INFINITY);
		this.setView({ scrollFrame: next });
	}

	private applyViewport(v: Viewport): void {
		const ext = this.extent(v);
		this.setView({ pxPerFrame: v.pxPerFrame, scrollFrame: clampScroll(v, ext) });
		this.env.ui.setState({ zoomPrev: null });
	}

	zoomBy(factor: number, anchorX: number, v = this.env.geometry().viewport): void {
		const seq = this.committedSeq();
		const min = minPxPerFrame(seq ? sequenceDuration(seq) : 0, this.fps(), v.width);
		const p = clampZoom(v.pxPerFrame * factor, min, PX_PER_FRAME_MAX);
		this.applyViewport(zoomAround(v, p, anchorX));
	}

	/** `=` / `-` (TL-107: anchor = playhead when visible, else center). */
	zoomStep(dir: 1 | -1): void {
		const v = this.env.geometry().viewport;
		this.zoomBy(dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP, keyZoomAnchorX(v, this.playhead()), v);
	}

	/** `\` toggles zoom to sequence and back to the exact previous zoom and scroll (TL-108, AC-3c). */
	toggleZoomToSequence(): void {
		const v = this.env.geometry().viewport;
		const prev = this.env.ui.getState().zoomPrev;
		if (prev) {
			this.setView({ pxPerFrame: prev.pxPerFrame, scrollFrame: prev.scrollFrame });
			this.env.ui.setState({ zoomPrev: null });
			return;
		}
		const seq = this.committedSeq();
		const z = zoomToSequenceViewport(v, seq ? sequenceDuration(seq) : 0, this.fps());
		this.setView({ pxPerFrame: z.pxPerFrame, scrollFrame: z.scrollFrame });
		this.env.ui.setState({ zoomPrev: { pxPerFrame: v.pxPerFrame, scrollFrame: v.scrollFrame } });
	}

	/** Fits `[f0, f1)` to the width with a margin fraction on each side (TL-109, TL-650). */
	zoomToRange(f0: number, f1: number, margin = 0.05): void {
		const v = this.env.geometry().viewport;
		const span = Math.max(1, f1 - f0);
		const total = span * (1 + 2 * margin);
		const seq = this.committedSeq();
		const min = minPxPerFrame(seq ? sequenceDuration(seq) : 0, this.fps(), v.width);
		const p = clampZoom(v.width / total, min, PX_PER_FRAME_MAX);
		const center = (f0 + f1) / 2;
		this.applyViewport({ ...v, pxPerFrame: p, scrollFrame: center - v.width / p / 2 });
	}

	/** Page Up/Down (TL-113): one visible width without moving the playhead. */
	page(dir: 1 | -1): void {
		const v = this.env.geometry().viewport;
		this.setScroll(v.scrollFrame + (dir * v.width) / v.pxPerFrame);
	}

	/** TL-120: after keyboard seeks, bring the playhead into view with minimum movement. */
	reveal(frame: number): void {
		const v = this.env.geometry().viewport;
		const s = revealFrame(v, frame);
		if (s !== null) this.setScroll(s);
	}

	/** Wheel over the clip area (TL-111). */
	wheel(e: {
		deltaX: number;
		deltaY: number;
		deltaMode: number;
		ctrlKey: boolean;
		altKey: boolean;
		shiftKey: boolean;
		metaKey?: boolean;
		x: number;
		y: number;
		pinch?: boolean;
	}): void {
		const { dx, dy } = normalizeWheel(e);
		const platform = this.env.platform ?? { mac: false };
		const intent = wheelIntent(
			{ dx, dy, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey },
			{ mac: platform.mac, preferHorizontal: platform.wheelHorizontal ?? undefined, pinch: e.pinch },
		);
		const v = this.env.geometry().viewport;
		const layout = this.env.geometry().layout;
		const scrollV = (px: number) => {
			const view = this.view();
			if (!view) return;
			if (e.y < layout.dividerTop)
				this.setView({ scrollYVideo: Math.min(layout.video.maxScroll, Math.max(0, view.scrollYVideo - px)) });
			else
				this.setView({ scrollYAudio: Math.min(layout.audio.maxScroll, Math.max(0, view.scrollYAudio + px)) });
		};
		switch (intent.kind) {
			case 'zoom':
				this.zoomBy(intent.factor, e.x, v);
				break;
			case 'hscroll':
				this.setScroll(v.scrollFrame + intent.px / v.pxPerFrame);
				break;
			case 'vscroll':
				scrollV(intent.px);
				break;
			case 'both':
				if (intent.hpx) this.setScroll(v.scrollFrame + intent.hpx / v.pxPerFrame);
				if (intent.vpx) scrollV(intent.vpx);
				break;
		}
	}

	setTrackHeight(trackId: string, h: number): void {
		const view = this.view();
		if (!view) return;
		this.setView({ trackHeights: { ...view.trackHeights, [trackId]: clampHeight(h) } });
	}

	/** Seek from the ruler (TL-203): floor rule; Shift (or the preference) snaps to targets (TL-455). */
	scrubTo(x: number, snap: boolean): number {
		const seq = this.committedSeq();
		if (!seq) return 0;
		const v = this.env.geometry().viewport;
		const end = sequenceDuration(seq);
		let f = seekFrameAt(v, x, end);
		if (snap) {
			const targets = collectSnapTargets(seq, { playhead: null });
			const s = snapEdge(f, targets, v.pxPerFrame, true);
			f = Math.max(0, Math.min(end, s.frame));
			this.env.ui.setState({ snapFrame: s.snap ? s.frame : null });
		}
		const t = this.session.transport;
		if (t.getState().playing) t.pause(); // TL-832
		t.seek(f);
		return f;
	}
}
