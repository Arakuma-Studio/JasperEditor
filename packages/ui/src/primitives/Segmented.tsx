// Segmented control: a WAI-ARIA radio group of buttons (APG "Radio Group" pattern). One Tab stop — the checked option,
// else the first enabled one (roving tabindex); ←/↑ and →/↓ move to the previous / next enabled option with wrap,
// Home / End to the first / last, and choosing follows focus (as native radio buttons do). `data-keymap-local` makes
// the editor's keyboard dispatcher let the group handle those keys first (a consumed key runs no shortcut).
import { type KeyboardEvent, type ReactNode, useRef } from 'react';
import { cx } from '../cx.ts';

export type SegmentedOption<T extends string> = {
	value: T;
	label: ReactNode;
	/** Accessible name when `label` is not text (an icon). */
	ariaLabel?: string;
	title?: string;
	disabled?: boolean;
	testId?: string;
};

/**
 * The option a radio-group key moves to, or null when the key is not a navigation key (or nothing is enabled).
 * `from` is the focused option's index (−1: none).
 */
function segmentedKeyTarget(
	key: string,
	from: number,
	enabled: readonly boolean[],
	dir: 'ltr' | 'rtl' = 'ltr',
): number | null {
	const n = enabled.length;
	if (!enabled.some(Boolean)) return null;
	const first = enabled.indexOf(true);
	const last = enabled.lastIndexOf(true);
	const step = (d: 1 | -1) => {
		let i = from < 0 ? (d === 1 ? -1 : n) : from;
		for (let k = 0; k < n; k++) {
			i = (i + d + n) % n;
			if (enabled[i]) return i;
		}
		return null;
	};
	const fwd = dir === 'rtl' ? -1 : 1;
	switch (key) {
		case 'ArrowRight':
			return step(fwd as 1 | -1);
		case 'ArrowLeft':
			return step(-fwd as 1 | -1);
		case 'ArrowDown':
			return step(1);
		case 'ArrowUp':
			return step(-1);
		case 'Home':
			return first;
		case 'End':
			return last;
		default:
			return null;
	}
}

export function SegmentedControl<T extends string>(props: {
	/** Accessible name of the group. */
	label: string;
	value: T | null;
	options: readonly SegmentedOption<T>[];
	disabled?: boolean;
	onChange(v: T): void;
	className?: string;
	/** Classes of one option button (its checked state given). */
	optionClassName?: (checked: boolean) => string;
	'data-testid'?: string;
}) {
	const refs = useRef<(HTMLButtonElement | null)[]>([]);
	const enabled = props.options.map((o) => !props.disabled && !o.disabled);
	const checked = props.options.findIndex((o) => o.value === props.value);
	const tabStop = checked >= 0 && enabled[checked] ? checked : enabled.indexOf(true);
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
		const from = refs.current.indexOf(e.target as HTMLButtonElement);
		const dir = dirOf(e.currentTarget);
		const to = segmentedKeyTarget(e.key, from, enabled, dir);
		if (to === null) return;
		e.preventDefault();
		e.stopPropagation();
		refs.current[to]?.focus();
		const v = props.options[to]!.value;
		if (v !== props.value) props.onChange(v);
	};
	return (
		<div
			role="radiogroup"
			aria-label={props.label}
			aria-disabled={props.disabled || undefined}
			data-keymap-local=""
			className={cx('flex gap-[2px]', props.className)}
			data-testid={props['data-testid']}
			onKeyDown={onKeyDown}
		>
			{props.options.map((o, i) => {
				const on = i === checked;
				return (
					// biome-ignore lint/a11y/useSemanticElements: a segmented control's options are buttons
					<button
						key={o.value}
						ref={(el) => {
							refs.current[i] = el;
						}}
						type="button"
						role="radio"
						aria-checked={on}
						aria-label={o.ariaLabel}
						title={o.title}
						tabIndex={i === tabStop ? 0 : -1}
						disabled={!enabled[i]}
						onClick={() => {
							if (o.value !== props.value) props.onChange(o.value);
						}}
						className={
							props.optionClassName?.(on) ??
							cx(
								'h-[20px] rounded-pr-control border px-2 text-pr-small outline-none focus-visible:ring-1 focus-visible:ring-pr-focus disabled:opacity-40',
								on
									? 'border-pr-accent bg-pr-accent-fill text-pr-on-accent'
									: 'border-pr-border-subtle text-pr-muted hover:text-pr-text',
							)
						}
						data-value={o.value}
						data-testid={o.testId}
					>
						{o.label}
					</button>
				);
			})}
		</div>
	);
}

function dirOf(el: HTMLElement): 'ltr' | 'rtl' {
	const d = el.closest('[dir]')?.getAttribute('dir');
	return d === 'rtl' ? 'rtl' : 'ltr';
}
