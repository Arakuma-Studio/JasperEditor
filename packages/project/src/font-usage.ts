// wp fonts: which fonts a document's layers draw with (Resolve Fonts, the font menus' "missing" marks, MCP
// list_fonts). Pure: walks every sequence once; unknown or malformed values are skipped, never thrown on.
import type { ProjectDocument } from './schema/document.ts';

export type FontUse = {
	/** Text and captions clips that draw with the font (style, styled runs, Source Text keys). */
	clips: number;
	/** Caption tracks whose style uses the font. */
	tracks: number;
};

type StyleLike =
	| { style?: { fontId?: unknown }; runs?: { style?: { fontId?: unknown } }[] }
	| null
	| undefined;

function contentFonts(content: StyleLike, out: Set<string>): void {
	if (!content || typeof content !== 'object') return;
	const id = content.style?.fontId;
	if (typeof id === 'string' && id) out.add(id);
	for (const r of Array.isArray(content.runs) ? content.runs : []) {
		const rid = r?.style?.fontId;
		if (typeof rid === 'string' && rid) out.add(rid);
	}
}

/** Font id → how many clips and caption tracks use it (ids missing from `doc.fonts` included, as they are). */
export function documentFontUsage(doc: ProjectDocument): Map<string, FontUse> {
	const uses = new Map<string, FontUse>();
	const bump = (id: string, key: keyof FontUse) => {
		const u = uses.get(id) ?? { clips: 0, tracks: 0 };
		u[key]++;
		uses.set(id, u);
	};
	for (const seq of Object.values(doc.sequences)) {
		for (const c of Object.values(seq.clips)) {
			const ids = new Set<string>();
			const r = c as unknown as {
				kind: string;
				content?: StyleLike;
				sourceTextKeyframes?: { value?: StyleLike }[];
				style?: { fontId?: unknown };
			};
			if (r.kind === 'text') {
				contentFonts(r.content, ids);
				for (const k of Array.isArray(r.sourceTextKeyframes) ? r.sourceTextKeyframes : [])
					contentFonts(k?.value, ids);
			} else if (r.kind === 'captions' && typeof r.style?.fontId === 'string' && r.style.fontId)
				ids.add(r.style.fontId);
			for (const id of ids) bump(id, 'clips');
		}
		for (const t of seq.captionTracks) {
			const id = t.styleDefaults?.fontId;
			if (typeof id === 'string' && id) bump(id, 'tracks');
		}
	}
	return uses;
}
