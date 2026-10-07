// Project panel operations as document transactions (S01 §5, §16.2; S05:PRJ-003/006/007).
import { clipsInRange, type LabelColor, type ProjectDocument } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import type { CommandCtx } from '../../commands/types.ts';
import { notices } from '../../home/notices.tsx';
import { runIfRegistered } from '../../home/ui-bridge.ts';
import { projectDialogs } from './dialogs.tsx';
import { isInside } from './model.ts';

const fail = (message: string, detail?: string) => notices.push({ kind: 'error', message, detail });

function nextBinName(doc: ProjectDocument): string {
	const taken = new Set(
		Object.values(doc.items)
			.filter((i) => i.kind === 'bin')
			.map((i) => i.name),
	);
	if (!taken.has('Bin')) return 'Bin';
	let n = 1;
	while (taken.has(`Bin ${String(n).padStart(2, '0')}`)) n++;
	return `Bin ${String(n).padStart(2, '0')}`;
}

/** New Bin (Ctrl+B): creates it in `parentBinId` and returns its id. */
export function createBin(session: EditorSession, parentBinId: string | null): string | null {
	const r = session.apply({
		label: 'New Bin',
		origin: 'user',
		commands: [{ type: 'bin.create', name: nextBinName(session.getCommitted()), parentBinId }],
	});
	if (!r.ok) {
		fail('Could not create the bin', r.errors[0]?.message);
		return null;
	}
	const itemId = (r.results[0] as { itemId?: string } | undefined)?.itemId ?? null;
	if (itemId) session.select('project', [itemId], 'replace');
	return itemId;
}

export function renameItem(session: EditorSession, itemId: string, name: string): boolean {
	const trimmed = name.trim();
	const item = session.getCommitted().items[itemId];
	if (!item || !trimmed || trimmed === item.name) return false;
	const r = session.apply({
		label: 'Rename',
		origin: 'user',
		commands: [{ type: 'item.rename', itemIds: [itemId], name: trimmed }],
	});
	if (!r.ok) fail('Could not rename', r.errors[0]?.message);
	return r.ok;
}

export function setLabel(session: EditorSession, itemIds: string[], label: LabelColor): void {
	if (!itemIds.length) return;
	const r = session.apply({
		label: 'Set Label',
		origin: 'user',
		commands: [{ type: 'item.setLabel', itemIds, label }],
	});
	if (!r.ok) fail('Could not set the label', r.errors[0]?.message);
}

/** Drag onto a bin (S01:PRJ-007): items that would move into themselves are skipped. */
export function moveItems(session: EditorSession, itemIds: string[], toBinId: string | null): boolean {
	const doc = session.getCommitted();
	const ids = itemIds.filter(
		(id) => doc.items[id] && id !== toBinId && !(toBinId && isInside(doc, toBinId, id)),
	);
	if (!ids.length) return false;
	const r = session.apply({
		label: ids.length === 1 ? 'Move Item' : `Move ${ids.length} Items`,
		origin: 'user',
		commands: [{ type: 'item.move', itemIds: ids, toBinId }],
	});
	if (!r.ok) fail('Could not move the items', r.errors[0]?.message);
	return r.ok;
}

/**
 * Clear (Delete): a dry run first; when media is still used by clips the user is warned with
 * "N clips in M sequences use this media" and the confirmed delete passes `force` (S01:PRJ-006).
 */
export function deleteItems(session: EditorSession, itemIds: string[]): void {
	if (!itemIds.length) return;
	const label = itemIds.length === 1 ? 'Delete Item' : `Delete ${itemIds.length} Items`;
	const commands = [{ type: 'item.delete' as const, itemIds }];
	const dry = session.apply({ label, origin: 'user', dryRun: true, commands });
	if (dry.ok) {
		session.apply({ label, origin: 'user', commands });
		return;
	}
	const err = dry.errors[0];
	if (err?.code !== 'E_IN_USE') {
		fail('Could not delete', err?.message);
		return;
	}
	projectDialogs.open({
		kind: 'confirm',
		title: 'Delete media in use?',
		message: `${err.message}. Deleting removes those clips too.`,
		confirmLabel: 'Delete',
		danger: true,
		onConfirm: () => {
			const r = session.apply({
				label,
				origin: 'user',
				commands: [{ type: 'item.delete', itemIds, force: true }],
			});
			if (!r.ok) fail('Could not delete', r.errors[0]?.message);
		},
	});
}

/**
 * Double-click (S05:PRJ-006): media → Source monitor (`source.open` when registered); sequence → Timeline;
 * bin → navigate into it (handled by the caller through `onBin`).
 */
export async function openItem(
	session: EditorSession,
	itemId: string,
	ctx: CommandCtx,
	onBin: (binId: string) => void,
): Promise<void> {
	const item = session.getCommitted().items[itemId];
	if (!item) return;
	if (item.kind === 'bin') return onBin(item.id);
	if (item.kind === 'sequence') {
		session.openSequence(item.sequenceId);
		return;
	}
	// edit-structure (Premiere): double-clicking a Color Matte opens its Color Picker.
	if (
		item.kind === 'synthetic' &&
		session.getCommitted().synthetics[item.syntheticId]?.kind === 'color-matte'
	) {
		await runIfRegistered('project.editSynthetic', ctx, { itemId });
		return;
	}
	if (item.kind === 'media' || item.kind === 'synthetic') {
		const ok = await runIfRegistered('source.open', ctx, { itemId });
		if (!ok) notices.push({ kind: 'info', message: 'The Source monitor is not available yet.' });
	}
}

/**
 * New Item ▸ Text: a 5 s text clip at the playhead on the lowest video track that is free there
 * (a new track when none is).
 */
export function createText(session: EditorSession): void {
	const state = session.getState();
	const seqId = state.activeSequenceId;
	const seq = seqId ? session.getCommitted().sequences[seqId] : undefined;
	if (!seq) {
		notices.push({ kind: 'info', message: 'Open a sequence first to add a text clip.' });
		return;
	}
	const at = session.transport.getState().frame;
	const duration = Math.round((seq.settings.frameRate.num / seq.settings.frameRate.den) * 5);
	const free = seq.videoTracks.findIndex(
		(t) => !t.locked && clipsInRange(seq, t.id, at, at + duration).length === 0,
	);
	const track = `V${free >= 0 ? free + 1 : seq.videoTracks.length + 1}`;
	const r = session.apply({
		label: 'New Text',
		origin: 'user',
		commands: [{ type: 'clip.addText', sequenceId: seq.id, at, duration, track, content: { text: 'Title' } }],
	});
	if (!r.ok) fail('Could not add the text clip', r.errors[0]?.message);
	else {
		const clipId = (r.results[0] as { clipId?: string } | undefined)?.clipId;
		if (clipId) session.select('timeline', [clipId], 'replace');
	}
}
