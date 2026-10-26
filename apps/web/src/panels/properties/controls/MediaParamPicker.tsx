// Picker for `media` params that take pictures (fx framework, wave 1: depth/displacement maps, textures, mattes;
// template media params such as avatars, docs/wp-notes/social-comments.md; `mediaKinds` e.g. ['image', 'video']):
// "None" plus the project's items of those kinds, and a drop target for Project panel items. The value is
// `{mediaId}`; "None" is `{mediaId: ''}` for effect params and `null` for template params (`nullable`); an id that is
// not in the project shows as "Missing media".
import type { ProjectDocument } from '@jasper/project';
import { cx } from '@jasper/ui';
import { type DragEvent, useState } from 'react';
import { PROJECT_ITEMS_MIME } from '../../../state/services.ts';

const MISSING = '__missing__';

/** The media of the first Project panel item of a drag that is a medium of one of `kinds` (null otherwise). */
export function droppedMediaId(
	dt: Pick<DataTransfer, 'types' | 'getData'>,
	doc: Pick<ProjectDocument, 'items' | 'media'>,
	kinds: readonly string[],
): { mediaId: string } | { refused: true; message: string } | null {
	if (!Array.from(dt.types ?? []).includes(PROJECT_ITEMS_MIME)) return null;
	let ids: unknown;
	try {
		ids = (JSON.parse(dt.getData(PROJECT_ITEMS_MIME)) as { itemIds?: unknown }).itemIds;
	} catch {
		return null;
	}
	if (!Array.isArray(ids)) return null;
	for (const id of ids) {
		const it = typeof id === 'string' ? doc.items[id] : undefined;
		if (it?.kind !== 'media') continue;
		const asset = doc.media[it.mediaId];
		if (asset && kinds.includes(asset.kind)) return { mediaId: asset.id };
	}
	return {
		refused: true,
		message: kinds.includes('video')
			? 'Drop an image or video item from the Project panel'
			: 'Drop an image item from the Project panel',
	};
}

export function MediaParamPicker(props: {
	doc: ProjectDocument;
	value: unknown;
	kinds: readonly string[];
	label: string;
	onChange(mediaId: string): void;
	/** Template params: the value may be `null` ("None"). */
	nullable?: boolean;
	/** A drop that cannot be used (no media item of the accepted kinds): the reason, for the panel's hint. */
	onRefusedDrop?(message: string): void;
	disabled?: boolean;
	'data-testid'?: string;
}) {
	const [over, setOver] = useState(false);
	const items = Object.values(props.doc.media)
		.filter((m) => props.kinds.includes(m.kind))
		.map((m) => ({ mediaId: m.id, name: m.originalName }))
		.sort((a, b) => a.name.localeCompare(b.name));
	const raw = (props.value as { mediaId?: unknown } | null)?.mediaId;
	const current = typeof raw === 'string' ? raw : '';
	const known = current === '' || items.some((i) => i.mediaId === current);
	const accepts = (e: DragEvent) =>
		!props.disabled && Array.from(e.dataTransfer.types).includes(PROJECT_ITEMS_MIME);
	return (
		<select
			aria-label={props.label}
			title={props.label}
			disabled={props.disabled}
			className={cx(
				'h-[20px] min-w-0 max-w-full flex-1 rounded-pr-control border border-transparent bg-pr-field px-1 font-pr text-pr-ui text-pr-text',
				'hover:border-pr-border-strong focus:outline focus:outline-1 focus:outline-pr-focus',
				over && 'outline outline-1 outline-pr-focus',
				!known && 'text-pr-warning',
			)}
			value={known ? current : MISSING}
			onChange={(e) => {
				const v = e.target.value;
				if (v !== MISSING && v !== current) props.onChange(v);
			}}
			onDragOver={(e) => {
				if (!accepts(e)) return;
				e.preventDefault();
				e.dataTransfer.dropEffect = 'copy';
				setOver(true);
			}}
			onDragLeave={() => setOver(false)}
			onDrop={(e) => {
				setOver(false);
				if (!accepts(e)) return;
				e.preventDefault();
				const r = droppedMediaId(e.dataTransfer, props.doc, props.kinds);
				if (!r) return;
				if ('refused' in r) props.onRefusedDrop?.(r.message);
				else if (r.mediaId !== current) props.onChange(r.mediaId);
			}}
			data-testid={props['data-testid']}
			data-nullable={props.nullable ? 'true' : undefined}
		>
			<option value="">None</option>
			{!known ? <option value={MISSING}>Missing media</option> : null}
			{items.map((i) => (
				<option key={i.mediaId} value={i.mediaId}>
					{i.name}
				</option>
			))}
		</select>
	);
}
