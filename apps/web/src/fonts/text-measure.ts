// spec 13 SH-004 (docs/wp-notes/text-render.md): the editor session's text measurer. Text boxes are laid out in
// this page with the faces the Program monitor draws them with (the engine font catalog, resolved like
// `render-doc.ts`), so a box follows the glyph metrics of the font the text renders in. While the catalog is not
// known yet the measurer waits (the clips keep an estimate, `layoutPending`); when it arrives, or when a font is
// installed or removed, the session measures the affected text again (system transactions, no History entries).
import { resolveCatalogFont } from '@jasper/api';
import { createDomTextMeasurer, type DomTextMeasurer } from '@jasper/compositions';
import type { ProjectDocument } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { type FontsState, fontsStore } from './store.ts';

/** `hosted` = an engine serves the fonts: until its catalog is known, measurements wait. */
export function editorTextMeasurer(hosted: boolean): DomTextMeasurer {
	return createDomTextMeasurer((font, weight, italic) => {
		const st = fontsStore().getState();
		if (hosted && (st.status === 'offline' || st.status === 'loading')) return 'pending';
		return resolveCatalogFont(st.catalog, font.family, weight, italic)?.file.url ?? null;
	});
}

/** Text clips whose faces resolve to other files in `next` than in `prev` (a font was installed or removed). */
export function clipsWithChangedFaces(doc: ProjectDocument, prev: FontsState, next: FontsState): string[] {
	const url = (st: FontsState, family: string, weight: number, italic: boolean) =>
		resolveCatalogFont(st.catalog, family, weight, italic)?.file.url ?? null;
	const out: string[] = [];
	for (const seq of Object.values(doc.sequences))
		for (const c of Object.values(seq.clips)) {
			if (c.kind !== 'text' || c.box.autoSize === 'none') continue;
			const styles = [c.content.style, ...(c.content.runs ?? []).map((r) => ({ ...c.content.style, ...r.style }))];
			const changed = styles.some((s) => {
				const family = doc.fonts[s.fontId]?.family;
				return !!family && url(prev, family, s.weight, s.italic) !== url(next, family, s.weight, s.italic);
			});
			if (changed) out.push(c.id);
		}
	return out;
}

/** Keeps a session's text measured as the font catalog changes; returns the unsubscribe. */
export function followFontCatalog(session: EditorSession, measurer: DomTextMeasurer): () => void {
	let prev = fontsStore().getState();
	return fontsStore().subscribe((st) => {
		const before = prev;
		prev = st;
		if (st.status === before.status && st.catalog === before.catalog) return;
		measurer.notify();
		if (!before.catalog || !st.catalog || before.catalog === st.catalog) return;
		const ids = clipsWithChangedFaces(session.getCommitted(), before, st);
		if (ids.length)
			session.apply({ label: 'Measure Text', origin: 'system', commands: [{ type: 'text.relayout', clipIds: ids }] });
	});
}
