// HTML composition pages in scene files (docs/wp-notes/scene-file.md § HTML pages): a composition layer whose
// `bundle` is an .html / .htm file names one import of that page — its render size, rate and query (`page`), since
// another query or size is another import (another media item). Pure.
import type { ProjectDocument } from '../schema/document.ts';
import type { MediaAsset } from '../schema/media.ts';
import type { ScenePage } from './format.ts';

/** True when a `bundle` names an HTML page (an .html / .htm file) rather than a Remotion folder or a media id. */
export const isScenePagePath = (bundle: string) => /\.html?$/i.test(bundle.trim());

/** The composition id an import of `pagePath` produces: the file name without its extension. */
export function scenePageCompositionId(pagePath: string): string {
	const name = pagePath.split(/[\\/]/).pop() ?? pagePath;
	return name.replace(/\.html?$/i, '');
}

/** The page import of `asset` as a scene file writes it, or null when the asset is no HTML page. */
export function scenePageOf(asset: MediaAsset | undefined, compositionId?: string): ScenePage | null {
	const b = asset?.kind === 'mg-bundle' ? asset.mgBundle : undefined;
	const html = b?.html as { query?: unknown } | undefined;
	if (!b || !html || b.source.type !== 'html-page') return null;
	const comp = b.compositions.find((c) => c.id === compositionId) ?? b.compositions[0];
	if (!comp) return null;
	const query = typeof html.query === 'string' ? html.query : '';
	return { width: comp.width, height: comp.height, fps: comp.fps, ...(query ? { query } : {}) };
}

/** The import of the page at `absPath` (normalised by the caller) with exactly this size, rate and query, or null. */
export function findScenePage(
	doc: Pick<ProjectDocument, 'media'>,
	absPath: string,
	page: ScenePage,
	samePath: (stored: string) => boolean = (stored) => stored === absPath,
): string | null {
	for (const m of Object.values(doc.media)) {
		const p = scenePageOf(m);
		const stored = m.mgBundle?.source.path;
		if (!p || !stored || !samePath(stored)) continue;
		if (
			p.width === page.width &&
			p.height === page.height &&
			Math.abs(p.fps - page.fps) < 1e-6 &&
			(p.query ?? '') === (page.query ?? '')
		)
			return m.id;
	}
	return null;
}
