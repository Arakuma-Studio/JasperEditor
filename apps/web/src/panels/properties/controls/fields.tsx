// Inspector value editors besides the scrubby number (S03:EC-011…014, S05:CT-010…014).

import { cx } from '@jasper/ui';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { type ReactNode, useEffect, useState } from 'react';

type RGBA = [number, number, number, number];

const to255 = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255);

/** `#rrggbb` for `<input type="color">` (alpha is edited separately). */
function rgbaToHex(c: readonly number[]): string {
	return `#${[c[0] ?? 0, c[1] ?? 0, c[2] ?? 0].map((x) => to255(x).toString(16).padStart(2, '0')).join('')}`;
}
function hexToRgb(hex: string): [number, number, number] | null {
	const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
	if (!m) return null;
	return [
		Number.parseInt(m[1]!, 16) / 255,
		Number.parseInt(m[2]!, 16) / 255,
		Number.parseInt(m[3]!, 16) / 255,
	];
}
/** CSS color of a document RGBA value (document data, not UI chrome). */
function rgbaCss(c: readonly number[]): string {
	return `rgba(${to255(c[0] ?? 0)}, ${to255(c[1] ?? 0)}, ${to255(c[2] ?? 0)}, ${Math.min(1, Math.max(0, c[3] ?? 1))})`; // tokens-allow: document color
}

/** 24×16 swatch opening the platform color picker, plus alpha in percent (S05:CT-014). */
export function ColorField(props: {
	value: RGBA | null;
	label: string;
	onChange(v: RGBA): void;
	disabled?: boolean;
	alpha?: boolean;
	'data-testid'?: string;
}) {
	const { value } = props;
	const c: RGBA = value ?? [0.5, 0.5, 0.5, 1];
	return (
		<span className="inline-flex items-center gap-2">
			<label
				className={cx(
					'relative inline-block h-[16px] w-[24px] shrink-0 rounded-[2px] border border-pr-border-strong',
					props.disabled ? 'opacity-40' : 'cursor-pointer',
				)}
				style={{
					background: value
						? rgbaCss(c)
						: 'repeating-linear-gradient(45deg, var(--pr-border-strong) 0 3px, transparent 3px 6px)',
				}}
				title={props.label}
			>
				<input
					type="color"
					aria-label={props.label}
					disabled={props.disabled}
					className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
					value={rgbaToHex(c)}
					onChange={(e) => {
						const rgb = hexToRgb(e.target.value);
						if (rgb) props.onChange([rgb[0], rgb[1], rgb[2], c[3]]);
					}}
					data-testid={props['data-testid']}
				/>
			</label>
			{props.alpha !== false ? (
				<AlphaInput
					value={value ? Math.round(c[3] * 100) : null}
					label={`${props.label} alpha`}
					disabled={props.disabled}
					onChange={(a) => props.onChange([c[0], c[1], c[2], a / 100])}
				/>
			) : null}
		</span>
	);
}

function AlphaInput(props: {
	value: number | null;
	label: string;
	disabled?: boolean;
	onChange(v: number): void;
}) {
	const [text, setText] = useState(props.value === null ? '' : String(props.value));
	useEffect(() => setText(props.value === null ? '' : String(props.value)), [props.value]);
	const commit = () => {
		const n = Number(text.replace(',', '.'));
		if (Number.isFinite(n) && n !== props.value) props.onChange(Math.min(100, Math.max(0, n)));
	};
	return (
		<span className="inline-flex items-baseline gap-[2px]">
			<input
				aria-label={props.label}
				disabled={props.disabled}
				className="h-[18px] w-[34px] rounded-pr-control bg-pr-field px-1 text-right font-pr text-pr-small text-pr-value"
				value={text}
				placeholder="–"
				onChange={(e) => setText(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => e.key === 'Enter' && commit()}
			/>
			<span className="text-pr-small text-pr-muted">%</span>
		</span>
	);
}

export function SelectField<T extends string | number>(props: {
	value: T | null;
	options: readonly T[];
	labels?: readonly string[];
	/** Section of each option (`options` order): consecutive runs become labelled `<optgroup>`s (Premiere's menus). */
	groups?: readonly string[];
	label: string;
	onChange(v: T): void;
	disabled?: boolean;
	className?: string;
	'data-testid'?: string;
}) {
	return (
		<select
			aria-label={props.label}
			disabled={props.disabled}
			className={cx(
				'h-[20px] min-w-0 max-w-full rounded-pr-control border border-transparent bg-pr-field px-1 font-pr text-pr-ui text-pr-text',
				'hover:border-pr-border-strong focus:outline focus:outline-1 focus:outline-pr-focus',
				props.className,
			)}
			value={props.value === null ? '' : String(props.value)}
			onChange={(e) => {
				const i = props.options.findIndex((o) => String(o) === e.target.value);
				if (i >= 0) props.onChange(props.options[i]!);
			}}
			data-testid={props['data-testid']}
		>
			{props.value === null ? <option value="">–</option> : null}
			{props.groups
				? optionRuns(props.groups, props.options.length).map((run) => (
						<optgroup key={`${run.label}:${run.start}`} label={run.label}>
							{props.options.slice(run.start, run.end).map((o, k) => (
								<option key={String(o)} value={String(o)}>
									{props.labels?.[run.start + k] ?? String(o)}
								</option>
							))}
						</optgroup>
					))
				: props.options.map((o, i) => (
						<option key={String(o)} value={String(o)}>
							{props.labels?.[i] ?? String(o)}
						</option>
					))}
		</select>
	);
}

/** Consecutive runs of equal group labels: `[{label, start, end}]` over `count` options. */
function optionRuns(
	groups: readonly string[],
	count: number,
): { label: string; start: number; end: number }[] {
	const runs: { label: string; start: number; end: number }[] = [];
	for (let i = 0; i < count; i++) {
		const label = groups[i] ?? '';
		const last = runs[runs.length - 1];
		if (last && last.label === label) last.end = i + 1;
		else runs.push({ label, start: i, end: i + 1 });
	}
	return runs;
}

/** Checkbox with a mixed (dash) state (S05:CT-012). */
export function CheckboxField(props: {
	value: boolean | null;
	label: string;
	onChange(v: boolean): void;
	disabled?: boolean;
	children?: ReactNode;
}) {
	return (
		<label className="inline-flex cursor-pointer items-center gap-1 text-pr-ui text-pr-text">
			<input
				type="checkbox"
				aria-label={props.label}
				disabled={props.disabled}
				checked={props.value === true}
				ref={(el) => {
					if (el) el.indeterminate = props.value === null;
				}}
				onChange={(e) => props.onChange(e.target.checked)}
				className="size-[12px] accent-[var(--pr-text-primary)]"
			/>
			{props.children}
		</label>
	);
}

/** Text entry that commits on blur/Enter as one undo step (S05:PRP-004); multiline commits on blur/Ctrl+Enter. */
export function TextField(props: {
	value: string | null;
	label: string;
	multiline?: boolean;
	onCommit(v: string): void;
	disabled?: boolean;
	'data-testid'?: string;
}) {
	const [text, setText] = useState(props.value ?? '');
	useEffect(() => setText(props.value ?? ''), [props.value]);
	const commit = () => {
		if (text !== (props.value ?? '')) props.onCommit(text);
	};
	const cls =
		'w-full min-w-0 rounded-pr-control border border-transparent bg-pr-field px-1 font-pr text-pr-ui text-pr-text hover:border-pr-border-strong focus:outline focus:outline-1 focus:outline-pr-focus';
	if (props.multiline) {
		return (
			<textarea
				aria-label={props.label}
				disabled={props.disabled}
				rows={3}
				className={cx(cls, 'resize-y py-1')}
				placeholder={props.value === null ? '–' : undefined}
				value={text}
				onChange={(e) => setText(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit();
					if (e.key === 'Escape') setText(props.value ?? '');
				}}
				data-testid={props['data-testid']}
			/>
		);
	}
	return (
		<input
			aria-label={props.label}
			disabled={props.disabled}
			className={cx(cls, 'h-[20px]')}
			placeholder={props.value === null ? '–' : undefined}
			value={text}
			onChange={(e) => setText(e.target.value)}
			onBlur={commit}
			onKeyDown={(e) => {
				if (e.key === 'Enter') commit();
				if (e.key === 'Escape') setText(props.value ?? '');
			}}
			data-testid={props['data-testid']}
		/>
	);
}

/** Small square icon button used inside rows (keyframe navigator, reset, fx toggle). */
export function MiniButton(props: {
	label: string;
	/** The click event (Alt-click on a stopwatch toggles an expression, AE). */
	onClick(e: ReactMouseEvent<HTMLButtonElement>): void;
	disabled?: boolean;
	active?: boolean;
	children: ReactNode;
	className?: string;
	'data-testid'?: string;
}) {
	return (
		<button
			type="button"
			aria-label={props.label}
			title={props.label}
			disabled={props.disabled}
			aria-pressed={props.active === undefined ? undefined : props.active}
			onClick={props.onClick}
			className={cx(
				'inline-flex size-[18px] shrink-0 items-center justify-center rounded-pr-control',
				'disabled:pointer-events-none disabled:text-pr-dim',
				props.active
					? 'text-pr-accent hover:bg-pr-hover'
					: 'text-pr-icon hover:bg-pr-hover hover:text-pr-icon-hover',
				props.className,
			)}
			data-testid={props['data-testid']}
		>
			{props.children}
		</button>
	);
}
