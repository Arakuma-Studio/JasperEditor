// "Randomize stats" (design §7.9): the wand in the header of the group holding the social-comment counts and time.
// Fills every stat the clip's variant draws — time value and unit, likes, replies, and reposts and views on X —
// consistently (`randomStats`), one seed per selected clip, as ONE undo step. Stats a variant hides keep their value.
import { Icon } from '@jasper/ui';
import { useState } from 'react';
import type { TemplateGroupActionProps } from '../extensions/index.ts';
import { t } from '../i18n/runtime.ts';
import { MiniButton } from '../panels/properties/controls/fields.tsx';
import { randomSeed, statsPatch } from './params.ts';

export function RandomizeStatsAction(p: TemplateGroupActionProps) {
	const [refused, setRefused] = useState(false);
	return (
		<span className="flex items-center gap-1">
			{refused ? (
				<span
					role="alert"
					className="text-pr-small text-pr-danger"
					data-testid="social-randomize-stats-error"
				>
					{t('The change was refused')}
				</span>
			) : null}
			<MiniButton
				label={t('Randomize Stats')}
				disabled={p.disabled}
				onClick={() =>
					setRefused(
						!p.onChangeParams((params) => statsPatch(params, randomSeed()), { label: t('Randomize Stats') }),
					)
				}
				data-testid="social-randomize-stats"
			>
				<Icon id="action.randomize" size={13} />
			</MiniButton>
		</span>
	);
}
