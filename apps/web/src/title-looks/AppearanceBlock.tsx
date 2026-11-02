// Spec 19 TL-090: the look's stack in Effect Controls, below its header: Colours, Light and one twirl per layer, top of the
// stack first. Rows are drawn by the panel's own renderer, so stopwatches, keyframe lanes and graphs are every row's.
import type { Command } from '@jasper/project';
import { cx, Icon } from '@jasper/ui';
import type { CSSProperties, ReactNode } from 'react';
import type { AppearanceBlockModel } from '../panels/effectControls/items.ts';
import { SummaryLane } from '../panels/effectControls/MiniTimeline.tsx';
import type { Range } from '../panels/effectControls/lib.ts';
import { MiniButton } from '../panels/properties/controls/fields.tsx';
import { CaretGlyph, TrashGlyph } from '../panels/properties/controls/glyphs.tsx';
import type { InspectorOps } from '../panels/properties/lib/ops.ts';
import type { Row } from '../panels/properties/lib/model.ts';
import type { Sequence } from '@jasper/project';
import { LIGHT_TARGET, lookFocus } from './focus.ts';
import { layerName } from './selection.ts';

type Layout = { left: CSSProperties; lane(children: ReactNode): ReactNode };

export function AppearanceBlock(props: {
	model: AppearanceBlockModel;
	ops: InspectorOps;
	seq: Sequence;
	range: Range;
	readOnly: boolean;
	layout: Layout;
	collapsed: Record<string, boolean>;
	setCollapsed(next: Record<string, boolean>): void;
	renderRow(r: Row): ReactNode;
	filter(r: Row): boolean;
}) {
	const { model, layout, ops, seq, range, collapsed, setCollapsed } = props;
	const select = (target: string) => lookFocus.set({ clipId: model.clipId, fxId: model.fxId, target });
	const group = (
		key: string,
		label: string,
		rows: Row[],
		target: string,
		lead?: ReactNode,
		actions?: ReactNode,
	) => {
		const id = `${model.fxId}:appearance:${key}`;
		const visible = rows.filter(props.filter);
		// Groups start closed: a stack of eight layers is eight lines until one is opened.
		const open = collapsed[id] === false;
		return (
			<div key={key} data-ec-look-group={key}>
				<div className="flex items-stretch">
					{/* biome-ignore lint/a11y/noStaticElementInteractions: the name selects the layer; the twirl is the button */}
					{/* biome-ignore lint/a11y/useKeyWithClickEvents: the twirl is reachable by keyboard */}
					<div
						style={layout.left}
						className="flex h-[var(--pr-row-h)] min-w-0 shrink-0 items-center gap-1 pl-4 pr-1"
						onClick={() => select(target)}
					>
						<MiniButton
							label={open ? `Collapse ${label}` : `Expand ${label}`}
							onClick={() => setCollapsed({ ...collapsed, [id]: open })}
							data-testid={`ec-look-toggle-${key}`}
						>
							<CaretGlyph open={open} size={11} />
						</MiniButton>
						{lead}
						<span className="min-w-0 flex-1 truncate text-pr-ui text-pr-text">{label}</span>
						{actions}
					</div>
					{layout.lane(<SummaryLane rows={rows} seq={seq} range={range} />)}
				</div>
				{open ? visible.map((r) => props.renderRow(r)) : null}
			</div>
		);
	};
	return (
		<div data-testid={`ec-appearance-${model.fxId}`}>
			{group('palette', 'Colours', model.palette, 'palette')}
			{group('light', 'Light', model.light, LIGHT_TARGET)}
			{model.layers.map((l) => {
				const name = layerName(l.layer);
				return group(
					l.layer.id,
					name,
					l.rows,
					l.layer.id,
					<MiniButton
						label={l.layer.enabled ? `Hide ${name}` : `Show ${name}`}
						active={l.layer.enabled}
						disabled={props.readOnly}
						onClick={() =>
							ops.apply(l.layer.enabled ? 'Hide Layer' : 'Show Layer', [
								{
									type: 'appearance.setLayerEnabled',
									effectInstanceId: model.fxId,
									layerId: l.layer.id,
									enabled: !l.layer.enabled,
								} as Command,
							])
						}
						className={cx(!l.layer.enabled && 'opacity-60')}
						data-testid={`ec-look-eye-${l.layer.id}`}
					>
						<Icon id={l.layer.enabled ? 'track.output' : 'track.outputOff'} size={12} />
					</MiniButton>,
					<MiniButton
						label={`Remove ${name}`}
						disabled={props.readOnly}
						onClick={() =>
							ops.apply('Remove Layer', [
								{
									type: 'appearance.removeLayer',
									effectInstanceId: model.fxId,
									layerId: l.layer.id,
								} as Command,
							])
						}
						data-testid={`ec-look-remove-${l.layer.id}`}
					>
						<TrashGlyph size={12} />
					</MiniButton>,
				);
			})}
		</div>
	);
}
