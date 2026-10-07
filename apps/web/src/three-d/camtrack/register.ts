// Registers the 3D Camera Tracker UI into the extension points (three-d): Properties ▸ 3D Camera Tracker, the Program
// monitor track-point overlay and the timeline clip menu ("Track Camera").
import type { Clip, ClipCameraTracker } from '@jasper/project';
import { clipMenuExtensions, clipSections, programOverlays } from '../../extensions/index.ts';
import { camtrackEngine, trackCamera } from './actions.ts';
import { CamTrackOverlay } from './CamTrackOverlay.tsx';
import { CamTrackSection } from './CamTrackSection.tsx';

let registered = false;

export function registerCamTrackUi(): void {
	if (registered) return;
	registered = true;
	clipSections.register({
		id: 'camera-tracker',
		title: '3D Camera Tracker',
		appliesTo: (clips) =>
			clips.length === 1 && clips[0]!.kind === 'video' && !!(clips[0] as { cameraTracker?: unknown }).cameraTracker,
		component: CamTrackSection,
		defaultOpen: true,
		order: 63,
	});
	programOverlays.register({
		id: 'camera-tracker',
		active: (session) => !!session.getState().activeSequenceId,
		component: CamTrackOverlay,
		order: 63,
	});
	clipMenuExtensions.register({
		id: 'camera-tracker',
		order: 63,
		items: ({ session, clip }) => {
			if ((clip as Clip).kind !== 'video') return [];
			const has = !!(clip as { cameraTracker?: ClipCameraTracker }).cameraTracker;
			return [
				{
					kind: 'item',
					label: has ? 'Track Camera Again' : 'Track Camera',
					disabled: session.getState().readOnly || !camtrackEngine(),
					run: () => {
						session.select('timeline', [clip.id], 'replace', { linked: false });
						const e = camtrackEngine();
						if (e) void trackCamera(session, e, clip.id);
					},
				},
			];
		},
	});
}
