import type { Sequence } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { openDialog } from '@jasper/ui';
import { clampHeight, trackHeight } from '../panels/timeline/model/layout.ts';
import type { ContextMenuItem } from '../panels/timeline/state/ui-store.ts';
import { MANAGE_HEIGHT_PRESETS_DIALOG, promptName, registerSmallDialogs } from './SmallDialogs.tsx';
import { presetHeights, TRACK_HEIGHT_SIZES, trackHeightPresets } from './track-heights.ts';

function active(session: EditorSession): Sequence | null {
	const id = session.getState().activeSequenceId;
	return id ? ((session.getCommitted().sequences[id] as Sequence | undefined) ?? null) : null;
}

function setAll(session: EditorSession, fn: (h: number) => number): void {
	const seq = active(session);
	if (!seq) return;
	const view = session.getState().views[seq.id];
	const cur = view?.trackHeights ?? {};
	const next = { ...cur };
	for (const t of seq.videoTracks) next[t.id] = clampHeight(fn(trackHeight(cur, t.id, 'video')));
	for (const t of seq.audioTracks) next[t.id] = clampHeight(fn(trackHeight(cur, t.id, 'audio')));
	session.setView(seq.id, { trackHeights: next });
}

/** Entries appended to the Timeline Display Settings menu. */
export function trackHeightDisplayMenu(session: EditorSession): ContextMenuItem[] {
	const seq = active(session);
	const presets = trackHeightPresets.list();
	const items: ContextMenuItem[] = [
		{
			kind: 'item',
			label: 'Expand All Tracks',
			shortcut: 'Shift+=',
			disabled: !seq,
			run: () => setAll(session, (h) => Math.max(h, 72)),
		},
		{
			kind: 'item',
			label: 'Minimize All Tracks',
			shortcut: 'Shift+-',
			disabled: !seq,
			run: () => setAll(session, () => 20),
		},
		{ kind: 'separator' },
		...presets.map(
			(p, i): ContextMenuItem => ({
				kind: 'item',
				label: `${i + 1}. ${p.name}`,
				disabled: !seq,
				run: () => {
					const s = active(session);
					if (!s) return;
					const cur = session.getState().views[s.id]?.trackHeights ?? {};
					session.setView(s.id, { trackHeights: presetHeights(p, s, cur) });
				},
			}),
		),
		{
			kind: 'item',
			label: 'Save Preset…',
			disabled: !seq,
			run: async () => {
				const s = active(session);
				if (!s) return;
				const cur = session.getState().views[s.id]?.trackHeights ?? {};
				const name = await promptName({
					title: 'Save Track Height Preset',
					label: 'Preset Name',
					initial: `Preset ${presets.length + 1}`,
					maxLength: 60,
				});
				if (!name) return;
				trackHeightPresets.save(
					name,
					s.videoTracks.map((t) => trackHeight(cur, t.id, 'video')),
					s.audioTracks.map((t) => trackHeight(cur, t.id, 'audio')),
				);
			},
		},
		{
			kind: 'item',
			label: 'Manage Presets…',
			run: () => {
				registerSmallDialogs();
				void openDialog(MANAGE_HEIGHT_PRESETS_DIALOG, {});
			},
		},
	];
	return items;
}

/** Track header ▸ Track Height ▸ (one track). */
export function trackHeightSubmenu(
	session: EditorSession,
	seq: Sequence,
	trackId: string,
	kind: 'video' | 'audio',
): ContextMenuItem {
	const cur = session.getState().views[seq.id]?.trackHeights ?? {};
	const h = trackHeight(cur, trackId, kind);
	return {
		kind: 'submenu',
		label: 'Track Height',
		items: TRACK_HEIGHT_SIZES.map((s) => ({
			kind: 'item' as const,
			label: s.label,
			checked: h === s.px,
			run: () => session.setView(seq.id, { trackHeights: { ...cur, [trackId]: s.px } }),
		})),
	};
}
