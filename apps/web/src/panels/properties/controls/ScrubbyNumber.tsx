// Inspector scrubby number (S05:CT-020…025, S03:EC-010): commits a value function so relative edits
// apply independently to each value in a mixed selection.
//
// - drag horizontally: 1 step per px, Shift ×10, Ctrl/Cmd ×0.1; Esc during the drag reverts;
// - click (< 3 px movement) enters edit mode; Enter/Tab commit, Esc cancels; `+10`, `-5`, `*2`, `/3`
//   apply relative to each value (so they work on mixed `–` fields); `=-5` or a plain number is absolute;
// - ArrowUp/ArrowDown step (Shift ×10) when focused.
// Spec 19 TL-096: `useScrubLabel` scrubs from the row's label as from the value, double-click resets, and `track` adds a
// small slider whose log or quadratic mapping keeps wide ranges usable at the low end.
import { cx } from '@jasper/ui';
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from 'react';

export type ValueFn = (base: number) => number;

type ScrubbyNumberProps = {
	/** Displayed value; `null` shows the mixed `–` (S03:INS-004). */
	value: number | null;
	label: string;
	step?: number;
	precision?: number;
	unit?: string;
	min?: number;
	max?: number;
	disabled?: boolean;
	/** Dimmed (playhead outside the clip, S03:EC-006). */
	dim?: boolean;
	onScrubStart?(): void;
	/** Accumulated delta from the scrub start (already multiplied by step and modifiers). */
	onScrub?(delta: number): void;
	onScrubEnd?(cancelled: boolean): void;
	/** Typed entry / arrow keys: the function maps each base value to its new value. */
	onCommit?(fn: ValueFn): void;
	/** TL-096: double-click puts the default back. */
	onReset?(): void;
	/** TL-096: a slider next to the value. Its range is the useful one (typed values may go beyond it). */
	track?: ValueTrack;
	/** What a mixed value reads as. */
	mixedText?: string;
	className?: string;
	'data-testid'?: string;
};

/** Screen px a press must travel before it is a scrub; shorter is a click. */
const DRAG_THRESHOLD = 3;
/** A second press within this long after a click is a double-click, whatever the click turned the field into. */
const DOUBLE_CLICK_MS = 400;

/** How a slider's position maps to values. `log`: even by ratio. `pow`: quadratic, finer near `min`. */
export type TrackMapping = 'linear' | 'log' | 'pow';
export type ValueTrack = { min: number; max: number; mapping?: TrackMapping };

/** The mapping that suits a range: `log` for positive ranges spanning 50× or more, `pow` for many steps from low values. */
export function trackMappingOf(min: number, max: number, step: number): TrackMapping {
	if (!(max > min)) return 'linear';
	if (min > 0 && max / min >= 50) return 'log';
	return min >= 0 && (max - min) / Math.max(step, 1e-9) >= 200 ? 'pow' : 'linear';
}

/** A value's slider position, 0…1. */
export function toTrack(v: number, t: ValueTrack): number {
	const { min, max } = t;
	const x = Math.max(min, Math.min(max, v));
	const mapping = t.mapping ?? 'linear';
	if (mapping === 'log' && min > 0) return Math.log(x / min) / Math.log(max / min);
	const u = (x - min) / (max - min || 1);
	return mapping === 'pow' ? Math.sqrt(u) : u;
}

/** The value of a slider position, 0…1. */
export function fromTrack(u: number, t: ValueTrack): number {
	const { min, max } = t;
	const x = Math.max(0, Math.min(1, u));
	const mapping = t.mapping ?? 'linear';
	if (mapping === 'log' && min > 0) return min * (max / min) ** x;
	return min + (max - min) * (mapping === 'pow' ? x * x : x);
}

type ScrubHandlers = {
	step: number;
	onStart?(): void;
	onScrub?(delta: number): void;
	onEnd?(cancelled: boolean): void;
	/** The press never travelled. */
	onClick?(): void;
};

/** Offset of a horizontal drag: Shift ×10, Ctrl/Cmd ×0.1, quantized to the step. */
export function scrubDelta(dx: number, step: number, mods: { shift: boolean; ctrl: boolean }): number {
	const mult = mods.shift ? 10 : mods.ctrl ? 0.1 : 1;
	const q = step * (mult < 1 ? 0.1 : 1);
	return Number((Math.round((dx * step * mult) / q) * q).toFixed(6));
}

/**
 * One press: a click if it stays within 3 px, else a scrub from the press. Esc during the drag cancels. Returns the
 * cleanup for an unmount mid-drag.
 */
function beginScrub(e: PointerEvent<HTMLElement>, handlers: () => ScrubHandlers): () => void {
	e.preventDefault();
	const x0 = e.clientX;
	let active = false;
	let cleanup = () => {};
	const move = (ev: globalThis.PointerEvent) => {
		const dx = ev.clientX - x0;
		const h = handlers();
		if (!active) {
			if (Math.abs(dx) < DRAG_THRESHOLD) return;
			active = true;
			h.onStart?.();
		}
		h.onScrub?.(scrubDelta(dx, h.step, { shift: ev.shiftKey, ctrl: ev.ctrlKey || ev.metaKey }));
	};
	const finish = (cancelled: boolean) => {
		cleanup();
		const h = handlers();
		if (active) h.onEnd?.(cancelled);
		else if (!cancelled) h.onClick?.();
	};
	const up = () => finish(false);
	const key = (ev: globalThis.KeyboardEvent) => {
		if (ev.key === 'Escape') {
			ev.preventDefault();
			finish(true);
		}
	};
	window.addEventListener('pointermove', move);
	window.addEventListener('pointerup', up);
	window.addEventListener('pointercancel', up);
	window.addEventListener('keydown', key, true);
	cleanup = () => {
		window.removeEventListener('pointermove', move);
		window.removeEventListener('pointerup', up);
		window.removeEventListener('pointercancel', up);
		window.removeEventListener('keydown', key, true);
	};
	return () => cleanup();
}

/** TL-096: a `onPointerDown` that scrubs a value from its row's label (a click stays a click). */
export function useScrubLabel(handlers: Omit<ScrubHandlers, 'onClick'> | null) {
	const latest = useRef(handlers);
	latest.current = handlers;
	const stop = useRef<(() => void) | null>(null);
	useEffect(() => () => stop.current?.(), []);
	return (e: PointerEvent<HTMLElement>) => {
		if (!latest.current || e.button !== 0) return;
		stop.current = beginScrub(e, () => latest.current ?? { step: 1 });
	};
}

/** Evaluates `+ - * /` arithmetic with parentheses; accepts `,` as decimal separator (S03:NFR-032). */
function evaluateExpression(src: string): number | null {
	const s = src.replace(/,/g, '.').replace(/\s+/g, '');
	let i = 0;
	const peek = () => s[i];
	const num = (): number | null => {
		if (peek() === '(') {
			i++;
			const v = expr();
			if (peek() !== ')') return null;
			i++;
			return v;
		}
		if (peek() === '-' || peek() === '+') {
			const sign = s[i++] === '-' ? -1 : 1;
			const v = num();
			return v === null ? null : sign * v;
		}
		const m = /^\d*\.?\d+(?:e[+-]?\d+)?|^\d+\./i.exec(s.slice(i));
		if (!m) return null;
		i += m[0].length;
		return Number(m[0]);
	};
	const term = (): number | null => {
		let v = num();
		while (v !== null && (peek() === '*' || peek() === '/')) {
			const op = s[i++];
			const r = num();
			if (r === null) return null;
			v = op === '*' ? v * r : v / r;
		}
		return v;
	};
	const expr = (): number | null => {
		let v = term();
		while (v !== null && (peek() === '+' || peek() === '-')) {
			const op = s[i++];
			const r = term();
			if (r === null) return null;
			v = op === '+' ? v + r : v - r;
		}
		return v;
	};
	const v = expr();
	return v !== null && i === s.length && Number.isFinite(v) ? v : null;
}

/** Parses a typed entry into a value function (relative when it starts with an operator). */
function parseEntry(text: string): ValueFn | null {
	const t = text.trim();
	if (!t) return null;
	if (t.startsWith('=')) {
		const v = evaluateExpression(t.slice(1));
		return v === null ? null : () => v;
	}
	const op = t[0];
	if (op === '+' || op === '-' || op === '*' || op === '/') {
		const v = evaluateExpression(t.slice(1));
		if (v === null) return null;
		if (op === '+') return (b) => b + v;
		if (op === '-') return (b) => b - v;
		if (op === '*') return (b) => b * v;
		return (b) => (v === 0 ? b : b / v);
	}
	const v = evaluateExpression(t);
	return v === null ? null : () => v;
}

function formatNumber(v: number, precision: number): string {
	const r = v.toFixed(precision);
	return r === `-${(0).toFixed(precision)}` ? (0).toFixed(precision) : r;
}

export function ScrubbyNumber(props: ScrubbyNumberProps) {
	const {
		value,
		label,
		step = 1,
		precision = step >= 1 ? 0 : step >= 0.1 ? 1 : 2,
		unit,
		min,
		max,
		disabled,
		dim,
	} = props;
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState('');
	const [scrubbing, setScrubbing] = useState(false);
	const drag = useRef<(() => void) | null>(null);
	const lastClick = useRef(0);
	const cbs = useRef(props);
	cbs.current = props;
	useEffect(() => () => drag.current?.(), []);

	const display = value === null ? (props.mixedText ?? '–') : formatNumber(value, precision);
	const startEditing = () => {
		setText(value === null ? '' : formatNumber(value, precision));
		setEditing(true);
	};

	const onPointerDown = (e: PointerEvent<HTMLSpanElement>) => {
		if (disabled || e.button !== 0 || editing) return;
		drag.current = beginScrub(e, () => ({
			step,
			onStart: () => {
				setScrubbing(true);
				cbs.current.onScrubStart?.();
			},
			onScrub: (d) => cbs.current.onScrub?.(d),
			onEnd: (cancelled) => {
				setScrubbing(false);
				cbs.current.onScrubEnd?.(cancelled);
			},
			onClick: () => {
				lastClick.current = performance.now();
				startEditing();
			},
		}));
	};

	/** The press on the slider sets the value from where it lands, and follows the pointer until it is released. */
	const onTrackPointerDown = (e: PointerEvent<HTMLSpanElement>) => {
		const track = props.track;
		if (disabled || e.button !== 0 || !track) return;
		e.preventDefault();
		e.stopPropagation();
		const box = e.currentTarget.getBoundingClientRect();
		const at = (x: number) => {
			const v = fromTrack((x - box.left) / Math.max(1, box.width), track);
			return Number((Math.round(v / step) * step).toFixed(6));
		};
		// A mixed selection has no common value: the press is the origin and each clip moves by the same offset.
		const origin = value ?? at(e.clientX);
		cbs.current.onScrubStart?.();
		setScrubbing(true);
		cbs.current.onScrub?.(at(e.clientX) - origin);
		const cleanup = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', up);
			window.removeEventListener('keydown', key, true);
		};
		const end = (cancelled: boolean) => {
			cleanup();
			setScrubbing(false);
			cbs.current.onScrubEnd?.(cancelled);
		};
		const move = (ev: globalThis.PointerEvent) => cbs.current.onScrub?.(at(ev.clientX) - origin);
		const up = () => end(false);
		const key = (ev: globalThis.KeyboardEvent) => {
			if (ev.key === 'Escape') {
				ev.preventDefault();
				end(true);
			}
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', up);
		window.addEventListener('keydown', key, true);
		drag.current = cleanup;
	};

	const commitText = () => {
		setEditing(false);
		const fn = parseEntry(text);
		if (!fn) return;
		props.onCommit?.((b) => clampN(fn(b), min, max));
	};

	const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
		if (disabled) return;
		if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			e.preventDefault();
			const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
			props.onCommit?.((b) => clampN(b + d, min, max));
		} else if (e.key === 'Enter') {
			e.preventDefault();
			startEditing();
		}
	};

	if (editing) {
		return (
			<input
				// biome-ignore lint/a11y/noAutofocus: edit mode is entered explicitly by the user (S05:CT-022)
				autoFocus
				aria-label={label}
				className="h-[20px] w-[64px] rounded-pr-control bg-pr-field px-1 font-pr text-pr-ui text-pr-text outline outline-1 outline-pr-focus"
				value={text}
				onChange={(e) => setText(e.target.value)}
				onFocus={(e) => e.currentTarget.select()}
				onBlur={commitText}
				onDoubleClick={(e) => {
					// The first click of a double-click turned the value into this field.
					if (!props.onReset || performance.now() - lastClick.current > DOUBLE_CLICK_MS) return;
					e.preventDefault();
					setEditing(false);
					props.onReset();
				}}
				onKeyDown={(e) => {
					if (e.key === 'Enter' || e.key === 'Tab') commitText();
					else if (e.key === 'Escape') {
						e.preventDefault();
						e.stopPropagation();
						setEditing(false);
					}
				}}
				data-testid={props['data-testid'] ? `${props['data-testid']}-input` : undefined}
			/>
		);
	}
	const number = (
		<span
			role="spinbutton"
			tabIndex={disabled ? -1 : 0}
			aria-label={label}
			aria-valuenow={value ?? undefined}
			aria-valuemin={min}
			aria-valuemax={max}
			aria-valuetext={value === null ? 'mixed' : `${display}${unit ?? ''}`}
			aria-disabled={disabled || undefined}
			className={cx(
				'inline-flex select-none items-baseline gap-[2px] whitespace-nowrap font-pr text-pr-ui',
				disabled ? 'text-pr-dim' : 'cursor-ew-resize text-pr-value hover:underline',
				scrubbing && 'underline',
				dim && 'opacity-60',
				props.className,
			)}
			style={{ fontVariantNumeric: 'tabular-nums', touchAction: 'none' }}
			onPointerDown={onPointerDown}
			onKeyDown={onKeyDown}
			data-testid={props['data-testid']}
		>
			{display}
			{unit ? <span className="text-pr-muted">{unit}</span> : null}
		</span>
	);
	if (!props.track) return number;
	const fill = value === null ? 0 : toTrack(value, props.track);
	return (
		<span className="inline-flex min-w-0 items-center gap-2">
			{number}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: the keyboard steps the value through the number */}
			<span
				className={cx(
					'relative h-[12px] w-[56px] shrink-0 touch-none',
					disabled ? 'opacity-40' : 'cursor-ew-resize',
				)}
				title={
					props.track.mapping === 'log'
						? 'Logarithmic track: finer at the low end'
						: props.track.mapping === 'pow'
							? 'Quadratic track: finer at the low end'
							: undefined
				}
				onPointerDown={onTrackPointerDown}
				data-track={props.track.mapping ?? 'linear'}
				data-testid={props['data-testid'] ? `${props['data-testid']}-track` : undefined}
			>
				<span className="absolute inset-x-0 top-[5px] h-[2px] rounded-pr-pill bg-pr-border-strong" />
				{value === null ? null : (
					<>
						<span
							className="absolute left-0 top-[5px] h-[2px] rounded-pr-pill bg-pr-value"
							style={{ width: `${fill * 100}%` }}
						/>
						<span
							className="absolute top-[2px] h-[8px] w-[8px] -translate-x-1/2 rounded-pr-pill bg-pr-value"
							style={{ left: `${fill * 100}%` }}
						/>
					</>
				)}
			</span>
		</span>
	);
}

function clampN(v: number, min?: number, max?: number): number {
	return Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, v));
}
