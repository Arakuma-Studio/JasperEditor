// Project Settings ▸ General ▸ Video / Audio Display Format in the UI (workstream gaps, §PRJ-4). Monitors, the
// timeline ruler and playhead, Info, Markers, Effect Controls, Properties and the time entry fields import
// `formatTimecode` / `parseTimecodeEntry` from here instead of `@jasper/project`: same signatures, but they show and
// read times in the open project's display format (timecode, frames, 35 mm / 16 mm feet + frames). The active format
// follows the open project (`syncDisplayFormat`); agents and exports keep SMPTE timecode.
import {
	type AudioDisplayFormat,
	formatTimeDisplay,
	parseTimeDisplayEntry,
	projectSettingsOf,
	type Rational,
	type TimecodeEntryContext,
	type TimecodeOptions,
	type VideoDisplayFormat,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSyncExternalStore } from 'react';

type Display = { video: VideoDisplayFormat; audio: AudioDisplayFormat };
let current: Display = { video: 'timecode', audio: 'samples' };
const listeners = new Set<() => void>();

export function getDisplayFormat(): Display {
	return current;
}

export function setDisplayFormat(next: Display): void {
	if (next.video === current.video && next.audio === current.audio) return;
	current = next;
	for (const l of [...listeners]) l();
}

export function subscribeDisplayFormat(l: () => void): () => void {
	listeners.add(l);
	return () => listeners.delete(l);
}

export function useDisplayFormat(): Display {
	return useSyncExternalStore(subscribeDisplayFormat, getDisplayFormat, getDisplayFormat);
}

/** Keeps the active display format equal to the open project's settings; returns the unsubscribe function. */
export function syncDisplayFormat(session: EditorSession | null): () => void {
	if (!session) {
		setDisplayFormat({ video: 'timecode', audio: 'samples' });
		return () => {};
	}
	const apply = () => setDisplayFormat(projectSettingsOf(session.getState().document).display);
	apply();
	const off = session.store.subscribe(apply);
	return () => {
		off();
		setDisplayFormat({ video: 'timecode', audio: 'samples' });
	};
}

/** `formatTimecode` in the project's video display format. */
export function formatTimecode(frame: number, rate: Rational, opts?: TimecodeOptions): string {
	return formatTimeDisplay(frame, rate, { ...opts, display: current.video });
}

/** `parseTimecodeEntry` accepting the project's display format (timecode entries always work). */
export function parseTimecodeEntry(input: string, rate: Rational, ctx: TimecodeEntryContext): number | null {
	return parseTimeDisplayEntry(input, rate, { ...ctx, display: current.video });
}
