// `social-time`: how long ago the comment was posted — value and unit (minutes…years) in one row, rendered on
// `timeValue` and editing `timeUnit` too (its own row is hidden, `alsoEdits`), with the platform's wording as a preview
// ("3h", "3 months ago"). Months stay months on every platform (tokcomment printed YouTube months as hours).
import {
	formatTime,
	SOCIAL_TIME_UNITS,
	SOCIAL_TIME_VALUE_MAX,
	type SocialTimeUnit,
} from '@jasper/mg-templates';
import { cx, Icon } from '@jasper/ui';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import type { TemplateParamControlProps } from '../extensions/index.ts';
import { t } from '../i18n/runtime.ts';
import { MiniButton } from '../panels/properties/controls/fields.tsx';
import { type CountInputError, parseCountInput } from './count-input.ts';
import { shared, useClipsParams } from './hooks.ts';
import { TIME_UNIT_LABELS, TIME_UNIT_SINGULAR_LABELS } from './labels.ts';
import { randomSeed, timePatch, timeUnitOf, timeValueOf, variantOf } from './params.ts';
import { countErrorText } from './SocialCountControl.tsx';

export function SocialTimeControl(p: TemplateParamControlProps) {
	const all = useClipsParams(p.clipIds, p.params);
	const valueState = shared(all, 'timeValue');
	const unitState = shared(all, 'timeUnit');
	const variant = variantOf(p.params);
	const stored = valueState.mixed ? null : timeValueOf(valueState.value);
	const unit = unitState.mixed ? null : timeUnitOf(unitState.value);
	const shownText = stored === null ? '' : String(stored);
	const [text, setText] = useState(shownText);
	const [error, setError] = useState<CountInputError | 'refused' | null>(null);
	const focused = useRef(false);
	const errorId = useId();
	useEffect(() => {
		if (focused.current) return;
		setText(shownText);
		setError(null);
	}, [shownText]);

	const parsed = parseCountInput(text, SOCIAL_TIME_VALUE_MAX);
	const previewValue = parsed.ok ? parsed.value : stored;
	const write = (patch: Record<string, unknown>) => {
		const ok = p.onChangeParams(patch, { label: t('Time') });
		setError(ok ? null : 'refused');
		return ok;
	};
	const commit = (raw: string): boolean => {
		if (raw === shownText) {
			setError(null);
			return true;
		}
		const r = parseCountInput(raw, SOCIAL_TIME_VALUE_MAX);
		if (!r.ok) {
			setError(r.error);
			return false;
		}
		if (r.value === stored) {
			setText(shownText);
			setError(null);
			return true;
		}
		setText(String(r.value));
		return write({ timeValue: r.value });
	};
	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.nativeEvent.isComposing) return;
		if (e.key === 'Enter') {
			e.preventDefault();
			commit(text);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			setText(shownText);
			setError(null);
		} else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey && !e.ctrlKey && !e.metaKey) {
			e.preventDefault();
			const base = parsed.ok ? parsed.value : (stored ?? 0);
			const next = Math.min(SOCIAL_TIME_VALUE_MAX, Math.max(0, base + (e.key === 'ArrowUp' ? 1 : -1)));
			setText(String(next));
			if (next !== stored) write({ timeValue: next });
		}
	};
	const labels = previewValue === 1 ? TIME_UNIT_SINGULAR_LABELS : TIME_UNIT_LABELS;

	return (
		<span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-[2px]" data-social-time>
			<input
				type="text"
				inputMode="numeric"
				autoComplete="off"
				spellCheck={false}
				aria-label={t('Time ago')}
				aria-invalid={error ? true : undefined}
				aria-describedby={error ? errorId : undefined}
				disabled={p.disabled}
				placeholder={valueState.mixed ? '–' : undefined}
				className={cx(
					'h-[20px] w-[48px] min-w-0 rounded-pr-control border bg-pr-field px-1 text-right font-pr text-pr-ui text-pr-value',
					'hover:border-pr-border-strong focus:outline focus:outline-1 focus:outline-pr-focus',
					error ? 'border-pr-danger' : 'border-transparent',
				)}
				value={text}
				onFocus={() => {
					focused.current = true;
				}}
				onChange={(e) => {
					setText(e.target.value);
					if (error) setError(null);
				}}
				onBlur={() => {
					focused.current = false;
					commit(text);
				}}
				onKeyDown={onKeyDown}
				data-testid="social-time-value"
			/>
			<select
				aria-label={t('Time unit')}
				disabled={p.disabled}
				className={cx(
					'h-[20px] min-w-0 rounded-pr-control border border-transparent bg-pr-field px-1 font-pr text-pr-ui text-pr-text',
					'hover:border-pr-border-strong focus:outline focus:outline-1 focus:outline-pr-focus',
				)}
				value={unit ?? ''}
				onChange={(e) => {
					const u = timeUnitOf(e.target.value);
					if (u && u !== unit) write({ timeUnit: u });
				}}
				data-testid="social-time-unit"
			>
				{unit === null ? <option value="">–</option> : null}
				{SOCIAL_TIME_UNITS.map((u: SocialTimeUnit) => (
					<option key={u} value={u}>
						{labels[u]}
					</option>
				))}
			</select>
			<output
				className="min-w-0 truncate text-pr-small text-pr-muted"
				aria-label={t('Shown on the card as')}
				title={t('Shown on the card as')}
				data-testid="social-time-preview"
			>
				{previewValue === null || unit === null ? '–' : formatTime(variant, previewValue, unit)}
			</output>
			<span className="ml-auto">
				<MiniButton
					label={t('Randomize Time')}
					onClick={() => {
						const ok = p.onChangeParams((params) => timePatch(params, randomSeed()), {
							label: t('Randomize Time'),
						});
						setError(ok ? null : 'refused');
					}}
					disabled={p.disabled}
					data-testid="social-time-randomize"
				>
					<Icon id="action.randomize" size={13} />
				</MiniButton>
			</span>
			{error ? (
				<span id={errorId} role="alert" className="w-full text-pr-small text-pr-danger" data-testid="social-time-error">
					{countErrorText(error, SOCIAL_TIME_VALUE_MAX)}
				</span>
			) : null}
		</span>
	);
}
