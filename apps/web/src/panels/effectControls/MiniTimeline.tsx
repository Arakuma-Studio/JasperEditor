// Mini-timeline pieces for Effect Controls (S03:EC-020…024, S05:ECP-006): ruler with clip range bar,
// per-row keyframe lanes with interpolation glyphs, summary diamonds on effect headers, and the
// playhead line that follows the TransportStore imperatively (no React render per frame).
import { formatTimecode, type Sequence } from '@jasper/project';
import type { TransportStore } from '@jasper/session';
import { cx } from '@jasper/ui';
import {
	type MouseEvent as ReactMouseEvent,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useEffect,
	useRef,
} from 'react';
import { exactFrameOf, type Row } from '../properties/lib/model.ts';
import { glyphHalves, halfPath, pctOf, type Range, rulerTicks } from './lib.ts';

export function KeyGlyph(props: {
	left: ReturnType<typeof glyphHalves>['left'];
	right: ReturnType<typeof glyphHalves>['right'];
	selected?: boolean;
	summary?: boolean;
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
	return (
		<svg width={9} height={9} viewBox="0 0 9 9" aria-hidden className="block">
			<path d={halfPath(props.left, 'left')} fill={fill} stroke={stroke} strokeWidth={0.6} />
			<path d={halfPath(props.right, 'right')} fill={fill} stroke={stroke} strokeWidth={0.6} />
		</svg>
	);
}

export type KeyPointerHandler = (
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
				return (
					<button
						type="button"
						key={k.id}
						data-kf-id={k.id}
						data-kf-clip={b.clip.id}
						data-kf-shape={`${h.left}/${h.right}`}
						aria-label={`Keyframe ${props.row.label} at frame ${Math.round(frame)}`}
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
						<KeyGlyph left={h.left} right={h.right} selected={selected} />
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

/** Ruler + clip range bar; dragging scrubs the playhead (S03:EC-020/021). */
export function Ruler(props: {
	seq: Sequence;
	range: Range;
	clip: { start: number; duration: number; name: string };
	transport: TransportStore;
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
	return (
		<div
			ref={ref}
			className="relative h-[34px] flex-1 cursor-pointer select-none"
			onPointerDown={onPointerDown}
			data-testid="ec-ruler"
		>
			{rulerTicks(range).map((f) => (
				<span
					key={f}
					className="absolute top-0 h-[14px] border-l border-pr-border-strong pl-[2px] text-[10px] leading-[12px] text-pr-muted"
					style={{ left: `${pctOf(range, f)}%` }}
				>
					{formatTimecode(f, seq.settings.frameRate, { dropFrame: seq.settings.dropFrame })}
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
