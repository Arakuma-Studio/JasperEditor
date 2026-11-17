import type { CommandInput } from '@jasper/project';
// edit-ux dialogs (Premiere's): Fit Clip (four-point edits), Clip Speed / Duration and Make / Edit Subclip. Each
// applies one undoable transaction through the session.
//
// Sources (helpx.adobe.com): "Three-point and four-point editing" (Fit Clip: Change Clip Speed (Fit to Fill),
// Ignore Source In Point, Ignore Source Out Point, Ignore Sequence In Point, Ignore Sequence Out Point, "Always use
// this choice"); "Change clip speed and duration" (Speed %, Duration linked by the chain toggle, Reverse Speed,
// Maintain Audio Pitch, Ripple Edit, Shifting Trailing Clips; speed 0.01%–10000%); "Create subclips" (Name, Start /
// End, Restrict Trims To Subclip Boundaries).
import { type Clip, type FitClip, FLICKS_PER_SECOND, type Rational, type Sequence } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Checkbox, Dialog, type HostedDialogProps, registerDialog, TextField } from '@jasper/ui';
import { useId, useMemo, useState } from 'react';
import { useDialogClose } from '../extensions/dialog.ts';
import { formatTimecode, parseTimecodeEntry } from '../gaps/time-display.ts';

export const FIT_CLIP_DIALOG = 'editux.fitClip';
export const SPEED_DURATION_DIALOG = 'editux.speedDuration';
export const SUBCLIP_DIALOG = 'editux.subclip';
export const INSERT_TIME_DIALOG = 'editux.insertTime';

let registered = false;
export function registerEditUxDialogs(): void {
	if (registered) return;
	registered = true;
	registerDialog(FIT_CLIP_DIALOG, FitClipDialog);
	registerDialog(SPEED_DURATION_DIALOG, SpeedDurationDialog);
	registerDialog(SUBCLIP_DIALOG, SubclipDialog);
	registerDialog(INSERT_TIME_DIALOG, InsertTimeDialog);
}

function Row({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
	return (
		<div className="flex min-h-[26px] items-center gap-2">
			<label htmlFor={htmlFor} className="w-[150px] shrink-0 text-pr-muted">
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

const FIT_KEY = 'jasper:edit-ux:fit-clip';

export const FIT_CHOICES: { id: FitClip; label: string }[] = [
	{ id: 'change-speed', label: 'Change Clip Speed (Fit to Fill)' },
	{ id: 'ignore-source-in', label: 'Ignore Source In Point' },
	{ id: 'ignore-source-out', label: 'Ignore Source Out Point' },
	{ id: 'ignore-sequence-in', label: 'Ignore Sequence In Point' },
	{ id: 'ignore-sequence-out', label: 'Ignore Sequence Out Point' },
];

function storage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

/** The remembered Fit Clip choice ("Always use this choice"), or null to ask. */
export function rememberedFitChoice(): FitClip | null {
	const v = storage()?.getItem(FIT_KEY);
	return FIT_CHOICES.some((c) => c.id === v) ? (v as FitClip) : null;
}

export function rememberFitChoice(choice: FitClip | null): void {
	const s = storage();
	if (!s) return;
	if (choice) s.setItem(FIT_KEY, choice);
	else s.removeItem(FIT_KEY);
}

type FitProps = { message?: string; apply(fit: FitClip): { ok: boolean; message?: string } };

export function FitClipDialog(props: HostedDialogProps<FitProps>) {
	const { open, finish } = useDialogClose(props.close);
	const [choice, setChoice] = useState<FitClip>('change-speed');
	const [always, setAlways] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const name = useId();
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title="Fit Clip"
			description="The source and sequence durations differ"
			size="small"
			primaryLabel="OK"
			onPrimary={() => {
				const r = props.apply(choice);
				if (!r.ok) {
					setError(r.message ?? 'The edit is not possible');
					return false;
				}
				if (always) rememberFitChoice(choice);
				finish(choice);
				return true;
			}}
			data-testid="fit-clip-dialog"
		>
			<fieldset className="flex flex-col gap-1.5 text-pr-ui">
				<legend className="mb-1 text-pr-muted">Source and destination durations differ. Options:</legend>
				{FIT_CHOICES.map((c) => (
					<label key={c.id} className="flex items-center gap-2">
						<input
							type="radio"
							name={name}
							value={c.id}
							checked={choice === c.id}
							onChange={() => setChoice(c.id)}
							data-testid={`fit-clip-${c.id}`}
						/>
						{c.label}
					</label>
				))}
				<div className="mt-1">
					<Checkbox checked={always} onCheckedChange={setAlways} label="Always use this choice" />
				</div>
				<ErrorLine error={error} />
			</fieldset>
		</Dialog>
	);
}

type SpeedProps = { session: EditorSession; sequenceId: string; clipIds: string[] };

/** Speed limits of Premiere's dialog (0.01 % … 10000 %, as `clip.setSpeed` accepts). */
export const SPEED_MIN_PERCENT = 1;
export const SPEED_MAX_PERCENT = 10000;

export function SpeedDurationDialog(props: HostedDialogProps<SpeedProps>) {
	const { session, sequenceId, clipIds } = props;
	const { open, finish } = useDialogClose(props.close);
	const seq = session.getCommitted().sequences[sequenceId] as Sequence | undefined;
	const clips = useMemo(
		() => (seq ? clipIds.map((id) => seq.clips[id]).filter((c): c is Clip => !!c) : []),
		[seq, clipIds],
	);
	const rate = (seq?.settings.frameRate ?? { num: 30, den: 1 }) as Rational;
	const dropFrame = !!seq?.settings.dropFrame;
	const first = clips[0];
	const same = <T,>(f: (c: Clip) => T): T | null =>
		first && clips.every((c) => f(c) === f(first)) ? f(first) : null;
	const speed0 = same((c) => Math.round(c.speed.rate * 10000) / 100);
	const dur0 = same((c) => c.duration);
	const [speedText, setSpeedText] = useState(speed0 === null ? '' : String(speed0));
	const [durText, setDurText] = useState(dur0 === null ? '' : formatTimecode(dur0, rate, { dropFrame }));
	const [linked, setLinked] = useState(true);
	const [reverse, setReverse] = useState<boolean | 'mixed'>(same((c) => c.speed.reverse) ?? 'mixed');
	const [pitch, setPitch] = useState<boolean | 'mixed'>(same((c) => c.speed.maintainPitch) ?? 'mixed');
	const [ripple, setRipple] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = { speed: useId(), dur: useId() };
	const spanFrames = first ? first.duration * first.speed.rate : 0;
	const onSpeed = (t: string) => {
		setSpeedText(t);
		const v = Number(t);
		if (linked && first && Number.isFinite(v) && v > 0 && clips.length === 1)
			setDurText(formatTimecode(Math.max(1, Math.round(spanFrames / (v / 100))), rate, { dropFrame }));
	};
	const onDur = (t: string) => {
		setDurText(t);
		const f = parseTimecodeEntry(t, rate, { dropFrame, current: first?.duration ?? 0 });
		if (linked && first && f !== null && f > 0 && clips.length === 1)
			setSpeedText(String(Math.round((spanFrames / f) * 10000) / 100));
	};
	const apply = () => {
		const cmd: Extract<CommandInput, { type: 'clip.setSpeed' }> = { type: 'clip.setSpeed', clipIds, ripple };
		const v = Number(speedText);
		const speedChanged = speedText !== '' && (speed0 === null || v !== speed0);
		if (speedChanged) {
			if (!Number.isFinite(v) || v < SPEED_MIN_PERCENT / 100 || v > SPEED_MAX_PERCENT) {
				setError(`Speed must be between 0.01% and ${SPEED_MAX_PERCENT}%`);
				return false;
			}
			cmd.rate = v / 100;
		}
		const f = durText === '' ? null : parseTimecodeEntry(durText, rate, { dropFrame, current: dur0 ?? 0 });
		if (durText !== '' && (f === null || f < 1)) {
			setError('Invalid duration');
			return false;
		}
		const durChanged = f !== null && f !== dur0;
		if (durChanged) {
			cmd.duration = f;
			// Unlinked: the duration changes without changing the speed (Premiere's chain toggle).
			if (!linked && cmd.rate === undefined && first) cmd.rate = first.speed.rate;
			if (linked && speedChanged && clips.length === 1) delete cmd.duration;
		}
		if (reverse !== 'mixed') cmd.reverse = reverse;
		if (pitch !== 'mixed') cmd.maintainPitch = pitch;
		const r = session.apply({
			label: 'Speed/Duration',
			origin: 'user',
			sequenceId,
			commands: [cmd],
		});
		if (!r.ok) {
			setError(r.errors[0]?.message ?? 'Speed/Duration failed');
			return false;
		}
		finish(r.results[0]);
		return true;
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title="Clip Speed / Duration"
			size="small"
			primaryLabel="OK"
			onPrimary={apply}
			data-testid="speed-duration-dialog"
		>
			<div className="flex flex-col gap-1.5 text-pr-ui">
				<Row label="Speed" htmlFor={ids.speed}>
					<TextField
						id={ids.speed}
						value={speedText}
						placeholder="—"
						onChange={(e) => onSpeed(e.target.value)}
						aria-label="Speed (%)"
						data-testid="speed-percent"
					/>
					<span className="text-pr-muted">%</span>
					<button
						type="button"
						aria-pressed={linked}
						aria-label={linked ? 'Unlink speed and duration' : 'Link speed and duration'}
						title={linked ? 'Speed and duration are linked' : 'Speed and duration are unlinked'}
						className={`rounded-pr-control px-1.5 ${linked ? 'text-pr-accent' : 'text-pr-muted'} hover:bg-pr-hover`}
						onClick={() => setLinked((x) => !x)}
						data-testid="speed-link"
					>
						{linked ? '⛓' : '⛓̸'}
					</button>
				</Row>
				<Row label="Duration" htmlFor={ids.dur}>
					<TextField
						id={ids.dur}
						value={durText}
						placeholder="—"
						onChange={(e) => onDur(e.target.value)}
						aria-label="Duration"
						data-testid="speed-duration"
					/>
				</Row>
				<Checkbox checked={reverse} onCheckedChange={setReverse} label="Reverse Speed" />
				<Checkbox checked={pitch} onCheckedChange={setPitch} label="Maintain Audio Pitch" />
				<Checkbox checked={ripple} onCheckedChange={setRipple} label="Ripple Edit, Shifting Trailing Clips" />
				<ErrorLine error={error} />
			</div>
		</Dialog>
	);
}

type InsertTimeProps = {
	session: EditorSession;
	sequenceId: string;
	/** Default insert point (the playhead). */
	at: number;
	/** Targeted unlocked tracks (empty: nothing targeted). */
	targeted: string[];
	rippleMarkers: boolean;
};

/** Sequence ▸ Insert Time…: empty frames at a point on every unlocked (or the targeted) track, one undo step. */
export function InsertTimeDialog(props: HostedDialogProps<InsertTimeProps>) {
	const { session, sequenceId, targeted } = props;
	const { open, finish } = useDialogClose(props.close);
	const seq = session.getCommitted().sequences[sequenceId] as Sequence | undefined;
	const rate = (seq?.settings.frameRate ?? { num: 30, den: 1 }) as Rational;
	const dropFrame = !!seq?.settings.dropFrame;
	const second = Math.max(1, Math.round(rate.num / rate.den));
	const [atText, setAtText] = useState(formatTimecode(props.at, rate, { dropFrame }));
	const [durText, setDurText] = useState(formatTimecode(second, rate, { dropFrame }));
	const [targetedOnly, setTargetedOnly] = useState(false);
	const [markers, setMarkers] = useState(props.rippleMarkers);
	const [error, setError] = useState<string | null>(null);
	const ids = { at: useId(), dur: useId() };
	const apply = () => {
		const at = parseTimecodeEntry(atText, rate, { dropFrame, current: props.at });
		const n = parseTimecodeEntry(durText, rate, { dropFrame, current: second });
		if (at === null || at < 0) {
			setError('Invalid insert point');
			return false;
		}
		if (n === null || n < 1) {
			setError('Invalid duration');
			return false;
		}
		const r = session.apply({
			label: 'Insert Time',
			origin: 'user',
			sequenceId,
			commands: [
				{
					type: 'range.insertTime',
					at,
					duration: n,
					...(targetedOnly && targeted.length ? { tracks: targeted } : {}),
					rippleMarkers: markers,
				},
			],
		});
		if (!r.ok) {
			setError(r.errors[0]?.message ?? 'Insert Time failed');
			return false;
		}
		finish(r.results[0]);
		return true;
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title="Insert Time"
			size="small"
			primaryLabel="OK"
			onPrimary={apply}
			data-testid="insert-time-dialog"
		>
			<div className="flex flex-col gap-1.5 text-pr-ui">
				<Row label="Insert At" htmlFor={ids.at}>
					<TextField
						id={ids.at}
						value={atText}
						onChange={(e) => setAtText(e.target.value)}
						aria-label="Insert At"
						data-testid="insert-time-at"
					/>
				</Row>
				<Row label="Duration" htmlFor={ids.dur}>
					<TextField
						id={ids.dur}
						value={durText}
						onChange={(e) => setDurText(e.target.value)}
						aria-label="Duration"
						data-testid="insert-time-duration"
					/>
				</Row>
				<Checkbox
					checked={targetedOnly}
					onCheckedChange={setTargetedOnly}
					disabled={targeted.length === 0}
					label="Targeted Tracks Only"
				/>
				<Checkbox checked={markers} onCheckedChange={setMarkers} label="Ripple Sequence Markers" />
				<p className="text-pr-muted">
					Clips across the insert point are split. Locked tracks stay; sync-locked tracks follow.
				</p>
				<ErrorLine error={error} />
			</div>
		</Dialog>
	);
}

type SubclipProps = {
	session: EditorSession;
	/** Make: the media item (or subclip) and the range in content flicks; Edit: the subclip item. */
	mode: 'make' | 'edit';
	itemId: string;
	range: { in: number; out: number };
	fps: number;
	name?: string;
	restrictTrims?: boolean;
};

export function SubclipDialog(props: HostedDialogProps<SubclipProps>) {
	const { session, mode, itemId, fps } = props;
	const { open, finish } = useDialogClose(props.close);
	const rate: Rational = { num: Math.round(fps * 1000), den: 1000 };
	const toFrames = (fl: number) => Math.round((fl / FLICKS_PER_SECOND) * fps);
	const item = session.getCommitted().items[itemId];
	const [name, setName] = useState(
		props.name ?? (item ? `${item.name.replace(/\.[^.]+$/, '')}.Subclip` : 'Subclip'),
	);
	const [start, setStart] = useState(formatTimecode(toFrames(props.range.in), rate));
	const [end, setEnd] = useState(formatTimecode(Math.max(0, toFrames(props.range.out) - 1), rate));
	const [restrict, setRestrict] = useState(props.restrictTrims ?? false);
	const [error, setError] = useState<string | null>(null);
	const apply = () => {
		const a = parseTimecodeEntry(start, rate, { dropFrame: false, current: toFrames(props.range.in) });
		const b = parseTimecodeEntry(end, rate, { dropFrame: false, current: toFrames(props.range.out) - 1 });
		if (a === null || b === null || b < a) {
			setError("The subclip's end must be after its start");
			return false;
		}
		const range = { in: { sourceFrames: a }, out: { sourceFrames: b + 1 } };
		const cmd: CommandInput =
			mode === 'make'
				? {
						type: 'item.makeSubclip',
						itemId,
						...range,
						name: name.trim() || undefined,
						restrictTrims: restrict,
					}
				: { type: 'item.updateSubclip', itemId, ...range, restrictTrims: restrict };
		const commands: CommandInput[] = [cmd];
		if (mode === 'edit' && name.trim() && name.trim() !== item?.name)
			commands.push({ type: 'item.rename', itemIds: [itemId], name: name.trim() });
		const r = session.apply({
			label: mode === 'make' ? 'Make Subclip' : 'Edit Subclip',
			origin: 'user',
			commands,
			...(mode === 'make'
				? { selectAfter: (res) => ({ project: [(res.results[0] as { itemId: string }).itemId] }) }
				: {}),
		});
		if (!r.ok) {
			setError(r.errors[0]?.message ?? 'Subclip failed');
			return false;
		}
		finish(r.results[0]);
		return true;
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title={mode === 'make' ? 'Make Subclip' : 'Edit Subclip'}
			size="small"
			primaryLabel="OK"
			onPrimary={apply}
			data-testid="subclip-dialog"
		>
			<div className="flex flex-col gap-1.5 text-pr-ui">
				<Row label="Name">
					<TextField
						value={name}
						onChange={(e) => setName(e.target.value)}
						aria-label="Subclip name"
						data-testid="subclip-name"
					/>
				</Row>
				<Row label="Start">
					<TextField
						value={start}
						onChange={(e) => setStart(e.target.value)}
						aria-label="Subclip start"
						data-testid="subclip-start"
					/>
				</Row>
				<Row label="End">
					<TextField
						value={end}
						onChange={(e) => setEnd(e.target.value)}
						aria-label="Subclip end"
						data-testid="subclip-end"
					/>
				</Row>
				<Checkbox
					checked={restrict}
					onCheckedChange={setRestrict}
					label="Restrict Trims To Subclip Boundaries"
				/>
				<ErrorLine error={error} />
			</div>
		</Dialog>
	);
}
