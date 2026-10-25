// The project-media part of the `social-avatar` control, kept apart so the template media-param plumbing (contract C1:
// `mediaParam()`, `collectParamMediaIds`, `mediaUrls`) can replace or reuse it with a small change. The value it
// writes is the stored shape `{ mediaId }` (an id of `doc.media`), like `MediaParamPicker`. Only still images
// (`kind: 'image'`) can be avatars: video and animated images are refused with a message.
import type { MediaAsset, ProjectDocument } from '@jasper/project';
import { cx, Icon } from '@jasper/ui';
import { useRef, useState } from 'react';
import { t } from '../i18n/runtime.ts';
import { mediaKeyOf } from '../import/assets.ts';
import { readDataTransfer } from '../import/service.ts';
import { MiniButton } from '../panels/properties/controls/fields.tsx';
import { getImportService, PROJECT_ITEMS_MIME } from '../state/services.ts';

const MISSING = '__missing__';
/** Picture formats an avatar may be imported from (still images only). */
export const AVATAR_IMPORT_ACCEPT = 'image/png,image/jpeg,image/webp,image/avif,image/bmp,image/tiff';

export const isAvatarMedia = (m: Pick<MediaAsset, 'kind'> | undefined): boolean => m?.kind === 'image';

/** The project's still images, by name. */
export function avatarImages(media: Readonly<Record<string, MediaAsset>>): { mediaId: string; name: string }[] {
	return Object.values(media)
		.filter(isAvatarMedia)
		.map((m) => ({ mediaId: m.id, name: m.originalName }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

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

export type DropResult = { kind: 'media'; mediaId: string } | { kind: 'files'; files: File[] } | { kind: 'error'; message: string } | null;

/** Whether a drag may be dropped on the avatar control (Project panel items or OS files). */
export function acceptsAvatarDrag(dt: DataTransfer | null): boolean {
	const types = Array.from(dt?.types ?? []);
	return types.includes(PROJECT_ITEMS_MIME) || types.includes('Files');
}

/** What a drop on the avatar control means: a project image, OS files to import, or a refusal. */
export function avatarFromDrop(dt: DataTransfer, doc: ProjectDocument | null): DropResult {
	const payload = readDataTransfer(dt);
	if (!payload) return null;
	if (payload.type === 'os-files') {
		const files = payload.files.filter((f) => !f.type || f.type.startsWith('image/'));
		if (!files.length) return { kind: 'error', message: t('Only still images can be avatars') };
		return { kind: 'files', files: files.slice(0, 1) };
	}
	if (!doc) return null;
	for (const id of payload.itemIds) {
		const item = doc.items[id];
		const mediaId = item?.kind === 'media' || item?.kind === 'subclip' ? item.mediaId : null;
		if (mediaId && isAvatarMedia(doc.media[mediaId])) return { kind: 'media', mediaId };
	}
	return { kind: 'error', message: t('Only still images can be avatars') };
}

/** Imports one picture into the project root bin; resolves to its media id or an error message. */
export async function importAvatarFile(file: File): Promise<{ mediaId: string } | { error: string }> {
	const service = getImportService();
	if (!service) return { error: t('Open a project to import images') };
	try {
		const r = await service.importFiles({ files: [file] }, { kind: 'bin', binId: null });
		const mediaId = r.mediaIds[0];
		if (!mediaId) return { error: r.failed[0]?.message ?? t('The image could not be imported') };
		return { mediaId };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/** Project image select + Import button (the value is the current `{ mediaId }`, or null). */
export function AvatarMediaPicker(props: {
	media: Readonly<Record<string, MediaAsset>>;
	mediaId: string | null;
	disabled: boolean;
	onPick(mediaId: string): void;
	onImport(file: File): void;
	importing: boolean;
}) {
	const items = avatarImages(props.media);
	const current = props.mediaId ?? '';
	const known = current === '' || items.some((i) => i.mediaId === current);
	const file = useRef<HTMLInputElement>(null);
	const [canImport] = useState(() => getImportService() !== null);
	return (
		<span className="flex min-w-0 flex-1 items-center gap-1">
			<select
				aria-label={t('Avatar image')}
				disabled={props.disabled}
				className={cx(
					'h-[20px] min-w-0 flex-1 rounded-pr-control border border-transparent bg-pr-field px-1 font-pr text-pr-ui text-pr-text',
					'hover:border-pr-border-strong focus:outline focus:outline-1 focus:outline-pr-focus',
					!known && 'text-pr-warning',
				)}
				value={known ? current : MISSING}
				onChange={(e) => {
					const v = e.target.value;
					if (v && v !== MISSING && v !== current) props.onPick(v);
				}}
				data-testid="social-avatar-media"
			>
				{current === '' ? (
					<option value="" disabled>
						{items.length ? t('Choose an image…') : t('No images in the project')}
					</option>
				) : null}
				{!known ? <option value={MISSING}>{t('Missing media')}</option> : null}
				{items.map((i) => (
					<option key={i.mediaId} value={i.mediaId}>
						{i.name}
					</option>
				))}
			</select>
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
