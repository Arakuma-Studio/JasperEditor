// spec 13 AS-021: display names of the built-in subtitle templates (translated; user templates show their own name).
import type { SubtitleTemplate } from '@jasper/project';
import { t } from '../i18n/runtime.ts';

const TEMPLATE_NAMES: Record<string, string> = {
	'builtin:pixel-pop': 'Pixel Pop',
	'builtin:pixel-pop-classic': 'Pixel Pop Classic',
	'builtin:subtitles': 'Subtitles',
	'builtin:bold-pop': 'Bold Pop',
	'builtin:word-highlight': 'Word Highlight',
	'builtin:karaoke': 'Karaoke',
	'builtin:minimal': 'Minimal',
	'builtin:lower-third': 'Lower Third',
};

export function templateName(tpl: Pick<SubtitleTemplate, 'id' | 'name' | 'builtIn'>): string {
	const n = tpl.builtIn ? TEMPLATE_NAMES[tpl.id] : undefined;
	return n ?? tpl.name;
}

/** The name of a template id as the project / built-ins know it (null = none). */
export function templateIdName(id: string | null, find: (id: string) => SubtitleTemplate | null): string {
	if (!id) return t('No template');
	const tpl = find(id);
	return tpl ? templateName(tpl) : id;
}
