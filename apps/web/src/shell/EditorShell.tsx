// The Premiere-style editor shell (S05 §2–§7, §12–§14, ARCHITECTURE §7.1): Row A title/menu bar,
// Row B header, the dock (Edit mode) or a mode view (Import/Export), the command palette, and the
// window-level services: focus tracking, the single keyboard dispatcher, the `shell` panel service,
// autosave, layout-mode switch and workspace persistence.
import { useSessionOrNull } from '@jasper/session/react';
import { EmptyState, openDialog, type ResolvedMenuItem, toast } from '@jasper/ui';
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';
import { useNavigate } from 'react-router';
import { setUiAutomationHost } from '../agent-bridge/ui-automation.ts';
import { installClipboardEvents } from '../clipboard/events.ts';
import { isCommandChecked, isCommandEnabled, listCommands, runCommand } from '../commands/registry.ts';
import { ExportMode } from '../export/ExportMode.tsx';
import { claimExportModeHost, exportMode, useExportMode } from '../export/mode.ts';
import { setMonitorPanelServices } from '../panels/program/monitor-commands.ts';
import { listPanels } from '../panels/registry.ts';
import { type TimelineEnv, TimelineEnvProvider } from '../panels/timeline/env.tsx';
import type { PanelDefinition, PanelKind } from '../panels/types.ts';
import { getDesktopBridge } from '../runtime/platform.ts';
import { ensureAutosaver, flushAutosaver } from '../runtime/save.ts';
import { AgentApprovals } from './AgentApprovals.tsx';
import { type ShellController, type ShellMode, ShellRuntimeProvider, useShellRuntime } from './context.tsx';
import { DIALOGS, registerShellDialogs } from './dialogs.tsx';
import { DockController } from './dock/controller.ts';
import { DockHost } from './dock/DockHost.tsx';
import { focusStore, installFocusTracking } from './focus.ts';
import { HeaderBar, useFullscreen } from './header/HeaderBar.tsx';
import { AppMenu, TitleBar, useDocumentTitle, useMenubarMenus } from './header/TitleBar.tsx';
import { installKeyboardDispatcher } from './keymap/dispatcher.ts';
import { loadKeyboardLayoutMap, shortcutFor } from './keymap/format.ts';
import { useLayoutMode } from './layout-mode.ts';
import { MENUBAR, WORKSPACES_MENU } from './menus/model.ts';
import type { MenuEnv, ShellMenuItem } from './menus/resolve.ts';
import { CommandPalette, type PaletteSources } from './palette/CommandPalette.tsx';
import { useUiPrefs } from './prefs.ts';
import { COMPACT_WORKSPACE, PHONE_WORKSPACE } from './workspaces/definitions.ts';
import { getWorkspaceStore } from './workspaces/instance.ts';
import { sanitizeLayout } from './workspaces/layout.ts';
import type { WorkspaceRecord } from './workspaces/store.ts';

// ------------------------------------------------------------------ mode views (Import / Export)

/** Export mode (WP-2E) rendered in the shell's mode area (S05:EX-001, HD-003). */
function ShellExportView() {
	const state = useExportMode();
	return (
		<div className="h-full" data-testid="mode-view-export">
			<ExportMode key={state.sequenceId ?? 'active'} sequenceId={state.sequenceId} />
		</div>
	);
}

function ImportMode() {
	const runtime = useShellRuntime();
	return (
		<div className="flex h-full items-center justify-center bg-pr-panel" data-testid="mode-view-import">
			<EmptyState
				icon="app.import"
				message="Import mode: browse and ingest media"
				action={{ label: 'Import…', onClick: () => void runtime.run('project.import') }}
			/>
		</div>
	);
}

// ------------------------------------------------------------------ shell

let warnedReset = false;

function download(name: string, text: string) {
	const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pickFile(accept: string): Promise<string | null> {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = accept;
		input.onchange = () => {
			const f = input.files?.[0];
			if (!f) resolve(null);
			else void f.text().then(resolve, () => resolve(null));
		};
		input.click();
	});
}

function ShellBody() {
	const runtime = useShellRuntime();
	const session = useSessionOrNull();
	const navigate = useNavigate();
	const prefs = useUiPrefs();
	const layoutMode = useLayoutMode(prefs.layoutMode);
	const fullscreen = useFullscreen();
	const title = useDocumentTitle();
	const store = useMemo(() => getWorkspaceStore(), []);
	const ws = useSyncExternalStore(store.subscribe, store.getState, store.getState);
	const [mode, setModeState] = useState<ShellMode>('edit');
	const [palette, setPalette] = useState<string | null>(null);
	const panels = useMemo(() => new Map<PanelKind, PanelDefinition>(listPanels().map((d) => [d.kind, d])), []);
	const desktopLike = layoutMode === 'desktop';
	const effectiveWs = desktopLike
		? ws.activeId
		: layoutMode === 'phone'
			? PHONE_WORKSPACE.id
			: COMPACT_WORKSPACE.id;
	const modeRef = useRef(mode);
	modeRef.current = mode;
	const effectiveRef = useRef(effectiveWs);
	effectiveRef.current = effectiveWs;

	const dock = useMemo(
		() =>
			new DockController(store, panels, {
				onLayoutFallback: () =>
					toast({
						kind: 'warning',
						title: 'Workspace layout was reset because it could not be read',
						dedupeKey: 'workspace-reset',
					}),
			}),
		[store, panels],
	);

	useEffect(() => registerShellDialogs(), []);
	useEffect(() => void loadKeyboardLayoutMap(), []);

	// One-time warning when stored layouts were corrupt or from a newer build (SH-021, AC-SH-4).
	useEffect(() => {
		if (store.resetReason && !warnedReset) {
			warnedReset = true;
			toast({
				kind: 'warning',
				title: 'Workspace layout was reset because it could not be read',
				dedupeKey: 'workspace-reset',
			});
		}
	}, [store]);

	// Flush layouts and the project on pagehide/beforeunload (SH-022).
	useEffect(() => {
		const flush = () => {
			store.flush();
			flushAutosaver(session);
		};
		window.addEventListener('pagehide', flush);
		window.addEventListener('beforeunload', flush);
		return () => {
			window.removeEventListener('pagehide', flush);
			window.removeEventListener('beforeunload', flush);
			flush();
		};
	}, [store, session]);

	// Autosave normally comes from <ProjectLifecycle> (a parent, whose effects run after ours); defer so
	// the shell only attaches the shared saver when no lifecycle host did.
	useEffect(() => {
		if (!session) return;
		const t = setTimeout(() => ensureAutosaver(session), 0);
		return () => clearTimeout(t);
	}, [session]);

	const setMode = useCallback(
		(m: ShellMode) => {
			if (m === 'export') session?.transport.pause(); // HD-011
			setModeState(m);
		},
		[session],
	);

	// Export mode (WP-2E) keeps its own store (export.media / Ctrl+M, the Export view's close button);
	// keep it and the header's mode tabs in sync, and render it here instead of ProjectLifecycle's overlay.
	useEffect(() => claimExportModeHost(), []);
	const exportState = useExportMode();
	useEffect(() => {
		if (exportState.open && modeRef.current !== 'export') {
			session?.transport.pause(); // HD-011
			setModeState('export');
		} else if (!exportState.open && modeRef.current === 'export') setModeState('edit');
	}, [exportState.open, session]);
	useEffect(() => {
		const open = exportMode.get().open;
		if (mode === 'export' && !open) exportMode.open(session?.getState().activeSequenceId ?? null);
		else if (mode !== 'export' && open) exportMode.close();
	}, [mode, session]);

	const switchWorkspace = useCallback(
		(id: string) => {
			if (!store.get(id)) return;
			if (dock.isMaximized()) dock.api?.exitMaximizedGroup(); // DK-041: switching restores first
			if (modeRef.current !== 'edit') setModeState('edit');
			store.setActive(id);
		},
		[store, dock],
	);

	const shell = useMemo<ShellController>(
		() => ({
			workspaces: store,
			platform: runtime.platform,
			runtime: runtime.runtime,
			focusPanel: (kind) => {
				if (modeRef.current !== 'edit') setModeState('edit');
				dock.focus(kind);
			},
			isPanelOpen: (kind) => dock.isOpen(kind),
			closePanel: (id) => dock.close(id),
			floatPanel: (id) => dock.float(id),
			toggleMaximize: (target, id) => dock.toggleMaximize(target, id),
			isMaximized: () => dock.isMaximized(),
			cycleFocus: (dir) => dock.cycleFocus(dir),
			switchWorkspace,
			resetWorkspace: () => {
				const id = effectiveRef.current;
				dock.apply(id, store.resetToSaved(id));
			},
			saveWorkspace: () => {
				const id = effectiveRef.current;
				store.saveChanges(id, dock.currentLayout() ?? undefined);
				toast({ kind: 'success', title: `Saved changes to “${store.get(id)?.name ?? id}”` });
			},
			saveWorkspaceAs: () => {
				void openDialog<string>(DIALOGS.saveWorkspaceAs, { store }).then((name) => {
					if (!name) return;
					const r = store.saveAs(name, dock.currentLayout());
					if (!r.ok) toast({ kind: 'error', title: r.error });
				});
			},
			editWorkspaces: () =>
				void openDialog(DIALOGS.editWorkspaces, {
					store,
					onRestoreFactory: (id: string) => {
						store.restoreFactory(id);
						if (id === effectiveRef.current) dock.apply(id, null);
					},
				}),
			importWorkspace: () => {
				void pickFile('application/json,.json').then((text) => {
					if (text === null) return;
					const r = store.importJson(text, (l) => sanitizeLayout(l));
					if (r.ok) toast({ kind: 'success', title: `Imported workspace “${store.get(r.id)?.name}”` });
					else toast({ kind: 'error', title: 'Could not import the workspace', detail: r.error });
				});
			},
			exportWorkspace: () => {
				const id = effectiveRef.current;
				store.setCurrent(id, dock.currentLayout() ?? (store.get(id)?.current as never));
				const json = store.exportJson(id);
				if (json)
					download(`${(store.get(id)?.name ?? id).replace(/[^\w-]+/g, '_')}.jasper-workspace.json`, json);
			},
			openPalette: (q) => setPalette(q ?? ''),
			getMode: () => modeRef.current,
			setMode,
			goHome: () => navigate('/'),
			toggleFullscreen: () => {
				if (document.fullscreenElement) void document.exitFullscreen?.();
				else void document.documentElement.requestFullscreen?.().catch(() => {});
			},
			isFullscreen: () => !!document.fullscreenElement,
		}),
		[store, dock, runtime.platform, runtime.runtime, switchWorkspace, setMode, navigate],
	);

	useEffect(() => runtime.services.register('shell', 'shell', shell), [runtime.services, shell]);
	// mcp-cli (live-UI automation): ui_commands / ui_command / ui_state run against this shell.
	useEffect(
		() =>
			setUiAutomationHost({
				getCtx: runtime.getCtx,
				runCommand: (id, args) => runCommand(id, runtime.getCtx(), args),
				listCommands: () => listCommands(),
				isEnabled: isCommandEnabled,
				isChecked: isCommandChecked,
				shortcutFor: (id) => shortcutFor(id, { platform: runtime.platform, runtime: runtime.runtime }),
				labelFor: (c, ctx) => {
					try {
						return c.labelFor?.(ctx) ?? c.label;
					} catch {
						return c.label;
					}
				},
				shell: () => shell,
			}),
		[runtime, shell],
	);
	// Dev/E2E hook: inspect the dock and workspaces from the console or Playwright.
	useEffect(() => {
		if (!import.meta.env.DEV) return;
		const w = window as unknown as { __jasperShell?: unknown };
		w.__jasperShell = { dock, workspaces: store, shell };
		return () => {
			w.__jasperShell = undefined;
		};
	}, [dock, store, shell]);
	useEffect(() => installFocusTracking(document), []);
	useEffect(
		() =>
			installKeyboardDispatcher(window, {
				getCtx: runtime.getCtx,
				getFocusKind: () => focusStore.getState().kind,
				platform: runtime.platform,
				runtime: runtime.runtime,
				run: runtime.runResolved,
				focusMenubar: () => document.querySelector<HTMLElement>('[data-menu-id]')?.focus(),
			}),
		[runtime],
	);
	// wp-clipboard (S01:CLB-002): copy/cut/paste events from the browser or app menu run the Edit commands.
	useEffect(() => installClipboardEvents(window, (id, args) => void runtime.run(id, args)), [runtime]);
	// Electron native menu clicks arrive as command ids (S05:MN-001, §21).
	useEffect(() => getDesktopBridge()?.onMenuCommand((id) => void runtime.run(id)), [runtime]);

	// Menu providers: workspace list and panel list (Window menu, DK-050).
	const providers = useMemo<MenuEnv['providers']>(
		() => ({
			workspaces: () =>
				store.list().map(
					(w): ShellMenuItem => ({
						type: 'command',
						command: 'workspace.switch',
						label: w.name,
						args: { id: w.id },
						checked: w.id === store.getState().activeId,
						shortcut: store.shortcutNumber(w.id) ? `Alt+Shift+${store.shortcutNumber(w.id)}` : null,
					}),
				),
			panels: () =>
				listPanels().map(
					(d): ShellMenuItem => ({
						type: 'command',
						command: `panel.focus.${d.kind}`,
						label: d.title({}),
						checked: dock.isOpen(d.kind),
					}),
				),
		}),
		[store, dock],
	);
	const menuEnv = useMemo<Omit<MenuEnv, 'ctx'>>(
		() => ({
			platform: runtime.platform,
			runtime: runtime.runtime,
			run: (id, args) => void runtime.run(id, args),
			providers,
		}),
		[runtime, providers],
	);
	const windowMenu = useMemo(() => MENUBAR.find((m) => m.id === 'window')?.items ?? [], []);
	const menus = useMenubarMenus(MENUBAR, menuEnv, mode === 'edit');

	const tabMenu = useCallback(
		(w: WorkspaceRecord): ResolvedMenuItem[] => {
			const item = (id: string, label: string, onSelect: () => void, disabled = false): ResolvedMenuItem => ({
				type: 'item',
				id: `wsmenu.${w.id}.${id}`,
				label,
				onSelect,
				disabled,
				disabledReason: disabled ? 'Built-in workspaces cannot be renamed or deleted' : undefined,
			});
			const activate = () => switchWorkspace(w.id);
			return [
				item('reset', 'Reset to Saved Layout', () => {
					activate();
					dock.apply(w.id, store.resetToSaved(w.id));
				}),
				item('save', 'Save Changes to This Workspace', () => {
					store.saveChanges(
						w.id,
						w.id === effectiveRef.current ? (dock.currentLayout() ?? undefined) : undefined,
					);
				}),
				item('dup', 'Duplicate…', () => shell.saveWorkspaceAs()),
				item('rename', 'Rename…', () => shell.editWorkspaces(), w.builtIn),
				item('delete', 'Delete', () => store.remove(w.id), w.builtIn),
				item('hide', 'Hide from Bar', () => store.setShowInBar(w.id, false)),
				{ type: 'separator', id: `wsmenu.${w.id}.sep` },
				item('edit', 'Edit Workspaces…', () => shell.editWorkspaces()),
			];
		},
		[store, dock, shell, switchWorkspace],
	);

	const sources = useMemo<PaletteSources>(
		() => ({
			session,
			panels: listPanels(),
			workspaces: store,
			focusPanel: shell.focusPanel,
			switchWorkspace,
		}),
		[session, store, shell, switchWorkspace],
	);
	const closePalette = useCallback(() => setPalette(null), []);

	const compactHeader = !desktopLike;
	return (
		<div
			className="flex h-full min-h-0 flex-col bg-pr-app font-pr text-pr-text"
			data-testid="editor-shell"
			data-layout-mode={layoutMode}
			data-workspace={effectiveWs}
		>
			{compactHeader ? null : <TitleBar menus={MENUBAR} env={menuEnv} editMode={mode === 'edit'} />}
			<HeaderBar
				mode={mode}
				onMode={setMode}
				store={store}
				activeWorkspaceId={ws.activeId}
				showWorkspaceTabs={prefs.showWorkspaceTabs && desktopLike}
				workspaceMenu={WORKSPACES_MENU}
				menuEnv={menuEnv}
				tabMenu={tabMenu}
				onSwitchWorkspace={switchWorkspace}
				projectId={session?.projectId}
				fullscreen={fullscreen}
				leading={compactHeader ? <AppMenu menus={menus} /> : null}
				center={
					compactHeader ? (
						<span className="block truncate text-center text-pr-text" data-testid="document-title">
							{title?.full ?? 'JasperEditor'}
						</span>
					) : null
				}
			/>
			{layoutMode === 'tablet' || layoutMode === 'phone' ? (
				<div
					className="flex h-7 shrink-0 items-center justify-center bg-pr-raised text-pr-small text-pr-muted"
					data-testid="touch-notice"
				>
					Touch layout coming soon — showing a simplified docked layout.
				</div>
			) : null}
			<main className="relative min-h-0 flex-1 p-[var(--pr-gutter)] pt-0">
				<div className={mode === 'edit' ? 'h-full' : 'hidden'} data-testid="edit-mode">
					<DockHost
						controller={dock}
						panels={panels}
						workspaceId={effectiveWs}
						providers={providers}
						windowMenu={windowMenu}
					/>
				</div>
				{mode === 'export' ? <ShellExportView /> : mode === 'import' ? <ImportMode /> : null}
			</main>
			<CommandPalette query={palette} onClose={closePalette} sources={sources} />
			<AgentApprovals />
		</div>
	);
}

/** The editor shell mounted on `/project/:projectId` inside the SessionProvider. */
export function EditorShell() {
	return (
		<ShellRuntimeProvider>
			<PanelEnvBridge>
				<ShellBody />
			</PanelEnvBridge>
		</ShellRuntimeProvider>
	);
}

/**
 * Integration: panels that shipped before the shell existed keep module-level fallbacks; point them at
 * the shell's PanelServices and toast/dialog hosts so every panel shares one registry (S05:SH-005).
 */
function PanelEnvBridge({ children }: { children?: ReactNode }) {
	const { services, getCtx } = useShellRuntime();
	// Program/Source monitors publish `programPlayer` into this registry (WP-2C).
	useMemo(() => setMonitorPanelServices(services), [services]);
	const env = useMemo<Partial<TimelineEnv>>(
		() => ({
			services,
			toast: (r) => getCtx().ui.toast(r),
			openDialog: (kind, props) => getCtx().ui.openDialog(kind as never, props),
		}),
		[services, getCtx],
	);
	return <TimelineEnvProvider value={env}>{children}</TimelineEnvProvider>;
}
