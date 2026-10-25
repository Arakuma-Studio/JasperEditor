// `social-count` (likes, replies, reposts, views): a count field that takes what people type ("1393", "1,234",
// "12.3K", "3.4M"), shows how the card will print it for the clip's platform ("1,393", "12.3K"), validates visibly and
// has a wand that draws a believable value consistent with the other counts (one undo step).
import { formatCount, SOCIAL_COUNT_MAX, type SocialCountField } from '@jasper/mg-templates';
import { cx, Icon } from '@jasper/ui';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import type { TemplateParamControlProps } from '../extensions/index.ts';
import { t } from '../i18n/runtime.ts';
import { MiniButton } from '../panels/properties/controls/fields.tsx';
import { type CountInputError, parseCountInput } from './count-input.ts';
import { COUNT_ERROR_TEXTS, COUNT_FIELD_LABELS } from './labels.ts';
import { countOf, countPatch, isCountField, randomSeed, variantOf } from './params.ts';

/** "1,000,000,000,000" (the cap, for the error message; locale-independent like the card). */
const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export function countErrorText(error: CountInputError | 'refused', max = SOCIAL_COUNT_MAX): string {
	return error === 'too-large' ? t('At most {0}', grouped(max)) : COUNT_ERROR_TEXTS[error];
}

export function SocialCountControl(p: TemplateParamControlProps) {
	const field: SocialCountField = isCountField(p.paramName) ? p.paramName : 'likes';
	const fieldLabel = COUNT_FIELD_LABELS[field];
	const variant = variantOf(p.params);
	const stored = p.mixed ? null : countOf(p.value);
	const shownText = stored === null ? '' : String(stored);
	const [text, setText] = useState(shownText);
	const [error, setError] = useState<CountInputError | 'refused' | null>(null);
	const focused = useRef(false);
	const errorId = useId();
	// another clip, undo/redo or the wand changed the value: show it (a field being typed in keeps its text)
	useEffect(() => {
		if (focused.current) return;
		setText(shownText);
		setError(null);
	}, [shownText]);

	const parsed = parseCountInput(text);
	const preview = parsed.ok ? parsed.value : stored;
	const commit = (raw: string): boolean => {
		if (raw === shownText) {
			setError(null);
			return true;
		}
		const r = parseCountInput(raw);
		if (!r.ok) {
			setError(r.error);
			return false;
		}
		setError(null);
		if (r.value === stored) {
			setText(shownText);
			return true;
		}
		if (!p.onChange(r.value)) {
			setError('refused');
			return false;
		}
		setText(String(r.value));
		return true;
	};
	const step = (delta: number) => {
		const base = parsed.ok ? parsed.value : (stored ?? 0);
		const next = Math.min(SOCIAL_COUNT_MAX, Math.max(0, base + delta));
		setText(String(next));
		if (next !== stored && !p.onChange(next)) setError('refused');
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
			step((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1));
		}
	};
	const randomize = () => {
		const ok = p.onChangeParams((params) => countPatch(field, params, randomSeed()), {
			label: t('Randomize {0}', fieldLabel),
		});
		setError(ok ? null : 'refused');
	};

	return (
		<span
			className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-[2px]"
			data-social-count={field}
		>
			<input
				type="text"
				inputMode="decimal"
				autoComplete="off"
				spellCheck={false}
				aria-label={fieldLabel}
				aria-invalid={error ? true : undefined}
				aria-describedby={error ? errorId : undefined}
				disabled={p.disabled}
				placeholder={p.mixed ? '–' : undefined}
				title={t('A number such as 1393, 1,234, 12.3K or 3.4M')}
				className={cx(
					'h-[20px] w-[84px] min-w-0 rounded-pr-control border bg-pr-field px-1 text-right font-pr text-pr-ui text-pr-value',
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
					// an invalid entry stays visible with its message until fixed or Escape
					commit(text);
				}}
				onKeyDown={onKeyDown}
				data-testid={`social-count-${field}`}
			/>
			<output
				className="min-w-0 truncate text-pr-small text-pr-muted"
				aria-label={t('Shown on the card as')}
				title={t('Shown on the card as')}
				data-testid={`social-count-${field}-preview`}
			>
				{preview === null ? '–' : formatCount(variant, preview, field)}
			</output>
			<span className="ml-auto">
				<MiniButton
					label={t('Randomize {0}', fieldLabel)}
					onClick={randomize}
					disabled={p.disabled}
					data-testid={`social-count-${field}-randomize`}
				>
					<Icon id="action.randomize" size={13} />
				</MiniButton>
			</span>
			{error ? (
				<span
					id={errorId}
					role="alert"
					className="w-full text-pr-small text-pr-danger"
					data-testid={`social-count-${field}-error`}
				>
					{countErrorText(error)}
				</span>
			) : null}
		</span>
	);
}
