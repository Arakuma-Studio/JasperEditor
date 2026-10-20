// Easing panel ▸ a numeric field that commits on Enter / blur; text that is not a number is refused (red border,
// the value kept), Escape restores it.
import { cx } from '@jasper/ui';
import { useEffect, useState } from 'react';

/** One number that commits on Enter / blur; text that is not a number is refused (red, original value kept). */
export function NumberCell(props: {
	label: string;
	value: number;
	onCommit(v: number): void;
	testId: string;
	/** Why the field cannot be edited (shown as its tooltip); the field is disabled. */
	disabled?: string;
	/** Unit shown after the field. */
	unit?: string;
	digits?: number;
}) {
	const shown = Number.isFinite(props.value) ? Number(props.value.toFixed(props.digits ?? 3)).toString() : '';
	const [text, setText] = useState(shown);
	const [bad, setBad] = useState(false);
	useEffect(() => {
		setText(shown);
		setBad(false);
	}, [shown]);
	const commit = () => {
		if (props.disabled) return;
		// The rounded value shown, untouched: not an edit (committing it would round the real value).
		if (text.trim() === shown) {
			setBad(false);
			return;
		}
		const s = text.trim().replace(',', '.');
		const v = s === '' ? Number.NaN : Number(s);
		if (!Number.isFinite(v)) {
			setBad(true);
			return;
		}
		setBad(false);
		if (v !== props.value) props.onCommit(v);
		else setText(shown);
	};
	return (
		<label className="flex min-w-0 items-center gap-[2px] text-pr-small text-pr-muted" title={props.disabled}>
			{props.label}
			<input
				disabled={!!props.disabled}
				className={cx(
					'pr-tabular h-[20px] w-[52px] min-w-0 rounded-pr-control border bg-pr-field px-1 text-pr-ui text-pr-text outline-none focus:border-pr-focus disabled:text-pr-dim',
					bad ? 'border-pr-danger' : 'border-transparent',
				)}
				aria-invalid={bad || undefined}
				aria-label={props.label}
				value={text}
				inputMode="decimal"
				onChange={(e) => setText(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === 'Enter') commit();
					if (e.key === 'Escape') {
						setText(shown);
						setBad(false);
					}
				}}
				data-testid={props.testId}
			/>
			{props.unit ? <span className="text-pr-dim">{props.unit}</span> : null}
		</label>
	);
}
