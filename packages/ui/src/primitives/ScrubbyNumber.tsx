// Callers map callbacks onto session gestures so one drag is one undo step:
//   onScrubStart → session.beginGesture(label); onScrub → gesture.update(...); onScrubEnd → gesture.commit();
//   onScrubCancel → gesture.cancel(); onCommit (typed entry, arrow keys) → session.apply(...).
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from 'react';
import { forceCursor } from '../cursors/ForcedCursor.tsx';
import { cx } from '../cx.ts';
import {
	clampValue,
	evaluateEntry,
	formatNumber,
	type NumericSpec,
	roundTo,
	scrubDelta,
	stepMultiplier,
} from './scrubby-math.ts';

export type ScrubbyNumberProps = NumericSpec & {
	/** Current value; `null` = mixed values in a multi-selection (shows `–`, drags apply a delta). */
	value: number | null;
	/** Accessible name, e.g. "Scale". */
	label: string;
	/** Unit shown after the value in secondary text (`%`, `°`, `px`, `dB`). */
	unit?: string;
	disabled?: boolean;
	/** Pixels of drag per step (default 1). */
	pixelsPerStep?: number;
	/** Custom display formatting (default: fixed `precision` decimals). */
	format?(value: number): string;
	onScrubStart?(): void;
	/** Live value during a drag; `delta` = change since the drag started (use it for mixed values). */
	onScrub?(value: number, delta: number): void;
	/** Drag finished: commit exactly once. */
	onScrubEnd?(value: number, delta: number): void;
	/** Esc (or pointer cancel) during a drag: revert. */
	onScrubCancel?(): void;
	/** Typed entry, arrow keys: a single committed value (already clamped). */
	onCommit?(value: number): void;
	className?: string;
	id?: string;
};

type Drag = {
	pointerId: number;
	startX: number;
	lastX: number;
	startValue: number;
	accum: number;
	scrubbing: boolean;
	cancelled: boolean;
	locked: boolean;
	release: (() => void) | null;
	live: number;
};

export function ScrubbyNumber(props: ScrubbyNumberProps) {
	const { value, label, unit, disabled, precision = 0, step = 1, className, id } = props;
	const spec: NumericSpec = { min: props.min, max: props.max, precision };
	const [live, setLive] = useState<number | null>(null);
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState('');
	const [invalid, setInvalid] = useState(false);
	const drag = useRef<Drag | null>(null);
	const elRef = useRef<HTMLSpanElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const cb = useRef(props);
	cb.current = props;

	const shown = live ?? value;
	const display = shown === null ? '–' : props.format ? props.format(shown) : formatNumber(shown, precision);

	const endDrag = (d: Drag) => {
		d.release?.();
		d.release = null;
		if (d.locked && typeof document !== 'undefined' && document.pointerLockElement)
			document.exitPointerLock?.();
		drag.current = null;
		setLive(null);
	};

	useEffect(() => {
		const onKey = (e: globalThis.KeyboardEvent) => {
			const d = drag.current;
			if (!d?.scrubbing || d.cancelled || e.key !== 'Escape') return;
			e.preventDefault();
			d.cancelled = true;
			cb.current.onScrubCancel?.();
			d.release?.();
			d.release = null;
			if (d.locked && document.pointerLockElement) document.exitPointerLock?.();
			setLive(null);
		};
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	}, []);

	useEffect(() => {
		if (!editing) return;
		const input = inputRef.current;
		input?.focus();
		input?.select();
	}, [editing]);

	useEffect(() => {
		if (!invalid) return;
		const t = setTimeout(() => setInvalid(false), 400);
		return () => clearTimeout(t);
	}, [invalid]);

	const onPointerDown = (e: PointerEvent<HTMLSpanElement>) => {
		if (disabled || editing || e.button !== 0) return;
		e.preventDefault();
		try {
			e.currentTarget.setPointerCapture?.(e.pointerId);
		} catch {
			// The browser can cancel the pointer before capture is requested.
		}
		const start = value ?? 0;
		drag.current = {
			pointerId: e.pointerId,
			startX: e.clientX,
			lastX: e.clientX,
			startValue: start,
			accum: 0,
			scrubbing: false,
			cancelled: false,
			locked: false,
			release: null,
			live: start,
		};
	};

	const onPointerMove = (e: PointerEvent<HTMLSpanElement>) => {
		const d = drag.current;
		if (!d || d.cancelled || e.pointerId !== d.pointerId) return;
		const locked = typeof document !== 'undefined' && document.pointerLockElement === elRef.current;
		const dx = locked ? e.movementX : e.clientX - d.lastX;
		d.lastX = e.clientX;
		if (!d.scrubbing) {
			if (Math.abs(e.clientX - d.startX) < 3) return;
			d.scrubbing = true;
			cb.current.onScrubStart?.();
			d.release = forceCursor('ew-resize');
			// Pointer lock removes the screen-edge limit and hides the cursor (CT-021) where available.
			try {
				const req = elRef.current?.requestPointerLock?.();
				if (req)
					void req.catch(() => {
						d.locked = false;
					});
				d.locked = !!elRef.current?.requestPointerLock;
			} catch {
				d.locked = false;
			}
			// The threshold distance counts toward the drag.
			d.accum += scrubDelta(e.clientX - d.startX - dx, step, e, props.pixelsPerStep);
		}
		d.accum += scrubDelta(dx, step, e, props.pixelsPerStep);
		const mixed = value === null;
		let next: number;
		if (mixed) next = roundTo(d.accum, precision);
		else {
			next = clampValue(d.startValue + d.accum, spec);
			// Preserve sub-step movement while keeping the accumulator inside the actual bounds.
			// Rounding after every pointer event would make Ctrl-drag move too fast.
			if (spec.min !== undefined && d.startValue + d.accum < spec.min) d.accum = spec.min - d.startValue;
			if (spec.max !== undefined && d.startValue + d.accum > spec.max) d.accum = spec.max - d.startValue;
		}
		if (next === d.live) return;
		d.live = next;
		setLive(next);
		cb.current.onScrub?.(next, mixed ? next : roundTo(next - d.startValue, precision + 1));
	};

	const onPointerUp = (e: PointerEvent<HTMLSpanElement>) => {
		const d = drag.current;
		if (!d || e.pointerId !== d.pointerId) return;
		if (d.cancelled) {
			endDrag(d);
			return;
		}
		if (d.scrubbing) {
			const final = d.live;
			const mixed = value === null;
			endDrag(d);
			cb.current.onScrubEnd?.(final, mixed ? final : roundTo(final - d.startValue, precision + 1));
			return;
		}
		endDrag(d);
		startEdit();
	};

	const onPointerCancel = () => {
		const d = drag.current;
		if (!d) return;
		if (d.scrubbing && !d.cancelled) cb.current.onScrubCancel?.();
		endDrag(d);
	};

	const startEdit = () => {
		if (disabled) return;
		setText(value === null ? '' : formatNumber(value, precision));
		setEditing(true);
	};

	const commitText = () => {
		const current = value ?? 0;
		const parsed = evaluateEntry(text, current);
		setEditing(false);
		if (parsed === null) {
			if (text.trim() !== '' && text !== formatNumber(value, precision)) setInvalid(true);
			return;
		}
		const next = clampValue(parsed, spec);
		if (value === null || next !== value) cb.current.onCommit?.(next);
	};

	const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter' || e.key === 'Tab') {
			if (e.key === 'Enter') e.preventDefault();
			commitText();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			setEditing(false);
		} else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			e.preventDefault();
			const base = evaluateEntry(text, value ?? 0) ?? value ?? 0;
			const dir = e.key === 'ArrowUp' ? 1 : -1;
			setText(formatNumber(clampValue(base + dir * step * (e.shiftKey ? 10 : 1), spec), precision));
		}
	};

	const onDisplayKey = (e: KeyboardEvent<HTMLSpanElement>) => {
		if (disabled) return;
		if (e.key === 'Enter' || e.key === 'F2') {
			e.preventDefault();
			startEdit();
		} else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			e.preventDefault();
			const dir = e.key === 'ArrowUp' ? 1 : -1;
			const base = value ?? 0;
			cb.current.onCommit?.(clampValue(base + dir * step * stepMultiplier(e), spec));
		}
	};

	const unitEl = unit ? <span className="ml-0.5 text-pr-muted">{unit}</span> : null;

	if (editing) {
		return (
			<span className={cx('inline-flex items-center', className)}>
				<input
					ref={inputRef}
					id={id}
					aria-label={label}
					value={text}
					spellCheck={false}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={onInputKey}
					onBlur={commitText}
					className="h-[20px] w-[64px] rounded-pr-control border border-pr-focus bg-pr-field px-1 font-pr text-pr-ui text-pr-text outline-none pr-tabular"
					data-testid="scrubby-input"
				/>
				{unitEl}
			</span>
		);
	}

	return (
		<span className={cx('inline-flex items-baseline whitespace-nowrap', className)}>
			<span
				ref={elRef}
				id={id}
				role="spinbutton"
				tabIndex={disabled ? -1 : 0}
				aria-label={label}
				aria-valuenow={shown ?? undefined}
				aria-valuemin={props.min}
				aria-valuemax={props.max}
				aria-valuetext={shown === null ? 'Mixed' : `${display}${unit ? ` ${unit}` : ''}`}
				aria-disabled={disabled || undefined}
				data-keymap-local=""
				data-testid="scrubby"
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={onPointerCancel}
				onLostPointerCapture={() => {
					const d = drag.current;
					if (d && !d.locked) onPointerCancel();
				}}
				onKeyDown={onDisplayKey}
				className={cx(
					'font-pr text-pr-ui pr-tabular select-none touch-none outline-none',
					disabled
						? 'text-pr-dim'
						: 'cursor-ew-resize text-pr-value decoration-1 underline-offset-2 hover:underline focus-visible:underline',
					invalid && 'bg-[var(--pr-field-invalid)]',
				)}
			>
				{display}
			</span>
			{unitEl}
		</span>
	);
}
