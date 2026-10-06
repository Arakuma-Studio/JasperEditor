// Web registrations of the fx framework (wave 1), loaded once by commands/index.ts: the Program-monitor overlay with
// the on-canvas handles of point params (`ui.control: 'point'`) of the effect focused in Effect Controls, and those
// of the selected transition (Center…, wave-4 transition polish).
import { programOverlays } from '../extensions/index.ts';
import { FxPointOverlay } from './PointOverlay.tsx';
import { TransitionPointOverlay } from './TransitionPointOverlay.tsx';

programOverlays.register({
	id: 'fx-points',
	active: (session) => !!session.getState().activeSequenceId,
	component: FxPointOverlay,
	order: 70,
});

programOverlays.register({
	id: 'transition-points',
	active: (session) => {
		const s = session.getState();
		return !!s.activeSequenceId && s.selection.timeline.transitions.length > 0;
	},
	component: TransitionPointOverlay,
	order: 71,
});
