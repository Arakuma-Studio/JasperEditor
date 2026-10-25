// UI strings of the social-comment controls that are looked up by key (the i18n transform makes `*_LABELS` / `*_TEXTS`
// map values lazy translations, so these answer in the current UI language).
import type { SocialCountField, SocialMark, SocialTimeUnit } from '@jasper/mg-templates';
import type { CountInputError } from './count-input.ts';

export const COUNT_FIELD_LABELS: Readonly<Record<SocialCountField, string>> = {
	likes: 'Likes',
	replies: 'Replies',
	reposts: 'Reposts',
	views: 'Views',
};

export const TIME_UNIT_LABELS: Readonly<Record<SocialTimeUnit, string>> = {
	minute: 'Minutes',
	hour: 'Hours',
	day: 'Days',
	week: 'Weeks',
	month: 'Months',
	year: 'Years',
};

export const TIME_UNIT_SINGULAR_LABELS: Readonly<Record<SocialTimeUnit, string>> = {
	minute: 'Minute',
	hour: 'Hour',
	day: 'Day',
	week: 'Week',
	month: 'Month',
	year: 'Year',
};

export const MARK_LABELS: Readonly<Record<SocialMark | 'clear', string>> = {
	highlight: 'Highlight',
	blur: 'Blur',
	remove: 'Remove',
	clear: 'Clear Marks',
};

export const MARK_HINT_TEXTS: Readonly<Record<SocialMark | 'clear', string>> = {
	highlight: 'Highlight the selected words',
	blur: 'Blur the selected words',
	remove: 'Remove the selected words (they stay in the text; the card keeps their space)',
	clear: 'Clear the marks of the selected words',
};

export const COUNT_ERROR_TEXTS: Readonly<Record<CountInputError | 'refused', string>> = {
	empty: 'Enter a number',
	invalid: 'Not a number. Use digits, optionally with K, M or B (e.g. 1.2K)',
	negative: 'Cannot be negative',
	fraction: 'Use a whole number (or K, M, B: 1.5K)',
	'too-large': 'Too large',
	refused: 'The change was refused',
};
