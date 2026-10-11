// Label colors (S05:DT-020…022, R-PUI §3.4). Names match the document's LabelColor (S01:PRJ-001);
// the colors themselves live in theme/tokens.css.
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

export function labelColor(name: LabelName): string {
	return `var(--pr-label-${name})`;
}
