// edit-ux context menu entries: the timeline clip menu's "Show Clip Keyframes ▸" (Premiere's clip keyframe menu:
// the property the clip's lane and rubber band show), Speed/Duration…, Make Subclip…; the Project panel item menu's
// Make Subclip… / Edit Subclip… / Open in Source Monitor for subclips.
import {
	type Clip,
	flicksPerFrame,
	isRemapped,
	type ProjectItem,
	type Sequence,
	type TimedClip,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { openDialog } from '@jasper/ui';
import { clipMenuExtensions, type MenuItemSpec, projectItemMenuExtensions } from '../extensions/index.ts';
import { assetFps, openInSource } from '../panels/source/source-state.ts';
import { laneKeyFor, laneOptions } from '../panels/timeline/model/keyframe-lane.ts';
import { isBandShown, setBandShown } from '../time/store.ts';
import { registerEditUxDialogs, SPEED_DURATION_DIALOG, SUBCLIP_DIALOG } from './dialogs.tsx';

function openSubclipDialog(
	session: EditorSession,
	itemId: string,
	range: { in: number; out: number },
	edit: boolean,
) {
	const doc = session.getCommitted();
	const it = doc.items[itemId];
	const mediaId = it && (it.kind === 'media' || it.kind === 'subclip') ? it.mediaId : null;
	const asset = mediaId ? doc.media[mediaId] : undefined;
	registerEditUxDialogs();
	void openDialog(SUBCLIP_DIALOG, {
		session,
		mode: edit ? 'edit' : 'make',
		itemId,
		range,
		fps: assetFps(asset ?? null, 30),
		...(edit && it?.kind === 'subclip' ? { name: it.name, restrictTrims: it.restrictTrims } : {}),
	});
}

/** Make Subclip from a timeline clip: its source range of the item it came from. */
function subclipFromClip(session: EditorSession, seq: Sequence, clip: Clip): void {
	const doc = session.getCommitted();
	const m = (clip as { mediaId?: string }).mediaId;
	const itemId =
		(clip.subclipId && doc.items[clip.subclipId] ? clip.subclipId : null) ??
		Object.values(doc.items).find((i) => i.kind === 'media' && i.mediaId === m)?.id;
	if (!itemId) return;
	const F = flicksPerFrame(seq.settings.frameRate);
	openSubclipDialog(
		session,
		itemId,
		{ in: clip.sourceIn, out: Math.round(clip.sourceIn + clip.duration * F * clip.speed.rate) },
		false,
	);
}

/** The keyframe display menu of a clip: None + every animatable property, grouped. */
export function keyframeMenu(session: EditorSession, seq: Sequence, clip: Clip): MenuItemSpec {
	const view = session.getState().views[seq.id];
	const current = laneKeyFor(view?.keyframeDisplay, clip);
	// Workstream `time`: Premiere's "Time Remapping ▸ Speed" entry shows the speed band (apps/web/src/time) instead
	// of a property lane; like Premiere's menu it is one choice among the others.
	const remappable = clip.kind === 'video' || clip.kind === 'nest-video';
	const set = (key: string) => {
		if (remappable) setBandShown([clip.id], false);
		session.setView(seq.id, { keyframeDisplay: { ...(view?.keyframeDisplay ?? {}), [clip.id]: key } });
	};
	const options = laneOptions(clip, session.ctx.registries);
	const groups = new Map<string, MenuItemSpec[]>();
	for (const o of options)
		groups.set(o.group, [
			...(groups.get(o.group) ?? []),
			{ kind: 'item', label: o.label, checked: current === o.key, run: () => set(o.key) },
		]);
	const entries = [...groups.entries()].map(
		([label, items]): MenuItemSpec => ({ kind: 'submenu', label, items }),
	);
	if (remappable) {
		const selected = session.getState().selection.timeline.clips;
		const ids = selected.includes(clip.id) ? selected : [clip.id];
		const shown = isRemapped(clip as TimedClip) || isBandShown(clip.id);
		const speed: MenuItemSpec = {
			kind: 'submenu',
			label: 'Time Remapping',
			items: [
				{
					kind: 'item',
					label: 'Speed',
					checked: shown,
					run: () => {
						setBandShown(ids, !shown);
						if (!shown)
							session.setView(seq.id, {
								keyframeDisplay: {
									...(view?.keyframeDisplay ?? {}),
									...Object.fromEntries(ids.map((id) => [id, 'none'])),
								},
							});
					},
				},
			],
		};
		// Premiere's order: Motion, Opacity, Time Remapping, then the effects.
		const at = entries.findIndex((e) => e.kind === 'submenu' && e.label === 'Opacity');
		entries.splice(at >= 0 ? at + 1 : entries.length, 0, speed);
	}
	return {
		kind: 'submenu',
		label: 'Show Clip Keyframes',
		items: [
			{ kind: 'item', label: 'None', checked: current === null, run: () => set('none') },
			{ kind: 'separator' },
			...entries,
		],
	};
}

let registered = false;
export function registerEditUxMenus(): void {
	if (registered) return;
	registered = true;
	clipMenuExtensions.register({
		id: 'edit-ux.clip',
		order: 5,
		items: ({ session, clip }) => {
			const seq = Object.values(session.getCommitted().sequences).find((s) => s.clips[clip.id]) as
				| Sequence
				| undefined;
			if (!seq) return [];
			const items: MenuItemSpec[] = [keyframeMenu(session, seq, clip)];
			const ids = session.getState().selection.timeline.clips.includes(clip.id)
				? session.getState().selection.timeline.clips
				: [clip.id];
			items.push({
				kind: 'item',
				label: 'Speed/Duration…',
				shortcut: 'Ctrl+R',
				run: () => {
					registerEditUxDialogs();
					void openDialog(SPEED_DURATION_DIALOG, { session, sequenceId: seq.id, clipIds: [...ids] });
				},
			});
			if ((clip as { mediaId?: string }).mediaId)
				items.push({
					kind: 'item',
					label: 'Make Subclip…',
					shortcut: 'Ctrl+U',
					run: () => subclipFromClip(session, seq, clip),
				});
			return items;
		},
	});
	projectItemMenuExtensions.register({
		id: 'edit-ux.items',
		order: 5,
		items: ({ session, items, readOnly }) => {
			const one = items.length === 1 ? (items[0] as ProjectItem) : null;
			if (!one || (one.kind !== 'media' && one.kind !== 'subclip')) return [];
			const doc = session.getCommitted();
			const lo = one.kind === 'subclip' ? one.range.in : 0;
			const hi = one.kind === 'subclip' ? one.range.out : (doc.media[one.mediaId]?.probe.durationFlicks ?? 0);
			const bounded = one.kind === 'subclip' || doc.media[one.mediaId]?.probe.durationFlicks !== null;
			const out: MenuItemSpec[] = bounded
				? [
						{
							kind: 'item',
							label: 'Make Subclip…',
							shortcut: 'Ctrl+U',
							disabled: readOnly,
							run: () =>
								openSubclipDialog(
									session,
									one.id,
									{ in: one.marks.in?.flicks ?? lo, out: one.marks.out?.flicks ?? hi },
									false,
								),
						},
					]
				: [];
			if (one.kind === 'subclip') {
				out.push({
					kind: 'item',
					label: 'Edit Subclip…',
					disabled: readOnly,
					run: () => openSubclipDialog(session, one.id, one.range, true),
				});
				out.push({ kind: 'item', label: 'Open in Source Monitor', run: () => openInSource(session, one.id) });
			}
			return out;
		},
	});
}
