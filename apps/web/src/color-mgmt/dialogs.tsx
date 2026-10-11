// Sources: Adobe, "Color management in Premiere Pro" and "Interpret footage" (helpx.adobe.com); ITU-R BT.2408 for the
// HDR graphics white choices.
import { type ColorInterpretation, type MediaAsset, sequenceColorInfo } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Checkbox, Dialog, type HostedDialogProps, registerDialog, Select, TextField } from '@jasper/ui';
import { useMemo, useState } from 'react';
import { useDialogClose } from '../extensions/dialog.ts';
import {
	colorPatchOf,
	detectedSpaceLabel,
	isHdrWorking,
	type Option,
	SDR_WHITE_OPTIONS,
	sourceSpaceOptions,
	workingChoiceOf,
	workingSpaceOptions,
} from './model.ts';

export const SEQUENCE_COLOR_DIALOG = 'colorMgmt.sequenceSettings';
export const INTERPRET_COLOR_DIALOG = 'colorMgmt.interpretColor';

let registered = false;
export function registerColorMgmtDialogs(): void {
	if (registered) return;
	registered = true;
	registerDialog(SEQUENCE_COLOR_DIALOG, SequenceColorDialog);
	registerDialog(INTERPRET_COLOR_DIALOG, InterpretColorDialog);
}

function Row({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
	return (
		<div className="flex min-h-[26px] items-center gap-2">
			<label htmlFor={htmlFor} className="w-[170px] shrink-0 text-pr-muted">
				{label}
			</label>
			<div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
		</div>
	);
}

function ErrorLine({ error }: { error: string | null }) {
	return error ? (
		<p className="text-pr-small text-pr-danger" role="alert">
			{error}
		</p>
	) : null;
}

type SequenceColorProps = { session: EditorSession; sequenceId: string };

export function SequenceColorDialog(props: HostedDialogProps<SequenceColorProps>) {
	const { open, finish } = useDialogClose(props.close);
	const seq = props.session.getCommitted().sequences[props.sequenceId];
	const info = sequenceColorInfo(seq?.settings);
	const [choice, setChoice] = useState(workingChoiceOf(info));
	const [blend, setBlend] = useState(info.blendLinear && !info.linearize);
	const [toneMap, setToneMap] = useState(info.autoToneMap);
	const [white, setWhite] = useState(String(info.sdrWhiteNits));
	const [peak, setPeak] = useState(String(info.hdrPeakNits));
	const [error, setError] = useState<string | null>(null);
	const linear = choice.endsWith('-linear');
	const space = linear ? choice.slice(0, -'-linear'.length) : choice;
	const hdr = space === 'rec2100-pq' || space === 'rec2100-hlg';
	const whiteOptions = useMemo<Option[]>(
		() =>
			SDR_WHITE_OPTIONS.some((o) => o.value === white)
				? SDR_WHITE_OPTIONS
				: [...SDR_WHITE_OPTIONS, { value: white, label: `${white} nits` }],
		[white],
	);
	const apply = () => {
		const p = Number(peak);
		if (!Number.isFinite(p) || p < 203 || p > 10000) {
			setError('The HDR mastering peak must be 203 to 10,000 nits');
			return false;
		}
		const r = props.session.apply({
			label: 'Sequence Colour Settings',
			origin: 'user',
			sequenceId: props.sequenceId,
			commands: [
				{
					type: 'sequence.updateSettings',
					sequenceId: props.sequenceId,
					settings: {
						workingColorSpace: choice,
						color: {
							linearize: linear ? true : null,
							blendLinear: !linear && blend ? true : null,
							autoToneMap: toneMap ? null : false,
							sdrWhiteNits: Number(white) === 203 ? null : Number(white),
							hdrPeakNits: p === 1000 ? null : p,
						},
					},
				} as never,
			],
		});
		if (!r.ok) {
			setError(r.errors[0]?.message ?? 'The colour settings could not be changed');
			return false;
		}
		finish(true);
		return true;
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title="Sequence Settings ▸ Colour"
			size="medium"
			primaryLabel="OK"
			onPrimary={apply}
			data-testid="sequence-color-dialog"
		>
			<div className="flex flex-col gap-1.5 text-pr-ui">
				<Row label="Working Color Space" htmlFor="cm-working">
					<Select
						id="cm-working"
						value={choice}
						onValueChange={setChoice}
						options={workingSpaceOptions()}
						label="Working Color Space"
						className="flex-1"
					/>
				</Row>
				<Row label="">
					<Checkbox
						checked={linear}
						onCheckedChange={(on) => setChoice(on ? `${space}-linear` : space)}
						disabled={hdr}
						label="Linearize Working Space"
						id="cm-linearize"
					/>
				</Row>
				<Row label="">
					<Checkbox
						checked={linear || blend}
						onCheckedChange={setBlend}
						disabled={linear}
						label="Blend Using 1.0 Gamma"
						id="cm-blend-linear"
					/>
				</Row>
				<Row label="">
					<Checkbox
						checked={toneMap}
						onCheckedChange={setToneMap}
						disabled={hdr}
						label="Auto Tone Map Media (HDR and log media in an SDR working space)"
						id="cm-tonemap"
					/>
				</Row>
				<Row label="HDR Graphics White" htmlFor="cm-white">
					<Select
						id="cm-white"
						value={white}
						onValueChange={setWhite}
						options={whiteOptions}
						label="HDR Graphics White"
						disabled={!hdr}
						className="flex-1"
					/>
				</Row>
				<Row label="HDR Mastering Peak (nits)" htmlFor="cm-peak">
					<TextField
						id="cm-peak"
						value={peak}
						disabled={space !== 'rec2100-pq'}
						onChange={(e) => {
							setPeak(e.target.value);
							setError(null);
						}}
						aria-label="HDR mastering peak in nits"
						data-testid="cm-peak"
					/>
				</Row>
				<p className="text-pr-small text-pr-muted">
					The Program monitor shows {hdr ? 'HDR tone mapped to Rec. 709' : 'the working space'}; exports write
					the working space unless their colour space says otherwise.
					{linear || blend
						? ' Linear-light blending is drawn by the GPU compositor (exports use the Remotion path).'
						: ''}
				</p>
				<ErrorLine error={error} />
			</div>
		</Dialog>
	);
}

const AUTO = '@auto';
const NONE = '@none';
const OCIO = '@ocio:';

/** The Colour section's state: a full interpretation (absent fields = automatic). */
export function ColorInterpretationFields(props: {
	value: ColorInterpretation;
	onChange(v: ColorInterpretation): void;
	/** Shown as "Automatic (…)" (the space the file's tags give). */
	detected: string;
	/** The project's LUT items and OCIO configs. */
	luts: Option[];
	configs: { id: string; name: string; spaces: string[] }[];
	/** The sequence working space is HDR (the PQ peak and tone mapping read differently). */
	hdrWorking: boolean;
}) {
	const v = props.value;
	const spaceValue = v.ocio ? `${OCIO}${v.ocio.configId}` : (v.space ?? AUTO);
	const cfg = v.ocio ? props.configs.find((c) => c.id === v.ocio!.configId) : undefined;
	const set = (patch: Partial<ColorInterpretation>) => {
		const next: ColorInterpretation = { ...v, ...patch };
		for (const k of Object.keys(next) as (keyof ColorInterpretation)[])
			if (next[k] === undefined) delete next[k];
		props.onChange(next);
	};
	return (
		<div className="flex flex-col gap-1.5 text-pr-ui" data-testid="color-interpretation">
			<Row label="Color Space" htmlFor="cm-space">
				<Select
					id="cm-space"
					value={spaceValue}
					onValueChange={(s) => {
						if (s === AUTO) set({ space: undefined, ocio: undefined });
						else if (s.startsWith(OCIO)) {
							const c = props.configs.find((x) => x.id === s.slice(OCIO.length));
							set({ space: undefined, ocio: { configId: c!.id, space: c!.spaces[0] ?? '' } });
						} else set({ space: s, ocio: undefined });
					}}
					options={[
						{ value: AUTO, label: `Automatic (${props.detected})` },
						...sourceSpaceOptions(),
						...props.configs.map((c) => ({ value: `${OCIO}${c.id}`, label: `OCIO config: ${c.name}` })),
					]}
					label="Color Space"
					className="flex-1"
				/>
			</Row>
			{cfg ? (
				<Row label="OCIO Colour Space" htmlFor="cm-ocio-space">
					<Select
						id="cm-ocio-space"
						value={v.ocio!.space}
						onValueChange={(s) => set({ ocio: { configId: cfg.id, space: s } })}
						options={cfg.spaces.map((s) => ({ value: s, label: s }))}
						label="OCIO colour space"
						className="flex-1"
					/>
				</Row>
			) : null}
			<Row label="Input LUT" htmlFor="cm-input-lut">
				<Select
					id="cm-input-lut"
					value={v.inputLut ?? NONE}
					onValueChange={(s) => set({ inputLut: s === NONE ? undefined : s })}
					options={[{ value: NONE, label: 'None' }, ...props.luts]}
					label="Input LUT"
					className="flex-1"
				/>
			</Row>
			<Row label="Range" htmlFor="cm-range">
				<Select
					id="cm-range"
					value={v.range ?? AUTO}
					onValueChange={(s) => set({ range: s === AUTO ? undefined : (s as 'tv' | 'pc') })}
					options={[
						{ value: AUTO, label: "From the file's range flag" },
						{ value: 'tv', label: 'Limited (video levels)' },
						{ value: 'pc', label: 'Full (data levels)' },
					]}
					label="Range"
					className="flex-1"
				/>
			</Row>
			<Row label="Tone Mapping" htmlFor="cm-tm">
				<Select
					id="cm-tm"
					value={v.toneMap === undefined ? AUTO : v.toneMap ? 'on' : 'off'}
					onValueChange={(s) => set({ toneMap: s === AUTO ? undefined : s === 'on' })}
					options={[
						{ value: AUTO, label: 'Sequence default (Auto Tone Map Media)' },
						{ value: 'on', label: 'On (BT.2390)' },
						{ value: 'off', label: 'Off (clip highlights)' },
					]}
					label="Tone mapping"
					disabled={props.hdrWorking}
					className="flex-1"
				/>
			</Row>
			<Row label="PQ Content Peak (nits)" htmlFor="cm-peaknits">
				<TextField
					id="cm-peaknits"
					value={v.peakNits === undefined ? '' : String(v.peakNits)}
					placeholder="From the file (MaxCLL / mastering), else 1000"
					onChange={(e) => {
						const n = Number(e.target.value);
						set({ peakNits: e.target.value.trim() === '' || !Number.isFinite(n) ? undefined : n });
					}}
					aria-label="PQ content peak in nits"
				/>
			</Row>
		</div>
	);
}

type InterpretProps = {
	session: EditorSession;
	/** Media items (Interpret Footage) or timeline clips (clip override). */
	target: { kind: 'media'; mediaIds: string[] } | { kind: 'clips'; sequenceId: string; clipIds: string[] };
};

export function InterpretColorDialog(props: HostedDialogProps<InterpretProps>) {
	const { open, finish } = useDialogClose(props.close);
	const doc = props.session.getCommitted();
	const state = props.session.getState();
	const seq = state.activeSequenceId ? doc.sequences[state.activeSequenceId] : undefined;
	const info = sequenceColorInfo(seq?.settings);
	const t = props.target;
	const firstAsset: MediaAsset | undefined =
		t.kind === 'media'
			? (doc.media[t.mediaIds[0]!] as MediaAsset | undefined)
			: (() => {
					const c = doc.sequences[t.sequenceId]?.clips[t.clipIds[0]!] as { mediaId?: string } | undefined;
					return c?.mediaId ? (doc.media[c.mediaId] as MediaAsset | undefined) : undefined;
				})();
	const initial: ColorInterpretation =
		t.kind === 'media'
			? { ...(firstAsset?.interpretation?.color ?? {}) }
			: {
					...(((
						doc.sequences[t.sequenceId]?.clips[t.clipIds[0]!] as { colorInterpretation?: ColorInterpretation }
					)?.colorInterpretation as ColorInterpretation | undefined) ?? {}),
				};
	const [value, setValue] = useState<ColorInterpretation>(initial);
	const [error, setError] = useState<string | null>(null);
	const luts = Object.values(doc.media)
		.filter((m) => m.kind === 'lut')
		.map((m) => ({ value: m.id, label: m.originalName }));
	const configs = Object.values(doc.media)
		.filter((m) => m.kind === 'color-config' && (m as MediaAsset).colorConfig)
		.map((m) => ({
			id: m.id,
			name: (m as MediaAsset).colorConfig!.name || m.originalName,
			spaces: (m as MediaAsset).colorConfig!.spaces.map((s) => s.name),
		}));
	const apply = () => {
		const patch = colorPatchOf(initial, value);
		if (Object.keys(patch).length === 0) {
			finish(true);
			return true;
		}
		const empty = Object.keys(value).length === 0;
		const command =
			t.kind === 'media'
				? { type: 'media.interpretColor', mediaIds: t.mediaIds, color: empty ? null : patch }
				: { type: 'clip.setColorInterpretation', clipIds: t.clipIds, color: empty ? null : patch };
		const r = props.session.apply({
			label: t.kind === 'media' ? 'Interpret Footage (Colour)' : 'Clip Colour Space',
			origin: 'user',
			...(t.kind === 'clips' ? { sequenceId: t.sequenceId } : {}),
			commands: [command as never],
		});
		if (!r.ok) {
			setError(r.errors[0]?.message ?? 'The colour interpretation could not be changed');
			return false;
		}
		finish(true);
		return true;
	};
	const n = t.kind === 'media' ? t.mediaIds.length : t.clipIds.length;
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title={t.kind === 'media' ? 'Interpret Footage ▸ Colour' : 'Clip Colour Space'}
			description={
				t.kind === 'media'
					? `${n} item${n > 1 ? 's' : ''}: how the file's colours are read`
					: `${n} clip${n > 1 ? 's' : ''}: overrides the media's interpretation`
			}
			size="medium"
			primaryLabel="OK"
			onPrimary={apply}
			data-testid="interpret-color-dialog"
		>
			<ColorInterpretationFields
				value={value}
				onChange={(v) => {
					setValue(v);
					setError(null);
				}}
				detected={firstAsset ? detectedSpaceLabel(firstAsset, info.space) : 'Rec. 709'}
				luts={luts}
				configs={configs}
				hdrWorking={isHdrWorking(info)}
			/>
			<ErrorLine error={error} />
		</Dialog>
	);
}
