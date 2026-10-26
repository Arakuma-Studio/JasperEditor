// Registers the social-comment Properties / Effect Controls controls (design §7.9) under the names the
// `social-comment` template uses in its `ui.params.<name>.control` hints. Called at start-up from commands/mg.ts.
import { registerTemplateParamControl, type TemplateGroupAction } from '../extensions/index.ts';
import { RandomizeStatsAction } from './RandomizeStatsAction.tsx';
import { SocialAvatarControl } from './SocialAvatarControl.tsx';
import { SocialCommentTextControl } from './SocialCommentTextControl.tsx';
import { SocialCountControl } from './SocialCountControl.tsx';
import { SocialDateControl } from './SocialDateControl.tsx';
import { SocialRatingControl } from './SocialRatingControl.tsx';
import { SocialTimeControl } from './SocialTimeControl.tsx';

/** Control names (stable: templates refer to them). */
export const SOCIAL_CONTROLS = {
	text: 'social-comment-text',
	count: 'social-count',
	time: 'social-time',
	avatar: 'social-avatar',
	rating: 'social-rating',
	date: 'social-date',
} as const;

/** The "Randomize stats" wand drawn in the header of the group holding the counts / time. */
export const RANDOMIZE_STATS_ACTION: TemplateGroupAction = {
	id: 'social-randomize-stats',
	component: RandomizeStatsAction,
};

let offs: (() => void)[] | null = null;

/** Registers the controls (idempotent); returns a function unregistering them (tests, HMR). */
export function registerSocialCommentControls(): () => void {
	if (!offs)
		offs = [
			registerTemplateParamControl(SOCIAL_CONTROLS.text, SocialCommentTextControl, { layout: 'block' }),
			registerTemplateParamControl(SOCIAL_CONTROLS.count, SocialCountControl, {
				groupActions: [RANDOMIZE_STATS_ACTION],
			}),
			registerTemplateParamControl(SOCIAL_CONTROLS.time, SocialTimeControl, {
				alsoEdits: ['timeValue', 'timeUnit'],
				groupActions: [RANDOMIZE_STATS_ACTION],
			}),
			registerTemplateParamControl(SOCIAL_CONTROLS.avatar, SocialAvatarControl, { layout: 'block' }),
			// store reviews: the stars and the date; both bring the Randomize Stats wand to their group
			registerTemplateParamControl(SOCIAL_CONTROLS.rating, SocialRatingControl, {
				groupActions: [RANDOMIZE_STATS_ACTION],
			}),
			registerTemplateParamControl(SOCIAL_CONTROLS.date, SocialDateControl, {
				groupActions: [RANDOMIZE_STATS_ACTION],
			}),
		];
	return () => {
		for (const off of offs ?? []) off();
		offs = null;
	};
}
