// `social-rating` (store reviews, design §11): the star rating as five stars to click — a radio group, so the keyboard
// works the way screen readers announce it (arrows, Home / End, digits 1–5) — each pick one undo step.
import { SOCIAL_RATING_MAX, SOCIAL_RATING_MIN } from '@jasper/mg-templates';
import { cx, Icon } from '@jasper/ui';
import { type KeyboardEvent, useRef, useState } from 'react';
import type { TemplateParamControlProps } from '../extensions/index.ts';
import { t } from '../i18n/runtime.ts';
import { ratingOf } from './params.ts';

const STARS = Array.from(
	{ length: SOCIAL_RATING_MAX - SOCIAL_RATING_MIN + 1 },
	(_, i) => SOCIAL_RATING_MIN + i,
);

/** "1 star", "4 stars". */
export function starsLabel(n: number): string {
	return n === 1 ? t('1 star') : t('{0} stars', n);
}

export function SocialRatingControl(p: TemplateParamControlProps) {
	const stored = p.mixed ? null : ratingOf(p.value);
	const [hover, setHover] = useState<number | null>(null);
	const [refused, setRefused] = useState(false);
	const buttons = useRef<(HTMLButtonElement | null)[]>([]);
	const shown = hover ?? stored ?? 0;
	const pick = (n: number, coalesce = false) => {
		const v = Math.min(SOCIAL_RATING_MAX, Math.max(SOCIAL_RATING_MIN, n));
		if (v === stored) return;
		setRefused(!p.onChange(v, coalesce ? { coalesce: true } : undefined));
	};
	const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
		if (p.disabled || e.altKey || e.ctrlKey || e.metaKey) return;
		const base = stored ?? SOCIAL_RATING_MIN;
		let next: number | null = null;
		if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = base + 1;
		else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = base - 1;
		else if (e.key === 'Home') next = SOCIAL_RATING_MIN;
		else if (e.key === 'End') next = SOCIAL_RATING_MAX;
		else if (/^[1-5]$/.test(e.key)) next = Number(e.key);
		if (next === null) return;
		e.preventDefault();
		const v = Math.min(SOCIAL_RATING_MAX, Math.max(SOCIAL_RATING_MIN, next));
		// arrow presses in a row are one History entry, like typing
		pick(v, e.key.startsWith('Arrow'));
		buttons.current[v - SOCIAL_RATING_MIN]?.focus();
	};
	// roving tab stop: the checked star (or the first when none / mixed)
	const tabStop = stored ?? SOCIAL_RATING_MIN;
	return (
		<span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-[2px]" data-social-rating>
			<span
				role="radiogroup"
				aria-label={t('Rating')}
				aria-disabled={p.disabled || undefined}
				className="flex items-center"
				onKeyDown={onKeyDown}
				onMouseLeave={() => setHover(null)}
				data-testid="social-rating"
			>
				{STARS.map((n) => {
					const on = n <= shown;
					return (
						<button
							key={n}
							ref={(el) => {
								buttons.current[n - SOCIAL_RATING_MIN] = el;
							}}
							type="button"
							role="radio"
							aria-checked={stored === n}
							aria-label={starsLabel(n)}
							title={starsLabel(n)}
							tabIndex={n === tabStop ? 0 : -1}
							disabled={p.disabled}
							onMouseEnter={() => setHover(n)}
							onFocus={() => setHover(null)}
							onClick={() => pick(n)}
							className={cx(
								'inline-flex size-[18px] items-center justify-center rounded-pr-control',
								'hover:bg-pr-hover focus:outline focus:outline-1 focus:outline-pr-focus',
								'disabled:pointer-events-none disabled:text-pr-dim',
								on ? 'text-pr-accent' : 'text-pr-dim',
							)}
							data-testid={`social-rating-${n}`}
							data-on={on || undefined}
						>
							<Icon id="rating.star" size={14} className={on ? 'fill-current' : undefined} />
						</button>
					);
				})}
			</span>
			<output className="min-w-0 truncate text-pr-small text-pr-muted" data-testid="social-rating-value">
				{stored === null ? '–' : starsLabel(stored)}
			</output>
			{refused ? (
				<span role="alert" className="w-full text-pr-small text-pr-danger" data-testid="social-rating-error">
					{t('The change was refused')}
				</span>
			) : null}
		</span>
	);
}
