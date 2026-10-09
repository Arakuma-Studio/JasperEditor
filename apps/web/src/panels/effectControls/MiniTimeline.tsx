// Mini-timeline pieces for Effect Controls (S03:EC-020…024, S05:ECP-006): ruler with clip range bar,
// per-row keyframe lanes with interpolation glyphs, summary diamonds on effect headers, and the
// playhead line that follows the TransportStore imperatively (no React render per frame).
import { isRovingKey, type Keyframe, type Sequence } from '@jasper/project';
import type { TransportStore } from '@jasper/session';
import { cx } from '@jasper/ui';
import {
	memo,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';
import { formatTimecode } from '../../gaps/time-display.ts';
import { exactFrameOf, type Row } from '../properties/lib/model.ts';
import { cssVar, designTokens } from '../timeline/components/canvas.tsx';
import { glyphHalves, halfPath, pctOf, type Range, rulerTicks } from './lib.ts';

/**
 * ui-perf: key glyphs are CSS background images (an SVG data URI per shape and colour), not inline SVG: every inline
 * <svg> is a transform node for the compositor, and a lane of hundreds of keys made each repaint (the playhead moves
 * every frame of a scrub) pay for all of them. Colours are the design tokens, resolved (and re-resolved when the theme
 * changes, `designTokens`).
 */
const glyphUris = new Map<string, string>();
function glyphUri(
	shape:
		| { left: ReturnType<typeof glyphHalves>['left']; right: ReturnType<typeof glyphHalves>['right'] }
		| 'roving',
	fill: string,
	stroke: string,
): string {
	const key = `${shape === 'roving' ? 'roving' : `${shape.left}/${shape.right}`}|${fill}|${stroke}`;
	let uri = glyphUris.get(key);
	if (!uri) {
		const paint = `fill="${fill || 'currentColor'}" stroke="${stroke || 'currentColor'}" stroke-width="0.6"`;
		const body =
			shape === 'roving'
				? `<circle cx="4.5" cy="4.5" r="2.2" ${paint}/>`
				: `<path d="${halfPath(shape.left, 'left')}" ${paint}/><path d="${halfPath(shape.right, 'right')}" ${paint}/>`;
		uri = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 9 9">${body}</svg>`)}")`;
		glyphUris.set(key, uri);
	}
	return uri;
}

function KeyGlyph(props: {
	left: ReturnType<typeof glyphHalves>['left'];
	right: ReturnType<typeof glyphHalves>['right'];
	selected?: boolean;
	summary?: boolean;
	/** keyframes-blend: a roving key (After Effects draws it as a small dot). */
	roving?: boolean;
}) {
	const root = typeof document === 'undefined' ? null : document.documentElement;
	const fill = cssVar(
		root,
		props.summary ? '--pr-text-tertiary' : props.selected ? '--pr-keyframe-selected' : '--pr-keyframe',
	);
	const stroke = cssVar(
		root,
		props.summary
			? '--pr-text-tertiary'
			: props.selected
				? '--pr-keyframe-selected-stroke'
				: '--pr-keyframe-stroke',
	);
	return (
		<span
			aria-hidden
			className="block size-[9px]"
			data-kf-glyph={props.roving ? 'roving' : `${props.left}/${props.right}`}
			style={{
				backgroundImage: glyphUri(
					props.roving ? 'roving' : { left: props.left, right: props.right },
					fill,
					stroke,
				),
			}}
		/>
	);
}

type KeyPointerHandler = (
	e: ReactPointerEvent<HTMLElement>,
	info: { clipId: string; keyframeId: string; frame: number },
) => void;

type KeyLaneProps = {
	row: Row;
	seq: Sequence;
	range: Range;
	selected: ReadonlySet<string>;
	onKeyPointerDown: KeyPointerHandler;
	onKeyDoubleClick(frame: number): void;
	onKeyContextMenu(e: ReactMouseEvent, clipId: string, keyframeId: string): void;
	onLanePointerDown(e: ReactPointerEvent<HTMLElement>): void;
};

/**
 * ui-perf: a lane re-renders only when what it draws changes (its keyframes, clip, range, selection); the playhead
 * moving (the rows are rebuilt with the values at the new frame) leaves it alone. Pass stable handlers.
 */
function keyLaneEqual(a: KeyLaneProps, b: KeyLaneProps): boolean {
	const ba = a.row.bindings[0];
	const bb = b.row.bindings[0];
	return (
		a.row.id === b.row.id &&
		a.row.label === b.row.label &&
		ba?.clip === bb?.clip &&
		ba?.resolved.anim?.keyframes === bb?.resolved.anim?.keyframes &&
		a.seq === b.seq &&
		a.range.start === b.range.start &&
		a.range.end === b.range.end &&
		a.selected === b.selected &&
		a.onKeyPointerDown === b.onKeyPointerDown &&
		a.onKeyDoubleClick === b.onKeyDoubleClick &&
		a.onKeyContextMenu === b.onKeyContextMenu &&
		a.onLanePointerDown === b.onLanePointerDown
	);
}

/** One property row's keyframes (S03:EC-022). */
export const KeyLane = memo(function KeyLane(props: KeyLaneProps) {
	useSyncExternalStore(designTokens.subscribe, designTokens.version, designTokens.version);
	const b = props.row.bindings[0]!;
	const kfs = b.resolved.anim?.keyframes ?? [];
	return (
		<div
			data-lane={props.row.id}
			className="relative h-full min-h-[var(--pr-row-h)] flex-1 overflow-hidden"
			onPointerDown={props.onLanePointerDown}
		>
			{kfs.map((k, i) => {
				const frame = exactFrameOf(b.clip, k.time, props.seq);
				const pct = pctOf(props.range, frame);
				if (pct < -2 || pct > 102) return null;
				const h = glyphHalves(kfs, i);
				const selected = props.selected.has(k.id);
				const roving = isRovingKey(kfs as readonly Keyframe<unknown>[], i);
				return (
					<button
						type="button"
						key={k.id}
						data-kf-id={k.id}
						data-kf-clip={b.clip.id}
						data-kf-shape={roving ? 'roving' : `${h.left}/${h.right}`}
						aria-label={`${roving ? 'Roving keyframe' : 'Keyframe'} ${props.row.label} at frame ${Math.round(frame)}`}
						aria-pressed={selected}
						// ui-perf: centred with calc() rather than a CSS translate: a transform per key made every repaint
						// of a lane with hundreds of keys pay for as many compositor transform nodes (layerization).
						className="absolute flex size-[13px] items-center justify-center"
						style={{ left: `calc(${pct}% - 6.5px)`, top: 'calc(50% - 6.5px)' }}
						onPointerDown={(e) => {
							e.stopPropagation();
							props.onKeyPointerDown(e, { clipId: b.clip.id, keyframeId: k.id, frame });
						}}
						onDoubleClick={() => props.onKeyDoubleClick(Math.round(frame))}
						onContextMenu={(e) => props.onKeyContextMenu(e, b.clip.id, k.id)}
					>
						<KeyGlyph left={h.left} right={h.right} selected={selected} roving={roving} />
					</button>
				);
			})}
		</div>
	);
}, keyLaneEqual);

/** Summary keys of a collapsed/expanded effect header: union of its rows' key frames (reference only). */
type SummaryLaneProps = { rows: Row[]; seq: Sequence; range: Range };
/** ui-perf: like KeyLane, the summary re-renders only when the rows' keyframes change. */
function summaryLaneEqual(a: SummaryLaneProps, b: SummaryLaneProps): boolean {
	if (a.seq !== b.seq || a.range.start !== b.range.start || a.range.end !== b.range.end) return false;
	if (a.rows.length !== b.rows.length) return false;
	return a.rows.every((r, i) => {
		const x = r.bindings[0];
		const y = b.rows[i]!.bindings[0];
		return x?.clip === y?.clip && x?.resolved.anim?.keyframes === y?.resolved.anim?.keyframes;
	});
}

export const SummaryLane = memo(function SummaryLane(props: SummaryLaneProps) {
	useSyncExternalStore(designTokens.subscribe, designTokens.version, designTokens.version);
	const frames = new Set<number>();
	for (const r of props.rows) {
		const b = r.bindings[0]!;
		for (const k of b.resolved.anim?.keyframes ?? [])
			frames.add(Math.round(exactFrameOf(b.clip, k.time, props.seq)));
	}
	return (
		<div className="pointer-events-none relative h-full min-h-[var(--pr-row-h)] flex-1 overflow-hidden">
			{[...frames].map((f) => (
				<span
					key={f}
					className="absolute size-[9px]"
					style={{ left: `calc(${pctOf(props.range, f)}% - 4.5px)`, top: 'calc(50% - 4.5px)' }}
				>
					<KeyGlyph left="linear" right="linear" summary />
				</span>
			))}
		</div>
	);
}, summaryLaneEqual);

/** Premiere-style short ruler label: drop a leading zero hour field (`00:00:02:00` → `00:02:00`). */
function rulerLabel(tc: string): string {
	return /^00[:;]/.test(tc) ? tc.slice(3) : tc;
}

/** Ruler + clip range bar; dragging scrubs the playhead (S03:EC-020/021). */
export function Ruler(props: {
	seq: Sequence;
	range: Range;
	clip: { start: number; duration: number; name: string };
	transport: TransportStore;
	/** M2 (wp-m2-text-anim, S11:TXA-022): drawn over the clip bar (text animation In/Out bars). */
	overlay?: ReactNode;
}) {
	const { range, seq } = props;
	const ref = useRef<HTMLDivElement>(null);
	const seekAt = (clientX: number) => {
		const el = ref.current;
		if (!el) return;
		const r = el.getBoundingClientRect();
		const f = range.start + ((clientX - r.left) / Math.max(1, r.width)) * (range.end - range.start);
		props.transport.seek(Math.max(0, Math.round(f)));
	};
	const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return;
		seekAt(e.clientX);
		const move = (ev: PointerEvent) => seekAt(ev.clientX);
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	};
	const clipL = pctOf(range, props.clip.start);
	const clipR = pctOf(range, props.clip.start + props.clip.duration);
	// Label density follows the ruler width (≈ 1 label per 90 px) so timecodes never overlap.
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const measure = () => setWidth(el.clientWidth);
		measure();
		if (typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const target = width > 0 ? Math.max(2, Math.floor(width / 64)) : undefined;
	return (
		<div
			ref={ref}
			className="relative h-[34px] flex-1 cursor-pointer overflow-hidden select-none"
			onPointerDown={onPointerDown}
			data-testid="ec-ruler"
		>
			{rulerTicks(range, target).map((f) => (
				<span
					key={f}
					className="pr-tabular absolute top-0 h-[14px] border-l border-pr-border-strong pl-[2px] text-[10px] leading-[12px] whitespace-nowrap text-pr-muted"
					style={{ left: `${pctOf(range, f)}%` }}
				>
					{rulerLabel(formatTimecode(f, seq.settings.frameRate, { dropFrame: seq.settings.dropFrame }))}
				</span>
			))}
			<span
				className="absolute top-[16px] h-[14px]"
				style={{ left: 0, width: `${Math.max(0, clipL)}%`, background: 'var(--pr-locked-hatch)' }}
			/>
			<span
				className="absolute top-[16px] h-[14px]"
				style={{ left: `${Math.min(100, clipR)}%`, right: 0, background: 'var(--pr-locked-hatch)' }}
			/>
			<span
				className={cx(
					'absolute top-[16px] flex h-[14px] items-center overflow-hidden rounded-[2px] bg-pr-raised px-1',
					'text-[10px] text-pr-text',
				)}
				style={{ left: `${clipL}%`, width: `${clipR - clipL}%` }}
				title={props.clip.name}
			>
				<span className="truncate">{props.clip.name}</span>
			</span>
			{props.overlay}
		</div>
	);
}

/** Blue playhead line positioned from TransportStore listeners (S02:TL-155, S05:PERF-004). */
export function usePlayheadLine(
	ref: RefObject<HTMLDivElement | null>,
	transport: TransportStore,
	range: Range,
): void {
	const { start, end } = range;
	useEffect(() => {
		const place = (frame: number) => {
			const el = ref.current;
			if (!el) return;
			const pct = pctOf({ start, end }, frame);
			el.style.left = `${pct}%`;
			el.style.display = pct < 0 || pct > 100 ? 'none' : 'block';
		};
		place(transport.getState().frame);
		return transport.subscribe((s, prev) => {
			if (s.frame !== prev.frame) place(s.frame);
		});
	}, [ref, transport, start, end]);
}
