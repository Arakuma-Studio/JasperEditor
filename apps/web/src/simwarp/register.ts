// Web registrations of the sim-warp effects, loaded once by commands/index.ts: the Program-monitor tools of Puppet,
// Liquify and Mesh Warp (apps/web/src/simwarp/WarpOverlay.tsx).
import { programOverlays } from '../extensions/index.ts';
import { SimWarpOverlay } from './WarpOverlay.tsx';

programOverlays.register({
	id: 'sim-warp',
	active: (session) => !!session.getState().activeSequenceId,
	component: SimWarpOverlay,
	order: 72,
});
