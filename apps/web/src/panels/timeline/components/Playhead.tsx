// Playhead line and timecode readout (S02:TL-155, TL-205, TL-830/831). Both subscribe to the
// TransportStore and write to the DOM directly: a pure playhead move never re-renders React.
import { formatTimecode, parseTimecodeEntry, type Rational } from '@jasper/project';
import type { TransportStore } from '@jasper/session';
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { frameToX, type Viewport } from '../model/viewport.ts';

/** Playhead: head in the ruler plus a 1 px line through both regions. */
export function PlayheadLine(props: {
	transport: TransportStore;
	viewportRef: RefObject<Viewport>;
	rulerHeight: number;
	onHeadPointerDown?(e: React.PointerEvent): void;
	/** Called on every transport change (follow-playhead logic lives in the panel). */
	onFrame?(frame: number, playing: boolean): void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const cellRef = useRef<HTMLDivElement>(null);
	const place = (frame: number) => {
		const el = ref.current;
		const v = props.viewportRef.current;
		if (!el || !v) return;
		const x = frameToX(v, frame);
		el.style.transform = `translateX(${Math.round(x)}px)`;
		el.style.visibility = x < -12 || x > v.width + 12 ? 'hidden' : 'visible';
		const cell = cellRef.current;
		if (cell) {
			cell.style.width = `${v.pxPerFrame}px`;
			cell.style.display = v.pxPerFrame >= 6 ? 'block' : 'none';
		}
	};
	const onFrame = useRef(props.onFrame);
	onFrame.current = props.onFrame;
	const placeRef = useRef(place);
	placeRef.current = place;
	useEffect(
		() =>
			props.transport.subscribe((s) => {
				placeRef.current(s.frame);
				onFrame.current?.(s.frame, s.playing);
			}),
		[props.transport],
	);
	// Re-place after every render (zoom/scroll changes move the line without a transport change).
	useLayoutEffect(() => place(props.transport.getState().frame));
	return (
		<div
			ref={ref}
			className="pointer-events-none absolute top-0 bottom-0 left-0"
			style={{ zIndex: 20, width: 1 }}
			data-testid="timeline-playhead"
		>
			<div
				ref={cellRef}
				className="absolute top-0"
				style={{ height: 24, left: 0, background: 'var(--pr-inout-range)' }}
			/>
			<div
				className="pointer-events-auto absolute top-0 -left-[10px] h-[24px] w-[20px] cursor-ew-resize"
				onPointerDown={props.onHeadPointerDown}
				data-playhead-head
			>
				<div
					className="absolute top-[12px] left-[4px] h-[12px] w-[12px]"
					style={{
						background: 'var(--pr-playhead)',
						clipPath: 'polygon(0 0, 100% 0, 100% 55%, 50% 100%, 0 55%)',
					}}
				/>
			</div>
			<div
				className="absolute bottom-0 left-0 w-px"
				style={{ top: props.rulerHeight - 2, background: 'var(--pr-playhead)' }}
			/>
		</div>
	);
}

/**
 * Timeline timecode readout (TL-205): direct DOM text updates; click to type (partial timecode, `#frames`,
 * relative `+15`/`-1:00`), Enter seeks, Esc cancels; horizontal drag scrubs (1 frame / 2 px, Shift ×10);
 * Ctrl+click toggles timecode / frames.
 */
export function TimecodeReadout(props: {
	transport: TransportStore;
	rate: Rational;
	dropFrame: boolean;
	startFrames: number;
	frames: boolean;
	onToggleFrames(): void;
	onSeek(frame: number): void;
}) {
	const textRef = useRef<HTMLButtonElement>(null);
	const [editing, setEditing] = useState<string | null>(null);
	const drag = useRef<{ x: number; frame: number; moved: boolean } | null>(null);
	const fmt = (f: number) =>
		props.frames
			? String(f)
			: formatTimecode(f, props.rate, { dropFrame: props.dropFrame, startFrames: props.startFrames });
	const fmtRef = useRef(fmt);
	fmtRef.current = fmt;
	useEffect(
		() =>
			props.transport.subscribe((s) => {
				if (textRef.current) textRef.current.textContent = fmtRef.current(s.frame);
			}),
		[props.transport],
	);
	useLayoutEffect(() => {
		if (textRef.current) textRef.current.textContent = fmt(props.transport.getState().frame);
	});
	if (editing !== null) {
		return (
			<input
				// biome-ignore lint/a11y/noAutofocus: the field replaces the readout on click (TL-205)
				autoFocus
				className="h-[24px] w-[120px] rounded-pr-control bg-pr-field px-1 font-pr text-[length:var(--pr-font-size-timeline-tc)] pr-tabular text-pr-timecode outline-none"
				value={editing}
				aria-label="Playhead timecode"
				data-testid="timeline-timecode-input"
				onChange={(e) => setEditing(e.target.value)}
				onBlur={() => setEditing(null)}
				onKeyDown={(e) => {
					e.stopPropagation();
					if (e.key === 'Escape') setEditing(null);
					if (e.key === 'Enter') {
						const f = parseTimecodeEntry(editing, props.rate, {
							current: props.transport.getState().frame,
							dropFrame: props.dropFrame,
							startFrames: props.startFrames,
						});
						if (f !== null) props.onSeek(f);
						setEditing(null);
					}
				}}
			/>
		);
	}
	return (
		<button
			type="button"
			ref={textRef}
			className="cursor-ew-resize bg-transparent p-0 text-left font-pr text-[length:var(--pr-font-size-timeline-tc)] pr-tabular leading-[24px] text-pr-timecode tabular-nums select-none"
			title="Playhead position (click to type, drag to scrub, Ctrl+click toggles frames)"
			data-testid="timeline-timecode"
			onPointerDown={(e) => {
				if (e.ctrlKey || e.metaKey) return;
				(e.target as Element).setPointerCapture?.(e.pointerId);
				drag.current = { x: e.clientX, frame: props.transport.getState().frame, moved: false };
			}}
			onPointerMove={(e) => {
				const d = drag.current;
				if (!d) return;
				const dx = e.clientX - d.x;
				if (Math.abs(dx) >= 2) d.moved = true;
				if (d.moved) props.onSeek(Math.max(0, d.frame + Math.trunc(dx / 2) * (e.shiftKey ? 10 : 1)));
			}}
			onPointerUp={(e) => {
				const d = drag.current;
				drag.current = null;
				if (e.ctrlKey || e.metaKey) {
					props.onToggleFrames();
					return;
				}
				if (d && !d.moved) setEditing(fmt(props.transport.getState().frame));
			}}
			onKeyDown={(e) => {
				if (e.key === 'Enter') setEditing(fmt(props.transport.getState().frame));
			}}
		/>
	);
}
