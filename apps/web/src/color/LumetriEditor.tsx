// The Lumetri editor (S06:CGU-001/002): Basic Correction, Creative, Curves and Color Wheels of one clip's first
// `jasper.lumetri` instance. Hosted by the Lumetri Color panel (every section; the instance is created by the
// first edit, one undo step) and by Effect Controls (only the curves and wheels: the scalar and LUT params keep
// their generic rows and keyframe lanes there, `hideParams` = LUMETRI_EDITOR_PARAMS).
import {
	type Clip,
	type EffectInstance,
	type EffectSpec,
	LUMETRI_EFFECT,
	type ProjectDocument,
	type Sequence,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { cx } from '@jasper/ui';
import { type ReactNode, useState } from 'react';
import { MiniButton } from '../panels/properties/controls/fields.tsx';
import { ResetGlyph } from '../panels/properties/controls/glyphs.tsx';
import { PropertyRow, type RowContext } from '../panels/properties/controls/PropertyRow.tsx';
import { Section } from '../panels/properties/controls/Section.tsx';
import { planReset, type Row } from '../panels/properties/lib/model.ts';
import type { InspectorOps } from '../panels/properties/lib/ops.ts';
import { browseForLut } from './actions.ts';
import { type CurveChannel, CurveField } from './controls/CurveField.tsx';
import { LutPicker } from './controls/LutPicker.tsx';
import { SliderEditor } from './controls/SliderEditor.tsx';
import { WheelField } from './controls/WheelField.tsx';
import { curvePoints, curveValue, isIdentityPoints, lumetriRow } from './model.ts';
import { type RowWriteContext, useRowWriter } from './rowEdit.ts';

type LumetriEditorProps = {
	session: EditorSession;
	doc: ProjectDocument;
	seq: Sequence;
	clip: Clip;
	/** The edited instance; null = none yet (the first edit adds it). */
	fx: EffectInstance | null;
	effect?: EffectSpec;
	frame: number;
	ops: InspectorOps;
	host: 'effectControls' | 'properties' | 'panel';
	hint(message: string): void;
	confirmStopwatchOff(label: string, onConfirm: () => void): void;
};

const CURVES: { channel: CurveChannel; param: string; label: string }[] = [
	{ channel: 'master', param: 'curveMaster', label: 'Master' },
	{ channel: 'red', param: 'curveRed', label: 'Red' },
	{ channel: 'green', param: 'curveGreen', label: 'Green' },
	{ channel: 'blue', param: 'curveBlue', label: 'Blue' },
];

const WHEELS = [
	{ wheel: 'shadowsWheel', level: 'shadowsLevel', title: 'Shadows' },
	{ wheel: 'midtonesWheel', level: 'midtonesLevel', title: 'Midtones' },
	{ wheel: 'highlightsWheel', level: 'highlightsLevel', title: 'Highlights' },
] as const;

/** Gradient tracks (design tokens) of the white-balance and saturation sliders. */
const TRACKS: Record<string, string> = {
	temperature: 'var(--pr-slider-temperature)',
	tint: 'var(--pr-slider-tint)',
	saturation: 'var(--pr-slider-saturation)',
};

export function LumetriEditor(props: LumetriEditorProps) {
	const { session, doc, seq, clip, fx, frame, ops } = props;
	const effect = props.effect ?? LUMETRI_EFFECT;
	const live = () => session.transport.getState().frame;
	const writeCtx: RowWriteContext = { ops, live, hint: props.hint };
	const rowCtx: RowContext = {
		doc,
		seq,
		frame,
		ops,
		transport: session.transport,
		mode: 'effectControls',
		hint: props.hint,
		confirmStopwatchOff: props.confirmStopwatchOff,
	};
	const row = (name: string) => lumetriRow(doc, seq, clip, fx, name, frame, effect);
	const panel = props.host !== 'effectControls';

	const resetAction = (title: string, names: readonly string[]) => {
		const rows = names.map(row);
		const canReset = fx !== null;
		return canReset ? (
			<MiniButton
				label={`Reset ${title}`}
				onClick={() =>
					ops.apply(
						`Reset ${title}`,
						rows.flatMap((r) => planReset(r, doc, seq, live()).commands),
					)
				}
				data-testid={`lumetri-reset-${title.toLowerCase().replace(/\s+/g, '-')}`}
			>
				<ResetGlyph size={12} />
			</MiniButton>
		) : null;
	};

	const sliderRow = (name: string) => {
		const r = row(name);
		return (
			<div key={name} data-lumetri-param={name}>
				<PropertyRow
					row={r}
					ctx={rowCtx}
					editor={
						<SliderEditor
							row={r}
							ctx={writeCtx}
							trackBackground={TRACKS[name]}
							data-testid={`lumetri-${name}`}
						/>
					}
				/>
			</div>
		);
	};
	const lutRow = (name: string) => {
		const r = row(name);
		return (
			<div key={name} data-lumetri-param={name}>
				<PropertyRow row={r} ctx={rowCtx} editor={<LutRowPicker row={r} ctx={writeCtx} props={props} />} />
			</div>
		);
	};
	const sub = (text: string) => (
		<div className="px-2 pt-2 pb-[2px] text-pr-small font-semibold text-pr-muted uppercase">{text}</div>
	);

	const BASIC = [
		'inputLut',
		'temperature',
		'tint',
		'exposure',
		'contrast',
		'highlights',
		'shadows',
		'whites',
		'blacks',
		'saturation',
	];
	const CREATIVE = ['look', 'lookIntensity', 'vibrance'];

	return (
		<div className="flex min-w-0 flex-col" data-testid={`lumetri-editor-${props.host}`}>
			{panel ? (
				<>
					<Section
						id="lumetri.basic"
						title="Basic Correction"
						actions={resetAction('Basic Correction', BASIC)}
					>
						{lutRow('inputLut')}
						{sub('White Balance')}
						{sliderRow('temperature')}
						{sliderRow('tint')}
						{sub('Tone')}
						{sliderRow('exposure')}
						{sliderRow('contrast')}
						{sliderRow('highlights')}
						{sliderRow('shadows')}
						{sliderRow('whites')}
						{sliderRow('blacks')}
						<div className="h-1" />
						{sliderRow('saturation')}
					</Section>
					<Section id="lumetri.creative" title="Creative" actions={resetAction('Creative', CREATIVE)}>
						{lutRow('look')}
						{sliderRow('lookIntensity')}
						{sliderRow('vibrance')}
					</Section>
				</>
			) : null}
			<Section
				id={panel ? 'lumetri.curves' : 'lumetri.ec.curves'}
				title="Curves"
				variant={panel ? 'section' : 'group'}
				actions={resetAction(
					'Curves',
					CURVES.map((c) => c.param),
				)}
			>
				<CurvesEditor row={row} ctx={writeCtx} />
			</Section>
			<Section
				id={panel ? 'lumetri.wheels' : 'lumetri.ec.wheels'}
				title="Color Wheels"
				variant={panel ? 'section' : 'group'}
				actions={resetAction(
					'Color Wheels',
					WHEELS.flatMap((w) => (panel ? [w.wheel, w.level] : [w.wheel])),
				)}
			>
				<div className="flex flex-wrap justify-center gap-2 px-2 py-1">
					{WHEELS.map((w) => (
						<div key={w.wheel} className="min-w-[84px] flex-1" data-lumetri-param={w.wheel}>
							<WheelField
								row={row(w.wheel)}
								levelRow={panel ? row(w.level) : undefined}
								ctx={writeCtx}
								title={w.title}
								data-testid={`lumetri-${w.wheel}`}
							/>
						</div>
					))}
				</div>
			</Section>
		</div>
	);
}

function LutRowPicker({ row, ctx, props }: { row: Row; ctx: RowWriteContext; props: LumetriEditorProps }) {
	const writer = useRowWriter(row, ctx);
	return (
		<LutPicker
			doc={props.doc}
			value={row.bindings[0]?.resolved.value}
			label={row.label}
			onChange={(mediaId) => writer.commit({ mediaId })}
			onBrowse={() => browseForLut(props.session)}
			data-testid={`lumetri-${row.spec.key.split('.').pop()}`}
		/>
	);
}

/** Master/R/G/B tabs over one curve editor; the other channels are drawn faintly behind. */
function CurvesEditor({ row, ctx }: { row: (name: string) => Row; ctx: RowWriteContext }) {
	const [tab, setTab] = useState<CurveChannel>('master');
	const current = CURVES.find((c) => c.channel === tab)!;
	const r = row(current.param);
	const writer = useRowWriter(r, ctx);
	const pts = curvePoints(r.bindings[0]?.resolved.value);
	const tabButton = (c: (typeof CURVES)[number]): ReactNode => {
		const edited = !isIdentityPoints(curvePoints(row(c.param).bindings[0]?.resolved.value));
		return (
			<button
				key={c.channel}
				type="button"
				role="tab"
				aria-selected={tab === c.channel}
				className={cx(
					'flex h-[20px] items-center gap-1 rounded-pr-control px-2 text-pr-small',
					tab === c.channel ? 'bg-pr-selected text-pr-strong' : 'text-pr-muted hover:bg-pr-hover',
				)}
				onClick={() => setTab(c.channel)}
				data-testid={`lumetri-curve-tab-${c.channel}`}
			>
				<span
					className="inline-block size-[8px] rounded-full"
					style={{ background: `var(--pr-curve-${c.channel})` }}
				/>
				{c.label}
				{edited ? <span className="text-pr-accent">•</span> : null}
			</button>
		);
	};
	return (
		<div className="flex flex-col items-center gap-1 px-2 py-1" data-lumetri-param={current.param}>
			<div className="flex w-full flex-wrap items-center gap-1" role="tablist" aria-label="Curve channel">
				{CURVES.map(tabButton)}
				<span className="flex-1" />
				<MiniButton
					label={`Reset ${current.label} curve`}
					disabled={isIdentityPoints(pts)}
					onClick={() =>
						writer.commit(
							curveValue([
								[0, 0],
								[1, 1],
							]),
						)
					}
				>
					<ResetGlyph size={12} />
				</MiniButton>
			</div>
			<CurveField
				row={r}
				ctx={ctx}
				channel={tab}
				ghosts={CURVES.filter((c) => c.channel !== tab).map((c) => ({
					channel: c.channel,
					value: row(c.param).bindings[0]?.resolved.value,
				}))}
				data-testid="lumetri-curve"
			/>
		</div>
	);
}
