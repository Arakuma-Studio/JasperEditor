// `social-rating` (store reviews, design §11): the star rating as five stars to click — native radio buttons (visually
// hidden behind the stars), so the keyboard and screen readers work as for any radio group (arrows, plus Home / End and
// digits 1–5) — each pick one undo step.
import { SOCIAL_RATING_MAX, SOCIAL_RATING_MIN } from '@jasper/mg-templates';
import { cx, Icon } from '@jasper/ui';
import { type KeyboardEvent, useId, useRef, useState } from 'react';
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
	const inputs = useRef<(HTMLInputElement | null)[]>([]);
	const name = useId();
	const shown = hover ?? stored ?? 0;
	const pick = (n: number, coalesce = false) => {
		const v = Math.min(SOCIAL_RATING_MAX, Math.max(SOCIAL_RATING_MIN, n));
		if (v === stored) return;
		setRefused(!p.onChange(v, coalesce ? { coalesce: true } : undefined));
	};
	// native radios move with the arrows too; handled here so every browser (and Home / End / digits) agrees
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
		inputs.current[v - SOCIAL_RATING_MIN]?.focus();
	};
	return (
		<span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-[2px]" data-social-rating>
			<fieldset
				disabled={p.disabled}
				className="m-0 flex min-w-0 items-center border-0 p-0"
				onKeyDown={onKeyDown}
				onMouseLeave={() => setHover(null)}
				data-testid="social-rating"
			>
				<legend className="sr-only">{t('Rating')}</legend>
				{STARS.map((n) => {
					const on = n <= shown;
					return (
						<label
							key={n}
							title={starsLabel(n)}
							onMouseEnter={() => setHover(n)}
							className={cx(
								'inline-flex size-[18px] cursor-pointer items-center justify-center rounded-pr-control',
								'hover:bg-pr-hover has-[:focus-visible]:outline has-[:focus-visible]:outline-1 has-[:focus-visible]:outline-pr-focus',
								'has-[:disabled]:pointer-events-none has-[:disabled]:text-pr-dim',
								on ? 'text-pr-accent' : 'text-pr-dim',
							)}
							data-on={on || undefined}
						>
							<input
								ref={(el) => {
									inputs.current[n - SOCIAL_RATING_MIN] = el;
								}}
								type="radio"
								name={name}
								value={n}
								className="sr-only"
								checked={stored === n}
								disabled={p.disabled}
								aria-label={starsLabel(n)}
								onFocus={() => setHover(null)}
								onChange={() => pick(n)}
								data-testid={`social-rating-${n}`}
							/>
							<Icon id="rating.star" size={14} className={on ? 'fill-current' : undefined} />
						</label>
					);
				})}
			</fieldset>
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
