// Monitor chrome shared by Program and Source (S05 §16.3, R-PUI §8.1): current-time display with entry,
// zoom and resolution dropdowns, settings menu, duration display, mini ruler with In/Out, transport bar.
// Per-frame values (timecode text, ruler playhead) are written to the DOM from TransportStore
// subscriptions, never through React state (S02:TL-155, S05:PERF-004).
import { formatTimecode, parseTimecodeEntry, type Rational } from '@jasper/project';
import type { TransportStore } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { Tooltip, tooltipText } from '@jasper/ui';
import { Check, Settings } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Size } from './viewport.ts';

export function useElementSize<T extends HTMLElement>(): [React.RefObject<T | null>, Size] {
	const ref = useRef<T>(null);
	const [size, setSize] = useState<Size>({ width: 0, height: 0 });
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const measure = () =>
			setSize((s) =>
				s.width === el.clientWidth && s.height === el.clientHeight
					? s
					: { width: el.clientWidth, height: el.clientHeight },
			);
		measure();
		if (typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	return [ref, size];
}

export type TimecodeFormat = { rate: Rational; dropFrame: boolean; startFrames?: number };

function formatTc(frame: number, f: TimecodeFormat): string {
	return formatTimecode(frame, f.rate, { dropFrame: f.dropFrame, startFrames: f.startFrames });
}

/** Current time: blue, click to type (S02:TL-205 entry forms), updated without React re-renders. */
export function TimecodeDisplay({
	transport,
	format,
	onSeek,
	testId,
}: {
	transport: TransportStore;
	format: TimecodeFormat;
	onSeek(frame: number): void;
	testId?: string;
}) {
	const spanRef = useRef<HTMLButtonElement>(null);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState('');
	const fmtRef = useRef(format);
	fmtRef.current = format;
	const write = () => {
		if (spanRef.current) spanRef.current.textContent = formatTc(transport.getState().frame, fmtRef.current);
	};
	const writeRef = useRef(write);
	writeRef.current = write;
	useLayoutEffect(
		() =>
			transport.subscribe((s, p) => {
				if (s.frame !== p.frame) writeRef.current();
			}),
		[transport],
	);
	// After mount, a format change or leaving edit mode (the span is re-created).
	useLayoutEffect(() => {
		void editing;
		void format;
		writeRef.current();
	}, [editing, format]);
	if (editing) {
		return (
			<input
				// biome-ignore lint/a11y/noAutofocus: timecode entry replaces the display on click (S05:TY-006)
				autoFocus
				data-testid={testId ? `${testId}-input` : undefined}
				aria-label="Enter timecode"
				className="w-[110px] rounded-pr-control bg-pr-field px-1 font-pr text-[length:var(--pr-font-size-monitor-tc)] text-pr-timecode outline-none"
				style={{ fontVariantNumeric: 'tabular-nums' }}
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={() => setEditing(false)}
				onKeyDown={(e) => {
					e.stopPropagation();
					if (e.key === 'Escape') setEditing(false);
					if (e.key === 'Enter') {
						const f = parseTimecodeEntry(draft, format.rate, {
							current: transport.getState().frame,
							dropFrame: format.dropFrame,
						});
						if (f !== null) onSeek(Math.max(0, f - (format.startFrames ?? 0)));
						setEditing(false);
					}
				}}
			/>
		);
	}
	return (
		// Text is written by the transport subscription above, never by React (no per-frame renders).
		<button
			type="button"
			ref={spanRef}
			data-testid={testId}
			className="pr-tabular cursor-text bg-transparent p-0 select-none whitespace-nowrap font-pr text-[length:var(--pr-font-size-monitor-tc)] text-pr-timecode"
			style={{ fontVariantNumeric: 'tabular-nums' }}
			title="Click to enter a timecode"
			onClick={() => {
				setDraft(formatTc(transport.getState().frame, format));
				setEditing(true);
			}}
		/>
	);
}

/** Small native select styled with tokens. */
export function MonitorSelect<T extends string | number>({
	label,
	value,
	options,
	onChange,
	testId,
}: {
	label: string;
	value: T;
	options: readonly { value: T; label: string }[];
	onChange(v: T): void;
	testId?: string;
}) {
	return (
		<select
			aria-label={label}
			title={label}
			data-testid={testId}
			className="h-[20px] rounded-pr-control border border-pr-border bg-pr-field px-1 text-pr-small text-pr-text outline-none"
			value={String(value)}
			onChange={(e) => {
				const opt = options.find((o) => String(o.value) === e.target.value);
				if (opt) onChange(opt.value);
			}}
		>
			{options.map((o) => (
				<option key={String(o.value)} value={String(o.value)}>
					{o.label}
				</option>
			))}
		</select>
	);
}

type SettingsItem =
	| { type: 'toggle'; label: string; checked: boolean; onToggle(): void; shortcut?: string }
	| { type: 'separator' };

/** Wrench menu (S03:PGM-040 subset). */
export function SettingsMenu({ items, testId }: { items: SettingsItem[]; testId?: string }) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const close = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) setOpen(false);
		};
		window.addEventListener('pointerdown', close, true);
		return () => window.removeEventListener('pointerdown', close, true);
	}, [open]);
	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				aria-label="Settings"
				title="Settings"
				data-testid={testId}
				className="inline-flex size-[var(--pr-icon-btn)] items-center justify-center rounded-pr-control text-pr-icon hover:bg-pr-hover hover:text-pr-icon-hover"
				onClick={() => setOpen((o) => !o)}
			>
				<Settings size={16} />
			</button>
			{open ? (
				<div
					role="menu"
					className="absolute right-0 bottom-[26px] min-w-[220px] rounded-pr-menu border border-pr-menu-border bg-pr-menu py-1 text-pr-ui text-pr-text shadow-pr-floating"
					style={{ zIndex: 'var(--pr-z-popover)' as never }}
				>
					{items.map((it, i) =>
						it.type === 'separator' ? (
							// biome-ignore lint/suspicious/noArrayIndexKey: static menu model
							<div key={i} className="my-1 h-px bg-pr-border" />
						) : (
							<button
								key={it.label}
								type="button"
								role="menuitemcheckbox"
								aria-checked={it.checked}
								className="flex w-full items-center gap-2 px-2 py-[3px] text-left hover:bg-pr-accent-fill hover:text-pr-on-accent"
								onClick={() => {
									it.onToggle();
									setOpen(false);
								}}
							>
								<span className="inline-flex w-4 justify-center">
									{it.checked ? <Check size={12} /> : null}
								</span>
								<span className="flex-1">{it.label}</span>
								{it.shortcut ? <span className="text-pr-small text-pr-muted">{it.shortcut}</span> : null}
							</button>
						),
					)}
				</div>
			) : null}
		</div>
	);
}

type RulerMarker = { id: string; frame: number; color: string };

/**
 * Mini time ruler (S05:PGM-003): ticks, In/Out range, markers and a draggable playhead. Clicking or
 * dragging seeks. The playhead head moves by direct style writes.
 */
export function MiniRuler({
	transport,
	duration,
	markIn,
	markOut,
	markers = [],
	fps,
	onSeek,
	onScrubStart,
	testId,
}: {
	transport: TransportStore;
	/** Frames represented by the full width. */
	duration: number;
	markIn: number | null;
	markOut: number | null;
	markers?: RulerMarker[];
	fps: number;
	onSeek(frame: number): void;
	onScrubStart?(): void;
	testId?: string;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const headRef = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	const durRef = useRef(duration);
	durRef.current = Math.max(1, duration);
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
	useLayoutEffect(() => {
		const place = () => {
			const w = ref.current?.clientWidth ?? 0;
			const x = (transport.getState().frame / durRef.current) * w;
			if (headRef.current) headRef.current.style.transform = `translateX(${x}px)`;
		};
		place();
		return transport.subscribe((s, p) => {
			if (s.frame !== p.frame) place();
		});
	}, [transport]);
	useLayoutEffect(() => {
		const x = (transport.getState().frame / Math.max(1, duration)) * width;
		if (headRef.current) headRef.current.style.transform = `translateX(${x}px)`;
	}, [duration, width, transport]);
	const frameAt = (clientX: number) => {
		const r = ref.current!.getBoundingClientRect();
		const u = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
		return Math.round(u * durRef.current);
	};
	const ticks = rulerTicks(duration, width, fps);
	const d = Math.max(1, duration);
	return (
		<div
			ref={ref}
			data-testid={testId}
			className="relative h-[16px] shrink-0 cursor-pointer select-none border-t border-pr-border-subtle"
			onPointerDown={(e) => {
				if (e.button !== 0) return;
				(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
				onScrubStart?.();
				onSeek(frameAt(e.clientX));
			}}
			onPointerMove={(e) => {
				if (e.buttons & 1) onSeek(frameAt(e.clientX));
			}}
		>
			{markIn !== null || markOut !== null ? (
				<div
					data-testid={testId ? `${testId}-inout` : undefined}
					className="absolute top-0 bottom-0"
					style={{
						background: 'var(--pr-inout-range)',
						left: `${((markIn ?? 0) / d) * 100}%`,
						width: `${(((markOut ?? d) - (markIn ?? 0)) / d) * 100}%`,
					}}
				/>
			) : null}
			<svg className="pointer-events-none absolute inset-0" width="100%" height="16" aria-hidden="true">
				{ticks.map((t) => (
					<line
						key={t.frame}
						x1={(t.frame / d) * width}
						x2={(t.frame / d) * width}
						y1={t.major ? 7 : 11}
						y2={16}
						stroke="var(--pr-border-strong)"
						strokeWidth={1}
					/>
				))}
				{markIn !== null ? (
					<text x={(markIn / d) * width} y={11} fill="var(--pr-inout-bracket)" fontSize={11}>
						{'{'}
					</text>
				) : null}
				{markOut !== null ? (
					<text x={(markOut / d) * width - 5} y={11} fill="var(--pr-inout-bracket)" fontSize={11}>
						{'}'}
					</text>
				) : null}
				{markers.map((m) => {
					// Marker glyph: a small downward pentagon in the marker color (R-PUI §4.3, §9.4).
					const x = (m.frame / d) * width;
					return (
						<path key={m.id} d={`M${x - 4} 0h8v4.5l-4 3.5l-4-3.5z`} fill={m.color} data-marker-glyph="" />
					);
				})}
			</svg>
			<div
				ref={headRef}
				className="pointer-events-none absolute top-0 left-0 h-full"
				style={{ willChange: 'transform' }}
			>
				<div
					className="absolute top-0 h-full w-px bg-pr-playhead"
					style={{ left: 0 }}
					data-testid={testId ? `${testId}-playhead` : undefined}
				/>
				{/* 12 px blue head, the same pentagon as the Timeline playhead (R-PUI §4.3, §8.1 row 2). */}
				<div
					className="absolute top-0 h-[10px] w-[12px]"
					style={{
						left: -6,
						background: 'var(--pr-playhead)',
						clipPath: 'polygon(0 0, 100% 0, 100% 50%, 50% 100%, 0 50%)',
					}}
				/>
			</div>
		</div>
	);
}

/** Adaptive tick positions: majors ≥ 80 px apart on a 1/2/5 × seconds grid (S02 A.9 spirit). */
function rulerTicks(duration: number, width: number, fps: number): { frame: number; major: boolean }[] {
	if (duration <= 0 || width <= 0) return [];
	const pxPerFrame = width / duration;
	const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600].map((s) => Math.round(s * fps));
	const major = candidates.find((c) => c * pxPerFrame >= 80) ?? candidates[candidates.length - 1]!;
	const minor = Math.max(1, Math.round(major / 5));
	const out: { frame: number; major: boolean }[] = [];
	if (minor * pxPerFrame < 6) {
		for (let f = 0; f <= duration; f += major) out.push({ frame: f, major: true });
		return out;
	}
	for (let f = 0; f <= duration; f += minor) out.push({ frame: f, major: f % major === 0 });
	return out;
}

/** 28×28 transport button with a lucide/our glyph (S05:PGM-005). */
export function TransportButton({
	label,
	shortcut,
	onClick,
	children,
	active,
	testId,
	disabled,
}: {
	label: string;
	shortcut?: string;
	onClick(): void;
	children: ReactNode;
	active?: boolean;
	testId?: string;
	disabled?: boolean;
}) {
	return (
		<Tooltip content={tooltipText(label, shortcut)} side="top">
			<button
				type="button"
				aria-label={label}
				data-testid={testId}
				disabled={disabled}
				aria-pressed={active === undefined ? undefined : active}
				className={`inline-flex size-[var(--pr-transport-btn)] items-center justify-center rounded-pr-control transition-colors duration-100 hover:bg-pr-hover disabled:pointer-events-none disabled:text-pr-dim ${
					active ? 'text-pr-accent' : 'text-pr-icon hover:text-pr-icon-hover'
				}`}
				onClick={onClick}
			>
				{children}
			</button>
		</Tooltip>
	);
}

/** Re-renders only when `playing` flips (the Play/Stop glyph). */
export function useTransportPlaying(transport: TransportStore): boolean {
	return useStoreSelector(
		{ getState: () => transport.getState(), subscribe: (l) => transport.subscribe(l) },
		(s) => s.playing,
	);
}

/** Duration display: In→Out when marks exist, else the full duration (S05:PGM-001). */
export function durationLabel(
	format: TimecodeFormat,
	total: number,
	markIn: number | null,
	markOut: number | null,
): string {
	const d = markIn !== null || markOut !== null ? (markOut ?? total) - (markIn ?? 0) : total;
	return formatTimecode(Math.max(0, d), format.rate, { dropFrame: format.dropFrame });
}
