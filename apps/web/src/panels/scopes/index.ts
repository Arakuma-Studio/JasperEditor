import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

const scopes: PanelDefinition = {
	kind: 'scopes',
	title: () => 'Lumetri Scopes',
	icon: 'panel.scopes',
	instance: 'single',
	minSize: { w: 240, h: 200 },
	keymapScope: 'scopes',
	touch: 'hidden',
	agentDescription: 'Waveform, RGB parade and vectorscope of the Program frame or the selected clip.',
	component: lazyPanel(() => import('./ScopesPanel.tsx'), 'ScopesPanel'),
};
export default scopes;
