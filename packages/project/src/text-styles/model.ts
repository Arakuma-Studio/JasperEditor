// Spec 13 SH-002 / AS-032: linked project text styles.
//
// `ProjectDocument.textStyles` holds named styles; a text clip linked to one carries `styleId` and, where it deviates,
// `styleOverrides` (a patch over the style). The clip's `content.style` always holds the effective style (the
// renderers and older builds read only that); editing a project style rewrites every linked clip's effective style as
// `applyStylePatch(newStyle, deviations)`, the deviations taken from the clip itself, so a deviation is never lost
// whichever command made it. Stored leniently (schema v9 fields): a dangling `styleId` (pasted from another project)
// reads as "not linked", INV-TEXTSTYLE checks what is stored, `repairTextStyles` makes it readable on load.
import { z } from 'zod';
import { ID_PREFIXES, idPrefixOf, isValidId } from '../ids.ts';
import type { ProjectDocument } from '../schema/document.ts';
import { type Clip, type TextStyle, TextStyleSchema } from '../schema/sequence.ts';
import {
	applyStylePatch,
	diffStyle,
	MAX_TEXT_STYLE_NAME,
	MAX_TEXT_STYLES,
	type TextStyleOverrides,
	TextStyleOverridesSchema,
	textStyleProblem,
} from './patch.ts';

export const TEXT_STYLE_PREFIX = ID_PREFIXES.textStyle;

export type ProjectTextStyle = { id: string; name: string; style: TextStyle };

export const ProjectTextStyleSchema = z.looseObject({
	id: z.string(),
	name: z.string().min(1).max(MAX_TEXT_STYLE_NAME),
	style: TextStyleSchema,
});

const isPlain = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

type StyleLinkFields = { styleId?: unknown; styleOverrides?: unknown };

/** Why one stored project text style is unreadable (key = record key), or null. */
export function projectTextStyleProblem(key: string, v: unknown): string | null {
	const r = ProjectTextStyleSchema.safeParse(v);
	if (!r.success) {
		const i = r.error.issues[0]!;
		return `${i.path.join('.') || 'entry'}: ${i.message}`;
	}
	if (r.data.id !== key) return `record key ${key} differs from id ${r.data.id}`;
	if (!isValidId(key) || idPrefixOf(key) !== TEXT_STYLE_PREFIX) return `malformed id ${key}`;
	if (!r.data.name.trim()) return 'empty name';
	return textStyleProblem(r.data.style);
}

/** The readable project text styles (unreadable entries are skipped; the invariant reports them). */
export function textStylesOf(doc: Pick<ProjectDocument, 'textStyles'>): ProjectTextStyle[] {
	const rec = (doc as { textStyles?: unknown }).textStyles;
	if (!isPlain(rec)) return [];
	const out: ProjectTextStyle[] = [];
	for (const [k, v] of Object.entries(rec)) if (!projectTextStyleProblem(k, v)) out.push(v as ProjectTextStyle);
	return out;
}

/** One readable project text style, or null. */
export function textStyleById(
	doc: Pick<ProjectDocument, 'textStyles'>,
	id: string | undefined | null,
): ProjectTextStyle | null {
	if (!id) return null;
	const rec = (doc as { textStyles?: unknown }).textStyles;
	if (!isPlain(rec) || !Object.hasOwn(rec, id)) return null;
	const v = rec[id];
	return projectTextStyleProblem(id, v) ? null : (v as ProjectTextStyle);
}

/** The project style a clip is linked to (null: not a text clip, not linked, or the style is gone). */
export function linkedTextStyle(doc: Pick<ProjectDocument, 'textStyles'>, clip: Clip): ProjectTextStyle | null {
	if (clip.kind !== 'text') return null;
	const id = (clip as StyleLinkFields).styleId;
	return typeof id === 'string' ? textStyleById(doc, id) : null;
}

/** A clip's stored overrides when readable (an unreadable value reads as none). */
export function styleOverridesOf(clip: Clip): TextStyleOverrides {
	const v = (clip as StyleLinkFields).styleOverrides;
	if (v === undefined) return {};
	const r = TextStyleOverridesSchema.safeParse(v);
	return r.success ? r.data : {};
}

/** The fields a linked clip deviates in: its effective style compared with its style (exact, from the clip). */
export function clipDeviations(style: ProjectTextStyle, clip: Clip): TextStyleOverrides {
	if (clip.kind !== 'text') return {};
	return diffStyle(style.style, clip.content.style as TextStyle);
}

/** The effective style of a clip linked to `style` with `overrides`. */
export function linkedEffectiveStyle(style: ProjectTextStyle, overrides: TextStyleOverrides): TextStyle {
	return applyStylePatch(style.style, overrides);
}

/** Style id → ids of the text clips linked to it (every sequence; dangling links skipped). */
export function textStyleUsage(doc: ProjectDocument): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const s of textStylesOf(doc)) out.set(s.id, []);
	for (const seq of Object.values(doc.sequences))
		for (const c of Object.values(seq.clips)) {
			if (c.kind !== 'text') continue;
			const id = (c as StyleLinkFields).styleId;
			if (typeof id === 'string') out.get(id)?.push(c.id);
		}
	return out;
}

/** INV-TEXTSTYLE (document level): the stored `textStyles` record. Returns `[message, path]` pairs. */
export function textStylesRecordIssues(doc: ProjectDocument): [string, string[]][] {
	const rec = (doc as { textStyles?: unknown }).textStyles;
	if (rec === undefined) return [];
	if (!isPlain(rec)) return [['textStyles must be an object of styles by id', ['textStyles']]];
	const out: [string, string[]][] = [];
	const keys = Object.keys(rec);
	if (keys.length > MAX_TEXT_STYLES) out.push([`more than ${MAX_TEXT_STYLES} text styles`, ['textStyles']]);
	for (const k of keys) {
		const bad = projectTextStyleProblem(k, rec[k]);
		if (bad) {
			out.push([`Text style ${k}: ${bad}`, ['textStyles', k]]);
			continue;
		}
		const fontId = (rec[k] as ProjectTextStyle).style.fontId;
		if (!doc.fonts[fontId]) out.push([`Text style ${k} references missing font ${fontId}`, ['textStyles', k]]);
	}
	return out;
}

/** INV-TEXTSTYLE (clip level): a clip's link fields (a link to a missing style is soft and not reported). */
export function clipTextStyleIssue(clip: Clip): string | null {
	const r = clip as StyleLinkFields;
	if (r.styleId === undefined && r.styleOverrides === undefined) return null;
	if (clip.kind !== 'text') return `a ${clip.kind} clip cannot be linked to a text style`;
	if (r.styleId === undefined) return 'styleOverrides without a styleId';
	if (typeof r.styleId !== 'string' || !isValidId(r.styleId) || idPrefixOf(r.styleId) !== TEXT_STYLE_PREFIX)
		return `malformed styleId ${String(r.styleId)}`;
	if (r.styleOverrides !== undefined && !TextStyleOverridesSchema.safeParse(r.styleOverrides).success)
		return 'unreadable styleOverrides';
	return null;
}

type Note = (action: string, entity: string, detail: string) => void;

/**
 * Load repair (repairDocument): unreadable style records dropped (their clips unlinked), keys and ids made equal,
 * missing style fonts replaced by `defaultFontId()`, link fields on non-text clips, malformed or dangling links and
 * unreadable overrides removed (overrides are recomputed from the clip). Mutates `doc`; idempotent.
 */
export function repairTextStyles(
	doc: ProjectDocument,
	ids: { defaultFontId(): string; newStyleId(): string },
	note: Note,
): void {
	const d = doc as { textStyles?: unknown };
	if (d.textStyles !== undefined && !isPlain(d.textStyles)) {
		delete d.textStyles;
		note('drop-text-styles', 'textStyles', 'unreadable text styles record removed');
	}
	const rec = d.textStyles as Record<string, unknown> | undefined;
	if (rec) {
		const validKey = (k: unknown): k is string =>
			typeof k === 'string' && isValidId(k) && idPrefixOf(k) === TEXT_STYLE_PREFIX;
		for (const key of Object.keys(rec)) {
			let k = key;
			const v = rec[k];
			if (isPlain(v) && !validKey(k)) {
				const next = validKey(v.id) && !Object.hasOwn(rec, v.id) ? v.id : ids.newStyleId();
				delete rec[k];
				rec[next] = v;
				v.id = next;
				for (const seq of Object.values(doc.sequences))
					for (const c of Object.values(seq.clips))
						if ((c as StyleLinkFields).styleId === k) (c as StyleLinkFields).styleId = next;
				note('fix-id', next, `text style record key ${JSON.stringify(k)} replaced`);
				k = next;
			}
			if (isPlain(v) && v.id !== k) {
				v.id = k;
				note('fix-id', k, 'text style record key and id made equal');
			}
			if (isPlain(v) && typeof v.name === 'string' && v.name.length > MAX_TEXT_STYLE_NAME) {
				v.name = v.name.slice(0, MAX_TEXT_STYLE_NAME);
				note('fix-text-style', k, `name shortened to ${MAX_TEXT_STYLE_NAME} characters`);
			}
			if (isPlain(v) && isPlain(v.style) && typeof v.style.fontId === 'string' && !doc.fonts[v.style.fontId]) {
				const font = ids.defaultFontId();
				note('reset-font', k, `missing font ${v.style.fontId} of the text style replaced`);
				v.style.fontId = font;
			}
			if (projectTextStyleProblem(k, rec[k])) {
				delete rec[k];
				note('drop-text-style', k, 'unreadable text style removed (its clips keep their look, unlinked)');
			}
		}
		const keys = Object.keys(rec);
		for (const k of keys.slice(MAX_TEXT_STYLES)) {
			delete rec[k];
			note('drop-text-style', k, `more than ${MAX_TEXT_STYLES} text styles`);
		}
		if (Object.keys(rec).length === 0) delete d.textStyles;
	}
	for (const seq of Object.values(doc.sequences))
		for (const c of Object.values(seq.clips)) {
			const r = c as StyleLinkFields;
			if (r.styleId === undefined && r.styleOverrides === undefined) continue;
			const style = typeof r.styleId === 'string' ? textStyleById(doc, r.styleId) : null;
			if (c.kind !== 'text' || !style) {
				delete r.styleId;
				delete r.styleOverrides;
				note(
					'unlink-text-style',
					c.id,
					c.kind !== 'text' ? `a ${c.kind} clip cannot be linked to a text style` : 'the linked text style is missing',
				);
				continue;
			}
			const exact = clipDeviations(style, c);
			const stored = r.styleOverrides;
			if (stored !== undefined && !TextStyleOverridesSchema.safeParse(stored).success) {
				note('fix-style-overrides', c.id, 'unreadable style overrides recomputed from the clip');
				if (Object.keys(exact).length) r.styleOverrides = exact;
				else delete r.styleOverrides;
			}
		}
}

/** Whether a loaded document holds soft link problems the load repair tidies (a link to a style that is gone). */
export function textStylesNeedRepair(doc: ProjectDocument): boolean {
	for (const seq of Object.values(doc.sequences))
		for (const c of Object.values(seq.clips)) {
			const id = (c as StyleLinkFields).styleId;
			if (typeof id === 'string' && !textStyleById(doc, id)) return true;
		}
	return false;
}
