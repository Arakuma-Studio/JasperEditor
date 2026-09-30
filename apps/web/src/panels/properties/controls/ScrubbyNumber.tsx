// Scrubby number ("hot text", S05:CT-020…025, S03:EC-010). Local to the inspector panels until the
// WP-2A design-system ScrubbyNumber lands; the callback names match its contract
// (`onScrubStart/onScrub/onScrubEnd`) so the swap is mechanical.
//
// - drag horizontally: 1 step per px, Shift ×10, Ctrl/Cmd ×0.1; Esc during the drag reverts;
// - click (< 3 px movement) enters edit mode; Enter/Tab commit, Esc cancels; `+10`, `-5`, `*2`, `/3`
//   apply relative to each value (so they work on mixed `–` fields); `=-5` or a plain number is absolute;
// - ArrowUp/ArrowDown step (Shift ×10) when focused.
import { cx } from '@jasper/ui';
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from 'react';

export type ValueFn = (base: number) => number;

export type ScrubbyNumberProps = {
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
	className?: string;
	'data-testid'?: string;
};

const DRAG_THRESHOLD = 3;

/** Evaluates `+ - * /` arithmetic with parentheses; accepts `,` as decimal separator (S03:NFR-032). */
export function evaluateExpression(src: string): number | null {
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
export function parseEntry(text: string): ValueFn | null {
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

export function formatNumber(v: number, precision: number): string {
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
	const drag = useRef<{ x0: number; active: boolean; cleanup: () => void } | null>(null);
	const cbs = useRef(props);
	cbs.current = props;
	useEffect(() => () => drag.current?.cleanup(), []);

	const display = value === null ? '–' : formatNumber(value, precision);

	const onPointerDown = (e: PointerEvent<HTMLSpanElement>) => {
		if (disabled || e.button !== 0 || editing) return;
		e.preventDefault();
		const x0 = e.clientX;
		const state = { x0, active: false, cleanup: () => {} };
		const move = (ev: globalThis.PointerEvent) => {
			const dx = ev.clientX - state.x0;
			if (!state.active) {
				if (Math.abs(dx) < DRAG_THRESHOLD) return;
				state.active = true;
				setScrubbing(true);
				cbs.current.onScrubStart?.();
			}
			const mult = ev.shiftKey ? 10 : ev.ctrlKey || ev.metaKey ? 0.1 : 1;
			const raw = dx * step * mult;
			const q = step * (mult < 1 ? 0.1 : 1);
			cbs.current.onScrub?.(Number((Math.round(raw / q) * q).toFixed(6)));
		};
		const finish = (cancelled: boolean) => {
			state.cleanup();
			drag.current = null;
			if (state.active) {
				setScrubbing(false);
				cbs.current.onScrubEnd?.(cancelled);
			} else if (!cancelled) {
				setText(value === null ? '' : formatNumber(value, precision));
				setEditing(true);
			}
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
		state.cleanup = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', up);
			window.removeEventListener('keydown', key, true);
		};
		drag.current = state;
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
			setText(value === null ? '' : formatNumber(value, precision));
			setEditing(true);
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
	return (
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
}

function clampN(v: number, min?: number, max?: number): number {
	return Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, v));
}
