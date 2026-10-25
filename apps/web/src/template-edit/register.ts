// Program-monitor text editing of anime templates (WP7b canvas-edit): the double-click handler that finds the
// template text under the pointer and the overlay that edits it. Generic: any anime template whose implementation
// marks its text elements with `editableParamProps` (`data-template-param`) gets it.
import { isAnimeTemplate, mgRegistry } from '@jasper/mg-templates';
import type { ResolvedLayer } from '@jasper/project';
import {
	type LayerDoubleClickContext,
	layerDoubleClickHandlers,
	programOverlays,
} from '../extensions/index.ts';
import { t } from '../i18n/runtime.ts';
import { activeSequence } from '../panels/program/edits.ts';
import { pickTemplateParam } from './hit.ts';
import { type LayerMeasurement, measureTemplateLayer, templateLayerRoot } from './measure.ts';
import { showTemplateEditMessage, startTemplateTextEdit } from './store.ts';
import { TemplateTextEditorHost } from './TemplateTextEditor.tsx';

/** Whether a drawn layer is an installed anime template. */
export function isAnimeTemplateLayer(l: ResolvedLayer): boolean {
	const src = l.clip.source;
	if (!('mg' in src) || !src.mg) return false;
	const def = mgRegistry.getDefinition(src.mg.template.id, src.mg.template.version);
	return !!def && isAnimeTemplate(def);
}

/**
 * Double-click on the Program monitor: opens the in-place editor on the template text under the pointer (true), or
 * explains why it cannot (read-only project, locked track; true), or leaves the double-click to other handlers.
 */
export function templateTextDoubleClick(ctx: LayerDoubleClickContext): boolean {
	const { session, point, scene, surface } = ctx;
	if (!scene || !surface) return false;
	const scope = surface
		.closest('[data-testid="program-viewport"]')
		?.querySelector<HTMLElement>('[data-testid="program-player-wrapper"]');
	if (!scope) return false;
	const st = session.getState();
	const seq = activeSequence(session);
	if (!seq) return false;
	const measured = new Map<string, LayerMeasurement | null>();
	const measure = (l: ResolvedLayer) => {
		const id = l.clip.clipId;
		if (!measured.has(id)) {
			const root = templateLayerRoot(scope, id);
			let m: LayerMeasurement | null = null;
			try {
				m = root ? measureTemplateLayer(root, l.props.box) : null;
			} catch (e) {
				// A template DOM that cannot be measured is treated as transparent: the double-click goes on.
				console.warn('[program] measuring a template layer failed', e);
			}
			measured.set(id, m);
		}
		return measured.get(id) ?? null;
	};
	const hit = pickTemplateParam(scene, point, {
		viewScale: ctx.viewScale ?? 1,
		selected: new Set(st.selection.timeline.clips),
		locked: new Set(seq.videoTracks.filter((tr) => tr.locked).map((tr) => tr.id)),
		isTemplate: isAnimeTemplateLayer,
		measure,
	});
	if (!hit) return false;
	const clipId = hit.layer.clip.clipId;
	const clip = seq.clips[clipId] as
		| {
				kind: string;
				trackId: string;
				template?: { id: string; version: number };
				params?: Record<string, unknown>;
		  }
		| undefined;
	if (clip?.kind !== 'motion-graphic' || !clip.template) return false;
	// Only string params are text (a template marking another kind is a template bug: leave it to Properties).
	const info = mgRegistry.get(clip.template.id, clip.template.version);
	const value = clip.params?.[hit.box.param] ?? info?.defaults[hit.box.param];
	if (typeof value !== 'string') return false;
	if (st.readOnly) {
		showTemplateEditMessage(session, t('The project is read-only'), point);
		return true;
	}
	if (seq.videoTracks.find((tr) => tr.id === clip.trackId)?.locked) {
		showTemplateEditMessage(session, t('The clip’s track is locked'), point);
		return true;
	}
	const same = measure(hit.layer)?.params.filter((b) => b.param === hit.box.param) ?? [];
	const ordinal = Math.max(0, same.indexOf(hit.box));
	if (!st.selection.timeline.clips.includes(clipId) || st.selection.timeline.clips.length !== 1)
		session.select('timeline', [clipId], 'replace', { primary: clipId });
	startTemplateTextEdit({
		session,
		clipId,
		param: hit.box.param,
		marks: hit.box.marks,
		ordinal,
		point: [point[0], point[1]],
		at: hit.at,
	});
	return true;
}

programOverlays.register({
	id: 'template-text-editor',
	active: () => true,
	component: TemplateTextEditorHost,
	order: 6,
});

// Before the composition text editor (`mg-text`, order 100): a template text under the pointer wins.
layerDoubleClickHandlers.register({
	id: 'template-text',
	order: 50,
	anyPoint: true,
	run: templateTextDoubleClick,
});
