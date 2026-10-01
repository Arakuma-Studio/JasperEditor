// Integration points of the Timeline panel with the shell: panel services, toasts, the import
// service and dialogs. The shell (WP-2A) can provide them with <TimelineEnvProvider>; without a provider
// the panel falls back to a shared PanelServices instance and console toasts, so it works standalone.
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import type { ToastRequest } from '../../commands/types.ts';
import { PanelServices } from '../../state/panel-services.ts';
import type { ImportService } from '../../state/services.ts';
import type { TimelineController } from './state/controller.ts';
import type { GesturePreviewState } from './state/gesture-preview.ts';
import type { TimelineUiStore } from './state/ui-store.ts';

/** What a mounted Timeline panel exposes to UI commands and other panels. */
export interface TimelineHandle {
	instanceId: string;
	controller: TimelineController;
	ui: TimelineUiStore;
	sequenceId(): string | null;
	/** Escape: cancels the active gesture; false when nothing was active. */
	cancelGesture(): boolean;
}

declare module '../../state/panel-services.ts' {
	interface PanelServiceMap {
		/** The Timeline panel instance (WP-2B). */
		timelinePanel: TimelineHandle;
		/** Trim two-up / slip-slide four-up payloads for the Program monitor (S02:TL-538, TL-626). */
		timelineGesturePreview: { get(): GesturePreviewState['preview']; subscribe(cb: () => void): () => void };
		/** Import pipeline (WP-2E implements `ImportService`; the timeline uses it for OS file drops). */
		importService: ImportService;
	}
}

export type TimelineEnv = {
	services: PanelServices;
	toast(r: ToastRequest): void;
	openDialog?(kind: string, props?: Record<string, unknown>): void;
};

const shared = new PanelServices();

const defaultEnv: TimelineEnv = {
	services: shared,
	toast: (r) => {
		const fn = r.kind === 'error' ? console.error : r.kind === 'warning' ? console.warn : console.info;
		fn(`[timeline] ${r.message}${r.detail ? ` — ${r.detail}` : ''}`);
	},
};

const EnvContext = createContext<TimelineEnv | null>(null);

export function TimelineEnvProvider(props: { value: Partial<TimelineEnv>; children?: ReactNode }) {
	const { services, toast, openDialog } = props.value;
	// Stable identity across shell re-renders (callers usually pass an inline object).
	const value = useMemo<TimelineEnv>(
		() => ({
			services: services ?? defaultEnv.services,
			toast: toast ?? defaultEnv.toast,
			...(openDialog ? { openDialog } : {}),
		}),
		[services, toast, openDialog],
	);
	return <EnvContext.Provider value={value}>{props.children}</EnvContext.Provider>;
}

export function useTimelineEnv(): TimelineEnv {
	return useContext(EnvContext) ?? defaultEnv;
}

// ---------------------------------------------------------------- instance registry

const instances = new Map<string, { handle: TimelineHandle; at: number }>();
let counter = 0;

export function registerTimelineInstance(handle: TimelineHandle): () => void {
	const entry = { handle, at: ++counter };
	instances.set(handle.instanceId, entry);
	return () => {
		if (instances.get(handle.instanceId) === entry) instances.delete(handle.instanceId);
	};
}

/** Marks an instance as the most recently used (focus, pointer-down). */
export function touchTimelineInstance(instanceId: string): void {
	const e = instances.get(instanceId);
	if (e) e.at = ++counter;
}

/** The most recently used mounted Timeline panel, or null. */
export function activeTimeline(services?: PanelServices | null): TimelineHandle | null {
	const fromServices = services?.get('timelinePanel') ?? null;
	let best: { handle: TimelineHandle; at: number } | null = null;
	for (const e of instances.values()) if (!best || e.at > best.at) best = e;
	return best?.handle ?? fromServices;
}
