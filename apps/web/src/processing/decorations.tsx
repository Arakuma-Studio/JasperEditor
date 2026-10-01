// "Processed" badges (S07:PRC-004, PRU-003) on timeline clips and Project panel items whose media is a
// processed version, and the recipe as their tooltip.
//
// The timeline (panels/timeline/**, owned by wp-m2-transitions) and the Project panel have no per-clip / per-item
// badge extension point yet, so this package decorates them without editing their files: a stylesheet keyed by
// the `data-clip-id` / `data-item-id` attributes those panels already render draws the badge as a pseudo-element,
// and a delegated `pointerover` listener sets the `title` (recipe) of the hovered element. The host component is
// mounted through the one always-rendered, session-aware extension host (`programOverlays`, rendering nothing
// visible). A dedicated `clipBadges` / `projectItemBadges` registry would replace this when the owners add one.
import type { MediaAsset, ProjectDocument } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { useEffect, useRef } from 'react';
import { isProcessed, processedTooltip } from './model.ts';

const STYLE_ATTR = 'data-jasper-processed-badges';
const TITLE_ATTR = 'data-jasper-processed-title';

/** Ids of timeline clips and Project items that use a processed version. */
export function processedTargets(doc: ProjectDocument): { clipIds: string[]; itemIds: string[] } {
	const clipIds: string[] = [];
	const itemIds: string[] = [];
	for (const seq of Object.values(doc.sequences))
		for (const c of Object.values(seq.clips) as { id: string; kind: string; mediaId?: string }[])
			if (c.kind === 'video' && c.mediaId && isProcessed(doc.media[c.mediaId] as MediaAsset | undefined))
				clipIds.push(c.id);
	for (const it of Object.values(doc.items) as { id: string; kind: string; mediaId?: string }[])
		if (it.kind === 'media' && it.mediaId && isProcessed(doc.media[it.mediaId] as MediaAsset | undefined))
			itemIds.push(it.id);
	return { clipIds, itemIds };
}

const esc = (id: string) => id.replace(/["\\]/g, '\\$&');

const CHIP =
	'position: absolute; z-index: 1; pointer-events: none; height: 12px; padding: 0 3px; border-radius: 2px; ' +
	'font: 600 9px/12px var(--pr-font-ui); letter-spacing: 0.04em; text-transform: uppercase; white-space: nowrap; ' +
	'color: var(--pr-accent); background: var(--pr-menu-bg); box-shadow: 0 0 0 1px var(--pr-border-subtle);';

/** The stylesheet drawing the badges (empty when nothing is processed). */
export function processedBadgeCss(t: { clipIds: readonly string[]; itemIds: readonly string[] }): string {
	const out: string[] = [];
	if (t.clipIds.length) {
		const clip = t.clipIds.map((id) => `[data-testid="timeline-track-area"] div[data-clip-id="${esc(id)}"]`);
		out.push(`${clip.join(',\n')} { container-type: inline-size; }`);
		const after = clip.map((s) => `${s}::after`).join(',\n');
		out.push(`${after} { ${CHIP} content: none; left: 3px; bottom: 3px; }`);
		out.push(`@container (min-width: 48px) { ${after} { content: "Proc"; } }`);
		out.push(`@container (min-width: 110px) { ${after} { content: "Processed"; } }`);
	}
	if (t.itemIds.length) {
		const row = t.itemIds
			.map((id) => `[data-testid="project-row"][data-item-id="${esc(id)}"] > td:nth-child(2) > div::after`)
			.join(',\n');
		out.push(`${row} { ${CHIP} position: static; flex-shrink: 0; margin-left: 4px; content: "Processed"; }`);
		const tile = t.itemIds
			.map((id) => `[data-testid="project-tile"][data-item-id="${esc(id)}"] > div:first-child::after`)
			.join(',\n');
		out.push(`${tile} { ${CHIP} left: 4px; top: 4px; content: "Processed"; }`);
	}
	return out.join('\n');
}

/** Tooltip for a hovered timeline clip / Project item element (null when it is not a processed version). */
export function tooltipFor(doc: ProjectDocument, el: Element): string | null {
	const clipId = el.getAttribute('data-clip-id');
	if (clipId) {
		for (const seq of Object.values(doc.sequences)) {
			const c = seq.clips[clipId] as { mediaId?: string } | undefined;
			if (c) return c.mediaId ? processedTooltip(doc, c.mediaId) : null;
		}
		return null;
	}
	const itemId = el.getAttribute('data-item-id');
	const it = itemId ? (doc.items[itemId] as { kind: string; mediaId?: string } | undefined) : undefined;
	return it?.kind === 'media' && it.mediaId ? processedTooltip(doc, it.mediaId) : null;
}

/** Keeps the badge stylesheet and tooltips in sync with the session's document. Renders nothing. */
export function ProcessedDecorations({ session }: { session: EditorSession }) {
	const doc = useStoreSelector(session.store, (s) => s.document) as ProjectDocument;
	const docRef = useRef(doc);
	docRef.current = doc;
	const styleRef = useRef<HTMLStyleElement | null>(null);

	useEffect(() => {
		if (typeof document === 'undefined') return;
		const el = document.createElement('style');
		el.setAttribute(STYLE_ATTR, '');
		document.head.appendChild(el);
		styleRef.current = el;
		el.textContent = processedBadgeCss(processedTargets(docRef.current));
		const onOver = (e: Event) => {
			const target = (e.target as Element | null)?.closest?.(
				'[data-testid="timeline-track-area"] div[data-clip-id], [data-testid="project-row"][data-item-id], [data-testid="project-tile"][data-item-id]',
			);
			if (!target) return;
			const tip = tooltipFor(docRef.current, target);
			if (tip) {
				target.setAttribute('title', tip);
				target.setAttribute(TITLE_ATTR, '');
			} else if (target.hasAttribute(TITLE_ATTR)) {
				target.removeAttribute('title');
				target.removeAttribute(TITLE_ATTR);
			}
		};
		document.addEventListener('pointerover', onOver, true);
		return () => {
			document.removeEventListener('pointerover', onOver, true);
			el.remove();
			styleRef.current = null;
		};
	}, []);

	useEffect(() => {
		if (styleRef.current) styleRef.current.textContent = processedBadgeCss(processedTargets(doc));
	}, [doc]);

	return null;
}
