// The masks of one Effect Controls section (wp masks): the tool row, then per mask its header row and its property
// rows (drawn by the panel's own row renderer, so stopwatches, keyframe lanes and graphs behave like every row).
import type { Clip } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import type { CSSProperties, ReactNode } from 'react';
import type { MaskList as MaskListModel } from '../panels/effectControls/items.ts';
import type { Row } from '../panels/properties/lib/model.ts';
import type { MaskEngine } from './actions.ts';
import { MaskHeaderRow, MaskToolsRow } from './MaskControls.tsx';

const TRACE_KINDS = new Set(['video', 'still', 'animated-image']);

export function MaskList(props: {
	session: EditorSession;
	engine: MaskEngine | null;
	list: MaskListModel;
	clip: Clip;
	readOnly: boolean;
	layout: { left: CSSProperties; lane(children: ReactNode): ReactNode };
	collapsed: Record<string, boolean>;
	setCollapsed(next: Record<string, boolean>): void;
	renderRow(r: Row): ReactNode;
	filter(r: Row): boolean;
}) {
	const { list, layout } = props;
	return (
		<div data-testid={`masks-${list.owner.effectId ?? `${list.owner.clipId}:opacity`}`}>
			<MaskToolsRow
				session={props.session}
				engine={props.engine}
				owner={list.owner}
				canTrace={TRACE_KINDS.has(props.clip.kind)}
				readOnly={props.readOnly}
				layout={layout}
			/>
			{list.blocks.map(({ mask, rows }) => {
				const key = `mask:${mask.id}`;
				const open = !props.collapsed[key];
				return (
					<div key={mask.id}>
						<MaskHeaderRow
							session={props.session}
							engine={props.engine}
							mask={mask}
							clipId={list.owner.clipId}
							open={open}
							onToggle={() => props.setCollapsed({ ...props.collapsed, [key]: open })}
							readOnly={props.readOnly}
							layout={layout}
						/>
						{open ? rows.filter(props.filter).map((r) => props.renderRow(r)) : null}
					</div>
				);
			})}
		</div>
	);
}
