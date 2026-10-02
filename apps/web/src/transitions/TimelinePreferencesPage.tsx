// Edit ▸ Preferences ▸ Timeline (S10:TUI-031…033), also opened by Sequence ▸ Transition Defaults…: the default
// transitions and their default durations, with the two scopes the model has made explicit:
//   - "This computer" (user preference, localStorage, never in History): the default video and audio
//     transition (the Effects panel's video/audio transitions), the alignment of the two-sided transitions that
//     Ctrl+D / Ctrl+Shift+D / Shift+D create, and the unit each duration is shown in. Applies immediately.
//   - "This project" (project settings, saved with the project): the video and audio transition default
//     durations and the still image default duration. Each change is one History step ("Default … Duration").
// Durations are entered in frames or seconds; seconds are converted at the active sequence's frame rate.
import { CROSS_DISSOLVE, type ProjectSettings, type Rational, TRANSITION_SPECS } from '@jasper/project';
import type { EditorSession, SessionState } from '@jasper/session';
import { useSessionOrNull, useStoreSelector } from '@jasper/session/react';
import { Button, cx, DIALOG_ESCAPE_REVERTS, Kbd, Select, TextField } from '@jasper/ui';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import {
	type DurationField,
	type DurationUnit,
	resetTransitionDefaults,
	TRANSITION_ALIGNMENTS,
	type TransitionAlignment,
	transitionDefaults,
	updateTransitionDefaults,
} from '../panels/effects/transition-prefs.ts';
import { useShellRuntimeOrNull } from '../shell/context.tsx';
import { shortcutFor } from '../shell/keymap/format.ts';
import { PrefGroup, PrefRow } from '../shell/preferences/GeneralPage.tsx';
import {
	formatFps,
	formatStillDuration,
	formatTransitionDuration,
	type ParsedDuration,
	parseStillDuration,
	parseTransitionDuration,
	stillEquivalent,
	transitionEquivalent,
} from './durations.ts';

const DEFAULT_RATE: Rational = { num: 30, den: 1 };

const UNIT_OPTIONS = [
	{ value: 'frames', label: 'frames' },
	{ value: 'seconds', label: 'seconds' },
];

function typeOptions(medium: 'video' | 'audio') {
	return TRANSITION_SPECS.filter((s) => s.appliesTo === medium).map((s) => ({ value: s.id, label: s.label }));
}

function ScopeBadge({ children, testId }: { children: ReactNode; testId: string }) {
	return (
		<span
			data-testid={testId}
			className="inline-flex h-[18px] items-center rounded-pr-control border border-pr-border-subtle bg-pr-field-deep px-1.5 text-pr-small text-pr-muted"
		>
			{children}
		</span>
	);
}

function Hint({
	children,
	tone = 'muted',
	testId,
}: {
	children: ReactNode;
	tone?: 'muted' | 'danger';
	testId?: string;
}) {
	return (
		<p
			data-testid={testId}
			role={tone === 'danger' ? 'alert' : undefined}
			className={cx('pl-[172px] text-pr-small', tone === 'danger' ? 'text-pr-danger' : 'text-pr-muted')}
		>
			{children}
		</p>
	);
}

export function TimelinePreferencesPage() {
	const session = useSessionOrNull();
	return (
		<div data-testid="prefs-timeline">
			<UserTransitionDefaults />
			{session ? (
				<ProjectDurations session={session} />
			) : (
				<PrefGroup
					title="Default durations"
					testId="prefs-durations"
					actions={<ScopeBadge testId="scope-project">This project</ScopeBadge>}
				>
					<p className="text-pr-muted" data-testid="prefs-durations-no-project">
						Open a project to edit its default transition and still image durations.
					</p>
				</PrefGroup>
			)}
		</div>
	);
}

// ---------------------------------------------------------------- user scope

function UserTransitionDefaults() {
	const prefs = useStoreSelector(transitionDefaults(), (s) => s);
	const runtime = useShellRuntimeOrNull();
	const keys = (id: string) =>
		shortcutFor(id, { platform: runtime?.platform ?? 'win', runtime: runtime?.runtime ?? 'web' });
	const vId = useId();
	const aId = useId();
	const alId = useId();
	const shortcuts = [
		['timeline.applyDefaultVideoTransition', 'video'],
		['timeline.applyDefaultAudioTransition', 'audio'],
		['timeline.applyDefaultTransitionsToSelection', 'both on the selection'],
	] as const;
	return (
		<PrefGroup
			title="Default transitions"
			testId="prefs-transition-types"
			actions={
				<>
					<ScopeBadge testId="scope-user">This computer</ScopeBadge>
					<Button
						variant="quiet"
						data-testid="prefs-transitions-reset"
						onClick={() => resetTransitionDefaults()}
						disabled={
							prefs.video === CROSS_DISSOLVE &&
							prefs.audio === 'jasper.constant-power' &&
							prefs.alignment === 'center'
						}
					>
						Reset
					</Button>
				</>
			}
		>
			<PrefRow label="Video transition" htmlFor={vId}>
				<Select
					id={vId}
					label="Default video transition"
					className="w-48"
					value={prefs.video}
					onValueChange={(v) => updateTransitionDefaults({ video: v })}
					options={typeOptions('video')}
				/>
			</PrefRow>
			<PrefRow label="Audio transition" htmlFor={aId}>
				<Select
					id={aId}
					label="Default audio transition"
					className="w-48"
					value={prefs.audio}
					onValueChange={(v) => updateTransitionDefaults({ audio: v })}
					options={typeOptions('audio')}
				/>
			</PrefRow>
			<PrefRow label="Alignment" htmlFor={alId}>
				<Select
					id={alId}
					label="Default transition alignment"
					className="w-48"
					value={prefs.alignment}
					onValueChange={(v) => updateTransitionDefaults({ alignment: v as TransitionAlignment })}
					options={TRANSITION_ALIGNMENTS}
				/>
			</PrefRow>
			<Hint>
				Between two clips; a fade at a free clip edge always sits inside the clip. Applied by{' '}
				{shortcuts.map(([id, what], i) => {
					const k = keys(id);
					return (
						<span key={id}>
							{i > 0 ? (i === shortcuts.length - 1 ? ' and ' : ', ') : null}
							{k ? <Kbd>{k}</Kbd> : null} ({what})
						</span>
					);
				})}
				, the clip menu&apos;s Apply Default Transitions and AI agents. Also set from the Effects panel or a
				transition&apos;s context menu (Set as Default Transition). Not saved in the project, not in History.
			</Hint>
		</PrefGroup>
	);
}

// ---------------------------------------------------------------- project scope

type Snapshot = {
	settings: ProjectSettings;
	rate: Rational;
	sequenceName: string | null;
	projectName: string;
	readOnly: boolean;
};

function sequenceName(s: SessionState, sequenceId: string): string | null {
	for (const it of Object.values(s.document.items))
		if (it.kind === 'sequence' && (it as { sequenceId?: string }).sequenceId === sequenceId) return it.name;
	return null;
}

function snapshotOf(s: SessionState): Snapshot {
	const doc = s.document;
	const seq =
		(s.activeSequenceId ? doc.sequences[s.activeSequenceId] : undefined) ?? Object.values(doc.sequences)[0];
	return {
		settings: doc.settings,
		rate: (seq?.settings.frameRate as Rational | undefined) ?? DEFAULT_RATE,
		sequenceName: seq ? sequenceName(s, seq.id) : null,
		projectName: doc.name,
		readOnly: s.readOnly,
	};
}

const sameSnapshot = (a: Snapshot, b: Snapshot) =>
	a.settings === b.settings &&
	a.rate.num === b.rate.num &&
	a.rate.den === b.rate.den &&
	a.sequenceName === b.sequenceName &&
	a.projectName === b.projectName &&
	a.readOnly === b.readOnly;

function ProjectDurations({ session }: { session: EditorSession }) {
	const snap = useStoreSelector(session.store, snapshotOf, sameSnapshot);
	const units = useStoreSelector(transitionDefaults(), (s) => s.units);
	const { settings, rate } = snap;
	const audioFrames = settings.defaultAudioTransitionFrames ?? settings.defaultTransitionFrames;

	const apply = (label: string, patch: Partial<ProjectSettings>): string | null => {
		const r = session.apply({
			label,
			origin: 'user',
			commands: [{ type: 'project.updateSettings', settings: patch }] as never[],
		});
		return r.ok ? null : (r.errors[0]?.message ?? `${label}: not possible`);
	};
	const setUnit = (field: DurationField, unit: DurationUnit) =>
		updateTransitionDefaults({ units: { ...units, [field]: unit } });

	return (
		<PrefGroup
			title="Default durations"
			testId="prefs-durations"
			actions={<ScopeBadge testId="scope-project">This project</ScopeBadge>}
		>
			<DurationRow
				label="Video transition"
				testId="pref-video-duration"
				value={settings.defaultTransitionFrames}
				unit={units.video}
				onUnit={(u) => setUnit('video', u)}
				parse={(t, u) => parseTransitionDuration(t, u, rate)}
				format={(v, u) => formatTransitionDuration(v, u, rate)}
				equivalent={(v, u) => transitionEquivalent(v, u, rate)}
				disabled={snap.readOnly}
				onCommit={(v) =>
					apply('Default Video Transition Duration', {
						defaultTransitionFrames: v,
						// Older projects keep one length for both media: pin the audio one so it does not follow.
						...(settings.defaultAudioTransitionFrames === undefined
							? { defaultAudioTransitionFrames: settings.defaultTransitionFrames }
							: {}),
					})
				}
			/>
			<DurationRow
				label="Audio transition"
				testId="pref-audio-duration"
				value={audioFrames}
				unit={units.audio}
				onUnit={(u) => setUnit('audio', u)}
				parse={(t, u) => parseTransitionDuration(t, u, rate)}
				format={(v, u) => formatTransitionDuration(v, u, rate)}
				equivalent={(v, u) => transitionEquivalent(v, u, rate)}
				disabled={snap.readOnly}
				onCommit={(v) => apply('Default Audio Transition Duration', { defaultAudioTransitionFrames: v })}
			/>
			<DurationRow
				label="Still image"
				testId="pref-still-duration"
				value={settings.defaultStillDurationFrames}
				unit={units.still}
				onUnit={(u) => setUnit('still', u)}
				parse={(t, u) => parseStillDuration(t, u, rate)}
				format={(v, u) => formatStillDuration(v, u, rate)}
				equivalent={(v, u) => stillEquivalent(v, u, rate)}
				disabled={snap.readOnly}
				onCommit={(v) => apply('Default Still Duration', { defaultStillDurationFrames: v })}
			/>
			<Hint testId="prefs-durations-scope">
				{snap.readOnly ? 'The project is read-only. ' : null}
				Saved with “{snap.projectName}”; each change is one History step (Undo with <Kbd>Ctrl+Z</Kbd>).
				Seconds are converted at{' '}
				{snap.sequenceName
					? `the frame rate of “${snap.sequenceName}” (${formatFps(rate)} fps)`
					: `${formatFps(rate)} fps (no sequence yet)`}
				. Used by new transitions (drag from the Effects panel, the default-transition keys, agents) and new
				stills; existing ones keep their length.
			</Hint>
		</PrefGroup>
	);
}

function DurationRow(props: {
	label: string;
	testId: string;
	value: number;
	unit: DurationUnit;
	onUnit(unit: DurationUnit): void;
	parse(text: string, unit: DurationUnit): ParsedDuration;
	format(value: number, unit: DurationUnit): string;
	equivalent(value: number, unit: DurationUnit): string;
	onCommit(value: number): string | null;
	disabled?: boolean;
}) {
	const id = useId();
	const shown = props.format(props.value, props.unit);
	const [draft, setDraft] = useState<string | null>(null);
	const [message, setMessage] = useState<{ tone: 'muted' | 'danger'; text: string } | null>(null);
	const committed = useRef<{ value: number; unit: DurationUnit } | null>(null);
	// Another stored value or unit (undo, another window, the unit menu) clears the note of the last commit.
	useEffect(() => {
		const c = committed.current;
		if (!c || c.value !== props.value || c.unit !== props.unit) {
			committed.current = null;
			setMessage(null);
		}
	}, [props.value, props.unit]);
	const text = draft ?? shown;
	const parsed = draft !== null ? props.parse(draft, props.unit) : null;
	const invalid = parsed !== null && !parsed.ok;

	const commit = () => {
		if (draft === null) return;
		const p = props.parse(draft, props.unit);
		if (!p.ok) return; // stays invalid (red) until fixed or Esc
		setDraft(null);
		committed.current = { value: p.value, unit: props.unit };
		if (p.value === props.value) {
			setMessage(p.note ? { tone: 'muted', text: p.note } : null);
			return;
		}
		const error = props.onCommit(p.value);
		setMessage(error ? { tone: 'danger', text: error } : p.note ? { tone: 'muted', text: p.note } : null);
	};
	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			commit();
		} else if (e.key === 'Escape' && draft !== null) {
			e.preventDefault();
			e.stopPropagation();
			setDraft(null);
		}
	};
	return (
		<>
			<PrefRow label={props.label} htmlFor={id}>
				<TextField
					id={id}
					data-testid={props.testId}
					{...{ [DIALOG_ESCAPE_REVERTS]: draft !== null ? 'true' : undefined }}
					aria-label={`${props.label} default duration`}
					className="w-20 text-right tabular-nums"
					inputMode="decimal"
					value={text}
					invalid={invalid}
					disabled={props.disabled}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={commit}
					onKeyDown={onKeyDown}
				/>
				<Select
					label={`${props.label} duration unit`}
					className="w-24"
					value={props.unit}
					onValueChange={(u) => {
						setDraft(null);
						props.onUnit(u as DurationUnit);
					}}
					options={UNIT_OPTIONS}
				/>
				<span
					className="min-w-0 truncate text-pr-small text-pr-muted"
					data-testid={`${props.testId}-equivalent`}
				>
					{parsed?.ok
						? props.equivalent(parsed.value, props.unit)
						: invalid
							? null
							: props.equivalent(props.value, props.unit)}
				</span>
			</PrefRow>
			{invalid ? (
				<Hint tone="danger" testId={`${props.testId}-error`}>
					{parsed.error}
				</Hint>
			) : message ? (
				<Hint tone={message.tone} testId={`${props.testId}-note`}>
					{message.text}
				</Hint>
			) : null}
		</>
	);
}
