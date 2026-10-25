// `social-date` (store reviews, design §11): the review date with the browser's own date field (calendar picker,
// keyboard entry, screen-reader support), the date as the card prints it for the clip's store ("11/6/18" on Google
// Play, "09/24/2021" on the App Store) and a wand for a believable recent date. Only real dates in the schema's range
// are written; typing a year digit by digit writes once the date is complete (one History entry).
import {
	formatReviewDate,
	parseReviewDate,
	randomReviewDate,
	SOCIAL_DATE_MAX_YEAR,
	SOCIAL_DATE_MIN_YEAR,
	VARIANT_PLATFORM,
} from '@jasper/mg-templates';
import { cx, Icon } from '@jasper/ui';
import { useEffect, useId, useRef, useState } from 'react';
import type { TemplateParamControlProps } from '../extensions/index.ts';
import { t } from '../i18n/runtime.ts';
import { MiniButton } from '../panels/properties/controls/fields.tsx';
import { randomSeed, variantOf } from './params.ts';

const MIN = `${SOCIAL_DATE_MIN_YEAR}-01-01`;
const MAX = `${SOCIAL_DATE_MAX_YEAR}-12-31`;

/** How the clip's store prints a date (the App Store web form for every App Store variant). */
export function datePreview(variant: string, iso: unknown): string {
	const store =
		VARIANT_PLATFORM[variant as keyof typeof VARIANT_PLATFORM] === 'play-store' ? 'play-store' : 'app-store';
	return formatReviewDate(store, iso) || '–';
}

export function SocialDateControl(p: TemplateParamControlProps) {
	const variant = variantOf(p.params);
	const stored = !p.mixed && parseReviewDate(p.value) ? (p.value as string) : null;
	const [text, setText] = useState(stored ?? '');
	const [error, setError] = useState<'invalid' | 'refused' | null>(null);
	const focused = useRef(false);
	const errorId = useId();
	useEffect(() => {
		if (focused.current) return;
		setText(stored ?? '');
		setError(null);
	}, [stored]);

	const write = (iso: string, coalesce: boolean) => {
		if (iso === stored) return true;
		const ok = p.onChange(iso, coalesce ? { coalesce: true } : undefined);
		setError(ok ? null : 'refused');
		return ok;
	};
	return (
		<span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-[2px]" data-social-date>
			<input
				type="date"
				min={MIN}
				max={MAX}
				aria-label={t('Review date')}
				aria-invalid={error ? true : undefined}
				aria-describedby={error ? errorId : undefined}
				disabled={p.disabled}
				className={cx(
					'h-[20px] min-w-0 rounded-pr-control border bg-pr-field px-1 font-pr text-pr-ui text-pr-value',
					'hover:border-pr-border-strong focus:outline focus:outline-1 focus:outline-pr-focus',
					error ? 'border-pr-danger' : 'border-transparent',
				)}
				value={text}
				onFocus={() => {
					focused.current = true;
				}}
				onChange={(e) => {
					const v = e.target.value;
					setText(v);
					// the field reports '' while incomplete and partial years ("0202-…") while a year is typed
					if (parseReviewDate(v)) write(v, true);
					else if (error === 'refused') setError(null);
				}}
				onBlur={() => {
					focused.current = false;
					if (text === (stored ?? '')) return setError(null);
					if (parseReviewDate(text)) write(text, false);
					else setError('invalid');
				}}
				onKeyDown={(e) => {
					if (e.key === 'Escape') {
						e.preventDefault();
						setText(stored ?? '');
						setError(null);
					}
				}}
				data-testid="social-date-input"
			/>
			<output
				className="min-w-0 truncate text-pr-small text-pr-muted"
				aria-label={t('Shown on the card as')}
				title={t('Shown on the card as')}
				data-testid="social-date-preview"
			>
				{datePreview(variant, parseReviewDate(text) ? text : stored)}
			</output>
			<span className="ml-auto">
				<MiniButton
					label={t('Randomize Date')}
					onClick={() => {
						const ok = p.onChangeParams(() => ({ date: randomReviewDate(randomSeed()) }), {
							label: t('Randomize Date'),
						});
						setError(ok ? null : 'refused');
					}}
					disabled={p.disabled}
					data-testid="social-date-randomize"
				>
					<Icon id="action.randomize" size={13} />
				</MiniButton>
			</span>
			{error ? (
				<span
					id={errorId}
					role="alert"
					className="w-full text-pr-small text-pr-danger"
					data-testid="social-date-error"
				>
					{error === 'refused'
						? t('The change was refused')
						: t('Enter a real date between {0} and {1}', SOCIAL_DATE_MIN_YEAR, SOCIAL_DATE_MAX_YEAR)}
				</span>
			) : null}
		</span>
	);
}
