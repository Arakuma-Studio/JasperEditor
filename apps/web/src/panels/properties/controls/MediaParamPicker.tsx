// Picker for `media` effect params that take pictures (fx framework, wave 1: depth/displacement maps, textures,
// mattes; `mediaKinds` e.g. ['image', 'video']): "None" plus the project's items of those kinds. The value is
// `{mediaId}`; "None" is `{mediaId: ''}`; an id that is not in the project shows as "Missing media".
import type { ProjectDocument } from '@jasper/project';
import { cx } from '@jasper/ui';

const MISSING = '__missing__';

export function MediaParamPicker(props: {
	doc: ProjectDocument;
	value: unknown;
	kinds: readonly string[];
	label: string;
	onChange(mediaId: string): void;
	'data-testid'?: string;
}) {
	const items = Object.values(props.doc.media)
		.filter((m) => props.kinds.includes(m.kind))
		.map((m) => ({ mediaId: m.id, name: m.originalName }))
		.sort((a, b) => a.name.localeCompare(b.name));
	const raw = (props.value as { mediaId?: unknown } | null)?.mediaId;
	const current = typeof raw === 'string' ? raw : '';
	const known = current === '' || items.some((i) => i.mediaId === current);
	return (
		<select
			aria-label={props.label}
			title={props.label}
			className={cx(
				'h-[20px] min-w-0 max-w-full flex-1 rounded-pr-control border border-transparent bg-pr-field px-1 font-pr text-pr-ui text-pr-text',
				'hover:border-pr-border-strong focus:outline focus:outline-1 focus:outline-pr-focus',
				!known && 'text-pr-warning',
			)}
			value={known ? current : MISSING}
			onChange={(e) => {
				const v = e.target.value;
				if (v !== MISSING && v !== current) props.onChange(v);
			}}
			data-testid={props['data-testid']}
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
