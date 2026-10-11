// Export mode state (S05:EX-001, HD-003): the header "Export" tab and Ctrl+M open a full-area view.
// The shell (WP-2A) renders <ExportMode/> as its export mode view (claimExportModeHost); without a shell,
// ProjectLifecycle overlays it.
import type { EngineJob } from '@jasper/api';
import { useSyncExternalStore } from 'react';

type ExportModeState = { open: boolean; sequenceId: string | null };

let state: ExportModeState = { open: false, sequenceId: null };
const listeners = new Set<() => void>();
const emit = () => {
	for (const l of [...listeners]) l();
};

export const exportMode = {
	get: () => state,
	subscribe(l: () => void) {
		listeners.add(l);
		return () => listeners.delete(l);
	},
	open(sequenceId: string | null) {
		state = { open: true, sequenceId };
		emit();
	},
	close() {
		if (!state.open) return;
		state = { ...state, open: false };
		emit();
	},
};

export function useExportMode(): ExportModeState {
	return useSyncExternalStore(exportMode.subscribe, exportMode.get, exportMode.get);
}

let shellHosts = 0;
const hostListeners = new Set<() => void>();
const hostSubscribe = (l: () => void) => {
	hostListeners.add(l);
	return () => hostListeners.delete(l);
};
const hostSnapshot = () => shellHosts > 0;

/**
 * The shell (WP-2A) claims Export mode and renders it as its "export" mode view; while claimed,
 * ProjectLifecycle does not overlay its own copy. Returns the release function.
 */
export function claimExportModeHost(): () => void {
	shellHosts++;
	for (const l of [...hostListeners]) l();
	let released = false;
	return () => {
		if (released) return;
		released = true;
		shellHosts--;
		for (const l of [...hostListeners]) l();
	};
}

export function useExportModeHostedByShell(): boolean {
	return useSyncExternalStore(hostSubscribe, hostSnapshot, hostSnapshot);
}

const tracked = new Map<string, string>();

/** Remembers an export job so its completion shows a toast with Download (S05:EX-013, EX-030). */
export function trackExportJob(job: EngineJob, fileName: string): void {
	tracked.set(job.id, fileName);
}

export function takeTrackedExport(jobId: string): string | null {
	const t = tracked.get(jobId) ?? null;
	tracked.delete(jobId);
	return t;
}
