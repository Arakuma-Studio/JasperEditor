// M2 UI commands for shapes (S11:SHP-006, FIX-007): Graphics ▸ New Layer ▸ Rectangle / Ellipse
// (`graphics.newRectangle` / `graphics.newEllipse`, default keys Ctrl+Alt+R / Ctrl+Alt+E from the keymap) insert a
// default 400×400 shape at the playhead on the targeted video track; `tool.rectangle` / `tool.ellipse` select the
// Program monitor shape tools (XF-061; no default keys, S05:TOOL-002). Owner: wp-m2-shapes. This module is imported
// at start-up (commands/index.ts), so it also registers the package's UI extensions: Properties ▸ Shape, the
// Program monitor shape-tool overlay and Edit ▸ Preferences ▸ Graphics ("Resize shapes by size", SHP-007).
import type { LegacyShapeType } from '@jasper/project';
import { clipSections, programOverlays } from '../extensions/index.ts';
import { TOOLS } from '../panels/timeline/model/tools.ts';
import { addShapeAt, SHAPE_LABELS } from '../shapes/insert.ts';
import { GraphicsPreferencesPage } from '../shapes/PreferencesPage.tsx';
import { isShapeSelection, ShapeSection } from '../shapes/ShapeSection.tsx';
import { ShapeToolOverlay } from '../shapes/ShapeToolOverlay.tsx';
import { VectorPathOverlay } from '../shapes/VectorPathOverlay.tsx';
import { isVectorShapeSelection, VectorShapeSection } from '../shapes/VectorShapeSection.tsx';
import { registerPreferencesPage } from '../shell/preferences/index.ts';
import type { CommandCtx, UiCommand } from './types.ts';
import type { Command } from '@jasper/project';

const hasSequence = (ctx: CommandCtx) => !!ctx.session?.getState().activeSequenceId;

function newShape(id: string, type: LegacyShapeType): UiCommand {
	return {
		id,
		label: SHAPE_LABELS[type],
		description: `Add a 5 s ${SHAPE_LABELS[type].toLowerCase()} (400×400, white) at the playhead, centred in the frame, on the targeted video track.`,
		icon: type === 'rect' ? 'tool.rectangle' : 'tool.ellipse',
		scope: 'global',
		agentExposed: true,
		when: hasSequence,
		disabledReason: (ctx) => (hasSequence(ctx) ? undefined : 'Open a sequence first'),
		run: (ctx) => {
			const session = ctx.session;
			if (!session) return;
			if (!addShapeAt(session, type, session.transport.getState().frame))
				ctx.ui.toast({ kind: 'error', message: `Could not add the ${SHAPE_LABELS[type].toLowerCase()}` });
		},
	};
}

function toolCommand(tool: 'rectangle' | 'ellipse' | 'polygon' | 'star'): UiCommand {
	return {
		id: `tool.${tool}`,
		label: TOOLS[tool].label,
		description:
			tool === 'polygon' || tool === 'star'
				? 'Drag in the Program monitor from the centre outwards to draw it (Shift keeps it upright); with a vector shape selected it is added to that shape.'
				: 'Drag in the Program monitor to draw it; Shift constrains, Alt draws from the centre; with a vector shape selected it is added to that shape.',
		scope: 'editing',
		agentExposed: true,
		when: (ctx) => !!ctx.session,
		checked: (ctx) => ctx.session?.getState().toggles.activeTool === tool,
		run: (ctx) => ctx.session?.setToggles({ activeTool: tool }),
	};
}

export const shapeCommands: UiCommand[] = [
	newShape('graphics.newRectangle', 'rect'),
	newShape('graphics.newEllipse', 'ellipse'),
	toolCommand('rectangle'),
	toolCommand('ellipse'),
	// wp shapes
	toolCommand('polygon'),
	toolCommand('star'),
	{
		id: 'graphics.convertToVector',
		label: 'Convert to Vector Shape',
		description:
			'Turn the selected rectangles and ellipses into editable vector shapes (paths, fills and strokes you can add operators and gradients to); the picture does not change.',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => legacyShapeSelection(ctx).length > 0,
		disabledReason: (ctx) => (legacyShapeSelection(ctx).length ? undefined : 'Select a rectangle or ellipse'),
		run: (ctx) => {
			const ids = legacyShapeSelection(ctx);
			if (!ids.length || !ctx.session) return;
			const r = ctx.session.apply({
				label: 'Convert to Vector Shape',
				origin: 'user',
				commands: ids.map((clipId) => ({ type: 'shape.convertToVector', clipId }) as Command),
			});
			if (!r.ok) ctx.ui.toast({ kind: 'error', message: r.errors[0]?.message ?? 'Could not convert' });
		},
	},
];

function legacyShapeSelection(ctx: CommandCtx): string[] {
	const s = ctx.session?.getState();
	if (!s?.activeSequenceId) return [];
	const seq = (s.transient ?? s.document).sequences[s.activeSequenceId];
	return s.selection.timeline.clips.filter((id) => {
		const c = seq?.clips[id];
		return c?.kind === 'shape' && c.shape.type !== 'vector';
	});
}

clipSections.register({
	id: 'shape',
	title: 'Shape',
	appliesTo: isShapeSelection,
	component: ShapeSection,
	defaultOpen: true,
	order: 5,
});

programOverlays.register({ id: 'shape-tools', active: () => true, component: ShapeToolOverlay, order: 90 });

// wp shapes: Properties ▸ Shape Contents (vector shapes) and the monitor's vertex editing / Pen tool.
clipSections.register({
	id: 'vector-shape',
	title: 'Shape Contents',
	appliesTo: isVectorShapeSelection,
	component: VectorShapeSection,
	defaultOpen: true,
	order: 5,
});
programOverlays.register({ id: 'vector-paths', active: () => true, component: VectorPathOverlay, order: 85 });

registerPreferencesPage({ id: 'graphics', title: 'Graphics', order: 30, component: GraphicsPreferencesPage });
