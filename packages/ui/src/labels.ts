// Label colors (S05:DT-020…022, R-PUI §3.4). Names match the document's LabelColor (S01:PRJ-001);
// the colors themselves live in theme/tokens.css (and theme/label-presets.ts for canvas drawing).
import { LABEL_COLORS, type LabelColor } from '@jasper/project';

export type LabelName = LabelColor;

export const LABEL_NAMES: readonly LabelName[] = [...LABEL_COLORS];

/** Neutral display names (S05:DT-022) so the UI never copies trade dress. */
export const LABEL_DISPLAY_NAMES: Record<LabelName, string> = {
	violet: 'Indigo',
	iris: 'Steel',
	caribbean: 'Jade',
	lavender: 'Orchid',
	cerulean: 'Lagoon',
	forest: 'Moss',
	rose: 'Ruby',
	mango: 'Amber',
	purple: 'Purple',
	blue: 'Blue',
	teal: 'Teal',
	magenta: 'Magenta',
	tan: 'Tan',
	green: 'Green',
	brown: 'Brown',
	yellow: 'Yellow',
};

export type MediaKindKey =
	| 'video-only'
	| 'video-audio'
	| 'audio'
	| 'still'
	| 'animated-image'
	| 'sequence'
	| 'bin'
	| 'captions'
	| 'remotion-composition'
	| 'fframes-graphic'
	| 'solid'
	| 'adjustment'
	| 'text';

/** Default label per media kind (S05:DT-021). */
export const LABEL_DEFAULTS: Record<MediaKindKey, LabelName> = {
	'video-only': 'iris',
	'video-audio': 'violet',
	audio: 'caribbean',
	still: 'lavender',
	'animated-image': 'lavender',
	sequence: 'forest',
	bin: 'mango',
	captions: 'mango',
	'remotion-composition': 'magenta',
	'fframes-graphic': 'purple',
	solid: 'tan',
	adjustment: 'tan',
	text: 'lavender',
};

/** CSS color for a label body (`var(--pr-label-<name>)`). */
export function labelColor(name: LabelName): string {
	return `var(--pr-label-${name})`;
}

/** CSS color for a label tint (waveforms, text on dark). */
export function labelTint(name: LabelName): string {
	return `var(--pr-label-${name}-tint)`;
}
