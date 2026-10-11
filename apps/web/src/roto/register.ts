import type { Clip, ClipRoto } from '@jasper/project';
import { clipMenuExtensions, clipSections, type MenuItemSpec, programOverlays } from '../extensions/index.ts';
import { registerPreferencesDialog, registerPreferencesPage } from '../shell/preferences/index.ts';
import { rotoEngine, trackFaces } from './actions.ts';
import { RotoPreferencesPage } from './PreferencesPage.tsx';
import { RotoOverlay } from './RotoOverlay.tsx';
import { RotoSection } from './RotoSection.tsx';
import { rotoUi } from './store.ts';

let registered = false;

const isPicture = (c: Clip) => c.kind === 'video' || c.kind === 'still';

export function registerRotoUi(): void {
	if (registered) return;
	registered = true;
	clipSections.register({
		id: 'roto',
		title: 'Roto',
		appliesTo: (clips) => clips.length === 1 && isPicture(clips[0]!),
		component: RotoSection,
		defaultOpen: false,
		order: 62,
	});
	programOverlays.register({
		id: 'roto',
		active: (session) => !!session.getState().activeSequenceId,
		component: RotoOverlay,
		order: 62,
	});
	registerPreferencesDialog();
	registerPreferencesPage({
		id: 'roto',
		title: 'Roto & Face Tracking',
		order: 56,
		component: RotoPreferencesPage,
	});
	clipMenuExtensions.register({
		id: 'roto',
		order: 62,
		items: ({ session, clip }) => {
			if (!isPicture(clip)) return [];
			const readOnly = session.getState().readOnly;
			const rotos = ((clip as { rotos?: ClipRoto[] }).rotos ?? []) as ClipRoto[];
			const select = () => session.select('timeline', [clip.id], 'replace', { linked: false });
			const items: MenuItemSpec[] = [
				{
					kind: 'item',
					label: 'Roto Brush',
					disabled: readOnly,
					run: () => {
						select();
						rotoUi.set({ tool: true, activeRotoId: rotos[0]?.id ?? null });
					},
				},
				{
					kind: 'item',
					label: 'New Roto Object',
					disabled: readOnly,
					run: () => {
						select();
						rotoUi.set({ tool: true, activeRotoId: null });
					},
				},
				{
					kind: 'item',
					label: 'Track Faces',
					disabled: readOnly || !rotoEngine(),
					run: () => {
						select();
						const e = rotoEngine();
						if (e) void trackFaces(session, e, clip.id, false);
					},
				},
				{
					kind: 'item',
					label: 'Blur Faces',
					disabled: readOnly || !rotoEngine(),
					run: () => {
						select();
						const e = rotoEngine();
						if (e) void trackFaces(session, e, clip.id, true);
					},
				},
			];
			return [{ kind: 'submenu', label: 'Roto', items }];
		},
	});
}
