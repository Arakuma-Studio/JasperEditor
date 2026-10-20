// Shell dialogs registered with the dialog host: Save as New Workspace (WS-011), Edit Workspaces
// (WS-012), Keyboard Shortcut Reference (KB-014) and About (§14.2).
import {
	Button,
	Checkbox,
	confirmDialog,
	Dialog,
	type HostedDialogProps,
	IconButton,
	Kbd,
	registerDialog,
	TextField,
} from '@jasper/ui';
import { useId, useState, useSyncExternalStore } from 'react';
import {
	effectiveKey,
	getActiveKeymap,
	type Platform,
	type Runtime,
	scopeChain,
} from '../commands/keymap-defaults.ts';
import { getCommand } from '../commands/registry.ts';
import type { CommandScope } from '../commands/types.ts';
import { formatChord } from './keymap/format.ts';
import { ThirdPartyLicenses } from './licenses.tsx';
import { prefsStore, useUiPrefs } from './prefs.ts';
import { workspaceName } from './workspaces/definitions.ts';
import type { WorkspaceStore } from './workspaces/store.ts';

export const DIALOGS = {
	saveWorkspaceAs: 'shell.workspace.saveAs',
	editWorkspaces: 'shell.workspace.edit',
	shortcutReference: 'shell.shortcutReference',
	about: 'shell.about',
} as const;

function SaveWorkspaceAsDialog(props: HostedDialogProps<{ store: WorkspaceStore; initial?: string }>) {
	const [name, setName] = useState(props.initial ?? '');
	const fieldId = useId();
	const [error, setError] = useState<string | null>(null);
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Save as New Workspace"
			size="small"
			primaryLabel="Save"
			onPrimary={() => {
				const check = props.store.checkName(name);
				if (!check.ok) {
					setError(check.error);
					return false;
				}
				props.close(check.name);
				return false;
			}}
			data-testid="save-workspace-dialog"
		>
			<div className="flex flex-col gap-1.5">
				<label htmlFor={fieldId} className="text-pr-muted">
					Name
				</label>
				<TextField
					id={fieldId}
					value={name}
					maxLength={40}
					invalid={!!error}
					onChange={(e) => {
						setName(e.target.value);
						setError(null);
					}}
					aria-label="Workspace name"
					data-testid="workspace-name"
				/>
				{error ? (
					<span className="text-pr-small text-pr-danger" role="alert">
						{error}
					</span>
				) : null}
			</div>
		</Dialog>
	);
}

function EditWorkspacesDialog(
	props: HostedDialogProps<{ store: WorkspaceStore; onRestoreFactory?(id: string): void }>,
) {
	const store = props.store;
	useSyncExternalStore(store.subscribe, store.getState);
	const prefs = useUiPrefs();
	const list = store.list();
	const [renaming, setRenaming] = useState<{ id: string; name: string; error?: string } | null>(null);
	const move = (id: string, dir: -1 | 1) => {
		const order = list.map((w) => w.id);
		const i = order.indexOf(id);
		const j = i + dir;
		if (j < 0 || j >= order.length) return;
		[order[i], order[j]] = [order[j] as string, order[i] as string];
		store.reorder(order);
	};
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Edit Workspaces"
			size="medium"
			data-testid="edit-workspaces-dialog"
		>
			<div className="flex flex-col gap-3">
				<ul className="flex flex-col divide-y divide-pr-border-subtle rounded-pr-control border border-pr-border-subtle">
					{list.map((w, i) => {
						const n = store.shortcutNumber(w.id);
						return (
							<li key={w.id} className="flex h-8 items-center gap-2 px-2" data-testid={`ws-row-${w.id}`}>
								<IconButton
									icon="app.chevronDown"
									label="Move up"
									size="small"
									className="rotate-180"
									disabled={i === 0}
									onClick={() => move(w.id, -1)}
								/>
								<IconButton
									icon="app.chevronDown"
									label="Move down"
									size="small"
									disabled={i === list.length - 1}
									onClick={() => move(w.id, 1)}
								/>
								{renaming?.id === w.id ? (
									<TextField
										autoFocus
										value={renaming.name}
										invalid={!!renaming.error}
										title={renaming.error}
										onChange={(e) => setRenaming({ id: w.id, name: e.target.value })}
										onKeyDown={(e) => {
											if (e.key === 'Enter') {
												e.preventDefault();
												const r = store.rename(w.id, renaming.name);
												if (r.ok) setRenaming(null);
												else setRenaming({ ...renaming, error: r.error });
											} else if (e.key === 'Escape') {
												e.preventDefault();
												e.stopPropagation();
												setRenaming(null);
											}
										}}
										className="min-w-0 flex-1"
										aria-label="Workspace name"
									/>
								) : (
									<span className="min-w-0 flex-1 truncate" data-no-i18n>
										{workspaceName(w)}
									</span>
								)}
								<Kbd className="w-[72px] text-right">{n ? `Alt+Shift+${n}` : ''}</Kbd>
								<Checkbox
									checked={w.showInBar}
									onCheckedChange={(c) => store.setShowInBar(w.id, c)}
									aria-label={`Show ${workspaceName(w)} in bar`}
								/>
								{w.builtIn ? (
									<Button variant="quiet" onClick={() => props.onRestoreFactory?.(w.id)}>
										Restore factory layout
									</Button>
								) : (
									<>
										<Button variant="quiet" onClick={() => setRenaming({ id: w.id, name: w.name })}>
											Rename
										</Button>
										<Button
											variant="quiet"
											onClick={async () => {
												if (
													await confirmDialog({
														title: `Delete “${w.name}”?`,
														body: 'The workspace layout will be removed.',
														confirmLabel: 'Delete Workspace',
													})
												)
													store.remove(w.id);
											}}
										>
											Delete
										</Button>
									</>
								)}
							</li>
						);
					})}
				</ul>
				<Checkbox
					checked={prefs.showWorkspaceTabs}
					onCheckedChange={(c) => prefsStore.set({ showWorkspaceTabs: c })}
					label="Show workspace tabs in header"
				/>
			</div>
		</Dialog>
	);
}

function ShortcutReferenceDialog(
	props: HostedDialogProps<{ scope: CommandScope | null; platform: Platform; runtime: Runtime }>,
) {
	const scopes = scopeChain(props.scope);
	const sections = scopes.map((scope) => ({
		scope,
		rows: getActiveKeymap()
			.filter((b) => b.scope === scope && getCommand(b.command))
			.map((b) => ({
				id: b.command,
				label: getCommand(b.command)?.label ?? b.command,
				key: effectiveKey(b, props.platform, props.runtime),
			}))
			.filter((r): r is { id: string; label: string; key: string } => !!r.key),
	}));
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Keyboard Shortcut Reference"
			size="large"
			data-testid="shortcut-reference"
		>
			<div className="grid grid-cols-2 gap-6">
				{sections.map((s) => (
					<section key={s.scope}>
						<h3 className="mb-1 font-semibold text-pr-strong">
							{s.scope === 'global'
								? 'Application'
								: s.scope === 'editing'
									? 'Editing (Timeline and monitors)'
									: `Panel: ${s.scope}`}
						</h3>
						{s.rows.length ? (
							<ul>
								{s.rows.map((r) => (
									<li key={`${r.id}-${r.key}`} className="flex h-[22px] items-center gap-2">
										<span className="min-w-0 flex-1 truncate">{r.label}</span>
										<Kbd>{formatChord(r.key, props.platform)}</Kbd>
									</li>
								))}
							</ul>
						) : (
							<p className="text-pr-muted">No commands registered yet</p>
						)}
					</section>
				))}
			</div>
		</Dialog>
	);
}

function AboutDialog(props: HostedDialogProps<{ engineVersion?: string | null }>) {
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="About JasperEditor"
			size="medium"
			data-testid="about-dialog"
		>
			<div className="flex flex-col gap-2">
				<p className="text-pr-strong">JasperEditor</p>
				<p className="text-pr-muted">
					An agentic video editor. Engine {props.engineVersion ?? 'not connected'}.
				</p>
				<p className="text-pr-small text-pr-muted">
					Uses Remotion (company license terms apply), FFmpeg (LGPL build, run as a separate process),
					fframes, dockview, Radix UI, lucide and Source Sans 3 (SIL OFL).
				</p>
				<ThirdPartyLicenses />
			</div>
		</Dialog>
	);
}

let registered = false;
/** Registers the shell dialogs with the dialog host (idempotent). */
export function registerShellDialogs(): void {
	if (registered) return;
	registered = true;
	registerDialog(DIALOGS.saveWorkspaceAs, SaveWorkspaceAsDialog);
	registerDialog(DIALOGS.editWorkspaces, EditWorkspacesDialog);
	registerDialog(DIALOGS.shortcutReference, ShortcutReferenceDialog);
	registerDialog(DIALOGS.about, AboutDialog);
}
