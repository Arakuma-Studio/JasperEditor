// Web registrations of the fx framework (wave 1), loaded once by commands/index.ts: the Program-monitor overlay with
// the on-canvas handles of point params (`ui.control: 'point'`) of the effect focused in Effect Controls.
import { programOverlays } from '../extensions/index.ts';
import { FxPointOverlay } from './PointOverlay.tsx';

programOverlays.register({
	id: 'fx-points',
	active: (session) => !!session.getState().activeSequenceId,
	component: FxPointOverlay,
	order: 70,
});
