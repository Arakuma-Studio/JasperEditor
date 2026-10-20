import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

const strokeAnimation: PanelDefinition = {
	kind: 'strokeAnimation',
	title: () => 'Stroke Animation',
	icon: 'panel.strokeAnimation',
	instance: 'single',
	minSize: { w: 120, h: 160 },
	keymapScope: 'strokeAnimation',
	touch: 'sheet',
	dockWith: 'essentialGraphics',
	agentDescription:
		'Stroke Animation: one-click Trim Paths animations for the selected shape clips (Draw In / Out / In and Out, Grow from / Shrink to Middle, Divide In / Out; Alt = reverse, Shift = animate offset), Reverse Path Direction, Add Horizontal / Vertical Line, tracers that follow the moving tip, and the settings they use.',
	component: lazyPanel(() => import('./StrokeAnimationPanel.tsx'), 'StrokeAnimationPanel'),
};
export default strokeAnimation;
