// Comment text → styled spans for the social-comment card: word marks (marks.ts) combined with the @mention and
// #hashtag runs the platform colours. Pure and total.
import { parseMarks, type SocialMarkKind } from './marks.ts';
import { type SocialPlatform, type SocialVariant, VARIANT_PLATFORM } from './variants.ts';

export type CommentRole = 'plain' | 'mention' | 'hashtag';
/** A run of visible text with one mark and one role; concatenating the texts gives the visible text. */
export type CommentSpan = { text: string; mark: SocialMarkKind; role: CommentRole };

/**
 * Account-name rules per platform: allowed characters and maximum length (TikTok 24 and Instagram 30 characters of
 * letters, digits, "_" and "."; YouTube handles 30 characters including "-" and non-Latin letters; X 15 characters
 * of letters, digits and "_"). A name never ends with "." (a sentence's full stop stays plain).
 */
const NAME_RULES: Readonly<Record<SocialPlatform, { chars: RegExp; max: number }>> = {
	tiktok: { chars: /[A-Za-z0-9_.]/u, max: 24 },
	instagram: { chars: /[A-Za-z0-9_.]/u, max: 30 },
	youtube: { chars: /[\p{L}\p{M}\p{N}_.-]/u, max: 30 },
	x: { chars: /[A-Za-z0-9_]/u, max: 15 },
};

/** A mention or hashtag starts at the text start or after a character that cannot be part of a word or e-mail. */
const WORDISH = /[\p{L}\p{M}\p{N}_@#&.]/u;
const TAG_CHAR = /[\p{L}\p{M}\p{N}_]/u;
const LETTER = /\p{L}/u;

/** Code points of `s` with their UTF-16 start offsets. */
function codePoints(s: string): { cp: string; at: number }[] {
	const out: { cp: string; at: number }[] = [];
	let at = 0;
	for (const cp of s) {
		out.push({ cp, at });
		at += cp.length;
	}
	return out;
}

/** Per-code-unit roles of `visible` under `platform`'s mention and hashtag rules. */
function roles(visible: string, platform: SocialPlatform): CommentRole[] {
	const out: CommentRole[] = new Array(visible.length).fill('plain');
	const cps = codePoints(visible);
	const rule = NAME_RULES[platform];
	let i = 0;
	while (i < cps.length) {
		const { cp, at } = cps[i]!;
		const prev = i > 0 ? cps[i - 1]!.cp : '';
		if ((cp === '@' || cp === '#') && !(prev && WORDISH.test(prev))) {
			const chars = cp === '@' ? rule.chars : TAG_CHAR;
			let j = i + 1;
			while (j < cps.length && chars.test(cps[j]!.cp)) j++;
			let end = j;
			if (cp === '@') while (end > i + 1 && cps[end - 1]!.cp === '.') end--;
			const body = cps.slice(i + 1, end);
			const ok =
				cp === '@'
					? body.length >= 1 && body.length <= rule.max && !(j < cps.length && cps[j]!.cp === '@')
					: body.some((c) => LETTER.test(c.cp));
			if (ok) {
				const stop = end < cps.length ? cps[end]!.at : visible.length;
				out.fill(cp === '@' ? 'mention' : 'hashtag', at, stop);
			}
			i = Math.max(j, i + 1);
			continue;
		}
		i++;
	}
	return out;
}

/**
 * Splits comment markup into spans by word mark and role: `@name` mentions and `#tag` hashtags (at least one letter)
 * per the variant's platform rules, starting at the text start or after a character that is not a letter, digit,
 * "_", "@", "#", "&" or "." (so e-mail addresses and "a#b" stay plain). Never throws.
 */
export function tokenizeComment(text: string, variant: SocialVariant): CommentSpan[] {
	const spans = parseMarks(text);
	let visible = '';
	const marks: SocialMarkKind[] = [];
	for (const sp of spans) {
		visible += sp.text;
		for (let k = 0; k < sp.text.length; k++) marks.push(sp.mark);
	}
	const role = roles(visible, VARIANT_PLATFORM[variant] ?? 'tiktok');
	const out: CommentSpan[] = [];
	for (let k = 0; k < visible.length; k++) {
		const last = out[out.length - 1];
		if (last && last.mark === marks[k] && last.role === role[k]) last.text += visible[k];
		else out.push({ text: visible[k]!, mark: marks[k]!, role: role[k]! });
	}
	return out;
}
