// Content names of social-comment clips (docs/wp-notes/social-comments.md "Clip names", App QA N5): "X post · Luna
// Park", "Instagram post comment · @luna.makes" instead of "Social comment" on every card, so the timeline, the
// Program asset chip and export messages tell the cards apart. The `clipName` hook of `social-comment@1`
// (`MgTemplateInfo.clipName`, applied by `mgClipName` in @jasper/project: whitespace collapsed, cut to 80 characters).
import { isSocialVariant, shownNameParam, VARIANT_LABELS } from './variants.ts';

/** Longest author name kept in a clip name (longer ones end in "…"). */
const NAME_CHARS = 32;

/**
 * "<variant label> · <the name the card shows>" (`shownNameParam`: the display name on TikTok and X, "@handle" on
 * Instagram and YouTube); just the label when the name is empty; undefined (the template name) for an unknown
 * variant.
 */
export function socialClipName(params: Readonly<Record<string, unknown>>): string | undefined {
	const variant = params.variant;
	if (!isSocialVariant(variant)) return undefined;
	const label = VARIANT_LABELS[variant];
	const param = shownNameParam(variant);
	const raw = params[param];
	let name = typeof raw === 'string' ? raw.replace(/\s+/gu, ' ').trim() : '';
	if (!name) return label;
	if (param === 'handle' && !name.startsWith('@')) name = `@${name}`;
	const chars = [...name];
	if (chars.length > NAME_CHARS)
		name = `${chars
			.slice(0, NAME_CHARS - 1)
			.join('')
			.trimEnd()}…`;
	return `${label} · ${name}`;
}
