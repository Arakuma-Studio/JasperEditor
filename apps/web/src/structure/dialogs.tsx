// edit-structure dialogs (Premiere's): Nested Sequence Name, Frame Hold Options, Color Matte (Color Picker) and the
// Universal Counting Leader Setup. Each applies one undoable transaction.
import {
	DEFAULT_LEADER_STYLE,
	DEFAULT_MATTE_COLOR,
	FLICKS_PER_SECOND,
	leaderStyleOf,
	type CountingLeaderStyle,
	type Rational,
	type RGBA,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import {
	Checkbox,
	ColorPicker,
	ColorSwatch,
	Dialog,
	type HostedDialogProps,
	registerDialog,
	Select,
	TextField,
	TimecodeField,
} from '@jasper/ui';
import { useMemo, useState } from 'react';

export const NEST_DIALOG = 'structure.nest';
export const FRAME_HOLD_DIALOG = 'structure.frameHoldOptions';
export const COLOR_MATTE_DIALOG = 'structure.colorMatte';
export const LEADER_DIALOG = 'structure.countingLeader';

let registered = false;
export function registerStructureDialogs(): void {
	if (registered) return;
	registered = true;
	registerDialog(NEST_DIALOG, NestDialog);
	registerDialog(FRAME_HOLD_DIALOG, FrameHoldOptionsDialog);
	registerDialog(COLOR_MATTE_DIALOG, ColorMatteDialog);
	registerDialog(LEADER_DIALOG, CountingLeaderDialog);
}

function useClose(close: (r?: unknown) => void) {
	const [open, setOpen] = useState(true);
	const [done, setDone] = useState(false);
	return {
		open,
		finish(result?: unknown) {
			setOpen(false);
			if (done) return;
			setDone(true);
			close(result);
		},
	};
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-2">
			<span className="w-[140px] shrink-0 text-pr-muted">{label}</span>
			{children}
		</div>
	);
}

// ---------------------------------------------------------------- Nest

function nextNestName(session: EditorSession): string {
	const names = new Set(Object.values(session.getCommitted().items).map((i) => i.name));
	for (let k = 1; ; k++) {
		const n = `Nested Sequence ${String(k).padStart(2, '0')}`;
		if (!names.has(n)) return n;
	}
}

type NestProps = { session: EditorSession; sequenceId: string; clipIds: string[] };

export function NestDialog(props: HostedDialogProps<NestProps>) {
	const { session, sequenceId, clipIds } = props;
	const { open, finish } = useClose(props.close);
	const [name, setName] = useState(() => nextNestName(session));
	const [error, setError] = useState<string | null>(null);
	const apply = () => {
		const r = session.apply({
			label: 'Nest',
			origin: 'user',
			sequenceId,
			commands: [{ type: 'clip.nest', clipIds, name: name.trim() || nextNestName(session) } as never],
			selectAfter: ((res: { results: unknown[] }) => ({
				timeline: (res.results[0] as { clipIds: string[] }).clipIds,
			})) as never,
		});
		if (!r.ok) {
			setError(r.errors[0]?.message ?? 'Nest failed');
			return false;
		}
		finish(r.results[0]);
		return true;
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title="Nested Sequence Name"
			size="small"
			primaryLabel="OK"
			onPrimary={apply}
			data-testid="nest-dialog"
		>
			<div className="flex flex-col gap-2 text-pr-ui">
				<TextField
					value={name}
					onChange={(e) => setName(e.target.value)}
					aria-label="Nested sequence name"
					data-testid="nest-name"
				/>
				{error ? (
					<p className="text-pr-small text-pr-danger" role="alert">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

// ---------------------------------------------------------------- Frame Hold Options

type HoldOn = 'source-time' | 'sequence-time' | 'in' | 'out' | 'playhead';
const HOLD_ON: { value: HoldOn; label: string }[] = [
	{ value: 'source-time', label: 'Source Timecode' },
	{ value: 'sequence-time', label: 'Sequence Time' },
	{ value: 'in', label: 'In Point' },
	{ value: 'out', label: 'Out Point' },
	{ value: 'playhead', label: 'Playhead' },
];

type FrameHoldProps = { session: EditorSession; sequenceId: string; clipIds: string[]; playhead: number };

export function FrameHoldOptionsDialog(props: HostedDialogProps<FrameHoldProps>) {
	const { session, sequenceId, clipIds, playhead } = props;
	const { open, finish } = useClose(props.close);
	const seq = session.getCommitted().sequences[sequenceId];
	const first = seq?.clips[clipIds[0] ?? ''];
	const rate = (seq?.settings.frameRate ?? { num: 30, den: 1 }) as Rational;
	const [enabled, setEnabled] = useState(true);
	const [holdOn, setHoldOn] = useState<HoldOn>(first?.frameHold ? 'source-time' : 'in');
	const [holdFilters, setHoldFilters] = useState(!!first?.frameHold?.holdFilters);
	const initialSource = first?.frameHold
		? Math.round((first.frameHold.flicks / FLICKS_PER_SECOND) * (rate.num / rate.den))
		: Math.round(((first?.sourceIn ?? 0) / FLICKS_PER_SECOND) * (rate.num / rate.den));
	const [sourceFrame, setSourceFrame] = useState(initialSource);
	const [seqFrame, setSeqFrame] = useState(playhead);
	const [error, setError] = useState<string | null>(null);
	const apply = () => {
		const cmd: Record<string, unknown> = { type: 'clip.frameHoldOptions', clipIds, enabled };
		if (enabled) {
			cmd.holdOn = holdOn;
			cmd.holdFilters = holdFilters;
			if (holdOn === 'source-time')
				cmd.sourceTime = { flicks: Math.round((sourceFrame * FLICKS_PER_SECOND * rate.den) / rate.num) };
			if (holdOn === 'sequence-time') cmd.at = seqFrame;
			if (holdOn === 'playhead') cmd.at = playhead;
		}
		const r = session.apply({ label: 'Frame Hold Options', origin: 'user', sequenceId, commands: [cmd as never] });
		if (!r.ok) {
			setError(r.errors[0]?.message ?? 'Frame Hold Options failed');
			return false;
		}
		finish(r.results[0]);
		return true;
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title="Frame Hold Options"
			size="small"
			primaryLabel="OK"
			onPrimary={apply}
			data-testid="frame-hold-dialog"
		>
			<div className="flex flex-col gap-3 text-pr-ui">
				<div className="flex items-center gap-2">
					<Checkbox checked={enabled} onCheckedChange={setEnabled} label="Hold On" id="frame-hold-enabled" />
					<Select
						value={holdOn}
						onValueChange={(v) => setHoldOn(v as HoldOn)}
						options={HOLD_ON}
						disabled={!enabled}
						label="Hold On"
						id="frame-hold-on"
					/>
				</div>
				{enabled && holdOn === 'source-time' ? (
					<Row label="Source Timecode">
						<TimecodeField frame={sourceFrame} rate={rate} onCommit={setSourceFrame} size="ui" label="Source Timecode" />
					</Row>
				) : null}
				{enabled && holdOn === 'sequence-time' ? (
					<Row label="Sequence Time">
						<TimecodeField frame={seqFrame} rate={rate} onCommit={setSeqFrame} size="ui" label="Sequence Time" />
					</Row>
				) : null}
				<Checkbox
					checked={holdFilters}
					onCheckedChange={setHoldFilters}
					disabled={!enabled}
					label="Hold Filters"
					id="frame-hold-filters"
				/>
				{error ? (
					<p className="text-pr-small text-pr-danger" role="alert">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

// ---------------------------------------------------------------- Color Matte

type ColorMatteProps = { session: EditorSession; syntheticId?: string; binId?: string | null };

export function ColorMatteDialog(props: HostedDialogProps<ColorMatteProps>) {
	const { session, syntheticId } = props;
	const { open, finish } = useClose(props.close);
	const existing = syntheticId ? session.getCommitted().synthetics[syntheticId] : undefined;
	const [color, setColor] = useState<RGBA>(
		existing?.kind === 'color-matte' ? ([...existing.color] as RGBA) : DEFAULT_MATTE_COLOR,
	);
	const [name, setName] = useState('Color Matte');
	const apply = () => {
		const r = session.apply({
			label: existing ? 'Edit Color Matte' : 'New Color Matte',
			origin: 'user',
			commands: [
				(existing
					? { type: 'synthetic.update', syntheticId: existing.id, params: { color } }
					: {
							type: 'synthetic.create',
							kind: 'color-matte',
							params: { color },
							name: name.trim() || 'Color Matte',
							...(props.binId !== undefined ? { binId: props.binId } : {}),
						}) as never,
			],
		});
		if (!r.ok) return false;
		const itemId = (r.results[0] as { itemId?: string }).itemId;
		if (itemId) session.select('project', [itemId], 'replace');
		finish(r.results[0]);
		return true;
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title={existing ? 'Color Picker' : 'New Color Matte'}
			size="small"
			primaryLabel="OK"
			onPrimary={apply}
			data-testid="color-matte-dialog"
		>
			<div className="flex flex-col gap-3 text-pr-ui">
				<ColorPicker value={color} onChange={(c) => setColor(c as RGBA)} alpha={false} />
				{existing ? null : (
					<Row label="Name">
						<TextField value={name} onChange={(e) => setName(e.target.value)} aria-label="Color matte name" />
					</Row>
				)}
			</div>
		</Dialog>
	);
}

// ---------------------------------------------------------------- Universal Counting Leader Setup

type LeaderProps = { session: EditorSession; syntheticId?: string; binId?: string | null };

const LEADER_COLORS: { key: keyof CountingLeaderStyle; label: string }[] = [
	{ key: 'wipeColor', label: 'Wipe Color' },
	{ key: 'backgroundColor', label: 'Background Color' },
	{ key: 'lineColor', label: 'Line Color' },
	{ key: 'targetColor', label: 'Target Color' },
	{ key: 'numeralColor', label: 'Numeral Color' },
];

export function CountingLeaderDialog(props: HostedDialogProps<LeaderProps>) {
	const { session, syntheticId } = props;
	const { open, finish } = useClose(props.close);
	const existing = syntheticId ? session.getCommitted().synthetics[syntheticId] : undefined;
	const initial = useMemo(
		() => (existing?.kind === 'counting-leader' ? leaderStyleOf(existing.style) : { ...DEFAULT_LEADER_STYLE }),
		[existing],
	);
	const [style, setStyle] = useState<CountingLeaderStyle>(initial);
	const set = <K extends keyof CountingLeaderStyle>(k: K, v: CountingLeaderStyle[K]) =>
		setStyle((s) => ({ ...s, [k]: v }));
	const apply = () => {
		const params = { ...style };
		const r = session.apply({
			label: existing ? 'Universal Counting Leader Setup' : 'New Universal Counting Leader',
			origin: 'user',
			commands: [
				(existing
					? { type: 'synthetic.update', syntheticId: existing.id, params }
					: {
							type: 'synthetic.create',
							kind: 'counting-leader',
							params,
							...(props.binId !== undefined ? { binId: props.binId } : {}),
						}) as never,
			],
		});
		if (!r.ok) return false;
		const itemId = (r.results[0] as { itemId?: string }).itemId;
		if (itemId) session.select('project', [itemId], 'replace');
		finish(r.results[0]);
		return true;
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title="Universal Counting Leader Setup"
			size="small"
			primaryLabel="OK"
			onPrimary={apply}
			data-testid="leader-dialog"
		>
			<div className="flex flex-col gap-2 text-pr-ui">
				{LEADER_COLORS.map(({ key, label }) => (
					<Row key={key} label={label}>
						<ColorSwatch
							label={label}
							value={style[key] as RGBA}
							onChange={(c) => set(key, c as never)}
							alpha={false}
						/>
					</Row>
				))}
				<Checkbox checked={style.cueBlipOnOut} onCheckedChange={(v) => set('cueBlipOnOut', v)} label="Cue Blip on out" />
				<Checkbox checked={style.cueBlipOnTwo} onCheckedChange={(v) => set('cueBlipOnTwo', v)} label="Cue Blip on 2" />
				<Checkbox
					checked={style.cueBlipAllSeconds}
					onCheckedChange={(v) => set('cueBlipAllSeconds', v)}
					label="Cue Blip at all Second Starts"
				/>
			</div>
		</Dialog>
	);
}
