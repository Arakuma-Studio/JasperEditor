// Properties ▸ 3D Title (spec 19 §9): what makes a text or shape layer a designed 3D title. Materials per surface, bevel
// bands, inflate, backplates, and the sequence's tone mapping, exposure and glints. Every number is a `PropertyRow`, so
// it scrubs, keys and takes expressions; structure goes through the `threeD.*` commands, one undo step each.
import {
	type Animatable,
	type Backplate,
	type BevelBand,
	type Clip,
	COST_CLASSES,
	costClassOf,
	ENVIRONMENT_PRESETS,
	type Layer3D,
	layerSurfaces,
	MAX_BACKPLATES,
	MAX_BEVEL_BANDS,
	type PropertySpec,
	SCENE_3D_PATH,
	SCENE_3D_SPECS,
	type Sequence,
	SURFACE_PRESETS,
	scene3dAnim,
	TONE_MAPPINGS,
	type ToneMapping,
} from '@jasper/project';
import { useSessionState } from '@jasper/session/react';
import { ArrowDown, ArrowUp, Layers, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { ClipSectionProps } from '../extensions/index.ts';
import { CheckboxField, SelectField } from '../panels/properties/controls/fields.tsx';
import { useNotices } from '../panels/properties/controls/Notices.tsx';
import { PropertyRow, type RowContext } from '../panels/properties/controls/PropertyRow.tsx';
import { bindProperty, makeRow, type Row as PropertyRowData } from '../panels/properties/lib/model.ts';
import { useInspectorOps } from '../panels/properties/lib/ops.ts';
import { Row, SmallButton, ToolButton } from '../tracking/controls.tsx';

const ENV_LABELS = ['Studio', 'Sky', 'City', 'Sunset', 'Chrome Bands', 'Neon'];
const NO_MEDIA = '';

const TONE_LABELS: Record<ToneMapping, string> = {
	none: 'None',
	aces: 'ACES',
	agx: 'AgX',
	neutral: 'Khronos Neutral',
	hue: 'Hue Preserving',
};
const SURFACE_GROUPS: { title: string; keys: string[] }[] = [
	{ title: 'Finish', keys: ['base', 'baseColor', 'metalness', 'roughness', 'reflectivity', 'specularBoost'] },
	{ title: 'Coat and Flakes', keys: ['clearcoat', 'clearcoatRoughness', 'flakes', 'flakeScale'] },
	{ title: 'Relief', keys: ['relief', 'reliefAmount', 'reliefScale'] },
	{ title: 'Iridescence', keys: ['iridescence', 'iridescenceThickness'] },
	{ title: 'Glass', keys: ['transmission', 'ior', 'thickness', 'dispersion', 'attenuationColor'] },
	{ title: 'Emission', keys: ['emissive', 'emissiveIntensity'] },
];
// The first option is a prompt, not a value: the select applies a preset and has no current one to show.
const PICK = '';
const PRESET_IDS = [PICK, ...Object.keys(SURFACE_PRESETS)];
const PRESET_LABELS = [
	'Apply Preset…',
	...Object.keys(SURFACE_PRESETS).map((k) => SURFACE_PRESETS[k]!.label),
];
const BAND_KEYS = ['width', 'depth', 'profile', 'curve', 'segments'];
const PLATE_KEYS = [
	'enabled',
	'shape',
	'grow',
	'depth',
	'gap',
	'corner',
	'fillCounters',
	'bevelWidth',
	'bevelDepth',
	'bevelProfile',
];

/** A row of a sequence-level 3D value: keyed in sequence time at `["scene3d", sequenceId, prop]`. */
function sceneRow(seq: Sequence, clip: Clip, prop: string, frame: number): PropertyRowData {
	const p = SCENE_3D_SPECS[prop]!;
	const anim = scene3dAnim(seq.threeD, prop);
	const spec: PropertySpec = {
		key: `${SCENE_3D_PATH}.${prop}`,
		label: p.label,
		group: 'threeD',
		kind: p.type === 'color' ? 'color' : 'number',
		...(p.unit ? { unit: p.unit as PropertySpec['unit'] } : {}),
		...(p.range ? { range: p.range } : {}),
		animatable: 'continuous',
		storagePath: ['$scene3d', prop],
		appliesTo: () => true,
		ui: { control: p.type === 'color' ? 'color' : 'scrub', precision: 2 },
		defaultValue: p.default,
	};
	const value = anim ? anim.value : p.default;
	return {
		id: spec.key,
		label: spec.label,
		spec,
		bindings: [
			{
				clip,
				spec,
				path: [SCENE_3D_PATH, seq.id, prop],
				resolved: {
					value,
					animated: (anim?.keyframes.length ?? 0) > 0,
					anim: (anim ?? null) as Animatable<unknown> | null,
					time: frame,
					outside: false,
				},
			},
		],
	} as PropertyRowData;
}

export function Title3DSection({ session, clips, frame, sequenceId }: ClipSectionProps) {
	const doc = useSessionState((s) => s.transient ?? s.document);
	const ops = useInspectorOps(session);
	const notices = useNotices();
	const [surfaceId, setSurfaceId] = useState('base');
	const seq = doc.sequences[sequenceId];
	const clip = clips[0];
	const td = (clip as { threeD?: Layer3D } | undefined)?.threeD;
	if (!seq || !clip || !td) return null;
	const ctx: RowContext = {
		doc,
		seq,
		frame,
		ops,
		transport: session.transport,
		mode: 'properties',
		hint: notices.hint,
		confirmStopwatchOff: notices.confirmStopwatchOff,
	};
	const row = (key: string) => {
		const r = makeRow(key, [bindProperty(doc, seq, clip, key, frame)]);
		return r ? <PropertyRow key={r.id} row={r} ctx={ctx} /> : null;
	};
	const advanced = seq.threeD?.renderer === 'advanced';
	const cost = costClassOf(td, seq.threeD);
	const costNote = (
		<p className="px-2 py-1 text-pr-small text-pr-muted" data-testid="title3d-cost">
			{COST_CLASSES[cost].label}: {COST_CLASSES[cost].detail}
		</p>
	);
	if (!advanced)
		return (
			<div data-testid="title3d-section">
				{costNote}
				<Row label="Renderer">
					<SmallButton
						onClick={() =>
							ops.apply('3D Renderer', [{ type: 'sequence.set3dRenderer', sequenceId, renderer: 'advanced' }])
						}
						data-testid="title3d-advanced"
					>
						Use Advanced 3D
					</SmallButton>
				</Row>
			</div>
		);
	const g = td.geometry;
	const surfaces = layerSurfaces(td);
	const current = surfaces.find((s) => s.id === surfaceId) ?? surfaces[0]!;
	const sid = current.id.replace('.', '-');
	const bands = (g?.bands ?? []) as BevelBand[];
	const plates = (g?.backplates ?? []) as Backplate[];
	const inflate = g?.mode === 'inflate';
	const three = seq.threeD!;
	const glint = three.glint;
	return (
		<div data-testid="title3d-section">
			{costNote}
			<Row label="Surface">
				<SelectField
					label="Surface"
					value={current.id}
					options={surfaces.map((s) => s.id)}
					labels={surfaces.map((s) => s.label)}
					onChange={(v) => setSurfaceId(String(v))}
					data-testid="title3d-surface"
				/>
			</Row>
			<Row label="Material">
				<SelectField
					label="Material"
					value={PICK}
					options={PRESET_IDS}
					labels={PRESET_LABELS}
					onChange={(preset) =>
						preset !== PICK &&
						ops.apply('3D Material', [
							{ type: 'threeD.setSurface', clipIds: [clip.id], surface: current.id, preset: String(preset) },
						])
					}
					data-testid="title3d-preset"
				/>
				{current.surface ? (
					<ToolButton
						icon={Trash2}
						label="Remove Material"
						onClick={() =>
							ops.apply('3D Material', [
								{ type: 'threeD.setSurface', clipIds: [clip.id], surface: current.id, clear: true },
							])
						}
					/>
				) : null}
			</Row>
			{current.surface
				? SURFACE_GROUPS.map((group) => (
						<details key={group.title} open={group.title === 'Finish'} data-testid={`title3d-${group.title}`}>
							<summary className="cursor-pointer px-2 py-1 text-pr-small text-pr-muted">
								{group.title}
							</summary>
							{group.keys.map((k) => row(`threeD.surface.${sid}.${k}`))}
						</details>
					))
				: null}
			{g ? (
				<>
					{row('threeD.geometry.mode')}
					{row('threeD.geometry.extrusionDepth')}
					{inflate ? (
						<>
							{row('threeD.geometry.inflate.height')}
							{row('threeD.geometry.inflate.smoothness')}
						</>
					) : (
						<>
							{row('threeD.geometry.bevelPosition')}
							{bands.map((b, i) => (
								<div key={b.id} data-testid={`title3d-band-${i}`}>
									<Row label={`Band ${i + 1}`}>
										<ToolButton
											icon={ArrowUp}
											label="Move Up"
											disabled={i === 0}
											onClick={() =>
												ops.apply('Reorder Bevel Band', [
													{ type: 'threeD.reorderBand', clipId: clip.id, bandId: b.id, index: i - 1 },
												])
											}
										/>
										<ToolButton
											icon={ArrowDown}
											label="Move Down"
											disabled={i === bands.length - 1}
											onClick={() =>
												ops.apply('Reorder Bevel Band', [
													{ type: 'threeD.reorderBand', clipId: clip.id, bandId: b.id, index: i + 1 },
												])
											}
										/>
										<ToolButton
											icon={Trash2}
											label="Remove Band"
											danger
											onClick={() =>
												ops.apply('Remove Bevel Band', [
													{ type: 'threeD.removeBand', clipId: clip.id, bandId: b.id },
												])
											}
										/>
									</Row>
									{BAND_KEYS.map((k) => row(`threeD.band.${b.id}.${k}`))}
								</div>
							))}
							<Row label="Bevel Bands">
								<SmallButton
									icon={Plus}
									disabled={bands.length >= MAX_BEVEL_BANDS}
									title={
										bands.length >= MAX_BEVEL_BANDS
											? `A solid has at most ${MAX_BEVEL_BANDS} bands`
											: 'Add Band'
									}
									onClick={() => ops.apply('Add Bevel Band', [{ type: 'threeD.addBand', clipId: clip.id }])}
									data-testid="title3d-add-band"
								>
									Add Band
								</SmallButton>
							</Row>
						</>
					)}
					{plates.map((p, i) => (
						<div key={p.id} data-testid={`title3d-plate-${i}`}>
							<Row label={`Plate ${i + 1}`}>
								<ToolButton
									icon={Trash2}
									label="Remove Plate"
									danger
									onClick={() =>
										ops.apply('Remove Backplate', [
											{ type: 'threeD.removeBackplate', clipId: clip.id, plateId: p.id },
										])
									}
								/>
							</Row>
							{PLATE_KEYS.map((k) => row(`threeD.plate.${p.id}.${k}`))}
						</div>
					))}
					<Row label="Backplates">
						<SmallButton
							icon={Layers}
							disabled={plates.length >= MAX_BACKPLATES}
							title={
								plates.length >= MAX_BACKPLATES ? `A title has at most ${MAX_BACKPLATES} plates` : 'Add Plate'
							}
							onClick={() =>
								ops.apply('Add Backplate', [
									{ type: 'threeD.addBackplate', clipId: clip.id, preset: 'black-gloss' },
								])
							}
							data-testid="title3d-add-plate"
						>
							Add Plate
						</SmallButton>
					</Row>
				</>
			) : null}
			<Row label="Tone Mapping">
				<SelectField
					label="Tone Mapping"
					value={three.toneMapping ?? 'none'}
					options={TONE_MAPPINGS}
					labels={TONE_MAPPINGS.map((t) => TONE_LABELS[t])}
					onChange={(toneMapping) =>
						ops.apply('3D Renderer', [{ type: 'sequence.set3dRenderer', sequenceId, toneMapping }])
					}
					data-testid="title3d-tone"
				/>
			</Row>
			<PropertyRow row={sceneRow(seq, clip, 'exposure', frame)} ctx={ctx} />
			<Row label="Glints">
				<CheckboxField
					label="Glints"
					value={!!glint?.enabled}
					onChange={(enabled) =>
						ops.apply('3D Renderer', [{ type: 'sequence.set3dRenderer', sequenceId, glint: { enabled } }])
					}
				/>
				{glint?.enabled ? (
					<SelectField
						label="Rays"
						value={glint.rays}
						options={[0, 2, 4, 6, 8]}
						labels={['No Rays', '2 Rays', '4 Rays', '6 Rays', '8 Rays']}
						onChange={(rays) =>
							ops.apply('3D Renderer', [{ type: 'sequence.set3dRenderer', sequenceId, glint: { rays } }])
						}
					/>
				) : null}
			</Row>
			{glint?.enabled
				? ['glintThreshold', 'glintIntensity', 'glintRadius', 'glintLength', 'glintAngle', 'glintTint'].map(
						(p) => <PropertyRow key={p} row={sceneRow(seq, clip, p, frame)} ctx={ctx} />,
					)
				: null}
		</div>
	);
}

/** Properties ▸ Environment of an environment light (TL-075): an image, a Radiance `.hdr`, or a procedural preset. */
export function Environment3DSection({ session, clips, sequenceId }: ClipSectionProps) {
	const doc = useSessionState((s) => s.transient ?? s.document);
	const ops = useInspectorOps(session);
	const clip = clips[0];
	if (!clip || clip.kind !== 'light' || !doc.sequences[sequenceId]) return null;
	const light = clip.light;
	const media = Object.values(doc.media).filter((m) => m.kind === 'hdri' || m.kind === 'image');
	const set = (patch: {
		environmentMediaId?: string | null;
		environmentPreset?: (typeof ENVIRONMENT_PRESETS)[number];
	}) => ops.apply('Light Settings', [{ type: 'light.settings', clipId: clip.id, ...patch }]);
	return (
		<div data-testid="environment3d-section">
			<Row label="Media">
				<SelectField
					label="Environment Media"
					value={light.environmentMediaId ?? NO_MEDIA}
					options={[NO_MEDIA, ...media.map((m) => m.id)]}
					labels={['Procedural', ...media.map((m) => m.originalName)]}
					onChange={(id) => set({ environmentMediaId: id === NO_MEDIA ? null : String(id) })}
					data-testid="environment3d-media"
				/>
			</Row>
			{light.environmentMediaId ? null : (
				<Row label="Preset">
					<SelectField
						label="Environment Preset"
						value={light.environmentPreset ?? 'studio'}
						options={ENVIRONMENT_PRESETS}
						labels={ENV_LABELS}
						onChange={(environmentPreset) => set({ environmentPreset })}
						data-testid="environment3d-preset"
					/>
				</Row>
			)}
		</div>
	);
}
