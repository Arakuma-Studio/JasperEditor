import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

const essentialGraphics: PanelDefinition = {
	kind: 'essentialGraphics',
	title: () => 'Essential Graphics',
	icon: 'panel.essentialGraphics',
	instance: 'single',
	minSize: { w: 260, h: 300 },
	keymapScope: 'essentialGraphics',
	touch: 'sheet',
	agentDescription:
		'Essential Graphics: browse and add graphic templates (.jgt), and edit the selected graphic — its layers (text, shapes), New Layer, Align and Transform, Responsive Design (pins, Intro / Outro), Roll / Crawl, Export As Template.',
	component: lazyPanel(() => import('./EssentialGraphicsPanel.tsx'), 'EssentialGraphicsPanel'),
};
export default essentialGraphics;
