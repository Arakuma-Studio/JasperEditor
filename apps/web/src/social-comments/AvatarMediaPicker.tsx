// The project-media part of the `social-avatar` control, kept apart from the rest so it follows the template
// media-param plumbing (contract C1). It reuses `MediaParamPicker` (project images, "None", drop from the Project panel)
// and its `droppedMediaId`; the stored value is `{ mediaId }` (an id of `doc.media`). Only still images
// (`kind: 'image'`) can be avatars: video and animated images are refused with a message. An image file can also be
// imported straight into the project (the tokcomment "upload" button) or dropped from the desktop.
import type { MediaAsset, ProjectDocument } from '@jasper/project';
import { Icon } from '@jasper/ui';
import { useRef } from 'react';
import { t } from '../i18n/runtime.ts';
import { mediaKeyOf } from '../import/assets.ts';
import { MiniButton } from '../panels/properties/controls/fields.tsx';
import { droppedMediaId, MediaParamPicker } from '../panels/properties/controls/MediaParamPicker.tsx';
import { getImportService, PROJECT_ITEMS_MIME } from '../state/services.ts';

/** Media kinds an avatar may use. */
export const AVATAR_MEDIA_KINDS = ['image'] as const;
/** Picture formats an avatar may be imported from (still images only). */
export const AVATAR_IMPORT_ACCEPT = 'image/png,image/jpeg,image/webp,image/avif,image/bmp,image/tiff';

/** URLs showing an image media item through the engine: its poster, then the file (none without an engine). */
export function avatarImageUrls(
	media: Readonly<Record<string, MediaAsset>>,
	mediaId: string | null,
	mediaUrl: ((key: string, variant?: 'poster' | 'original') => string) | null,
): string[] {
	if (!mediaId || !mediaUrl) return [];
	const key = mediaKeyOf(media[mediaId]);
	return key ? [mediaUrl(key, 'poster'), mediaUrl(key, 'original')] : [];
}

export type AvatarDrop =
	| { kind: 'media'; mediaId: string }
	| { kind: 'file'; file: File }
	| { kind: 'refused'; message: string }
	| null;

/** Whether a drag may be dropped on the avatar control (Project panel items or desktop files). */
export function acceptsAvatarDrag(dt: Pick<DataTransfer, 'types'> | null): boolean {
	const types = Array.from(dt?.types ?? []);
	return types.includes(PROJECT_ITEMS_MIME) || types.includes('Files');
}

/** What a drop on the avatar control means: a project image, an image file to import, or a refusal. */
export function avatarFromDrop(
	dt: Pick<DataTransfer, 'types' | 'getData' | 'files'>,
	doc: Pick<ProjectDocument, 'items' | 'media'> | null,
): AvatarDrop {
	if (Array.from(dt.types ?? []).includes(PROJECT_ITEMS_MIME)) {
		if (!doc) return null;
		const r = droppedMediaId(dt, doc, AVATAR_MEDIA_KINDS);
		if (!r) return null;
		return 'refused' in r
			? { kind: 'refused', message: t('Only still images can be avatars') }
			: { kind: 'media', ...r };
	}
	const files = Array.from(dt.files ?? []);
	if (!files.length) return null;
	const image = files.find((f) => f.type.startsWith('image/') && f.type !== 'image/gif');
	return image
		? { kind: 'file', file: image }
		: { kind: 'refused', message: t('Only still images can be avatars') };
}

/**
 * Imports one picture into the project root bin (its own History entry, "Import 1 file"); resolves to its media id,
 * or an error message (also when the file turned out not to be a still image).
 */
export async function importAvatarFile(
	file: File,
	media: () => Readonly<Record<string, MediaAsset>>,
): Promise<{ mediaId: string } | { error: string }> {
	const service = getImportService();
	if (!service) return { error: t('Open a project to import images') };
	try {
		const r = await service.importFiles({ files: [file] }, { kind: 'bin', binId: null });
		const mediaId = r.mediaIds[0];
		if (!mediaId) return { error: r.failed[0]?.message ?? t('The image could not be imported') };
		const kind = media()[mediaId]?.kind;
		if (kind && kind !== 'image') return { error: t('Only still images can be avatars') };
		return { mediaId };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/** Project image picker (shared `MediaParamPicker`) + Import button. */
export function AvatarMediaPicker(props: {
	doc: ProjectDocument;
	mediaId: string | null;
	disabled: boolean;
	/** '' = "None" (the platform default). */
	onPick(mediaId: string): void;
	onImport(file: File): void;
	onRefused(message: string): void;
	importing: boolean;
}) {
	const file = useRef<HTMLInputElement>(null);
	const canImport = getImportService() !== null;
	return (
		<span className="flex min-w-0 flex-1 items-center gap-1">
			<MediaParamPicker
				doc={props.doc}
				value={props.mediaId ? { mediaId: props.mediaId } : null}
				kinds={AVATAR_MEDIA_KINDS}
				label={t('Avatar image')}
				nullable
				disabled={props.disabled}
				onChange={props.onPick}
				onRefusedDrop={() => props.onRefused(t('Only still images can be avatars'))}
				data-testid="social-avatar-media"
			/>
			<MiniButton
				label={canImport ? t('Import an image…') : t('Open a project to import images')}
				disabled={props.disabled || !canImport || props.importing}
				onClick={() => file.current?.click()}
				data-testid="social-avatar-import"
			>
				<Icon id={props.importing ? 'app.spinner' : 'app.import'} size={13} />
			</MiniButton>
			<input
				ref={file}
				type="file"
				accept={AVATAR_IMPORT_ACCEPT}
				className="hidden"
				tabIndex={-1}
				aria-hidden
				onChange={(e) => {
					const f = e.target.files?.[0];
					e.target.value = '';
					if (f) props.onImport(f);
				}}
				data-testid="social-avatar-file"
			/>
		</span>
	);
}
