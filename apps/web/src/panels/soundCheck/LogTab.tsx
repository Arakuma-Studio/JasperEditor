// The Sound Check panel's Log tab (spec 12 §4 P6-E6 / P6-E7; wp-note "Phase 6 → WP-E3"): the listening transcript of
// the active sequence — Listen (the engine's `sound-listen` job: progress, Cancel), the detail (Low / Normal / High),
// Copy log, and the lines MCP `listen_to_sequence` returns, verbatim: sections, silences, every sound with the clip that
// plays it and the cue it fills, which cuts and cues it answers, the picture events with no sound (marked), each sync
// share next to its chance level. A line is a timecode: clicking it (or Enter) moves the playhead there and selects the
// clip that plays the sound (else its cue). Spectrogram shows the mix's log-frequency spectrogram of the listened range
// (≤ 120 s around the current line) with the line's moment marked. Keyboard: the list is one tab stop (↑ ↓ Home End
// move, Enter goes to the line); everything else is buttons. Progress and the outcome are announced (aria-live).
import {
	SOUND_LISTEN_DETAILS,
	type SoundListenDetail,
	type SoundListenLine,
	type SoundListenResult,
} from '@jasper/api';
import type { Sequence } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { Button, Icon, Select } from '@jasper/ui';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../i18n/runtime.ts';
import {
	cancelListen,
	jumpToLine,
	type ListenEngine,
	listenRangeFor,
	listenStore,
	runListen,
	setListenDetail,
	setListenSpectrogram,
	spectrogramWindow,
	stepLine,
	transcriptText,
} from './listen-run.ts';
import { spectrogramColour } from './spectrogram.tokens.ts';

const DETAIL_LABELS: Record<SoundListenDetail, string> = {
	low: 'Low: sections, sync, accents, no-sound',
	normal: 'Normal: also every placed sound',
	high: 'High: every event',
};

const LINE_TONE: Record<SoundListenLine['kind'], string> = {
	summary: 'text-pr-strong',
	sync: 'text-pr-text',
	section: 'font-semibold text-pr-strong',
	event: 'text-pr-text',
	unanswered: 'text-pr-danger',
	silence: 'text-pr-muted',
	note: 'text-pr-muted',
};

export function LogTab(props: {
	session: EditorSession;
	engine: ListenEngine | null;
	seq: Sequence | undefined;
	connected: boolean;
	reveal(frame: number): void;
}) {
	const { session, engine, seq } = props;
	const store = listenStore(session);
	const result = useStoreSelector(store, (s) => s.result);
	const running = useStoreSelector(store, (s) => s.running);
	const error = useStoreSelector(store, (s) => s.error);
	const detail = useStoreSelector(store, (s) => s.detail);
	const cursor = useStoreSelector(store, (s) => s.cursor);
	const showSpec = useStoreSelector(store, (s) => s.spectrogram);
	const [copied, setCopied] = useState(false);
	const shown = result && seq && result.sequenceId === seq.id ? result : null;
	const options = useMemo(
		() => SOUND_LISTEN_DETAILS.map((d) => ({ value: d, label: t(DETAIL_LABELS[d]) })),
		[],
	);
	const disabled = !engine || !props.connected || !seq;
	const reason = !seq
		? t('Open a sequence first')
		: !props.connected || !engine
			? t('The engine is not connected')
			: undefined;
	let playhead = 0;
	try {
		playhead = session.transport.getState().frame;
	} catch {
		// no Program player
	}
	const note = seq ? listenRangeFor(seq, playhead).note : null;
	const listen = () => {
		if (engine && seq) void runListen(session, engine, { sequenceId: seq.id });
	};
	const copy = async () => {
		if (!shown) return;
		try {
			await navigator.clipboard.writeText(transcriptText(shown));
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			setCopied(false);
		}
	};
	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="sound-listen-log">
			<div className="flex flex-wrap items-center gap-2 border-b border-pr-border px-2 py-1">
				{running && running.sequenceId === seq?.id ? (
					<Button variant="secondary" data-testid="sound-listen-cancel" onClick={() => cancelListen(session)}>
						{t('Cancel')}
					</Button>
				) : (
					<Button
						variant="primary"
						data-testid="sound-listen-run"
						disabled={disabled}
						disabledReason={reason}
						onClick={listen}
					>
						{shown ? t('Listen again') : t('Listen')}
					</Button>
				)}
				<Select
					label={t('Detail')}
					value={detail}
					options={options}
					onValueChange={(v) => setListenDetail(session, v as SoundListenDetail)}
				/>
				<Button
					variant="quiet"
					data-testid="sound-listen-copy"
					disabled={!shown}
					disabledReason={t('Listen first')}
					onClick={() => void copy()}
				>
					<Icon id="app.copy" size={14} />
					{copied ? t('Copied') : t('Copy log')}
				</Button>
				<Button
					variant="quiet"
					data-testid="sound-listen-spectrogram"
					aria-pressed={showSpec}
					disabled={!shown || !engine?.soundVisual}
					disabledReason={t('Listen first')}
					onClick={() => setListenSpectrogram(session, !showSpec)}
				>
					{t('Spectrogram')}
				</Button>
			</div>
			{note ? (
				<p className="m-0 border-b border-pr-border px-2 py-1 text-pr-small text-pr-muted">{note}</p>
			) : null}
			{running && running.sequenceId === seq?.id ? (
				<div className="shrink-0 border-b border-pr-border px-2 py-1" data-testid="sound-listen-progress">
					<div className="flex items-center justify-between text-pr-small text-pr-muted">
						<span>{running.stage ?? t('Listening…')}</span>
						<span className="pr-tabular">
							{running.progress === null ? '' : `${Math.round(running.progress * 100)} %`}
						</span>
					</div>
					<div
						role="progressbar"
						aria-label={t('Listen progress')}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={running.progress === null ? undefined : Math.round(running.progress * 100)}
						className="mt-0.5 h-1 w-full overflow-hidden rounded-pr-pill bg-pr-field"
					>
						<div
							className="h-full bg-pr-accent-fill"
							style={{ width: `${Math.round((running.progress ?? 0.02) * 100)}%` }}
						/>
					</div>
				</div>
			) : null}
			{error ? (
				<p
					role="alert"
					className="m-0 shrink-0 border-b border-pr-border px-2 py-1 text-pr-small text-pr-danger"
				>
					{t('The listen failed: {0}', error)}
				</p>
			) : null}
			{shown && showSpec && engine?.soundVisual ? (
				<SpectrogramStrip session={session} engine={engine} result={shown} cursor={cursor} />
			) : null}
			{shown ? (
				<Lines session={session} result={shown} cursor={cursor} reveal={props.reveal} />
			) : !running ? (
				<p className="m-0 p-4 text-center text-pr-small text-pr-muted">
					{t(
						'Listen writes a log of the mix: every sound with the clip that plays it and the cue it fills, the sections, the silences, and which cuts and cues have a sound — each share next to what random timing would score. Agents read the same log (listen_to_sequence).',
					)}
				</p>
			) : null}
		</div>
	);
}

function Lines(props: {
	session: EditorSession;
	result: SoundListenResult;
	cursor: number | null;
	reveal(frame: number): void;
}) {
	const { session, result, cursor } = props;
	const idPrefix = 'sound-listen-line-';
	const listRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (cursor === null) return;
		document.getElementById(`${idPrefix}${cursor}`)?.scrollIntoView?.({ block: 'nearest' });
	}, [cursor]);
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const step = (to: number | 'first' | 'last') => {
			e.preventDefault();
			e.stopPropagation();
			stepLine(session, to);
		};
		if (e.key === 'ArrowDown') step(1);
		else if (e.key === 'ArrowUp') step(-1);
		else if (e.key === 'Home') step('first');
		else if (e.key === 'End') step('last');
		else if (e.key === 'Enter' && cursor !== null) {
			e.preventDefault();
			e.stopPropagation();
			jumpToLine(session, cursor, props.reveal);
		}
	};
	return (
		<div
			ref={listRef}
			role="listbox"
			tabIndex={0}
			data-keymap-local
			aria-label={t('Listening transcript')}
			aria-activedescendant={cursor !== null ? `${idPrefix}${cursor}` : undefined}
			className="min-h-0 flex-1 overflow-auto font-pr-mono text-pr-small outline-none focus-visible:ring-1 focus-visible:ring-pr-focus"
			data-testid="sound-listen-lines"
			onKeyDown={onKeyDown}
			onFocus={() => {
				if (cursor === null && result.lines.length) stepLine(session, 'first');
			}}
		>
			{result.lines.map((l, i) => (
				// biome-ignore lint/a11y/useFocusableInteractive: listbox options are reached with aria-activedescendant
				// biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles the keys (Enter goes to the current line)
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: the lines of one result never reorder
					key={i}
					id={`${idPrefix}${i}`}
					role="option"
					aria-selected={cursor === i}
					data-kind={l.kind}
					data-frame={l.frame}
					className={`flex gap-2 border-t border-pr-border-subtle px-2 py-0.5 ${cursor === i ? 'bg-pr-selected' : ''} ${LINE_TONE[l.kind]}`}
					data-testid="sound-listen-line"
					onClick={() => jumpToLine(session, i, props.reveal)}
				>
					<span className="pr-tabular shrink-0 text-pr-muted" data-testid="sound-listen-timecode">
						{l.timecode}
					</span>
					{l.kind === 'unanswered' ? (
						<Icon id="status.warning" size={12} className="mt-0.5 shrink-0" />
					) : null}
					<span className="min-w-0 whitespace-pre-wrap break-words" data-testid="sound-listen-text">
						{l.text}
					</span>
				</div>
			))}
		</div>
	);
}

/** The mix's spectrogram of ≤ 120 s of the listened range, with the current line's moment marked. */
function SpectrogramStrip(props: {
	session: EditorSession;
	engine: ListenEngine;
	result: SoundListenResult;
	cursor: number | null;
}) {
	const { session, engine, result, cursor } = props;
	const win = spectrogramWindow(result, cursor);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [state, setState] = useState<{ key: string; frames: number; error?: string } | null>(null);
	const key = `${result.sequenceId}:${win.start}:${win.end}`;
	useEffect(() => {
		let live = true;
		const visual = engine.soundVisual;
		if (!visual) return;
		void visual
			.call(engine, {
				projectId: session.projectId,
				sequenceId: result.sequenceId,
				range: { start: win.start, end: win.end },
				spectrogram: true,
			})
			.then((v) => {
				if (!live) return;
				const s = v.spectrogram;
				const c = canvasRef.current;
				if (!s || !c) return setState({ key, frames: 0 });
				const bytes = Uint8Array.from(atob(s.data), (ch) => ch.charCodeAt(0));
				const W = Math.max(1, Math.min(1200, s.frames));
				const H = s.bands;
				c.width = W;
				c.height = H;
				const g = c.getContext('2d');
				if (!g) return setState({ key, frames: s.frames });
				const img = g.createImageData(W, H);
				for (let x = 0; x < W; x++) {
					const a = Math.floor((x / W) * s.frames);
					const b = Math.max(a + 1, Math.floor(((x + 1) / W) * s.frames));
					for (let band = 0; band < H; band++) {
						let m = 0;
						for (let f = a; f < b; f++) m = Math.max(m, bytes[f * s.bands + band] ?? 0);
						const [r, gg, bb] = spectrogramColour(m / 255);
						const o = ((H - 1 - band) * W + x) * 4;
						img.data[o] = r;
						img.data[o + 1] = gg;
						img.data[o + 2] = bb;
						img.data[o + 3] = 255;
					}
				}
				g.putImageData(img, 0, 0);
				setState({ key, frames: s.frames });
			})
			.catch((e: unknown) => {
				if (live) setState({ key, frames: 0, error: (e as Error)?.message ?? String(e) });
			});
		return () => {
			live = false;
		};
	}, [key, engine, session.projectId, result.sequenceId, win.start, win.end]);
	const line = cursor !== null ? result.lines[cursor] : undefined;
	const at = line ? (line.frame - win.start) / Math.max(1, win.end - win.start) : null;
	return (
		<div
			className="shrink-0 border-b border-pr-border px-2 py-1"
			data-testid="sound-listen-spectrogram-strip"
		>
			<div className="mb-0.5 flex justify-between text-pr-small text-pr-muted">
				<span>{t('Spectrogram of the mix (30 Hz–16 kHz, log frequency)')}</span>
				<span className="pr-tabular">
					{result.lines.length ? `${seqLabel(result, win.start)} – ${seqLabel(result, win.end)}` : ''}
				</span>
			</div>
			<div className="relative h-24 w-full overflow-hidden rounded-pr bg-pr-field">
				<canvas
					ref={canvasRef}
					className="absolute inset-0 size-full"
					data-testid="sound-listen-spectrogram"
					data-frames={state?.key === key ? state.frames : undefined}
					style={{ imageRendering: 'pixelated' }}
				/>
				{at !== null && at >= 0 && at <= 1 ? (
					<div
						className="pointer-events-none absolute top-0 bottom-0 w-px bg-pr-accent-fill"
						style={{ left: `${at * 100}%` }}
						data-testid="sound-listen-spectrogram-mark"
					/>
				) : null}
			</div>
			{state?.key === key && state.error ? (
				<p className="m-0 text-pr-small text-pr-danger">
					{t('The spectrogram could not be drawn: {0}', state.error)}
				</p>
			) : null}
		</div>
	);
}

function seqLabel(r: SoundListenResult, frame: number): string {
	const fps = r.fps.num / Math.max(1, r.fps.den);
	const s = Math.max(0, frame / fps);
	const m = Math.floor(s / 60);
	return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}
