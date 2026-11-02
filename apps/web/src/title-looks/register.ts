// Web registrations of Title Looks, loaded once by commands/index.ts: the Apply Look dialog, the Program outline and handles
// of the selected layer (TL-092), and the chip that names a preview (TL-088).
import { registerDialog } from '@jasper/ui';
import { createElement } from 'react';
import { programOverlays } from '../extensions/index.ts';
import { APPLY_LOOK_DIALOG, ApplyLookDialog } from './ApplyLookDialog.tsx';
import { LookLayerOverlay } from './LayerOverlay.tsx';
import { LookPreviewChip } from './PreviewChip.tsx';

registerDialog(APPLY_LOOK_DIALOG, (props) => createElement(ApplyLookDialog, props as never));

programOverlays.register({
	id: 'title-look-layer',
	active: (session) => !!session.getState().activeSequenceId,
	component: LookLayerOverlay,
	order: 72,
});
programOverlays.register({
	id: 'title-look-preview',
	active: (session) => !!session.getState().activeSequenceId,
	component: LookPreviewChip,
	order: 92,
});
