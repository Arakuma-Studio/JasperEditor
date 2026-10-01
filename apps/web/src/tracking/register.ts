// Registers the tracking UI into the M2 extension points (ARCHITECTURE §19.10): the Properties ▸ Tracking section,
// the Program overlay (tracker + corner-pin handles), the corner-pin Effect Controls editor, timeline clip menu
// entries and the "Apply Tracking" dialog. Called once at start-up from commands/tracking.ts.
import { type Clip, type ClipTracker, CORNER_PIN_EFFECT_ID, type VideoClip } from '@jasper/project';
import { openDialog, registerDialog } from '@jasper/ui';
import {
	clipMenuExtensions,
	clipSections,
	effectEditors,
	type MenuItemSpec,
	programOverlays,
} from '../extensions/index.ts';
import { ApplyTrackingDialog } from './ApplyTrackingDialog.tsx';
import { activeSeq, addTracker, applyCandidates } from './actions.ts';
import { CornerPinEditor } from './CornerPinEditor.tsx';
import { setActiveTracker } from './store.ts';
import { TrackingOverlay } from './TrackingOverlay.tsx';
import { APPLY_DIALOG, TrackingSection } from './TrackingSection.tsx';

let registered = false;

export function registerTrackingUi(): void {
	if (registered) return;
	registered = true;
	clipSections.register({
		id: 'tracking',
		title: 'Tracking',
		appliesTo: (clips) => clips.length === 1 && clips[0]!.kind === 'video',
		component: TrackingSection,
		defaultOpen: true,
		order: 60,
	});
	programOverlays.register({
		id: 'tracking',
		active: (session) => !!session.getState().activeSequenceId,
		component: TrackingOverlay,
		order: 60,
	});
	effectEditors.register({
		id: 'tracking.corner-pin',
		effectId: CORNER_PIN_EFFECT_ID,
		component: CornerPinEditor,
	});
	registerDialog(APPLY_DIALOG, ApplyTrackingDialog);
	clipMenuExtensions.register({
		id: 'tracking',
		order: 60,
		items: ({ session, clip }) => {
			const items: MenuItemSpec[] = [];
			const readOnly = session.getState().readOnly;
			if (clip.kind === 'video') {
				const add = (kind: 'planar' | 'point') => () => {
					session.select('timeline', [clip.id], 'replace', { linked: false });
					addTracker(session, clip.id, kind);
				};
				items.push({
					kind: 'submenu',
					label: 'Track',
					items: [
						{
							kind: 'item',
							label: 'Track Screen… (Add Planar Tracker)',
							disabled: readOnly,
							run: add('planar'),
						},
						{ kind: 'item', label: 'Add Point Tracker', disabled: readOnly, run: add('point') },
					],
				});
			}
			const plates = platesBelow(session, clip);
			if (plates.length) {
				items.push({
					kind: 'submenu',
					label: 'Apply Tracking',
					items: plates.map(({ plate, tracker }) => ({
						kind: 'item' as const,
						label: `${tracker.name} (${plate.name || 'plate'})…`,
						disabled: readOnly,
						run: () => {
							setActiveTracker(tracker.id);
							void openDialog(APPLY_DIALOG, { session, trackerId: tracker.id, targetClipId: clip.id });
						},
					})),
				});
			}
			return items;
		},
	});
}

/** Trackers of video clips below `clip` that it overlaps (it could follow them). */
export function platesBelow(
	session: Parameters<typeof activeSeq>[0],
	clip: Clip,
): { plate: VideoClip; tracker: ClipTracker }[] {
	const seq = activeSeq(session);
	if (!seq || !('transform' in clip)) return [];
	const out: { plate: VideoClip; tracker: ClipTracker }[] = [];
	for (const c of Object.values(seq.clips)) {
		if (c.kind !== 'video' || c.id === clip.id) continue;
		const v = c as VideoClip;
		if (!v.trackers?.length) continue;
		if (!applyCandidates(seq, v).some((x) => x.id === clip.id)) continue;
		for (const t of v.trackers) out.push({ plate: v, tracker: t });
	}
	return out;
}
