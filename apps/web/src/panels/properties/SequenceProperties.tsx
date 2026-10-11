// Properties with nothing selected: sequence settings (S03:INS-001, S05:PRP-001) — frame size with
// presets and swap, frame rate, background color and duration. Resizing a non-empty sequence asks
// "Keep layer sizes" / "Scale layers proportionally" (sequence.updateSettings `reposition`).
import {
	ALLOWED_SEQUENCE_RATES,
	type CommandOf,
	type Rational,
	rationalEquals,
	type Sequence,
	sequenceColorInfo,
	sequenceDuration,
} from '@jasper/project';
import { TimecodeText } from '@jasper/ui';
import { workingChoiceOf, workingSpaceOptions } from '../../color-mgmt/model.ts';
import { formatTimecode } from '../../gaps/time-display.ts';
import { CheckboxField, ColorField, MiniButton, SelectField } from './controls/fields.tsx';
import { SwapGlyph } from './controls/glyphs.tsx';
import type { Notices } from './controls/Notices.tsx';
import { ScrubbyNumber } from './controls/ScrubbyNumber.tsx';
import { Section } from './controls/Section.tsx';
import type { InspectorOps } from './lib/ops.ts';

const SIZE_PRESETS: { id: string; label: string; w: number; h: number }[] = [
	{ id: '1920x1080', label: '16:9 HD 1920 × 1080', w: 1920, h: 1080 },
	{ id: '3840x2160', label: '16:9 UHD 3840 × 2160', w: 3840, h: 2160 },
	{ id: '1280x720', label: '16:9 HD 1280 × 720', w: 1280, h: 720 },
	{ id: '1080x1920', label: '9:16 Vertical 1080 × 1920', w: 1080, h: 1920 },
	{ id: '1080x1080', label: '1:1 Square 1080 × 1080', w: 1080, h: 1080 },
	{ id: '1080x1350', label: '4:5 Portrait 1080 × 1350', w: 1080, h: 1350 },
];

function rateLabel(r: Rational): string {
	const fps = r.num / r.den;
	return Number.isInteger(fps) ? `${fps} fps` : `${(Math.round(fps * 1000) / 1000).toFixed(3)} fps`;
}

export function SequenceProperties(props: {
	seq: Sequence;
	name: string;
	ops: InspectorOps;
	notices: Notices;
}) {
	const { seq, ops, notices } = props;
	const { width, height, frameRate } = seq.settings;
	const hasClips = Object.keys(seq.clips).length > 0;
	const update = (
		label: string,
		settings: CommandOf<'sequence.updateSettings'>['settings'],
		reposition?: CommandOf<'sequence.updateSettings'>['reposition'],
	) =>
		ops.apply(label, [
			{
				type: 'sequence.updateSettings',
				sequenceId: seq.id,
				settings,
				...(reposition ? { reposition } : {}),
			},
		]);
	const resize = (w: number, h: number) => {
		const W = Math.max(16, Math.round(w / 2) * 2);
		const H = Math.max(16, Math.round(h / 2) * 2);
		if (W === width && H === height) return;
		if (!hasClips) {
			update('Sequence Frame Size', { width: W, height: H });
			return;
		}
		notices.confirm({
			message: `Change the frame size to ${W} × ${H}. What should happen to the layers?`,
			actions: [
				{ label: 'Cancel', run: () => {} },
				{
					label: 'Keep layer sizes',
					run: () => update('Sequence Frame Size', { width: W, height: H }, 'keep-offset-from-center'),
				},
				{
					label: 'Scale layers proportionally',
					primary: true,
					run: () => update('Sequence Frame Size', { width: W, height: H }, 'scale-proportionally'),
				},
			],
		});
	};
	const preset = SIZE_PRESETS.find((p) => p.w === width && p.h === height)?.id ?? 'custom';
	const rateIndex = ALLOWED_SEQUENCE_RATES.findIndex((r) => rationalEquals(r, frameRate));
	const duration = sequenceDuration(seq);
	const color = sequenceColorInfo(seq.settings);
	const row = 'flex min-h-[var(--pr-row-h)] items-center gap-2 px-2';
	const lab = 'w-[34%] shrink-0 text-pr-ui text-pr-muted';
	return (
		<div data-testid="sequence-properties">
			<header className="flex h-[28px] items-center px-2 text-pr-ui text-pr-strong">
				<span className="truncate">Sequence · {props.name}</span>
			</header>
			<Section id="properties.sequence.video" title="Video">
				<div className={row}>
					<span className={lab}>Frame Size</span>
					<SelectField
						value={preset}
						options={[...SIZE_PRESETS.map((p) => p.id), 'custom']}
						labels={[...SIZE_PRESETS.map((p) => p.label), 'Custom']}
						label="Frame size preset"
						onChange={(id) => {
							const p = SIZE_PRESETS.find((x) => x.id === id);
							if (p) resize(p.w, p.h);
						}}
						className="flex-1"
					/>
				</div>
				<div className={row}>
					<span className={lab} />
					<ScrubbyNumber
						value={width}
						label="Frame width"
						unit=" px"
						min={16}
						max={16384}
						onCommit={(fn) => resize(fn(width), height)}
						data-testid="seq-width"
					/>
					<span className="text-pr-muted">×</span>
					<ScrubbyNumber
						value={height}
						label="Frame height"
						unit=" px"
						min={16}
						max={16384}
						onCommit={(fn) => resize(width, fn(height))}
						data-testid="seq-height"
					/>
					<MiniButton label="Swap width and height" onClick={() => resize(height, width)}>
						<SwapGlyph size={12} />
					</MiniButton>
				</div>
				<div className={row}>
					<span className={lab}>Frame Rate</span>
					<SelectField
						value={rateIndex >= 0 ? String(rateIndex) : null}
						options={ALLOWED_SEQUENCE_RATES.map((_, i) => String(i))}
						labels={ALLOWED_SEQUENCE_RATES.map(rateLabel)}
						label="Frame rate"
						onChange={(i) =>
							update('Sequence Frame Rate', { frameRate: { ...ALLOWED_SEQUENCE_RATES[Number(i)]! } })
						}
						className="flex-1"
						data-testid="seq-rate"
					/>
				</div>
				<div className={row}>
					<span className={lab}>Background</span>
					<ColorField
						value={seq.settings.backgroundColor as [number, number, number, number]}
						label="Background color"
						onChange={(c) =>
							ops.apply(
								'Sequence Background',
								[
									{
										type: 'sequence.updateSettings',
										sequenceId: seq.id,
										settings: { backgroundColor: c },
									},
								],
								{ coalesceKey: `seq-bg:${seq.id}` },
							)
						}
					/>
				</div>
				<div className={row}>
					<span className={lab}>Duration</span>
					<TimecodeText
						tone="primary"
						value={formatTimecode(duration, frameRate, {
							dropFrame: seq.settings.dropFrame,
						})}
					/>
				</div>
			</Section>
			{/* color-mgmt: Sequence Settings ▸ Colour (the dialog has every field) */}
			<Section id="properties.sequence.color" title="Colour">
				<div className={row}>
					<span className={lab}>Working Space</span>
					<SelectField
						value={workingChoiceOf(color)}
						options={workingSpaceOptions().map((o) => o.value)}
						labels={workingSpaceOptions().map((o) => o.label)}
						label="Working colour space"
						onChange={(v) => update('Working Color Space', { workingColorSpace: v })}
						className="flex-1"
						data-testid="seq-working-space"
					/>
				</div>
				<div className={row}>
					<span className={lab} />
					<CheckboxField
						value={color.blendLinear}
						label="Blend using 1.0 gamma"
						onChange={(on) => update('Blend Using 1.0 Gamma', { color: { blendLinear: on ? true : null } })}
					>
						Blend using 1.0 gamma
					</CheckboxField>
				</div>
				<div className={row}>
					<span className={lab} />
					<CheckboxField
						value={color.autoToneMap}
						label="Auto tone map media"
						onChange={(on) => update('Auto Tone Map Media', { color: { autoToneMap: on ? null : false } })}
					>
						Auto tone map media
					</CheckboxField>
				</div>
			</Section>
			{/* audio-mix: sequence audio (Premiere Sequence Settings ▸ Audio: sample rate; the Mix's channel format) */}
			<Section id="properties.sequence.audio" title="Audio">
				<div className={row}>
					<span className={lab}>Sample Rate</span>
					<SelectField
						value={String(seq.settings.audioSampleRate)}
						options={['44100', '48000', '96000']}
						labels={['44100 Hz', '48000 Hz', '96000 Hz']}
						label="Audio sample rate"
						onChange={(v) => update('Sequence Audio Sample Rate', { audioSampleRate: Number(v) })}
						className="flex-1"
						data-testid="seq-audio-rate"
					/>
				</div>
				<div className={row}>
					<span className={lab}>Mix</span>
					<SelectField
						value={String(seq.settings.masterLayout)}
						options={['stereo', 'mono', '5.1']}
						labels={['Stereo', 'Mono', '5.1']}
						label="Mix channel format"
						onChange={(v) => update('Mix Channel Format', { masterLayout: v })}
						className="flex-1"
						data-testid="seq-master-layout"
					/>
				</div>
				<div className={row}>
					<span className={lab}>Loudness</span>
					<span className="text-pr-ui text-pr-muted" data-testid="seq-loudness">
						{seq.master.loudness?.enabled
							? `Normalized to ${seq.master.loudness.targetLufs} LUFS`
							: 'Not normalized'}
					</span>
				</div>
			</Section>
		</div>
	);
}
