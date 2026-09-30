// Timecode display + entry (S05:TY-004…006, S02:TL-205): tabular numerals so digits never jitter; click
// to type a full or partial timecode (`1510` = 00:00:15:10), `+N`/`-N` relative frames, `1.` = 1 second,
// `1..` = 1 minute, `#N` = absolute frame N. Enter commits, Esc cancels; invalid input flashes the field red
// once (no animation under reduced motion) and keeps the old value. Uses @jasper/project's timecode
// formatter/parser so every panel agrees on drop-frame numbering. For playback, pass `source` so the text
// updates via direct DOM writes instead of React renders (S05:PERF-004).
import { formatTimecode, parseTimecodeEntry, type Rational } from '@jasper/project';
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cx } from '../cx.ts';

export type FrameSource = { get(): number; subscribe(cb: (frame: number) => void): () => void };

export type TimecodeFieldProps = {
	/** Current frame (ignored when `source` is given). */
	frame?: number;
	/** Live frame source (TransportStore adapter). */
	source?: FrameSource;
	rate: Rational;
	dropFrame?: boolean;
	/** Sequence start timecode offset in frames. */
	startFrames?: number;
	/** Read-only display (durations). */
	readOnly?: boolean;
	onCommit?(frame: number): void;
	tone?: 'timecode' | 'primary' | 'muted';
	size?: 'timeline' | 'monitor' | 'ui';
	label?: string;
	className?: string;
};

const SIZES = {
	timeline: 'text-[length:var(--pr-font-size-timeline-tc)] leading-[22px]',
	monitor: 'text-[length:var(--pr-font-size-monitor-tc)] leading-[18px]',
	ui: 'text-pr-ui',
};
const TONES = { timecode: 'text-pr-timecode', primary: 'text-pr-text', muted: 'text-pr-muted' };

/** Spoken form for screen readers (S05:A11Y-003): "1 hour 2 minutes 3 seconds 4 frames". */
export function spokenTimecode(tc: string): string {
	const parts = tc.replace(/^-/, '').split(/[:;]/).map(Number);
	const [h = 0, m = 0, s = 0, f = 0] = parts;
	const out = [h && `${h} hours`, m && `${m} minutes`, s && `${s} seconds`, `${f} frames`].filter(Boolean);
	return (tc.startsWith('-') ? 'minus ' : '') + out.join(' ');
}

export function TimecodeField(props: TimecodeFieldProps) {
	const {
		rate,
		dropFrame,
		startFrames,
		readOnly,
		size = 'ui',
		tone = 'timecode',
		label = 'Timecode',
	} = props;
	const opts = { dropFrame, startFrames };
	const current = () => props.source?.get() ?? props.frame ?? 0;
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState('');
	const [invalid, setInvalid] = useState(false);
	const displayRef = useRef<HTMLButtonElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const source = props.source;
	const { num, den } = rate;

	// Live source: write the text directly (no React state per frame).
	useLayoutEffect(() => {
		if (!source || editing) return;
		const write = (f: number) => {
			const el = displayRef.current;
			if (el) el.textContent = formatTimecode(f, { num, den }, { dropFrame, startFrames });
		};
		write(source.get());
		return source.subscribe(write);
	}, [source, editing, num, den, dropFrame, startFrames]);

	useEffect(() => {
		if (!editing) return;
		inputRef.current?.focus();
		inputRef.current?.select();
	}, [editing]);

	useEffect(() => {
		if (!invalid) return;
		const t = setTimeout(() => setInvalid(false), 450);
		return () => clearTimeout(t);
	}, [invalid]);

	const commit = () => {
		const parsed = parseTimecodeEntry(text, rate, { ...opts, current: current() });
		if (parsed === null) {
			// Keep the old value and flash the display red once.
			setEditing(false);
			setInvalid(true);
			return false;
		}
		setEditing(false);
		props.onCommit?.(parsed);
		return true;
	};

	const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			commit();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			setEditing(false);
		}
	};

	const shown = formatTimecode(current(), rate, opts);
	const base = cx('font-pr pr-tabular whitespace-nowrap', SIZES[size], props.className);

	if (editing) {
		return (
			<input
				ref={inputRef}
				aria-label={label}
				value={text}
				spellCheck={false}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={onKey}
				onBlur={() => setEditing(false)}
				data-testid="timecode-input"
				className={cx(
					base,
					'w-[11ch] rounded-pr-control border border-pr-focus bg-pr-field px-1 text-pr-text outline-none',
				)}
			/>
		);
	}

	return (
		<button
			ref={displayRef}
			type="button"
			disabled={readOnly}
			aria-label={`${label}: ${spokenTimecode(shown)}`}
			data-testid="timecode-display"
			data-invalid={invalid || undefined}
			onClick={() => {
				if (readOnly) return;
				setText(formatTimecode(current(), rate, opts));
				setEditing(true);
			}}
			className={cx(
				base,
				TONES[tone],
				'rounded-pr-control px-0.5 text-left',
				!readOnly && 'hover:bg-pr-hover',
				invalid && 'bg-[var(--pr-field-invalid)]',
			)}
			style={{ fontVariantNumeric: 'tabular-nums' }}
		>
			{shown}
		</button>
	);
}
