// spec 13 AS-032: linked project text styles in the editor — what the selection is linked to, the commands for
// create / apply / detach / reset / redefine / rename / delete, and Select ▸ Same Style. Pure: document in, commands out.
import {
	type Clip,
	type Command,
	clipDeviations,
	linkedTextStyle,
	type ProjectDocument,
	type ProjectTextStyle,
	type Sequence,
	sameValue,
	textStylesOf,
	textStyleUsage,
} from '@jasper/project';
import { t } from '../i18n/runtime.ts';

export type TextClip = Extract<Clip, { kind: 'text' }>;

/** Readable names of text style fields (the deviation list of linked clips). */
export const STYLE_FIELD_LABELS: Record<string, string> = {
	fontId: 'Font',
	weight: 'Weight',
	italic: 'Italic',
	sizePx: 'Font Size',
	lineHeight: 'Leading',
	trackingEm: 'Tracking',
	align: 'Align',
	direction: 'Direction',
	fill: 'Fill',
	strokes: 'Strokes',
	background: 'Background',
	shadow: 'Shadow',
	allCaps: 'All Caps',
	kerning: 'Kerning',
	baselineShiftPx: 'Baseline Shift',
	tsume: 'Tsume',
	fauxBold: 'Faux Bold',
	fauxItalic: 'Faux Italic',
	smallCaps: 'Small Caps',
	script: 'Superscript / Subscript',
	ligatures: 'Ligatures',
	openType: 'OpenType',
	fontVariations: 'Variable Font Axes',
	justifyLast: 'Justify Last Line',
	indentLeftPx: 'Indent Left',
	indentRightPx: 'Indent Right',
	indentFirstLinePx: 'First Line Indent',
	spaceBeforePx: 'Space Before',
	spaceAfterPx: 'Space After',
};

export const isTextClip = (c: Clip): c is TextClip => c.kind === 'text';

/** What the selected text clips are linked to. */
export type SelectionLink = {
	/** The style every clip is linked to; null when none are linked or the clips differ (`mixed`). */
	style: ProjectTextStyle | null;
	mixed: boolean;
	/** Linked clips (to any style) and those of them that deviate from their style. */
	linked: TextClip[];
	deviating: TextClip[];
	/** Deviating fields per clip id (top-level style fields). */
	fields: Map<string, string[]>;
};

export function selectionLink(doc: ProjectDocument, clips: readonly Clip[]): SelectionLink {
	const text = clips.filter(isTextClip);
	const styles = text.map((c) => linkedTextStyle(doc, c));
	const first = styles[0] ?? null;
	const mixed = styles.some((s) => (s?.id ?? null) !== (first?.id ?? null));
	const linked: TextClip[] = [];
	const deviating: TextClip[] = [];
	const fields = new Map<string, string[]>();
	text.forEach((c, i) => {
		const s = styles[i];
		if (!s) return;
		linked.push(c);
		const dev = Object.keys(clipDeviations(s, c));
		if (dev.length) {
			deviating.push(c);
			fields.set(c.id, dev);
		}
	});
	return { style: mixed ? null : first, mixed, linked, deviating, fields };
}

export type StyleRow = { style: ProjectTextStyle; uses: number };

/** Every project text style with its number of linked clips, by name. */
export function styleRows(doc: ProjectDocument): StyleRow[] {
	const usage = textStyleUsage(doc);
	return textStylesOf(doc)
		.map((style) => ({ style, uses: usage.get(style.id)?.length ?? 0 }))
		.sort((a, b) => a.style.name.localeCompare(b.style.name));
}

/** "Pixel Pop", "Pixel Pop 2", … — the first free name. */
export function freeStyleName(doc: ProjectDocument, base: string): string {
	const taken = new Set(textStylesOf(doc).map((s) => s.name.trim().toLocaleLowerCase()));
	if (!taken.has(base.trim().toLocaleLowerCase())) return base;
	for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLocaleLowerCase())) return `${base} ${i}`;
}

/** The name problem the style commands would refuse, or null. */
export function styleNameProblem(doc: ProjectDocument, name: string, except?: string): string | null {
	const n = name.trim();
	if (!n) return t('Enter a name.');
	if (n.length > 120) return t('Use at most 120 characters.');
	const clash = textStylesOf(doc).find(
		(s) => s.id !== except && s.name.trim().toLocaleLowerCase() === n.toLocaleLowerCase(),
	);
	return clash ? t('A text style named “{0}” already exists.', clash.name) : null;
}

const ids = (clips: readonly Clip[]) => clips.map((c) => c.id);

/** New style from the primary clip, linked to every selected text clip (one transaction). */
export function createFromSelectionCommands(primary: Clip, clips: readonly Clip[], name: string): Command[] {
	const text = clips.filter(isTextClip);
	return [
		{ type: 'textStyle.create', name, fromClipId: primary.id, ref: '$style' } as Command,
		{ type: 'textStyle.apply', styleId: '$style', clipIds: ids(text) } as Command,
	];
}

export const applyCommands = (styleId: string, clips: readonly Clip[]): Command[] => [
	{ type: 'textStyle.apply', styleId, clipIds: ids(clips.filter(isTextClip)) } as Command,
];

export const detachCommands = (clips: readonly Clip[]): Command[] => [
	{ type: 'textStyle.detach', clipIds: ids(clips) } as Command,
];

export const resetCommands = (clips: readonly Clip[]): Command[] => [
	{ type: 'textStyle.reset', clipIds: ids(clips) } as Command,
];

/** Redefine the style as this clip's look: every other linked clip follows (Premiere "Push to style"). */
export const redefineCommands = (styleId: string, clip: Clip): Command[] => [
	{ type: 'textStyle.update', styleId, fromClipId: clip.id } as Command,
];

export const renameCommands = (styleId: string, name: string): Command[] => [
	{ type: 'textStyle.rename', styleId, name } as Command,
];

export const deleteCommands = (styleId: string): Command[] => [{ type: 'textStyle.delete', styleId } as Command];

/**
 * Select ▸ Same Style: the text clips of the sequence linked to the primary clip's style, or — when it is not linked —
 * every text clip whose effective style equals its style. Clips on locked tracks are left out (like Select All).
 */
export function sameStyleClipIds(doc: ProjectDocument, seq: Sequence, primary: Clip | null): string[] {
	if (!primary || primary.kind !== 'text') return [];
	const locked = new Set(
		[...seq.videoTracks, ...seq.audioTracks, ...seq.captionTracks].filter((t) => t.locked).map((t) => t.id),
	);
	const style = linkedTextStyle(doc, primary);
	return Object.values(seq.clips)
		.filter((c): c is TextClip => c.kind === 'text' && !locked.has(c.trackId))
		.filter((c) =>
			style ? linkedTextStyle(doc, c)?.id === style.id : sameValue(c.content.style, primary.content.style),
		)
		.sort((a, b) => a.start - b.start)
		.map((c) => c.id);
}
