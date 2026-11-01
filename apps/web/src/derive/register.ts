// Registers Derive Media (spec 18 AF-OPS-002): the dialog and the Project panel item context menu
// "Derive Media ▸ <op>…" (ops that apply to the media's kind). Called at module load of `commands/process.ts`.
import { DERIVE_OPS, type DeriveOp, deriveSourceKinds, type MediaAsset } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { openDialog, registerDialog } from '@jasper/ui';
import { type MenuItemSpec, projectItemMenuExtensions } from '../extensions/index.ts';
import { DeriveMediaDialog, type DeriveMediaDialogProps } from './DeriveMediaDialog.tsx';
import { DERIVE_MEDIA_DIALOG, DERIVE_MENU_LABELS } from './model.ts';

/** The ops that apply to a media of this kind (video: all six; audio: the audio and timing ops). */
export function deriveOpsFor(asset: Pick<MediaAsset, 'kind'> | undefined): DeriveOp[] {
	if (!asset) return [];
	return DERIVE_OPS.filter((op) => deriveSourceKinds(op).includes(asset.kind));
}

export function openDeriveMedia(session: EditorSession, mediaId: string, op: DeriveOp): void {
	void openDialog(DERIVE_MEDIA_DIALOG, { session, mediaId, op } satisfies DeriveMediaDialogProps);
}

let registered = false;
export function registerDeriveUi(): void {
	if (registered) return;
	registered = true;
	registerDialog(DERIVE_MEDIA_DIALOG, DeriveMediaDialog);
	projectItemMenuExtensions.register({
		id: 'derive',
		order: 55,
		items: ({ session, items, readOnly }) => {
			if (items.length !== 1) return [];
			const it = items[0] as { kind: string; mediaId?: string };
			if (it.kind !== 'media' || !it.mediaId) return [];
			const mediaId = it.mediaId;
			const ops = deriveOpsFor(session.getCommitted().media[mediaId] as MediaAsset | undefined);
			if (!ops.length) return [];
			const sub: MenuItemSpec = {
				kind: 'submenu',
				label: 'Derive Media',
				items: ops.map((op) => ({
					kind: 'item' as const,
					label: DERIVE_MENU_LABELS[op],
					disabled: readOnly,
					run: () => openDeriveMedia(session, mediaId, op),
				})),
			};
			return [sub];
		},
	});
}
