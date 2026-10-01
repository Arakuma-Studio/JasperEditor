// Timeline tracker glyphs (S09:TRU-005), registered as `clipDecorations` (extensions/index.ts):
// - plate clip (video clip with trackers): a tracker badge in the name strip (Scan = planar, Crosshair = point,
//   a count when > 1) whose tooltip lists the trackers, and a confidence strip per tracker (≤ 3 stacked, the
//   active one taller and brighter, "+n" for the rest) along the bottom of the body over the tracked span,
//   drawn into ≤ 512 px canvas tiles over the visible part only, worst confidence per px column at low zoom;
// - target clip (`trackedBy`): a link badge "Follows <tracker> on <plate> · Corner Pin|Motion".
// Clicking a glyph (Selection tool) selects the plate clip, makes the tracker active and reveals Properties ▸
// Tracking; it never starts a timeline drag and the strips leave the trim edge zones (TL-531) to the timeline.
// Nothing here subscribes to the transport or the document: names and timecode settings are read from the
// committed document when a tooltip is computed (TL-155), and only plate clips subscribe to the active tracker.
import {
	type Clip,
	type ClipTracker,
	findTracker,
	type Rational,
	type TimecodeOptions,
	type TrackedBy,
	type VideoClip,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSessionOrNull } from '@jasper/session/react';
import { cx, Tooltip } from '@jasper/ui';
import { Crosshair, Link2, Scan } from 'lucide-react';
import {
	memo,
	type MouseEvent as ReactMouseEvent,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { ClipDecorationProps } from '../extensions/index.ts';
import { revealSection } from '../panels/properties/controls/Section.tsx';
import { CanvasTiles, cssVar, type TileDraw } from '../panels/timeline/components/canvas.tsx';
import { edgeZonePx } from '../panels/timeline/model/hit.ts';
import { useShellRuntimeOrNull } from '../shell/context.tsx';
import { liveSamples } from './live.ts';
import { setActiveTracker, trackingStore, useTracking } from './store.ts';
import {
	frameUnderPointer,
	linkText,
	plateBadgeLines,
	type StripRun,
	stripFrameText,
	stripRuns,
	stripSpanPx,
	trackerLine,
} from './timeline-strip.ts';

/** Properties section id of the Tracking `clipSections` entry (ClipProperties: `properties.ext.<id>`). */
const TRACKING_SECTION = 'properties.ext.tracking';
/** Name strip height of the clip view (ClipView `NAME_STRIP_PX`). */
const NAME_STRIP_PX = 14;
const OVERSCAN_PX = 256;
const STRIP_PX = 3;
const ACTIVE_STRIP_PX = 4;
const STRIP_GAP_PX = 1;
const MAX_STRIPS = 3;
const TIP_DELAY_MS = 400;

const trackersOf = (c: Clip): readonly ClipTracker[] => (c as VideoClip).trackers ?? [];
const trackedByOf = (c: Clip): TrackedBy | undefined => (c as { trackedBy?: TrackedBy }).trackedBy;

/** Timecode display settings of the sequence holding `clipId` (read lazily from the committed document). */
function tcOptions(session: EditorSession | null, clipId: string): TimecodeOptions {
	if (!session) return {};
	for (const seq of Object.values(session.getCommitted().sequences))
		if (seq.clips[clipId])
			return { dropFrame: seq.settings.dropFrame, startFrames: seq.settings.startTimecodeFrames };
	return {};
}

// ------------------------------------------------------------------ activation

/** Selects the plate, activates the tracker and reveals Properties ▸ Tracking. */
function useRevealTracker(): (plateId: string, trackerId: string) => void {
	const session = useSessionOrNull();
	const runtime = useShellRuntimeOrNull();
	return useCallback(
		(plateId, trackerId) => {
			if (!session) return;
			session.select('timeline', [plateId], 'replace', { primary: plateId, linked: false });
			setActiveTracker(trackerId);
			runtime?.services.get('shell')?.focusPanel('properties');
			revealSection(TRACKING_SECTION);
		},
		[session, runtime],
	);
}

/**
 * Press handling of a glyph: with the Selection tool a primary press is taken from the timeline (no drag, no
 * marquee) and the click activates; with other tools (razor, slip…) the press goes through to the timeline.
 * Keyboard clicks (detail 0) always activate.
 */
function useGlyphPress(enabled: boolean, activate: () => void) {
	const session = useSessionOrNull();
	const armed = useRef(false);
	const onPointerDown = (e: ReactPointerEvent) => {
		armed.current = false;
		if (!enabled || e.button !== 0) return;
		if (session && session.getState().toggles.activeTool !== 'selection') return;
		e.stopPropagation();
		armed.current = true;
	};
	const onClick = (e: ReactMouseEvent) => {
		const ok = armed.current || e.detail === 0;
		armed.current = false;
		if (!enabled || !ok) return;
		e.stopPropagation();
		activate();
	};
	return { onPointerDown, onClick };
}

const BADGE_CLASS =
	'pointer-events-auto flex h-[12px] shrink-0 items-center gap-[1px] rounded-[2px] px-[1px] text-[10px] leading-[12px] text-pr-strong opacity-80 hover:opacity-100 focus-visible:opacity-100';

/** Tooltip content: first line, then the rest on their own lines. */
function TipLines({ lines }: { lines: readonly string[] }) {
	return <span className="whitespace-pre-line">{lines.join('\n')}</span>;
}

// ------------------------------------------------------------------ plate badge

const PlateBadge = memo(function PlateBadge(props: { clip: Clip; rate: Rational; locked: boolean }) {
	const { clip, rate, locked } = props;
	const session = useSessionOrNull();
	const reveal = useRevealTracker();
	const trackers = trackersOf(clip);
	// Recomputed when the clip changes or on hover (sequence timecode settings are read lazily).
	const [refresh, bump] = useReducer((n: number) => n + 1, 0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` re-reads the committed document on hover
	const lines = useMemo(
		() => plateBadgeLines(clip as VideoClip, rate, tcOptions(session, clip.id)),
		[clip, rate, session, refresh],
	);
	const press = useGlyphPress(!locked && trackers.length > 0, () => {
		const active = trackingStore.getState().activeTrackerId;
		const i = trackers.findIndex((t) => t.id === active);
		const sel = session?.getState().selection.timeline.clips ?? [];
		// Already showing this plate: a click cycles through its trackers.
		const next =
			i < 0
				? trackers[0]!
				: sel.length === 1 && sel[0] === clip.id
					? trackers[(i + 1) % trackers.length]!
					: trackers[i]!;
		reveal(clip.id, next.id);
	});
	if (!trackers.length) return null;
	const Icon = trackers.every((t) => t.kind === 'point') ? Crosshair : Scan;
	return (
		<Tooltip content={lines[0]} detail={lines.length > 1 ? <TipLines lines={lines.slice(1)} /> : undefined}>
			<button
				type="button"
				className={BADGE_CLASS}
				aria-label={lines.join('\n')}
				data-testid="clip-tracker-badge"
				data-clip-id={clip.id}
				onPointerEnter={bump}
				onFocus={bump}
				{...press}
			>
				<Icon size={10} strokeWidth={2.25} aria-hidden />
				{trackers.length > 1 ? <span>{trackers.length}</span> : null}
			</button>
		</Tooltip>
	);
});

export function TrackerBadge(p: ClipDecorationProps) {
	return <PlateBadge clip={p.clip} rate={p.rate} locked={p.trackLocked} />;
}

// ------------------------------------------------------------------ target link badge

function linkInfo(session: EditorSession | null, tb: TrackedBy) {
	const loc = session ? findTracker(session.getCommitted(), tb.trackerId) : null;
	return {
		loc,
		text: linkText(loc ? { trackerName: loc.tracker.name, plateName: loc.clip.name } : null, tb.mode),
	};
}

const LinkBadge = memo(function LinkBadge(props: { clip: Clip; locked: boolean }) {
	const { clip, locked } = props;
	const session = useSessionOrNull();
	const reveal = useRevealTracker();
	const tb = trackedByOf(clip);
	const [refresh, bump] = useReducer((n: number) => n + 1, 0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` re-reads the committed document on hover
	const info = useMemo(() => (tb ? linkInfo(session, tb) : null), [tb, session, refresh]);
	const press = useGlyphPress(!locked && !!tb, () => {
		if (!tb) return;
		// Fresh lookup: the plate may have moved since the label was computed.
		const loc = session ? findTracker(session.getCommitted(), tb.trackerId) : null;
		if (loc) reveal(loc.clip.id, loc.tracker.id);
	});
	if (!tb || !info) return null;
	return (
		<Tooltip content={info.text}>
			<button
				type="button"
				className={cx(BADGE_CLASS, !info.loc && 'text-pr-warning opacity-100')}
				aria-label={info.text}
				aria-disabled={!info.loc || undefined}
				data-testid="clip-tracked-link"
				data-clip-id={clip.id}
				data-tracker-missing={!info.loc || undefined}
				onPointerEnter={bump}
				onFocus={bump}
				{...press}
			>
				<Link2 size={10} strokeWidth={2.25} aria-hidden />
			</button>
		</Tooltip>
	);
});

export function TrackedLinkBadge(p: ClipDecorationProps) {
	return <LinkBadge clip={p.clip} locked={p.trackLocked} />;
}

// ------------------------------------------------------------------ confidence strips

type StripTip = { x: number; y: number; text: string };

function drawRuns(ctx: CanvasRenderingContext2D, runs: readonly StripRun[], height: number): void {
	const el = ctx.canvas;
	const fill = {
		good: cssVar(el, '--pr-success'),
		fair: cssVar(el, '--pr-warning'),
		poor: cssVar(el, '--pr-danger'),
		lost: cssVar(el, '--pr-danger'),
	};
	const gap = cssVar(el, '--pr-bg-app');
	for (const r of runs) {
		const w = Math.max(r.x1 - r.x0, 0.75);
		if (fill[r.cls]) {
			ctx.fillStyle = fill[r.cls];
			ctx.fillRect(r.x0, 0, w, height);
		}
		// Lost = a dark core inside a danger outline: distinct from "poor" even one px wide.
		if (r.cls === 'lost' && gap && height >= 3) {
			ctx.fillStyle = gap;
			ctx.fillRect(r.x0, 1, w, height - 2);
		}
	}
}

function StripRow(props: {
	deco: ClipDecorationProps;
	tracker: ClipTracker;
	bottom: number;
	height: number;
	hitBottom: number;
	hitHeight: number;
	active: boolean;
	interactive: boolean;
	tc: TimecodeOptions;
	onActivate(trackerId: string): void;
}) {
	const { deco: p, tracker, bottom, height, active } = props;
	const clip = p.clip;
	// Live: the frames a running job has tracked so far, merged over the committed samples (live.ts).
	const samples = liveSamples(tracker.id, tracker.samples);
	const live = samples !== tracker.samples;
	const [tip, setTip] = useState<StripTip | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const shown = useRef(false);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);

	const draw = useCallback<TileDraw>(
		(ctx, tile) =>
			drawRuns(
				ctx,
				stripRuns({
					clip,
					seqRate: p.rate,
					samples,
					clipX: p.x,
					pxPerFrame: p.pxPerFrame,
					x0: tile.x0,
					x1: tile.x0 + tile.width,
				}),
				tile.height,
			),
		[clip, samples, p.rate, p.x, p.pxPerFrame],
	);
	const press = useGlyphPress(props.interactive, () => props.onActivate(tracker.id));

	const span = stripSpanPx({ clip, seqRate: p.rate, samples, clipX: p.x, pxPerFrame: p.pxPerFrame });
	if (!span) return null;
	const vis0 = Math.max(p.x, -OVERSCAN_PX);
	const vis1 = Math.min(p.x + p.w, p.viewportWidth + OVERSCAN_PX);
	const a = Math.max(vis0, span.x0);
	const b = Math.min(vis1, span.x1);
	if (b <= a) return null;
	// Interactive part: the tracked span minus the clip's trim edge zones (TL-531).
	const zone = edgeZonePx(p.w);
	const ha = Math.max(a, p.x + zone);
	const hb = Math.min(b, p.x + p.w - zone);

	const tipAt = (clientX: number, target: HTMLElement): StripTip | null => {
		const rect = target.getBoundingClientRect();
		const x = ha + (clientX - rect.left);
		const hit = frameUnderPointer(
			{ clip, seqRate: p.rate, samples, clipX: p.x, pxPerFrame: p.pxPerFrame },
			x,
		);
		if (!hit) return null;
		const text = stripFrameText(tracker.name, clip.start + hit.frame, hit.confidence, p.rate, props.tc);
		return { x: clientX, y: rect.top, text };
	};
	const onMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
		if (e.pointerType === 'touch') return;
		const next = tipAt(e.clientX, e.currentTarget);
		if (shown.current) {
			setTip(next);
			return;
		}
		if (timer.current) clearTimeout(timer.current);
		const el = e.currentTarget;
		const clientX = e.clientX;
		timer.current = setTimeout(() => {
			shown.current = true;
			setTip(tipAt(clientX, el));
		}, TIP_DELAY_MS);
	};
	const onLeave = () => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		shown.current = false;
		setTip(null);
	};

	return (
		<>
			<div
				className={cx('pointer-events-none absolute right-0 left-0', live && 'animate-pulse')}
				style={{ bottom, height, opacity: active ? 1 : 0.7 }}
				data-tracker-strip={tracker.id}
				data-active={active || undefined}
				data-live={live || undefined}
			>
				<CanvasTiles x0={a} x1={b} height={height} originX={p.x} draw={draw} />
			</div>
			{hb > ha ? (
				<button
					type="button"
					className={cx(
						'absolute block p-0',
						props.interactive ? 'pointer-events-auto cursor-pointer' : 'pointer-events-none',
					)}
					style={{ left: ha - p.x, width: hb - ha, bottom: props.hitBottom, height: props.hitHeight }}
					aria-label={trackerLine(clip, tracker, p.rate, props.tc)}
					data-testid="clip-tracker-strip"
					data-tracker-id={tracker.id}
					data-clip-id={clip.id}
					onPointerMove={onMove}
					onPointerLeave={onLeave}
					{...press}
				/>
			) : null}
			{tip && typeof document !== 'undefined'
				? createPortal(
						<div
							className="pointer-events-none fixed z-[var(--pr-z-tooltip)] max-w-[280px] rounded-pr-control bg-pr-tooltip px-2 py-1 font-pr text-pr-ui whitespace-nowrap text-pr-text shadow-pr-overlay select-none"
							style={{ left: tip.x + 8, top: tip.y - 28 }}
							role="tooltip"
							data-testid="clip-tracker-strip-tip"
						>
							{tip.text}
						</div>,
						document.body,
					)
				: null}
		</>
	);
}

/** The trackers drawn as strips: tracked ones, at most `max`, the active one always among them. */
function shownTrackers(
	trackers: readonly ClipTracker[],
	active: string | null,
	max: number,
): { shown: ClipTracker[]; hidden: number } {
	const tracked = trackers.filter((t) => (liveSamples(t.id, t.samples)?.confidence.length ?? 0) > 0);
	if (tracked.length <= max) return { shown: tracked, hidden: 0 };
	const shown = tracked.slice(0, max);
	const act = tracked.find((t) => t.id === active);
	if (act && !shown.includes(act)) shown[max - 1] = act;
	return { shown, hidden: tracked.length - max };
}

export function TrackerStrips(p: ClipDecorationProps) {
	const trackers = trackersOf(p.clip);
	// Only plate clips subscribe, and they re-render only when the active tracker enters or leaves them.
	const active = useTracking((s) =>
		s.activeTrackerId && trackers.some((t) => t.id === s.activeTrackerId) ? s.activeTrackerId : null,
	);
	// Live progress of running jobs on this clip's trackers: a throttled (≤ 10 Hz) version per tracker (live.ts).
	useTracking((s) => trackers.map((t) => s.liveVersion[t.id] ?? 0).join(','));
	const reveal = useRevealTracker();
	const session = useSessionOrNull();
	const tc = useMemo(() => tcOptions(session, p.clip.id), [session, p.clip.id]);
	const contentH = p.height - NAME_STRIP_PX - 1;
	// LOD: no strips on short or hairline clips.
	if (contentH < 8 || p.w < 2 || !trackers.length) return null;
	const max = contentH >= 24 ? MAX_STRIPS : contentH >= 14 ? 2 : 1;
	const { shown, hidden } = shownTrackers(trackers, active, max);
	if (!shown.length) return null;
	const rows: { tracker: ClipTracker; bottom: number; height: number }[] = [];
	let bottom = 1;
	for (const t of shown) {
		const h = t.id === active ? ACTIVE_STRIP_PX : STRIP_PX;
		rows.push({ tracker: t, bottom, height: h });
		bottom += h + STRIP_GAP_PX;
	}
	const onActivate = (trackerId: string) => reveal(p.clip.id, trackerId);
	return (
		<div className="pointer-events-none absolute inset-0" data-tracker-strips={p.clip.id}>
			{rows.map((r, i) => (
				<StripRow
					key={r.tracker.id}
					deco={p}
					tracker={r.tracker}
					bottom={r.bottom}
					height={r.height}
					// Hit rows cover the gaps (and the bottom px / 2 px above the top strip) so they are easy to hit.
					hitBottom={i === 0 ? 0 : r.bottom}
					hitHeight={r.height + (i === 0 ? r.bottom : 0) + (i === rows.length - 1 ? 2 : STRIP_GAP_PX)}
					active={r.tracker.id === active}
					interactive={!p.trackLocked}
					tc={tc}
					onActivate={onActivate}
				/>
			))}
			{hidden > 0 ? (
				<span
					className="pointer-events-none absolute text-[9px] leading-[10px] text-pr-strong"
					style={{ left: Math.max(0, -p.x) + 2, bottom: bottom + 1 }}
					data-tracker-strips-more={hidden}
				>
					+{hidden}
				</span>
			) : null}
		</div>
	);
}
