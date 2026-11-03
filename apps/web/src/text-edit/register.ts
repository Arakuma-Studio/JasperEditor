// Spec 19 TL-085: direct text entry on the Program monitor: the overlay and the plain-text double-click handler.
import type { ResolvedLayer } from '@jasper/project';
import {
	type LayerDoubleClickContext,
	layerDoubleClickHandlers,
	programOverlays,
} from '../extensions/index.ts';
import { t } from '../i18n/runtime.ts';
import { activeSequence } from '../panels/program/edits.ts';
import { pointInQuad } from '../panels/program/transform-math.ts';
import { hitsLayerGeometry, layerEditQuad, layerHitSlop } from '../shapes/geometry.ts';
import { showTemplateEditMessage } from '../template-edit/store.ts';
import { beginTextEntry } from './begin.ts';
import { TextEntryHost } from './TextEntryEditor.tsx';

const HIT_SCREEN_PX = 4;

/** The layer drawn on top at `p`, locked tracks included: the handler explains what it cannot edit. */
function topLayerAt(ctx: LayerDoubleClickContext): ResolvedLayer | null {
	const scene = ctx.scene ?? [];
	for (let i = scene.length - 1; i >= 0; i--) {
		const l = scene[i]!;
		if (!l.props.transform || !(l.props.opacity > 0)) continue;
		const slop = layerHitSlop(l, ctx.viewScale ?? 1, HIT_SCREEN_PX);
		if (pointInQuad(ctx.point, layerEditQuad(l, slop)) && hitsLayerGeometry(l, ctx.point, slop)) return l;
	}
	return null;
}

/** Double-click on the Program monitor: edits the text clip under the pointer in place. */
export function textDoubleClick(ctx: LayerDoubleClickContext): boolean {
	const { session, point, frame, client } = ctx;
	if (ctx.clip?.kind === 'text')
		return beginTextEntry(session, { point, frame, clipId: ctx.clip.id, client: client ?? null });
	if (ctx.clip) return false;
	const top = topLayerAt(ctx);
	const seq = activeSequence(session);
	const clip = top && seq ? seq.clips[top.clip.clipId] : undefined;
	if (clip?.kind !== 'text') return false;
	if (seq?.videoTracks.find((tr) => tr.id === clip.trackId)?.locked) {
		showTemplateEditMessage(session, t('The clip’s track is locked'), point);
		return true;
	}
	return false;
}

programOverlays.register({
	id: 'text-entry',
	label: 'Text entry',
	active: () => true,
	component: TextEntryHost,
	order: 7,
});

// After a template text (`template-text`, order 50), before the composition text editor (`mg-text`, order 100).
layerDoubleClickHandlers.register({
	id: 'text-entry',
	order: 60,
	anyPoint: true,
	run: textDoubleClick,
});
