// Shell runtime context: the live CommandCtx (session, transport, focus, services, engine, capabilities,
// toast/dialog adapters), the per-window PanelServices, and the ShellController published as the
// `shell` panel service so UI commands can drive the dock, workspaces, palette and modes
// (S05:SH-004/005, KB-001). Panels use `usePanelServices()` and `useRunCommand()` from here.
import type { EditorSession } from '@jasper/session';
import { useSessionOrNull } from '@jasper/session/react';
import { openDialog as openUiDialog, toast as uiToast } from '@jasper/ui';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef } from 'react';
import { createCommandContext } from '../commands/context.ts';
import type { Platform, Runtime } from '../commands/keymap-defaults.ts';
import { runCommand } from '../commands/registry.ts';
import type { CommandCtx, ToastRequest, UiCommand } from '../commands/types.ts';
import type { PanelKind } from '../panels/types.ts';
import { detectPlatform, detectRuntime } from '../runtime/platform.ts';
import { useCapabilities, useEngine } from '../state/engine.tsx';
import { PanelServices } from '../state/panel-services.ts';
import { focusStore } from './focus.ts';
import type { WorkspaceStore } from './workspaces/store.ts';

export type ShellMode = 'import' | 'edit' | 'export';

/** What the shell exposes to UI commands (registered as the `shell` panel service). */
export interface ShellController {
	readonly workspaces: WorkspaceStore;
	readonly platform: Platform;
	readonly runtime: Runtime;
	/** Opens the panel if closed (home group, else floating) and focuses it (DK-050/051). */
	focusPanel(kind: PanelKind): void;
	isPanelOpen(kind: PanelKind): boolean;
	/** Closes a panel instance (default: the focused one). */
	closePanel(instanceId?: string): void;
	/** Undocks a panel into a floating group (DK-030). */
	floatPanel(instanceId?: string): void;
	/** `` ` `` (pointer) / `` Shift+` `` (focused) maximize toggle (DK-040). Returns the new state. */
	toggleMaximize(target: 'pointer' | 'focused', instanceId?: string): boolean;
	isMaximized(): boolean;
	/** Ctrl+Shift+. / , (FO-003). */
	cycleFocus(direction: 1 | -1): void;
	switchWorkspace(id: string): void;
	resetWorkspace(): void;
	saveWorkspace(): void;
	saveWorkspaceAs(): void;
	editWorkspaces(): void;
	importWorkspace(): void;
	exportWorkspace(): void;
	openPalette(query?: string): void;
	getMode(): ShellMode;
	setMode(mode: ShellMode): void;
	goHome(): void;
	toggleFullscreen(): void;
	isFullscreen(): boolean;
}

declare module '../state/panel-services.ts' {
	interface PanelServiceMap {
		shell: ShellController;
	}
}

/** Maps the command-contract toast onto the design-system toast API (S05:TS-002). */
export function adaptToast(r: ToastRequest, run: (id: string, args?: unknown) => void): number {
	return uiToast({
		kind: r.kind,
		title: r.message,
		detail: r.detail,
		durationMs: r.durationMs,
		source: 'user',
		actions: r.action
			? [{ label: r.action.label, run: () => run(r.action!.command, r.action!.args) }]
			: undefined,
	});
}

type ShellRuntime = {
	services: PanelServices;
	getCtx(): CommandCtx;
	/** Runs a command by id through the registry (menus, palette, buttons). */
	run(id: string, args?: unknown): Promise<boolean>;
	/** Runs an already-resolved command (keyboard dispatcher). */
	runResolved(command: UiCommand, ctx: CommandCtx, args?: unknown): void;
	platform: Platform;
	runtime: Runtime;
};

const RuntimeContext = createContext<ShellRuntime | null>(null);

const RECENT_KEY = 'jasper:palette-recent';
/** Recently run command ids, newest first (palette MN-043). */
export function recentCommands(): string[] {
	try {
		const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
		return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 20) : [];
	} catch {
		return [];
	}
}
function pushRecent(id: string) {
	try {
		localStorage.setItem(
			RECENT_KEY,
			JSON.stringify([id, ...recentCommands().filter((x) => x !== id)].slice(0, 20)),
		);
	} catch {
		/* ignore */
	}
}

const NOT_REGISTERED = (id: string) => `“${id}” is not available yet`;

/**
 * Provides the live command context. Must sit inside <EngineProvider>; the session is optional
 * (the shell also runs on Home).
 */
export function ShellRuntimeProvider({
	children,
	session: sessionProp,
}: {
	children?: ReactNode;
	session?: EditorSession | null;
}) {
	const engine = useEngine();
	const { flags } = useCapabilities();
	const contextSession = useSessionOrNull();
	const session = sessionProp === undefined ? contextSession : sessionProp;
	const services = useMemo(() => new PanelServices(), []);
	const live = useRef({ engine, flags, session });
	live.current = { engine, flags, session };
	const platform = useMemo(() => detectPlatform(), []);
	const runtime = useMemo(() => detectRuntime(), []);

	const getCtx = useCallback((): CommandCtx => {
		const { engine: e, flags: f, session: s } = live.current;
		const focus = focusStore.getState();
		const ctx = createCommandContext({
			engine: e.client,
			session: s,
			focus: { panel: focus.kind, instanceId: focus.instanceId },
			services,
			capabilities: f,
			toast: (r) => void adaptToast(r, (id, args) => void runCommand(id, getCtx(), args)),
			openDialog: (kind, props) => void openUiDialog(kind, props ?? {}),
		});
		return ctx;
	}, [services]);

	const value = useMemo<ShellRuntime>(() => {
		const run = async (id: string, args?: unknown) => {
			const ctx = getCtx();
			const r = await runCommand(id, ctx, args);
			if (r.ran) pushRecent(id);
			else if (r.reason === 'unknown') ctx.ui.toast({ kind: 'info', message: NOT_REGISTERED(id) });
			return r.ran;
		};
		return {
			services,
			getCtx,
			run,
			runResolved: (command, ctx, args) => {
				void runCommand(command.id, ctx, args).then((r) => r.ran && pushRecent(command.id));
			},
			platform,
			runtime,
		};
	}, [services, getCtx, platform, runtime]);

	return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

export function useShellRuntime(): ShellRuntime {
	const r = useContext(RuntimeContext);
	if (!r) throw new Error('useShellRuntime must be used inside <ShellRuntimeProvider>');
	return r;
}

export function useShellRuntimeOrNull(): ShellRuntime | null {
	return useContext(RuntimeContext);
}

/** The per-window panel service registry (S05:SH-005). */
export function usePanelServices(): PanelServices {
	return useShellRuntime().services;
}

/** `run(commandId, args)` through the registry (S05:KB-001). */
export function useRunCommand(): (id: string, args?: unknown) => Promise<boolean> {
	return useShellRuntime().run;
}

/** The live CommandCtx getter (menus and buttons evaluate enabled/checked when they render/open). */
export function useCommandCtx(): () => CommandCtx {
	return useShellRuntime().getCtx;
}
