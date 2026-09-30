// M2 UI commands: Track Forward/Backward, Add Tracker, Apply Tracking, corner-pin overlay. Owner: wp-m2-track (ARCHITECTURE §19.10).
// This module is imported at start-up (commands/index.ts), so it is also where the package registers its UI
// extensions (extensions/index.ts: effect editors, clip sections, Program overlays, menu entries).
//   tracking.addPlanar / addPoint          add a tracker to the selected video clip at the playhead
//   tracking.track{Forward,Backward,Both}  run the active tracker (engine `track` job, one "Track" entry)
//   tracking.step{Forward,Back}            track one frame
//   tracking.trackFromHere[Backward]       re-track from the (corrected) geometry at the playhead
//   tracking.stop                          cancel the running job
//   tracking.apply                         "Apply Tracking…" dialog
//   tracking.toggleCornerPinHandles        corner-pin handles on the Program monitor
//   tracking.removeTracker                 remove the active tracker
import type { TrackMode } from '@jasper/project';
import { openDialog } from '@jasper/ui';
import {
	addTracker,
	currentTracker,
	removeTracker,
	selectedVideoClip,
	startTrack,
	stopTrack,
	TRACK_MODE_LABEL,
} from '../tracking/actions.ts';
import { registerTrackingUi } from '../tracking/register.ts';
import { trackingStore } from '../tracking/store.ts';
import { APPLY_DIALOG } from '../tracking/TrackingSection.tsx';
import type { CommandCtx, UiCommand } from './types.ts';

registerTrackingUi();

const writable = (ctx: CommandCtx) => !!ctx.session && !ctx.session.getState().readOnly;
const current = (ctx: CommandCtx) => (ctx.session ? currentTracker(ctx.session) : null);
const isRunning = (ctx: CommandCtx) => {
	const c = current(ctx);
	return !!c && !!trackingStore.getState().running[c.tracker.id];
};

function trackCommand(id: string, mode: TrackMode, description: string): UiCommand {
	return {
		id,
		label: TRACK_MODE_LABEL[mode],
		description,
		scope: 'editing',
		capability: 'engine',
		agentExposed: false,
		when: (ctx) => writable(ctx) && !!current(ctx) && !isRunning(ctx),
		disabledReason: (ctx) =>
			!current(ctx)
				? 'Select a video clip with a tracker'
				: isRunning(ctx)
					? 'The tracker is running'
					: undefined,
		async run(ctx) {
			const c = current(ctx);
			if (!c || !ctx.session) return;
			await startTrack(ctx.session, ctx.engine, c.tracker.id, mode);
		},
	};
}

export const trackingCommands: UiCommand[] = [
	{
		id: 'tracking.addPlanar',
		label: 'Add Planar Tracker',
		description: 'Adds a four-corner (planar) tracker to the selected video clip at the playhead.',
		scope: 'editing',
		when: (ctx) => writable(ctx) && !!selectedVideoClip(ctx.session!),
		disabledReason: () => 'Select a single video clip',
		run(ctx) {
			const clip = selectedVideoClip(ctx.session!);
			if (clip) addTracker(ctx.session!, clip.id, 'planar');
		},
	},
	{
		id: 'tracking.addPoint',
		label: 'Add Point Tracker',
		description: 'Adds a point tracker to the selected video clip at the playhead.',
		scope: 'editing',
		when: (ctx) => writable(ctx) && !!selectedVideoClip(ctx.session!),
		disabledReason: () => 'Select a single video clip',
		run(ctx) {
			const clip = selectedVideoClip(ctx.session!);
			if (clip) addTracker(ctx.session!, clip.id, 'point');
		},
	},
	trackCommand(
		'tracking.trackForward',
		'forward',
		'Tracks the active tracker from its reference to the clip end.',
	),
	trackCommand(
		'tracking.trackBackward',
		'backward',
		'Tracks the active tracker from its reference to the clip start.',
	),
	trackCommand('tracking.trackBoth', 'both', 'Tracks the active tracker over the whole clip.'),
	trackCommand('tracking.stepForward', 'step-forward', 'Tracks one frame forward from the playhead.'),
	trackCommand('tracking.stepBack', 'step-back', 'Tracks one frame backward from the playhead.'),
	trackCommand(
		'tracking.trackFromHere',
		'from-here',
		'Re-tracks forward from the geometry at the playhead (after a manual correction).',
	),
	trackCommand(
		'tracking.trackFromHereBackward',
		'from-here-backward',
		'Re-tracks backward from the geometry at the playhead (after a manual correction).',
	),
	{
		id: 'tracking.stop',
		label: 'Stop Tracking',
		scope: 'editing',
		when: (ctx) => isRunning(ctx),
		async run(ctx) {
			const c = current(ctx);
			if (c) await stopTrack(ctx.engine, c.tracker.id);
		},
	},
	{
		id: 'tracking.apply',
		label: 'Apply Tracking…',
		description: 'Bakes the active tracker onto a clip above the plate (corner pin or Motion keyframes).',
		scope: 'editing',
		when: (ctx) => writable(ctx) && !!current(ctx),
		run(ctx) {
			const c = current(ctx);
			if (c) void openDialog(APPLY_DIALOG, { session: ctx.session, trackerId: c.tracker.id });
		},
	},
	{
		id: 'tracking.removeTracker',
		label: 'Remove Tracker',
		scope: 'editing',
		when: (ctx) => writable(ctx) && !!current(ctx) && !isRunning(ctx),
		run(ctx) {
			const c = current(ctx);
			if (c) removeTracker(ctx.session!, c.tracker.id);
		},
	},
	{
		id: 'tracking.toggleCornerPinHandles',
		label: 'Corner Pin Handles',
		description: 'Shows the corner-pin handles of the selected clip on the Program monitor.',
		scope: 'editing',
		checked: () => trackingStore.getState().cornerPinTool,
		run() {
			trackingStore.setState((s) => ({ cornerPinTool: !s.cornerPinTool }));
		},
	},
];
