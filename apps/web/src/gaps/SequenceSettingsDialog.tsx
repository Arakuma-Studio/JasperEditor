import {
	isAllowedSequenceRate,
	type MonoClipPanLaw,
	monoClipPanLawOf,
	type Rational,
	SEQUENCE_PAR_CHOICES,
	type Sequence,
	sequenceColorInfo,
	sequenceFormatOf,
	supportsDropFrame,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import {
	Button,
	Checkbox,
	confirmDialog,
	Dialog,
	type HostedDialogProps,
	registerDialog,
	Select,
	TextField,
} from '@jasper/ui';
import { type ReactNode, useState } from 'react';

export const SEQUENCE_SETTINGS_DIALOG = 'gaps.sequenceSettings';

export const TIMEBASES: { label: string; rate: Rational }[] = [
	{ label: '23.976 frames/second', rate: { num: 24000, den: 1001 } },
	{ label: '24 frames/second', rate: { num: 24, den: 1 } },
	{ label: '25 frames/second', rate: { num: 25, den: 1 } },
	{ label: '29.97 frames/second', rate: { num: 30000, den: 1001 } },
	{ label: '30 frames/second', rate: { num: 30, den: 1 } },
	{ label: '48 frames/second', rate: { num: 48, den: 1 } },
	{ label: '50 frames/second', rate: { num: 50, den: 1 } },
	{ label: '59.94 frames/second', rate: { num: 60000, den: 1001 } },
	{ label: '60 frames/second', rate: { num: 60, den: 1 } },
];
const rateKey = (r: Rational) => `${r.num}/${r.den}`;

type Form = {
	rate: string;
	storageWidth: number;
	height: number;
	par: string;
	fieldOrder: 'progressive' | 'upper' | 'lower';
	dropFrame: boolean;
	sampleRate: 44100 | 48000 | 96000;
	layout: 'mono' | 'stereo' | '5.1';
	panLaw: MonoClipPanLaw;
};

function formOf(seq: Sequence): Form {
	const f = sequenceFormatOf(seq.settings);
	const parId =
		SEQUENCE_PAR_CHOICES.find((c) => c.par.num * f.par.den === f.par.num * c.par.den)?.id ??
		`custom:${f.par.num}/${f.par.den}`;
	return {
		rate: rateKey(seq.settings.frameRate),
		storageWidth: f.storageWidth,
		height: seq.settings.height,
		par: parId,
		fieldOrder: f.fieldOrder,
		dropFrame: seq.settings.dropFrame,
		sampleRate: seq.settings.audioSampleRate as Form['sampleRate'],
		layout: seq.settings.masterLayout as Form['layout'],
		panLaw: monoClipPanLawOf(seq.settings),
	};
}

const parOf = (id: string): Rational => {
	const c = SEQUENCE_PAR_CHOICES.find((x) => x.id === id);
	if (c) return c.par;
	const m = /^custom:(\d+)\/(\d+)$/.exec(id);
	return m ? { num: Number(m[1]), den: Number(m[2]) } : { num: 1, den: 1 };
};

/** The `sequence.updateSettings` patch for a form (only what changed), or a validation message. */
function settingsPatch(seq: Sequence, f: Form): { patch: Record<string, unknown> } | { error: string } {
	const [num, den] = f.rate.split('/').map(Number) as [number, number];
	const rate = { num, den };
	if (!isAllowedSequenceRate(rate)) return { error: 'Choose one of the listed timebases.' };
	for (const [k, v] of [
		['Width', f.storageWidth],
		['Height', f.height],
	] as const)
		if (!Number.isInteger(v) || v < 16 || v > 8192 || v % 2)
			return { error: `${k} must be an even number of pixels between 16 and 8192.` };
	const cur = formOf(seq);
	const patch: Record<string, unknown> = {};
	if (f.rate !== cur.rate) patch.frameRate = rate;
	const par = parOf(f.par);
	const square = par.num === par.den;
	if (f.par !== cur.par || f.storageWidth !== cur.storageWidth) {
		if (square) {
			patch.pixelAspectRatio = null;
			patch.width = f.storageWidth;
		} else {
			patch.pixelAspectRatio = par;
			patch.storageWidth = f.storageWidth;
		}
	}
	if (f.height !== cur.height) patch.height = f.height;
	if (f.fieldOrder !== cur.fieldOrder) patch.fieldOrder = f.fieldOrder;
	if (f.dropFrame !== cur.dropFrame || patch.frameRate)
		patch.dropFrame = f.dropFrame && supportsDropFrame(rate);
	if (f.sampleRate !== cur.sampleRate) patch.audioSampleRate = f.sampleRate;
	if (f.layout !== cur.layout) patch.masterLayout = f.layout;
	if (f.panLaw !== cur.panLaw) patch.monoClipPanLaw = f.panLaw;
	return { patch };
}

function Row(props: { label: string; children: ReactNode }) {
	return (
		<div className="grid min-h-[28px] grid-cols-[160px_minmax(0,1fr)] items-center gap-3">
			<span className="text-pr-muted">{props.label}</span>
			<div className="flex min-w-0 items-center gap-2">{props.children}</div>
		</div>
	);
}

function Group(props: { title: string; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-1 pb-3">
			<h3 className="mb-1 border-b border-pr-border-subtle font-semibold text-pr-strong">{props.title}</h3>
			{props.children}
		</section>
	);
}

type Props = {
	session: EditorSession;
	sequenceId: string;
	/** Runs a UI command (Video Previews…, Working Colour Space…). */
	runCommand?(id: string): void;
};

function SequenceSettingsDialog(props: HostedDialogProps<Props>) {
	const { session } = props;
	const seq = session.getCommitted().sequences[props.sequenceId] as Sequence | undefined;
	const [form, setForm] = useState<Form | null>(() => (seq ? formOf(seq) : null));
	const [reposition, setReposition] = useState<
		'keep-offset-from-center' | 'scale-proportionally' | 'keep-pixels'
	>('keep-offset-from-center');
	const [error, setError] = useState<string | null>(null);
	if (!seq || !form) return null;
	const item = Object.values(session.getCommitted().items).find(
		(i) => i.kind === 'sequence' && i.sequenceId === seq.id,
	);
	const hasClips = Object.keys(seq.clips).length > 0;
	const presets = session.ctx.registries.presets.list();
	const set = (patch: Partial<Form>) => {
		setError(null);
		setForm({ ...form, ...patch });
	};
	const par = parOf(form.par);
	const display = Math.max(16, 2 * Math.round((form.storageWidth * par.num) / par.den / 2));
	const sizeChanges = display !== seq.settings.width || form.height !== seq.settings.height;
	const color = sequenceColorInfo(seq.settings);
	const pv = seq.previews;
	const parOptions = SEQUENCE_PAR_CHOICES.map((c) => ({ value: c.id, label: c.label }));
	if (form.par.startsWith('custom:'))
		parOptions.push({ value: form.par, label: `Custom (${par.num}:${par.den})` });
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title={`Sequence Settings — ${item?.name ?? 'Sequence'}`}
			size="large"
			primaryLabel="OK"
			onPrimary={async () => {
				const r = settingsPatch(seq, form);
				if ('error' in r) {
					setError(r.error);
					return false;
				}
				if (!Object.keys(r.patch).length) {
					props.close(false);
					return false;
				}
				if (hasClips && r.patch.frameRate) {
					const ok = await confirmDialog({
						title: 'Change the timebase of a sequence with clips?',
						body: 'Clips, markers and keyframes are conformed to the new frame rate (cuts move to the nearest frame of the new rate). Premiere does not allow this; you can undo it.',
						confirmLabel: 'Change Timebase',
					});
					if (!ok) return false;
				}
				const res = session.apply({
					label: 'Sequence Settings',
					origin: 'user',
					sequenceId: seq.id,
					commands: [
						{
							type: 'sequence.updateSettings',
							sequenceId: seq.id,
							settings: r.patch,
							...(sizeChanges && hasClips ? { reposition } : {}),
						},
					] as never[],
				});
				if (!res.ok) {
					setError(res.errors[0]?.message ?? 'The settings could not be changed.');
					return false;
				}
				props.close(true);
				return false;
			}}
			footerExtra={
				<Select
					label="Load preset"
					className="w-64"
					value=""
					placeholder="Load Preset…"
					onValueChange={(id) => {
						const p = presets.find((x) => x.id === id);
						if (!p) return;
						const tmp = { ...seq, settings: p.settings } as Sequence;
						setForm({ ...formOf(tmp) });
					}}
					options={presets.map((p) => ({ value: p.id, label: p.name }))}
				/>
			}
			data-testid="sequence-settings-dialog"
		>
			<div className="flex flex-col gap-1">
				<Group title="Video">
					<Row label="Timebase">
						<Select
							label="Timebase"
							className="w-56"
							value={form.rate}
							onValueChange={(v) => set({ rate: v, dropFrame: supportsDropFrame(parseRate(v)) })}
							options={TIMEBASES.map((t) => ({ value: rateKey(t.rate), label: t.label }))}
						/>
						{hasClips ? (
							<span className="text-pr-small text-pr-dim">changing it conforms the clips</span>
						) : null}
					</Row>
					<Row label="Frame Size">
						<TextField
							aria-label="Frame width"
							data-testid="seq-width"
							type="number"
							className="w-24"
							value={form.storageWidth}
							onChange={(e) => set({ storageWidth: Number.parseInt(e.target.value, 10) || 0 })}
						/>
						<span>horizontal</span>
						<TextField
							aria-label="Frame height"
							data-testid="seq-height"
							type="number"
							className="w-24"
							value={form.height}
							onChange={(e) => set({ height: Number.parseInt(e.target.value, 10) || 0 })}
						/>
						<span>vertical</span>
						{par.num !== par.den ? (
							<span className="text-pr-small text-pr-dim">
								edited at {display}×{form.height} square pixels
							</span>
						) : null}
					</Row>
					<Row label="Pixel Aspect Ratio">
						<Select
							label="Pixel aspect ratio"
							className="w-72"
							value={form.par}
							onValueChange={(v) => set({ par: v })}
							options={parOptions}
						/>
					</Row>
					<Row label="Fields">
						<Select
							label="Fields"
							className="w-56"
							value={form.fieldOrder}
							onValueChange={(v) => set({ fieldOrder: v as Form['fieldOrder'] })}
							options={[
								{ value: 'progressive', label: 'No Fields (Progressive Scan)' },
								{ value: 'upper', label: 'Upper Field First' },
								{ value: 'lower', label: 'Lower Field First' },
							]}
						/>
						{form.fieldOrder !== 'progressive' ? (
							<span className="text-pr-small text-pr-dim">exports are progressive</span>
						) : null}
					</Row>
					<Row label="Timecode">
						<Checkbox
							checked={form.dropFrame}
							disabled={!supportsDropFrame(parseRate(form.rate))}
							onCheckedChange={(c) => set({ dropFrame: c })}
							label="Drop-Frame"
						/>
					</Row>
					{sizeChanges && hasClips ? (
						<Row label="Existing clips">
							<Select
								label="Reposition clips"
								className="w-72"
								value={reposition}
								onValueChange={(v) => setReposition(v as typeof reposition)}
								options={[
									{ value: 'keep-offset-from-center', label: 'Keep their offset from the centre' },
									{ value: 'scale-proportionally', label: 'Scale them with the frame' },
									{ value: 'keep-pixels', label: 'Keep their pixel positions' },
								]}
							/>
						</Row>
					) : null}
				</Group>
				<Group title="Audio">
					<Row label="Sample Rate">
						<Select
							label="Audio sample rate"
							className="w-40"
							value={String(form.sampleRate)}
							onValueChange={(v) => set({ sampleRate: Number(v) as Form['sampleRate'] })}
							options={[
								{ value: '44100', label: '44100 Hz' },
								{ value: '48000', label: '48000 Hz' },
								{ value: '96000', label: '96000 Hz' },
							]}
						/>
					</Row>
					<Row label="Mix Channels">
						<Select
							label="Mix channel format"
							className="w-40"
							value={form.layout}
							onValueChange={(v) => set({ layout: v as Form['layout'] })}
							options={[
								{ value: 'mono', label: 'Mono' },
								{ value: 'stereo', label: 'Stereo' },
								{ value: '5.1', label: '5.1' },
							]}
						/>
					</Row>
					<Row label="Mono Clip Pan Law">
						<Select
							label="Pan law of mono clips on stereo tracks"
							className="w-56"
							value={form.panLaw}
							onValueChange={(v) => set({ panLaw: v as MonoClipPanLaw })}
							options={[
								{ value: '-3dB', label: '−3 dB (constant power)' },
								{ value: '0dB', label: '0 dB (unity, balance)' },
							]}
						/>
					</Row>
				</Group>
				<Group title="Video Previews">
					<Row label="Preview File Format">
						<span>
							{pv?.format === 'vp9' ? 'VP9 (WebM)' : pv?.format === 'h264' ? 'H.264' : 'I-Frame Only H.264'},{' '}
							{pv?.size === 'half' ? 'half size' : 'full size'}
						</span>
						<Button variant="quiet" onClick={() => props.runCommand?.('sequence.previewSettings')}>
							Video Previews…
						</Button>
					</Row>
				</Group>
				<Group title="Colour">
					<Row label="Working Colour Space">
						<span>{color.space}</span>
						<Button variant="quiet" onClick={() => props.runCommand?.('sequence.colorSettings')}>
							Colour Settings…
						</Button>
					</Row>
				</Group>
				{error ? (
					<p role="alert" className="text-pr-small text-pr-danger">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

function parseRate(v: string): Rational {
	const [num, den] = v.split('/').map(Number) as [number, number];
	return { num, den };
}

let registered = false;
export function registerSequenceSettingsDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(SEQUENCE_SETTINGS_DIALOG, SequenceSettingsDialog);
}
