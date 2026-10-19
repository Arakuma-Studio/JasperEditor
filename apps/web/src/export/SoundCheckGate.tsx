// "Run Sound Check before export" (spec 12 §2.7 "Optional 'Run Sound Check before export' in the Export dialog", P5-R3;
// wp-note "Phase 5 → WP5.2"): shown when the sequence has sound effects. When it is on, Export runs the Sound Check of
// the sequence first (its delivery target as the Sound Check panel has it; the summary is stored like any run), with the
// progress and Cancel in the dialog; a pass or warnings export straight away (the verdict is said), a fail stops with
// the summary and two choices — Export anyway, or Review issues (Export mode closes, the Sound Check panel opens with
// the report). The check delivers the mix as this export encodes it (`exportAudioOf`: the plan's audio codec and the
// bit rate), so LOUDNESS / TRUE_PEAK judge the decoded AAC / Opus. The choice is remembered per browser (off by default). Credits: `ExportSettings` has no credits option
// yet (Phase 6 adds the sidecar and defaults it from `soundDesign.settings.credits`).
import type { SoundCheckExportAudio, SoundCheckReport } from '@jasper/api';
import { isSfxClip, type Sequence } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Button, Icon } from '@jasper/ui';
import { type ReactNode, useCallback, useRef, useState } from 'react';
import { t } from '../i18n/runtime.ts';
import {
	countsText,
	VERDICT_ICON,
	VERDICT_LABELS,
	VERDICT_TONE,
	verdictSentence,
} from '../sound/check-model.ts';
import { type CheckEngine, cancelSoundCheck, runSoundCheck, soundCheckStore } from '../sound/check-run.ts';
import { fmtDb } from '../sound/mix-model.ts';

const PREF_KEY = 'jasper:sound-check-before-export';

function readPref(): boolean {
	try {
		return typeof localStorage !== 'undefined' && localStorage.getItem(PREF_KEY) === '1';
	} catch {
		return false;
	}
}
function writePref(on: boolean) {
	try {
		if (on) localStorage.setItem(PREF_KEY, '1');
		else localStorage.removeItem(PREF_KEY);
	} catch {
		// private mode / full storage: the choice lasts this dialog
	}
}

/** The audio encoding of an export for Sound Check: the plan's codec (what the file will hold) and the bit rate. */
export function exportAudioOf(
	planCodec: string | undefined,
	audio: { bitrateKbps?: number; sampleRate?: number } | undefined,
): SoundCheckExportAudio | undefined {
	if (!planCodec) return undefined;
	const codec = planCodec === 'libopus' ? 'opus' : planCodec.startsWith('pcm_') ? 'pcm' : 'aac';
	const rate = audio?.sampleRate;
	return {
		codec,
		...(codec !== 'pcm' && audio?.bitrateKbps ? { bitrateKbps: audio.bitrateKbps } : {}),
		...(rate === 44100 || rate === 48000 || rate === 96000 ? { sampleRate: rate } : {}),
	};
}

/** Whether the sequence has sound effects (the option is shown only then). */
export function hasSoundEffects(seq: Sequence | undefined): boolean {
	return !!seq && Object.values(seq.clips).some((c) => c.kind === 'audio' && isSfxClip(c));
}

type GateState =
	| { kind: 'idle' }
	| { kind: 'checking'; progress: number | null; stage: string | null }
	| { kind: 'failed'; report: SoundCheckReport }
	| { kind: 'error'; message: string };

export type ExportSoundCheck = {
	/** The checkbox (null when the sequence has no sound effects). */
	section: ReactNode;
	/** The progress / verdict prompt above the footer (null when idle). */
	prompt: ReactNode;
	/** Whether Export is waiting for the check. */
	busy: boolean;
	/**
	 * Before starting the export: resolves true to go on, false to stop (cancelled, or the user reviews issues). With the
	 * export's audio encoding the check judges loudness and true peak on the decoded codec audio, as the export delivers.
	 */
	gate(exportAudio?: SoundCheckExportAudio): Promise<boolean>;
};

export function useExportSoundCheck(opts: {
	session: EditorSession;
	engine: CheckEngine | null;
	seq: Sequence | undefined;
	/** Leave Export mode and show the Sound Check panel. */
	onReview(): void;
	/** Tell the user something (the verdict of a passing check). */
	notify(message: string): void;
}): ExportSoundCheck {
	const { session, engine, seq } = opts;
	const [on, setOn] = useState(readPref);
	const [state, setState] = useState<GateState>({ kind: 'idle' });
	const decide = useRef<((go: boolean) => void) | null>(null);
	const visible = hasSoundEffects(seq);

	const gate = useCallback(
		async (exportAudio?: SoundCheckExportAudio): Promise<boolean> => {
			if (!on || !visible || !seq || !engine) return true;
			setState({ kind: 'checking', progress: null, stage: null });
			const store = soundCheckStore(session);
			const off = store.subscribe((s) => {
				if (s.running?.sequenceId === seq.id)
					setState({ kind: 'checking', progress: s.running.progress, stage: s.running.stage });
			});
			const r = await runSoundCheck(session, engine, {
				sequenceId: seq.id,
				...(exportAudio ? { exportAudio } : {}),
			});
			off();
			if (!r.ok) {
				if (r.cancelled) {
					setState({ kind: 'idle' });
					return false;
				}
				setState({ kind: 'error', message: r.message });
				return new Promise<boolean>((resolve) => {
					decide.current = resolve;
				});
			}
			const report = r.result.report;
			if (report.verdict !== 'fail') {
				setState({ kind: 'idle' });
				opts.notify(verdictSentence(report.verdict, report.counts));
				return true;
			}
			setState({ kind: 'failed', report });
			return new Promise<boolean>((resolve) => {
				decide.current = resolve;
			});
		},
		[on, visible, seq, engine, session, opts],
	);

	const choose = (go: boolean, review = false) => {
		const d = decide.current;
		decide.current = null;
		setState({ kind: 'idle' });
		d?.(go);
		if (review) opts.onReview();
	};

	const section = visible ? (
		<label className="flex items-center gap-2 text-pr-small" data-testid="export-sound-check">
			<input
				type="checkbox"
				data-testid="export-sound-check-toggle"
				checked={on}
				onChange={(e) => {
					setOn(e.target.checked);
					writePref(e.target.checked);
				}}
			/>
			{t('Run Sound Check before export')}
		</label>
	) : null;

	let prompt: ReactNode = null;
	if (state.kind === 'checking')
		prompt = (
			<div
				className="flex items-center gap-2 border-t border-pr-border-subtle px-3 py-2 text-pr-small"
				data-testid="export-sound-check-running"
				role="status"
			>
				<span>{t('Sound Check before export: {0}', state.stage ?? t('Measuring…'))}</span>
				<span className="pr-tabular text-pr-muted">
					{state.progress === null ? '' : `${Math.round(state.progress * 100)} %`}
				</span>
				<Button className="ml-auto" onClick={() => cancelSoundCheck(session)}>
					{t('Cancel')}
				</Button>
			</div>
		);
	else if (state.kind === 'failed' || state.kind === 'error') {
		const report = state.kind === 'failed' ? state.report : null;
		prompt = (
			<div
				role="alertdialog"
				aria-labelledby="export-sound-check-title"
				className="flex flex-wrap items-center gap-2 border-t border-pr-border-subtle bg-pr-raised px-3 py-2 text-pr-small"
				data-testid="export-sound-check-prompt"
			>
				{report ? (
					<span className={`inline-flex items-center gap-1 font-semibold ${VERDICT_TONE[report.verdict]}`}>
						<Icon id={VERDICT_ICON[report.verdict]} size={14} />
						{t(VERDICT_LABELS[report.verdict])}
					</span>
				) : null}
				<span id="export-sound-check-title" className="min-w-0 flex-1">
					{report
						? t(
								'Sound Check: {0}. Integrated {1} LUFS, true peak {2} dBTP. Review the findings, or export anyway.',
								countsText(report.counts),
								report.loudness.integratedLufs === null ? '–' : fmtDb(report.loudness.integratedLufs),
								report.loudness.truePeakDb === null ? '–' : fmtDb(report.loudness.truePeakDb),
							)
						: t('The Sound Check could not run: {0}', state.kind === 'error' ? state.message : '')}
				</span>
				<Button onClick={() => choose(false, true)} data-testid="export-sound-check-review">
					{t('Review issues')}
				</Button>
				<Button variant="primary" onClick={() => choose(true)} data-testid="export-sound-check-anyway">
					{t('Export anyway')}
				</Button>
			</div>
		);
	}
	return { section, prompt, busy: state.kind !== 'idle', gate };
}
