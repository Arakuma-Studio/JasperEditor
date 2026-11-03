// Web registrations of Title Looks, loaded once by commands/index.ts: the Apply Look dialog, the Program outline and handles
// of the selected layer (TL-092), the chip that names a preview (TL-088), and the preset chips of each standalone
// generator effect in Effect Controls (TL-063).
import { TITLE_GENERATORS } from '@jasper/project';
import { registerDialog } from '@jasper/ui';
import { createElement } from 'react';
import { effectEditors, programOverlays } from '../extensions/index.ts';
import { GENERATOR_EFFECT_PREFIX } from '../panels/effects/drag.ts';
import { APPLY_LOOK_DIALOG, ApplyLookDialog } from './ApplyLookDialog.tsx';
import { GeneratorEffectPresets } from './GeneratorPresets.tsx';
import { LookLayerOverlay } from './LayerOverlay.tsx';
import { LookPreviewChip } from './PreviewChip.tsx';

registerDialog(APPLY_LOOK_DIALOG, (props) => createElement(ApplyLookDialog, props as never));

programOverlays.register({
	id: 'title-look-layer',
	label: 'Look layer outline',
	active: (session) => !!session.getState().activeSequenceId,
	component: LookLayerOverlay,
	order: 72,
});
programOverlays.register({
	id: 'title-look-preview',
	label: 'Look preview',
	active: (session) => !!session.getState().activeSequenceId,
	component: LookPreviewChip,
	order: 92,
});
for (const g of TITLE_GENERATORS)
	if (g.presets?.length)
		effectEditors.register({
			id: `generator-presets.${g.id}`,
			effectId: `${GENERATOR_EFFECT_PREFIX}${g.id}`,
			component: GeneratorEffectPresets,
		});
