// Mini-timeline pieces for Effect Controls (S03:EC-020…024, S05:ECP-006): ruler with clip range bar,
// per-row keyframe lanes with interpolation glyphs, summary diamonds on effect headers, and the
// playhead line that follows the TransportStore imperatively (no React render per frame).
import { formatTimecode, isRovingKey, type Keyframe, type Sequence } from '@jasper/project';
import type { TransportStore } from '@jasper/session';
import { cx } from '@jasper/ui';
import {
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from 'react';
import { exactFrameOf, type Row } from '../properties/lib/model.ts';
import { glyphHalves, halfPath, pctOf, type Range, rulerTicks } from './lib.ts';

function KeyGlyph(props: {
	left: ReturnType<typeof glyphHalves>['left'];
	right: ReturnType<typeof glyphHalves>['right'];
	selected?: boolean;
	summary?: boolean;
	/** keyframes-blend: a roving key (After Effects draws it as a small dot). */
	roving?: boolean;
}) {
	const fill = props.summary
		? 'var(--pr-text-tertiary)'
		: props.selected
			? 'var(--pr-keyframe-selected)'
			: 'var(--pr-keyframe)';
	const stroke = props.summary
		? 'var(--pr-text-tertiary)'
		: props.selected
			? 'var(--pr-keyframe-selected-stroke)'
			: 'var(--pr-keyframe-stroke)';
	if (props.roving)
		return (
			<svg width={9} height={9} viewBox="0 0 9 9" aria-hidden className="block">
				<circle cx={4.5} cy={4.5} r={2.2} fill={fill} stroke={stroke} strokeWidth={0.6} />
			</svg>
		);
	return (
		<svg width={9} height={9} viewBox="0 0 9 9" aria-hidden className="block">
			<path d={halfPath(props.left, 'left')} fill={fill} stroke={stroke} strokeWidth={0.6} />
			<path d={halfPath(props.right, 'right')} fill={fill} stroke={stroke} strokeWidth={0.6} />
		</svg>
	);
}

type KeyPointerHandler = (
	e: ReactPointerEvent<HTMLElement>,
	info: { clipId: string; keyframeId: string; frame: number },
) => void;

/** One property row's keyframes (S03:EC-022). */
export function KeyLane(props: {
	row: Row;
	seq: Sequence;
	range: Range;
	selected: ReadonlySet<string>;
	onKeyPointerDown: KeyPointerHandler;
	onKeyDoubleClick(frame: number): void;
	onKeyContextMenu(e: ReactMouseEvent, clipId: string, keyframeId: string): void;
	onLanePointerDown(e: ReactPointerEvent<HTMLElement>): void;
}) {
	const b = props.row.bindings[0]!;
	const kfs = b.resolved.anim?.keyframes ?? [];
	return (
		<div
			data-lane
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
						className="absolute top-1/2 flex size-[13px] -translate-x-1/2 -translate-y-1/2 items-center justify-center"
						style={{ left: `${pct}%` }}
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
}

/** Summary keys of a collapsed/expanded effect header: union of its rows' key frames (reference only). */
export function SummaryLane(props: { rows: Row[]; seq: Sequence; range: Range }) {
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
					className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
					style={{ left: `${pctOf(props.range, f)}%` }}
				>
					<KeyGlyph left="linear" right="linear" summary />
				</span>
			))}
		</div>
	);
}

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
