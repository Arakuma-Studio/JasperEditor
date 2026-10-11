import {
	type Clip,
	type CommandInput,
	type PropertySpec,
	propertyKeyToParamPath,
	type RGBA,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { cx } from '@jasper/ui';
import { type ReactNode, useMemo, useState } from 'react';
import { CheckboxField, ColorField, SelectField, TextField } from '../panels/properties/controls/fields.tsx';
import { ScrubbyNumber } from '../panels/properties/controls/ScrubbyNumber.tsx';
import { createScrub } from '../panels/properties/lib/ops.ts';

/** Parses `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` / `rgba()` (0..1 floats). */ // tokens-allow: prop value (CSS colour string), not a UI colour
function parseCssColor(s: string): RGBA | null {
	const v = s.trim();
	let m = /^#([0-9a-f]{3,4})$/i.exec(v);
	if (m) {
		const d = m[1]!.split('').map((c) => Number.parseInt(c + c, 16) / 255);
		return [d[0]!, d[1]!, d[2]!, d[3] ?? 1];
	}
	m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v);
	if (m) {
		const n = (i: number) => Number.parseInt(m![1]!.slice(i, i + 2), 16) / 255;
		return [n(0), n(2), n(4), m[2] ? Number.parseInt(m[2], 16) / 255 : 1];
	}
	m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(v);
	if (m)
		return [
			Number(m[1]) / 255,
			Number(m[2]) / 255,
			Number(m[3]) / 255,
			m[4] !== undefined ? Number(m[4]) : 1,
		];
	return null;
}

/** Formats `c` in the notation of `like` (`#rrggbb`, `#rrggbbaa`, `rgba()`), so schema patterns keep matching. */ // tokens-allow: prop value (CSS colour string), not a UI colour
function formatCssColor(c: RGBA, like: string): string {
	const h = (x: number) =>
		Math.round(Math.min(1, Math.max(0, x)) * 255)
			.toString(16)
			.padStart(2, '0');
	const t = like.trim();
	if (/^rgba?\(/i.test(t)) {
		const b = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255);
		return c[3] < 1 || /^rgba/i.test(t)
			? `rgba(${b(c[0])}, ${b(c[1])}, ${b(c[2])}, ${Math.round(c[3] * 1000) / 1000})` // tokens-allow: prop value (CSS colour string), not a UI colour
			: `rgb(${b(c[0])}, ${b(c[1])}, ${b(c[2])})`; // tokens-allow: prop value (CSS colour string), not a UI colour
	}
	const upper = /[A-F]/.test(t) && !/[a-f]/.test(t);
	const hex = `#${h(c[0])}${h(c[1])}${h(c[2])}${/^#([0-9a-f]{8}|[0-9a-f]{4})$/i.test(t) ? h(c[3]) : ''}`;
	return upper ? hex.toUpperCase() : hex;
}

export function PropEditor(props: {
	session: EditorSession;
	clip: Clip;
	spec: PropertySpec;
	value: unknown;
	disabled: boolean;
	onSet(v: unknown): void;
}): ReactNode {
	const { spec, value, disabled } = props;
	const testId = `prop-${spec.key}`;
	switch (spec.kind) {
		case 'number':
			return <NumberEditor {...props} />;
		case 'boolean':
			return (
				<CheckboxField
					value={typeof value === 'boolean' ? value : null}
					label={spec.label}
					disabled={disabled}
					onChange={props.onSet}
				/>
			);
		case 'enum':
			return (
				<SelectField
					value={typeof value === 'string' ? value : null}
					options={spec.options ?? []}
					label={spec.label}
					disabled={disabled}
					onChange={props.onSet}
					data-testid={testId}
				/>
			);
		case 'string': {
			const text = typeof value === 'string' ? value : value === undefined ? '' : String(value);
			if (spec.ui.control === 'color') {
				const rgba = parseCssColor(text);
				const alpha = /^#([0-9a-f]{8}|[0-9a-f]{4})$/i.test(text.trim()) || /^rgba/i.test(text.trim());
				return (
					<>
						<ColorField
							value={rgba}
							label={spec.label}
							alpha={alpha}
							disabled={disabled}
							onChange={(c) => props.onSet(formatCssColor(c, text || '#000000'))} // tokens-allow: prop value (CSS colour string), not a UI colour
							data-testid={`${testId}-swatch`}
						/>
						<TextField
							value={text}
							label={`${spec.label} value`}
							disabled={disabled}
							onCommit={props.onSet}
							data-testid={testId}
						/>
					</>
				);
			}
			return (
				<TextField
					value={text}
					label={spec.label}
					multiline={!!spec.ui.multiline}
					disabled={disabled}
					onCommit={props.onSet}
					data-testid={testId}
				/>
			);
		}
		default:
			return <JsonValueEditor {...props} />;
	}
}

function NumberEditor(props: {
	session: EditorSession;
	clip: Clip;
	spec: PropertySpec;
	value: unknown;
	disabled: boolean;
	onSet(v: unknown): void;
}) {
	const { spec, session, clip } = props;
	const value = typeof props.value === 'number' ? props.value : null;
	const scrub = useMemo(() => createScrub(session), [session]);
	const [base, setBase] = useState(0);
	const clamp = (x: number) => {
		const lo = spec.range?.min ?? Number.NEGATIVE_INFINITY;
		const hi = spec.range?.max ?? Number.POSITIVE_INFINITY;
		const v = Math.min(hi, Math.max(lo, x));
		return spec.range?.step === 1 ? Math.round(v) : v;
	};
	const cmd = (v: number) =>
		({
			type: 'param.set',
			target: propertyKeyToParamPath({ clipId: clip.id }, spec.key),
			value: v,
		}) satisfies CommandInput;
	return (
		<ScrubbyNumber
			value={value}
			label={spec.label}
			step={spec.range?.step ?? 1}
			precision={spec.ui.precision ?? (spec.range?.step === 1 ? 0 : 2)}
			{...(spec.range?.min !== undefined ? { min: spec.range.min } : {})}
			{...(spec.range?.max !== undefined ? { max: spec.range.max } : {})}
			disabled={props.disabled}
			onScrubStart={() => {
				setBase(value ?? 0);
				scrub.start(spec.label);
			}}
			onScrub={(d) => scrub.update([cmd(clamp(base + d))])}
			onScrubEnd={(cancelled) => scrub.end(cancelled)}
			onCommit={(fn) => props.onSet(clamp(fn(value ?? 0)))}
			data-testid={`prop-${spec.key}`}
		/>
	);
}

/** Arrays and free-form values: a one-line JSON field (S08:MGC-011 "everything stays editable as JSON"). */
function JsonValueEditor(props: {
	spec: PropertySpec;
	value: unknown;
	disabled: boolean;
	onSet(v: unknown): void;
}) {
	const text = props.value === undefined ? '' : JSON.stringify(props.value);
	const [error, setError] = useState(false);
	return (
		<span className={cx('min-w-0 flex-1', error && 'outline outline-1 outline-pr-danger')}>
			<TextField
				value={text}
				label={`${props.spec.label} (JSON)`}
				disabled={props.disabled}
				onCommit={(t) => {
					try {
						props.onSet(JSON.parse(t));
						setError(false);
					} catch {
						setError(true);
					}
				}}
				data-testid={`prop-${props.spec.key}`}
			/>
		</span>
	);
}
