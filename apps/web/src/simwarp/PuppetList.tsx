// The Puppet section's meshes and pins in Effect Controls (sim-warp): the Puppet Pin tool row (tool on/off and the
// pin kind, After Effects' Position / Advanced / Bend / Starch / Overlap tools), then per mesh its Density / Expansion /
// Triangles and per pin its header (name, kind, delete) and property rows — drawn by the panel's own row renderer so
// stopwatches, keyframe lanes and graphs behave like every row.
import { PUPPET_PIN_KINDS, type PuppetPinKind } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { cx } from '@jasper/ui';
import type { CSSProperties, ReactNode } from 'react';
import type { PuppetListModel } from '../panels/effectControls/items.ts';
import { CheckboxField, MiniButton, SelectField, TextField } from '../panels/properties/controls/fields.tsx';
import { CaretGlyph, TrashGlyph } from '../panels/properties/controls/glyphs.tsx';
import type { Row } from '../panels/properties/lib/model.ts';
import { simWarpUi, useSimWarpUi } from './store.ts';

type Layout = { left: CSSProperties; lane(children: ReactNode): ReactNode };

const KIND_LABELS: Record<PuppetPinKind, string> = {
	position: 'Position Pin',
	advanced: 'Advanced Pin',
	bend: 'Bend Pin',
	starch: 'Starch Pin',
	overlap: 'Overlap Pin',
};

function NumberCell(props: {
	label: string;
	value: number;
	min: number;
	max: number;
	onCommit(v: number): void;
	disabled: boolean;
	testId: string;
}) {
	return (
		<span className="flex items-center gap-1">
			<span className="text-pr-small text-pr-muted">{props.label}</span>
			<span className="w-[44px]">
				<TextField
					value={String(props.value)}
					label={props.label}
					disabled={props.disabled}
					onCommit={(t) => {
						const v = Number(t);
						if (Number.isFinite(v)) props.onCommit(Math.min(props.max, Math.max(props.min, v)));
					}}
					data-testid={props.testId}
				/>
			</span>
		</span>
	);
}

export function PuppetList(props: {
	session: EditorSession;
	model: PuppetListModel;
	readOnly: boolean;
	layout: Layout;
	collapsed: Record<string, boolean>;
	setCollapsed(next: Record<string, boolean>): void;
	renderRow(r: Row): ReactNode;
	filter(r: Row): boolean;
}) {
	const { session, model, layout } = props;
	const tool = useSimWarpUi((s) => s.pinTool);
	const selected = useSimWarpUi((s) => s.pins);
	const apply = (label: string, commands: unknown[]) =>
		session.apply({ label, origin: 'user', commands: commands as never });
	return (
		<div data-testid={`puppet-${model.fxId}`}>
			<div className="flex items-stretch">
				<div
					style={layout.left}
					className="flex h-[var(--pr-row-h)] min-w-0 shrink-0 items-center gap-2 pl-4 pr-1"
				>
					<CheckboxField
						value={tool !== null}
						label="Puppet Pin tool"
						disabled={props.readOnly}
						onChange={(on) => simWarpUi.set({ pinTool: on ? (tool ?? 'position') : null })}
					>
						<span className="text-pr-small">Pin tool</span>
					</CheckboxField>
					<SelectField<PuppetPinKind>
						value={tool ?? 'position'}
						options={PUPPET_PIN_KINDS}
						labels={PUPPET_PIN_KINDS.map((k) => KIND_LABELS[k])}
						label="Pin kind"
						disabled={props.readOnly}
						onChange={(k) => simWarpUi.set({ pinTool: k })}
						data-testid="puppet-pin-kind"
					/>
				</div>
			</div>
			{model.meshes.map((m) => (
				<div key={m.id} className="flex items-stretch" data-testid={`puppet-mesh-${m.id}`}>
					<div
						style={layout.left}
						className="flex h-[var(--pr-row-h)] min-w-0 shrink-0 items-center gap-2 pl-4 pr-1"
					>
						<span className="truncate text-pr-ui text-pr-text">{m.name}</span>
						<NumberCell
							label="Density"
							value={m.density}
							min={0}
							max={100}
							disabled={props.readOnly}
							testId={`puppet-density-${m.id}`}
							onCommit={(density) =>
								apply('Mesh Density', [{ type: 'puppet.updateMesh', meshId: m.id, density }])
							}
						/>
						<NumberCell
							label="Expansion"
							value={m.expansion}
							min={-100}
							max={200}
							disabled={props.readOnly}
							testId={`puppet-expansion-${m.id}`}
							onCommit={(expansion) =>
								apply('Mesh Expansion', [{ type: 'puppet.updateMesh', meshId: m.id, expansion }])
							}
						/>
						<NumberCell
							label="Triangles"
							value={m.triangles}
							min={10}
							max={10000}
							disabled={props.readOnly}
							testId={`puppet-triangles-${m.id}`}
							onCommit={(triangles) =>
								apply('Mesh Triangles', [{ type: 'puppet.updateMesh', meshId: m.id, triangles }])
							}
						/>
						<MiniButton
							label={`Delete ${m.name}`}
							disabled={props.readOnly}
							onClick={() => apply('Delete Puppet Mesh', [{ type: 'puppet.removeMesh', meshId: m.id }])}
						>
							<TrashGlyph size={12} />
						</MiniButton>
					</div>
				</div>
			))}
			{model.pins.map(({ pin, rows }) => {
				const key = `pin:${pin.id}`;
				const open = !props.collapsed[key];
				const sel = selected.includes(pin.id);
				return (
					<div key={pin.id}>
						{/* biome-ignore lint/a11y/noStaticElementInteractions: row selection like masks */}
						{/* biome-ignore lint/a11y/useKeyWithClickEvents: see above */}
						<div
							className={cx('flex items-stretch', sel && 'bg-pr-selected')}
							data-testid={`puppet-pin-${pin.id}`}
							onClick={() => simWarpUi.set({ pins: [pin.id] })}
						>
							<div
								style={layout.left}
								className="flex h-[var(--pr-row-h)] min-w-0 shrink-0 items-center gap-1 pl-4 pr-1"
							>
								<MiniButton
									label={open ? `Collapse ${pin.name}` : `Expand ${pin.name}`}
									onClick={() => props.setCollapsed({ ...props.collapsed, [key]: open })}
								>
									<CaretGlyph open={open} size={11} />
								</MiniButton>
								<span className="min-w-[72px] flex-1 truncate">
									<TextField
										value={pin.name}
										label="Pin name"
										disabled={props.readOnly}
										onCommit={(name) =>
											name.trim() &&
											apply('Rename Puppet Pin', [
												{ type: 'puppet.renamePin', pinId: pin.id, name: name.trim() },
											])
										}
										data-testid={`puppet-pin-name-${pin.id}`}
									/>
								</span>
								<span className="text-pr-small text-pr-muted">{KIND_LABELS[pin.kind]}</span>
								<MiniButton
									label={`Delete ${pin.name}`}
									disabled={props.readOnly}
									onClick={() =>
										apply('Delete Puppet Pins', [{ type: 'puppet.removePins', pinIds: [pin.id] }])
									}
								>
									<TrashGlyph size={12} />
								</MiniButton>
							</div>
						</div>
						{open ? rows.filter(props.filter).map((r) => props.renderRow(r)) : null}
					</div>
				);
			})}
		</div>
	);
}

/** Liquify's brush row: turns painting on the Program monitor on or off (the Tool param picks the brush). */
export function LiquifyToolsRow(props: { readOnly: boolean; layout: Layout }) {
	const brush = useSimWarpUi((s) => s.brush);
	return (
		<div className="flex items-stretch" data-testid="liquify-tools">
			<div
				style={props.layout.left}
				className="flex h-[var(--pr-row-h)] min-w-0 shrink-0 items-center gap-2 pl-4 pr-1"
			>
				<CheckboxField
					value={brush}
					label="Liquify brush"
					disabled={props.readOnly}
					onChange={(b) => simWarpUi.set({ brush: b })}
				>
					<span className="text-pr-small">Paint with the brush on the Program monitor</span>
				</CheckboxField>
			</div>
		</div>
	);
}
