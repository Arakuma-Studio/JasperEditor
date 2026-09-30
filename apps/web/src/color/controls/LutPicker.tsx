// LUT picker for `media` params with `mediaKinds: ['lut']` (S06:LUT-005): "None", the project's LUT items
// (name and size, e.g. `33³`), and "Browse…" which imports a `.cube` through the normal import path and selects
// it. The value is `{mediaId}`; "None" is `{mediaId: ''}`. A missing/offline id shows as "Missing LUT".
import type { ProjectDocument } from '@jasper/project';
import { cx } from '@jasper/ui';
import { useState } from 'react';
import { lutItems, mediaIdOf } from '../model.ts';

const BROWSE = '__browse__';
const MISSING = '__missing__';

export function LutPicker(props: {
	doc: ProjectDocument;
	value: unknown;
	label: string;
	onChange(mediaId: string): void;
	/** Imports a LUT and resolves with its media id (null = cancelled). Hidden when absent. */
	onBrowse?(): Promise<string | null>;
	disabled?: boolean;
	className?: string;
	'data-testid'?: string;
}) {
	const [busy, setBusy] = useState(false);
	const items = lutItems(props.doc);
	const current = mediaIdOf(props.value);
	const known = current === '' || items.some((i) => i.mediaId === current);
	const select = (v: string) => {
		if (v === BROWSE) {
			if (!props.onBrowse) return;
			setBusy(true);
			void props
				.onBrowse()
				.then((id) => {
					if (id && id !== current) props.onChange(id);
				})
				.catch((e) => console.warn('[lut] import failed', e))
				.finally(() => setBusy(false));
			return;
		}
		if (v === MISSING || v === current) return;
		props.onChange(v);
	};
	return (
		<select
			aria-label={props.label}
			title={props.label}
			disabled={props.disabled || busy}
			className={cx(
				'h-[20px] min-w-0 max-w-full flex-1 rounded-pr-control border border-transparent bg-pr-field px-1 font-pr text-pr-ui text-pr-text',
				'hover:border-pr-border-strong focus:outline focus:outline-1 focus:outline-pr-focus',
				!known && 'text-pr-warning',
				props.className,
			)}
			value={known ? current : MISSING}
			onChange={(e) => select(e.target.value)}
			data-testid={props['data-testid']}
		>
			<option value="">None</option>
			{!known ? <option value={MISSING}>Missing LUT</option> : null}
			{items.map((i) => (
				<option key={i.mediaId} value={i.mediaId}>
					{i.sizeText ? `${i.name} (${i.sizeText})` : i.name}
				</option>
			))}
			{props.onBrowse ? <option value={BROWSE}>{busy ? 'Importing…' : 'Browse…'}</option> : null}
		</select>
	);
}
