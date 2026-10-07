// Audio Track Mixer (audio-mix; Premiere Window ▸ Audio Track Mixer, Shift+6): one channel strip per audio track,
// per submix and the Mix, left to right. Each strip (top → bottom): input format / input map, effect slots (pre- and
// post-fader inserts), sends (target, level, pre/post), the pan knob (or the 5.1 panner pad when the strip feeds a
// 5.1 bus), M / S / R, the automation mode, fader + meter, output assignment and the name. Moving a control is heard
// at once; with playback running it is recorded per the automation mode (`audio/automation.ts`).
import {
	AUTOMATION_MODES,
	type AutomationMode,
	type EffectSpec,
	flicksPerFrame,
	listStrips,
	pans51,
	type Rational,
	type Sequence,
	type StripView,
} from '@jasper/project';
import type { EditorSession, SessionState } from '@jasper/session';
import { useSessionOrNull, useStoreSelector, useTransportFrame } from '@jasper/session/react';
import { EmptyState, Select } from '@jasper/ui';
import { useEffect, useReducer } from 'react';
import { type MixerController, mixerControllerFor } from '../../audio/automation.ts';
import { dbText, Fader, Knob, Panner51 } from '../../audio/components/controls.tsx';
import { LevelMeter } from '../../audio/components/LevelMeter.tsx';
import { useMeterReading, useMixGraph } from '../../audio/runtime.ts';
import type { PanelProps } from '../types.ts';

const NULL_STORE = { getState: (): SessionState | null => null, subscribe: () => () => {} };

export const MODE_LABELS: Record<AutomationMode, string> = {
	off: 'Off',
	read: 'Read',
	latch: 'Latch',
	touch: 'Touch',
	write: 'Write',
};

function useController(session: EditorSession | null): MixerController | null {
	const c = session ? mixerControllerFor(session) : null;
	const [, force] = useReducer((x: number) => x + 1, 0);
	useEffect(() => (c ? c.onChange(force) : undefined), [c]);
	return c;
}

function stripRef(s: StripView): string {
	return s.kind === 'master' ? 'Mix' : s.id;
}

type StripProps = {
	session: EditorSession;
	seq: Sequence;
	strip: StripView;
	strips: StripView[];
	ctl: MixerController;
	t: number;
	audioEffects: EffectSpec[];
};

function apply(session: EditorSession, label: string, commands: unknown[]) {
	session.apply({ label, origin: 'user', commands: commands as never });
}

function Strip({ session, seq, strip, strips, ctl, t, audioEffects }: StripProps) {
	const graph = useMixGraph();
	const reading = useMeterReading(graph, strip.id);
	const width = strip.format === '5.1' ? 6 : strip.format === 'mono' ? 1 : 2;
	const master = strip.kind === 'master';
	const ref = stripRef(strip);
	const vol = ctl.displayValue(strip.id, 'volume', t);
	const pan = ctl.displayValue(strip.id, 'pan', t);
	const surround = pans51(seq, strip.id);
	const px = ctl.displayValue(strip.id, 'pan51.x', t);
	const py = ctl.displayValue(strip.id, 'pan51.y', t);
	const center = ctl.displayValue(strip.id, 'pan51.center', t);
	const lfe = ctl.displayValue(strip.id, 'pan51.lfe', t);
	const mute = ctl.displayValue(strip.id, 'mute', t) >= 0.5;
	const update = (patch: Record<string, unknown>, label = 'Audio Track Mixer') =>
		apply(session, label, [{ type: 'mixer.updateStrip', sequenceId: seq.id, stripId: ref, patch }]);
	const idx = strips.indexOf(strip);
	const outputs = strips.filter((s) => s.kind === 'submix' && strips.indexOf(s) > idx);
	const preInserts = strip.effects.filter((e) => !e.postFader);
	const postInserts = strip.effects.filter((e) => !!e.postFader);
	const btn = (
		on: boolean,
		label: string,
		title: string,
		onClick: () => void,
		color?: string,
		testid?: string,
	) => (
		<button
			type="button"
			title={title}
			aria-pressed={on}
			onClick={onClick}
			data-testid={testid}
			className={`h-[18px] w-[18px] rounded-pr-control text-[10px] font-semibold ${on ? '' : 'text-pr-muted hover:bg-pr-hover'}`}
			style={
				on
					? {
							background: `var(${color})`,
							color: color === '--pr-track-solo' ? 'var(--pr-track-solo-text)' : 'var(--pr-on-accent)',
						}
					: undefined
			}
		>
			{label}
		</button>
	);
	const insertList = (list: typeof strip.effects, post: boolean) => (
		<div className="flex flex-col gap-[1px]">
			{list.map((e) => (
				<div
					key={e.id}
					className="flex items-center gap-0.5 rounded-[2px] bg-pr-field px-1 text-[10px]"
					data-testid="mixer-insert"
				>
					<button
						type="button"
						className={`min-w-0 flex-1 truncate text-left ${e.enabled ? 'text-pr-text' : 'text-pr-dim line-through'}`}
						title={`${e.effectId}: click to ${e.enabled ? 'bypass' : 'enable'}`}
						onClick={() =>
							apply(session, 'Toggle Effect', [
								{ type: 'effect.setEnabled', effectInstanceId: e.id, enabled: !e.enabled },
							])
						}
					>
						{audioEffects.find((s) => s.id === e.effectId)?.label ?? e.effectId}
					</button>
					<button
						type="button"
						className="text-pr-dim hover:text-pr-text"
						title={post ? 'Move before the fader' : 'Move after the fader'}
						onClick={() =>
							apply(session, 'Move Track Effect', [
								{ type: 'mixer.setInsertPosition', effectInstanceId: e.id, postFader: !post },
							])
						}
					>
						{post ? '↑' : '↓'}
					</button>
					<button
						type="button"
						className="text-pr-dim hover:text-pr-danger"
						title="Remove effect"
						onClick={() =>
							apply(session, 'Remove Effect', [{ type: 'effect.remove', effectInstanceId: e.id }])
						}
					>
						×
					</button>
				</div>
			))}
		</div>
	);
	return (
		<div
			className="flex h-full w-[92px] shrink-0 flex-col gap-1 border-r border-pr-border-subtle px-1 py-1"
			data-testid={`mixer-strip-${master ? 'Mix' : strip.label}`}
			data-strip-id={strip.id}
		>
			<div className="flex items-center justify-between gap-1 text-[10px] text-pr-muted">
				<Select
					label={`${strip.label} channel format`}
					value={strip.format}
					onValueChange={(v) => update({ channelFormat: v }, 'Channel Format')}
					options={[
						{ value: 'mono', label: 'Mono' },
						{ value: 'stereo', label: 'Stereo' },
						{ value: '5.1', label: '5.1' },
					]}
				/>
			</div>
			{strip.kind !== 'master' && strip.format === 'stereo' ? (
				<Select
					label={`${strip.label} input map`}
					value={strip.inputMap}
					onValueChange={(v) => update({ inputMap: v }, 'Input Map')}
					options={[
						{ value: 'stereo', label: 'L/R' },
						{ value: 'left', label: 'Left' },
						{ value: 'right', label: 'Right' },
						{ value: 'swap', label: 'Swap' },
						{ value: 'mono', label: 'Mono' },
					]}
				/>
			) : null}
			{/* effect slots (Premiere: 5) */}
			<div className="flex flex-col gap-[2px]" title="Effects">
				{insertList(preInserts, false)}
				{postInserts.length ? <div className="h-px bg-pr-border" title="Post-fader" /> : null}
				{insertList(postInserts, true)}
				{strip.effects.length < 5 ? (
					<Select
						label={`Add effect to ${strip.label}`}
						value=""
						placeholder={audioEffects.length ? '+ Effect' : 'No audio effects'}
						disabled={audioEffects.length === 0}
						onValueChange={(effectId) =>
							apply(session, 'Apply Effect', [
								master
									? { type: 'effect.add', sequenceId: seq.id, effectId, target: 'master' }
									: {
											type: 'effect.add',
											sequenceId: seq.id,
											effectId,
											target: { sequenceId: seq.id, trackId: strip.id },
										},
							])
						}
						options={audioEffects.map((e) => ({ value: e.id, label: e.label }))}
					/>
				) : null}
			</div>
			{/* sends (Premiere: 5) */}
			{!master ? (
				<div className="flex flex-col gap-[2px]" title="Sends">
					{strip.sends.map((x) => {
						const lvl = ctl.displayValue(strip.id, `send.${x.id}.level`, t);
						return (
							<div key={x.id} className="flex items-center gap-0.5 text-[10px]" data-testid="mixer-send">
								<span className="min-w-0 flex-1 truncate text-pr-muted" title="Send target">
									{strips.find((s) => s.id === x.target)?.label ?? '?'}
								</span>
								<Knob
									size={16}
									label="Send level"
									value={Math.max(-60, lvl)}
									min={-60}
									max={15}
									reset={0}
									onTouch={(v) => ctl.touch(strip.id, `send.${x.id}.level`, v <= -60 ? -96 : v)}
									onRelease={() => ctl.release(strip.id, `send.${x.id}.level`)}
								/>
								<button
									type="button"
									className="text-pr-dim hover:text-pr-text"
									title={x.preFader ? 'Pre-fader (click for post)' : 'Post-fader (click for pre)'}
									onClick={() =>
										apply(session, 'Edit Send', [
											{
												type: 'mixer.updateSend',
												sequenceId: seq.id,
												stripId: ref,
												sendId: x.id,
												patch: { preFader: !x.preFader },
											},
										])
									}
								>
									{x.preFader ? 'Pre' : 'Post'}
								</button>
								<button
									type="button"
									className="text-pr-dim hover:text-pr-danger"
									title="Remove send"
									onClick={() =>
										apply(session, 'Remove Send', [
											{ type: 'mixer.removeSend', sequenceId: seq.id, stripId: ref, sendId: x.id },
										])
									}
								>
									×
								</button>
							</div>
						);
					})}
					{strip.sends.length < 5 && outputs.length ? (
						<Select
							label={`Add send to ${strip.label}`}
							value=""
							placeholder="+ Send"
							onValueChange={(target) =>
								apply(session, 'Add Send', [
									{ type: 'mixer.addSend', sequenceId: seq.id, stripId: ref, target },
								])
							}
							options={outputs.map((s) => ({ value: s.id, label: s.name }))}
						/>
					) : null}
				</div>
			) : null}
			<div className="flex-1" />
			{/* pan / 5.1 panner */}
			{!master ? (
				surround ? (
					<div className="flex flex-col gap-0.5">
						<Panner51
							label={`${strip.label} 5.1 panner`}
							x={px}
							y={py}
							onTouchXY={(x, y) => {
								ctl.touch(strip.id, 'pan51.x', x);
								ctl.touch(strip.id, 'pan51.y', y);
							}}
							onRelease={() => {
								ctl.release(strip.id, 'pan51.x');
								ctl.release(strip.id, 'pan51.y');
							}}
							data-testid="mixer-panner51"
						/>
						<div className="flex items-center justify-between text-[9px] text-pr-muted">
							<Knob
								size={16}
								label="Center %"
								value={center}
								min={0}
								max={100}
								reset={100}
								onTouch={(v) => ctl.touch(strip.id, 'pan51.center', v)}
								onRelease={() => ctl.release(strip.id, 'pan51.center')}
							/>
							<span title="Center %">{Math.round(center)}%</span>
							<Knob
								size={16}
								label="LFE"
								value={Math.max(-60, lfe)}
								min={-60}
								max={15}
								reset={0}
								onTouch={(v) => ctl.touch(strip.id, 'pan51.lfe', v <= -60 ? -96 : v)}
								onRelease={() => ctl.release(strip.id, 'pan51.lfe')}
							/>
						</div>
					</div>
				) : (
					<div className="flex flex-col items-center gap-0.5">
						<Knob
							label={`${strip.label} ${strip.format === 'mono' ? 'pan' : 'balance'}`}
							value={pan}
							onTouch={(v) => ctl.touch(strip.id, 'pan', v)}
							onRelease={() => ctl.release(strip.id, 'pan')}
							data-testid="mixer-pan"
						/>
						<span className="text-[10px] text-pr-value pr-tabular">
							{Math.round(pan) === 0 ? '0' : Math.round(pan)}
						</span>
					</div>
				)
			) : null}
			{!master ? (
				<div className="flex justify-center gap-0.5">
					{btn(
						mute,
						'M',
						'Mute Track',
						() => {
							ctl.touch(strip.id, 'mute', mute ? 0 : 1);
							ctl.release(strip.id, 'mute');
						},
						'--pr-track-mute',
						'mixer-mute',
					)}
					{btn(
						strip.solo,
						'S',
						'Solo Track',
						() => update({ solo: !strip.solo }, strip.solo ? 'Unsolo Track' : 'Solo Track'),
						'--pr-track-solo',
						'mixer-solo',
					)}
					{strip.kind === 'track'
						? btn(
								strip.recordArm,
								'R',
								'Enable track for recording (voice-over)',
								() => update({ recordArm: !strip.recordArm }, 'Record Arm'),
								'--pr-danger',
								'mixer-record-arm',
							)
						: null}
				</div>
			) : null}
			<Select
				label={`${strip.label} automation mode`}
				value={strip.automation}
				onValueChange={(v) => update({ automation: v }, 'Automation Mode')}
				options={AUTOMATION_MODES.map((m) => ({ value: m, label: MODE_LABELS[m] }))}
			/>
			<div className="flex h-[160px] shrink-0 justify-center gap-1.5">
				<Fader
					label={`${strip.label} volume`}
					value={vol}
					onTouch={(v) => ctl.touch(strip.id, 'volume', v)}
					onRelease={() => ctl.release(strip.id, 'volume')}
					data-testid="mixer-fader"
				/>
				<LevelMeter reading={reading} channels={width} barWidth={width > 2 ? 3 : 5} gap={1} />
			</div>
			<div className="text-center text-[10px] text-pr-value pr-tabular" data-testid="mixer-volume-value">
				{dbText(vol)} dB
			</div>
			{!master ? (
				<Select
					label={`${strip.label} output`}
					value={strip.output ?? 'master'}
					onValueChange={(v) => update({ output: v === 'master' ? null : v }, 'Track Output')}
					options={[
						{ value: 'master', label: 'Mix' },
						...outputs.map((s) => ({ value: s.id, label: s.name })),
					]}
				/>
			) : null}
			<div
				className={`truncate rounded-[2px] px-1 text-center text-[11px] ${master ? 'bg-pr-selected text-pr-text' : 'bg-pr-field text-pr-text'}`}
				title={strip.name}
			>
				{master ? 'Mix' : `${strip.label} ${strip.name}`}
			</div>
			{strip.kind === 'submix' ? (
				<button
					type="button"
					className="text-[10px] text-pr-dim hover:text-pr-danger"
					onClick={() =>
						apply(session, 'Delete Submix Track', [
							{ type: 'mixer.removeSubmix', sequenceId: seq.id, stripId: strip.id },
						])
					}
				>
					Delete Submix
				</button>
			) : null}
		</div>
	);
}

export function AudioTrackMixerPanel(_props: PanelProps) {
	const session = useSessionOrNull();
	const seq = useStoreSelector(session?.store ?? NULL_STORE, (s: SessionState | null) =>
		s?.activeSequenceId ? ((s.document.sequences[s.activeSequenceId] as Sequence | undefined) ?? null) : null,
	);
	if (!session) return <EmptyState icon="panel.audioTrackMixer" message="Open a project to mix its audio" />;
	if (!seq) return <EmptyState icon="panel.audioTrackMixer" message="Open a sequence to mix its audio" />;
	return <Mixer session={session} seq={seq} />;
}

function Mixer({ session, seq }: { session: EditorSession; seq: Sequence }) {
	const ctl = useController(session)!;
	const transport = useTransportFrame(50);
	const F = flicksPerFrame(seq.settings.frameRate as Rational);
	const t = transport.playing ? ctl.now() : transport.frame * F;
	const strips = listStrips(seq);
	const audioEffects = session.ctx.registries.effects.list().filter((e) => e.appliesTo === 'audio');
	return (
		<div className="flex h-full min-h-0 flex-col" data-testid="audio-track-mixer">
			<div className="flex h-7 shrink-0 items-center gap-2 border-b border-pr-border-subtle px-2 text-pr-small text-pr-muted">
				<span className="truncate">
					{seq.settings.masterLayout === '5.1'
						? '5.1 Mix'
						: seq.settings.masterLayout === 'mono'
							? 'Mono Mix'
							: 'Stereo Mix'}{' '}
					· {(seq.settings.audioSampleRate as number) / 1000} kHz
				</span>
				{ctl.recording ? (
					<span className="text-pr-danger" data-testid="mixer-recording">
						● Writing automation
					</span>
				) : null}
				<button
					type="button"
					className="ml-auto rounded-pr-control px-2 hover:bg-pr-hover hover:text-pr-text"
					onClick={() =>
						apply(session, 'Add Submix Track', [{ type: 'mixer.addSubmix', sequenceId: seq.id }])
					}
					data-testid="mixer-add-submix"
				>
					+ Submix
				</button>
			</div>
			<div className="flex min-h-0 flex-1 overflow-x-auto overflow-y-auto">
				{strips.map((s) => (
					<Strip
						key={s.id}
						session={session}
						seq={seq}
						strip={s}
						strips={strips}
						ctl={ctl}
						t={t}
						audioEffects={audioEffects}
					/>
				))}
			</div>
		</div>
	);
}
