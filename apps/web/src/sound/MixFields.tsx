// A cue's stop-before and build (spec 12 §2.4 / §2.7; wp-note "Phase 4 → WP4.2b"), edited the same way in Properties ▸
// Cue and Essential Sound ▸ Sound Design: a toggle, the numbers (validated before anything is written: a dip needs a
// length and a depth under 0 dB, a build rises from From to To Hz), and where it stands — written into the mix (which
// tracks or clips) or only stored on the cue, with why. Every edit is ONE `soundCue.update` (on a filled cue the mix
// follows in the same command, WP4.2a); "Write Now" runs `soundDesign.applyStopBefore` / `applyBuild` for a cue that
// is not filled yet.
import {
	BUILD_DEFAULT,
	type Command,
	type Sequence,
	type SoundCue,
	STOP_BEFORE_DEFAULT,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Button, Checkbox, cx, toast } from '@jasper/ui';
import { useEffect, useId, useState } from 'react';
import { t } from '../i18n/runtime.ts';
import { useEngineOrNull } from '../state/engine.tsx';
import { stopBeforeNextCommands, withMusicGrid } from './cues/stop-on-bar.ts';
import {
	type CueMixKind,
	cueMixState,
	type FieldError,
	parseNumber,
	validateBuild,
	validateStopBefore,
} from './mix-model.ts';

/** A number typed in a small field: commits on Enter or blur; shows the invalid state the caller reports. */
export function NumberInput(props: {
	label: string;
	value: number;
	unit: string;
	disabled?: boolean;
	error?: string | null;
	onCommit(v: number | null): void;
	testId?: string;
	className?: string;
}) {
	const [draft, setDraft] = useState(String(props.value));
	const [focused, setFocused] = useState(false);
	useEffect(() => {
		if (!focused) setDraft(String(props.value));
	}, [props.value, focused]);
	const commit = () => {
		const n = parseNumber(draft);
		if (n === props.value) return;
		props.onCommit(n);
	};
	return (
		<label className={cx('flex items-center gap-1 text-pr-small', props.className)}>
			<span className="text-pr-muted">{props.label}</span>
			<input
				type="text"
				inputMode="decimal"
				aria-label={props.label}
				aria-invalid={props.error ? true : undefined}
				className={cx(
					'h-[20px] w-[56px] rounded-pr-control border bg-pr-field px-1 text-right text-pr-small text-pr-text pr-tabular',
					props.error ? 'border-pr-warning' : 'border-pr-border-subtle',
				)}
				value={draft}
				disabled={props.disabled}
				onFocus={() => setFocused(true)}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={() => {
					setFocused(false);
					commit();
				}}
				onKeyDown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						commit();
					} else if (e.key === 'Escape') {
						setDraft(String(props.value));
					}
				}}
				data-testid={props.testId}
			/>
			<span className="text-pr-dim">{props.unit}</span>
		</label>
	);
}

function updateCue(
	session: EditorSession,
	seqId: string,
	cueId: string,
	label: string,
	patch: object,
): boolean {
	const r = session.apply({
		label,
		origin: 'user',
		sequenceId: seqId,
		commands: [{ type: 'soundCue.update', cueId, ...patch } as Command],
	});
	if (!r.ok) toast({ kind: 'warning', title: r.errors[0]?.message ?? t('Edit failed') });
	return r.ok;
}

/** "Write Now": the explicit realisation (any cue, filled or not). */
function writeNow(session: EditorSession, seqId: string, cue: SoundCue, kind: CueMixKind): void {
	const r = session.apply({
		label: kind === 'stopBefore' ? t('Stop Before Cue') : t('Build Into Cue'),
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{
				type: kind === 'stopBefore' ? 'soundDesign.applyStopBefore' : 'soundDesign.applyBuild',
				cueId: cue.id,
			} as Command,
		],
	});
	if (!r.ok) {
		toast({ kind: 'warning', title: r.errors[0]?.message ?? t('Edit failed') });
		return;
	}
	const res = r.results[0] as { applied?: boolean; reason?: string | null } | undefined;
	if (res && !res.applied)
		toast({ kind: 'info', title: t('Nothing was written'), ...(res.reason ? { detail: res.reason } : {}) });
}

function Status(props: {
	seq: Sequence;
	cue: SoundCue;
	kind: CueMixKind;
	session: EditorSession;
	readOnly: boolean;
	testId: string;
}) {
	const st = cueMixState(props.seq, props.cue)[props.kind];
	if (!props.cue[props.kind]) return null;
	return (
		<div className="flex flex-wrap items-center gap-1 text-pr-small" data-testid={props.testId}>
			{st.written ? (
				<span className="text-pr-muted" data-written="true">
					<span aria-hidden="true">● </span>
					{t('Written into the mix: {0}', st.written.places.join(', ') || t('nothing'))}
				</span>
			) : (
				<>
					<span className="text-pr-dim" data-written="false">
						<span aria-hidden="true">○ </span>
						{t('Stored on the cue: {0}', st.why ?? '')}
					</span>
					{!props.cue.muted ? (
						<Button
							variant="quiet"
							disabled={props.readOnly}
							onClick={() => writeNow(props.session, props.seq.id, props.cue, props.kind)}
							data-testid={`${props.testId}-write`}
						>
							Write Now
						</Button>
					) : null}
				</>
			)}
		</div>
	);
}

const errorOf = (errors: readonly FieldError[], field: string) =>
	errors.find((e) => e.field === field)?.message ?? null;

/** Stop before next: toggle, length (s) and depth (dB), validated; and where it stands. */
export function StopBeforeEditor(props: {
	session: EditorSession;
	seq: Sequence;
	cue: SoundCue;
	readOnly: boolean;
	testId?: string;
}) {
	const { session, seq, cue, readOnly } = props;
	const id = props.testId ?? 'stop-before';
	// cached beat analyses put the stop on the bar line, as the cue menu does (`stopBeforeNextCommands`)
	const engine = useEngineOrNull()?.client ?? null;
	const [errors, setErrors] = useState<FieldError[]>([]);
	const errId = useId();
	// biome-ignore lint/correctness/useExhaustiveDependencies: errors belong to the cue they were made on
	useEffect(() => setErrors([]), [cue.id]);
	const sb = cue.stopBefore;
	const commit = (patch: Partial<{ seconds: number | null; depthDb: number | null }>) => {
		if (!sb) return;
		const next = {
			seconds: patch.seconds === undefined ? sb.seconds : (patch.seconds ?? Number.NaN),
			depthDb: patch.depthDb === undefined ? sb.depthDb : (patch.depthDb ?? Number.NaN),
		};
		const errs = validateStopBefore(next);
		setErrors(errs);
		if (!errs.length) updateCue(session, seq.id, cue.id, t('Stop Before Next'), { stopBefore: next });
	};
	return (
		<div className="flex flex-col gap-1" data-testid={id}>
			<Checkbox
				checked={!!sb}
				disabled={readOnly}
				label={t('Stop before next (dip the music before the cue)')}
				onCheckedChange={(on) => {
					setErrors([]);
					if (!on) {
						updateCue(session, seq.id, cue.id, t('Stop Before Next'), { stopBefore: null });
						return;
					}
					const doc = session.getCommitted();
					const s0 = doc.sequences[seq.id];
					if (!s0) return;
					withMusicGrid(engine, doc, s0, (grid) => {
						const now = session.getCommitted().sequences[seq.id];
						const cmd = now ? stopBeforeNextCommands(now, [cue.id], grid).commands[0] : undefined;
						const stopBefore = (cmd as { stopBefore?: unknown } | undefined)?.stopBefore ?? {
							...STOP_BEFORE_DEFAULT,
						};
						updateCue(session, seq.id, cue.id, t('Stop Before Next'), { stopBefore });
					});
				}}
			/>
			{sb ? (
				<div
					className="flex flex-wrap items-center gap-2 pl-5"
					aria-describedby={errors.length ? errId : undefined}
				>
					<NumberInput
						label={t('Length')}
						unit="s"
						value={sb.seconds}
						disabled={readOnly}
						error={errorOf(errors, 'seconds')}
						onCommit={(v) => commit({ seconds: v })}
						testId={`${id}-seconds`}
					/>
					<NumberInput
						label={t('Depth')}
						unit="dB"
						value={sb.depthDb}
						disabled={readOnly}
						error={errorOf(errors, 'depthDb')}
						onCommit={(v) => commit({ depthDb: v })}
						testId={`${id}-depth`}
					/>
				</div>
			) : null}
			{errors.length ? (
				<p id={errId} role="alert" className="pl-5 text-pr-small text-pr-warning" data-testid={`${id}-error`}>
					{errors.map((e) => e.message).join(' · ')}
				</p>
			) : null}
			<div className="pl-5">
				<Status
					seq={seq}
					cue={cue}
					kind="stopBefore"
					session={session}
					readOnly={readOnly}
					testId={`${id}-status`}
				/>
			</div>
		</div>
	);
}

/** Build into the cue: toggle, length (s), From and To (Hz), validated; and where it stands. */
export function BuildEditor(props: {
	session: EditorSession;
	seq: Sequence;
	cue: SoundCue;
	readOnly: boolean;
	testId?: string;
}) {
	const { session, seq, cue, readOnly } = props;
	const id = props.testId ?? 'build';
	const [errors, setErrors] = useState<FieldError[]>([]);
	const errId = useId();
	// biome-ignore lint/correctness/useExhaustiveDependencies: errors belong to the cue they were made on
	useEffect(() => setErrors([]), [cue.id]);
	const b = cue.build;
	const commit = (patch: Partial<Record<'seconds' | 'fromHz' | 'toHz', number | null>>) => {
		if (!b) return;
		const pick = (k: 'seconds' | 'fromHz' | 'toHz') =>
			patch[k] === undefined ? b[k] : (patch[k] ?? Number.NaN);
		const next = { seconds: pick('seconds'), fromHz: pick('fromHz'), toHz: pick('toHz') };
		const errs = validateBuild(next);
		setErrors(errs);
		if (!errs.length) updateCue(session, seq.id, cue.id, t('Cue Build'), { build: next });
	};
	return (
		<div className="flex flex-col gap-1" data-testid={id}>
			<Checkbox
				checked={!!b}
				disabled={readOnly}
				label={t('Build (a rising high-pass on the music into the cue)')}
				onCheckedChange={(on) => {
					setErrors([]);
					updateCue(session, seq.id, cue.id, t('Cue Build'), { build: on ? { ...BUILD_DEFAULT } : null });
				}}
			/>
			{b ? (
				<div
					className="flex flex-wrap items-center gap-2 pl-5"
					aria-describedby={errors.length ? errId : undefined}
				>
					<NumberInput
						label={t('Length')}
						unit="s"
						value={b.seconds}
						disabled={readOnly}
						error={errorOf(errors, 'seconds')}
						onCommit={(v) => commit({ seconds: v })}
						testId={`${id}-seconds`}
					/>
					<NumberInput
						label={t('From')}
						unit="Hz"
						value={b.fromHz}
						disabled={readOnly}
						error={errorOf(errors, 'fromHz')}
						onCommit={(v) => commit({ fromHz: v })}
						testId={`${id}-from`}
					/>
					<NumberInput
						label={t('To')}
						unit="Hz"
						value={b.toHz}
						disabled={readOnly}
						error={errorOf(errors, 'toHz')}
						onCommit={(v) => commit({ toHz: v })}
						testId={`${id}-to`}
					/>
				</div>
			) : null}
			{errors.length ? (
				<p id={errId} role="alert" className="pl-5 text-pr-small text-pr-warning" data-testid={`${id}-error`}>
					{errors.map((e) => e.message).join(' · ')}
				</p>
			) : null}
			<div className="pl-5">
				<Status
					seq={seq}
					cue={cue}
					kind="build"
					session={session}
					readOnly={readOnly}
					testId={`${id}-status`}
				/>
			</div>
		</div>
	);
}
