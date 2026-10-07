// edit-ux: Edit ▸ Keyboard Shortcuts… (Premiere's Keyboard Shortcuts dialog, helpx.adobe.com "Customize keyboard
// shortcuts"): keyboard layout preset (Premiere Pro default, Avid Media Composer, Final Cut Pro 7, Final Cut Pro,
// custom layouts with Save As / Delete), search by command name or key, the commands grouped by scope with their
// shortcuts; click "+" (or a shortcut) and press the new chord to (re)bind it; × removes one; Clear / Reset per
// command; Undo of the last change. Conflicts are shown as they happen: the other command in the same scope loses
// the chord (as in Premiere), shortcuts of enclosing scopes are listed as shadowed, browser-reserved chords are
// refused in the web app.
import { Button, Dialog, type HostedDialogProps, Kbd, registerDialog, Select, TextField } from '@jasper/ui';
import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
	chordFromEvent,
	effectiveKey,
	getActiveKeymap,
	type KeyBinding,
	type Platform,
	type Runtime,
	subscribeActiveKeymap,
} from '../../commands/keymap-defaults.ts';
import { LAYOUTS } from '../../commands/keymap-presets.ts';
import { getCommand, listCommands } from '../../commands/registry.ts';
import type { CommandScope } from '../../commands/types.ts';
import { formatChord } from './format.ts';
import {
	assignShortcut,
	chordAllowed,
	clearShortcuts,
	conflictsFor,
	deleteCustomLayout,
	keymapStore,
	removeShortcut,
	resetShortcuts,
	restoreBindings,
	saveLayoutAs,
	setLayout,
} from './store.ts';

export const KEYBOARD_SHORTCUTS_DIALOG = 'shell.keyboardShortcuts';

let registered = false;
export function registerKeyboardShortcutsDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(KEYBOARD_SHORTCUTS_DIALOG, KeyboardShortcutsDialog);
}

const SCOPE_LABEL = (s: CommandScope) =>
	s === 'global' ? 'Application' : s === 'editing' ? 'Editing (Timeline and monitors)' : `Panel: ${s}`;

type Row = { id: string; label: string; scope: CommandScope; bindings: KeyBinding[] };

/** Every command with a shortcut, plus every registered visible command (to bind new keys). */
export function shortcutRows(keymap: readonly KeyBinding[]): Row[] {
	const rows = new Map<string, Row>();
	const key = (id: string, scope: CommandScope) => `${scope}|${id}`;
	for (const b of keymap) {
		const k = key(b.command, b.scope);
		const r = rows.get(k) ?? {
			id: b.command,
			label: getCommand(b.command)?.label ?? b.command,
			scope: b.scope,
			bindings: [],
		};
		r.bindings.push(b);
		rows.set(k, r);
	}
	for (const c of listCommands()) {
		if (c.hidden || [...rows.values()].some((r) => r.id === c.id)) continue;
		rows.set(key(c.id, c.scope), { id: c.id, label: c.label, scope: c.scope, bindings: [] });
	}
	return [...rows.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function KeyboardShortcutsDialog(props: HostedDialogProps<{ platform: Platform; runtime: Runtime }>) {
	const { platform, runtime } = props;
	const [open, setOpen] = useState(true);
	const keymap = useSyncExternalStore(subscribeActiveKeymap, getActiveKeymap, getActiveKeymap);
	const prefs = useSyncExternalStore(keymapStore.subscribe, keymapStore.getState, keymapStore.getState);
	const [query, setQuery] = useState('');
	const [capture, setCapture] = useState<{ row: Row; replace?: KeyBinding } | null>(null);
	const [message, setMessage] = useState<{ kind: 'info' | 'warning'; text: string } | null>(null);
	const undo = useRef<KeyBinding[][]>([]);
	const [saveName, setSaveName] = useState<string | null>(null);
	const rows = useMemo(() => shortcutRows(keymap), [keymap]);
	const fmt = (b: KeyBinding) => {
		const k = effectiveKey(b, platform, runtime);
		return k ? formatChord(k, platform) : null;
	};
	const q = query.trim().toLowerCase();
	const shown = rows.filter(
		(r) =>
			!q ||
			r.label.toLowerCase().includes(q) ||
			r.id.toLowerCase().includes(q) ||
			r.bindings.some((b) => (fmt(b) ?? '').toLowerCase().includes(q)),
	);
	const groups = new Map<CommandScope, Row[]>();
	for (const r of shown) groups.set(r.scope, [...(groups.get(r.scope) ?? []), r]);
	const remember = () => {
		undo.current.push([...getActiveKeymap()]);
		if (undo.current.length > 50) undo.current.shift();
	};
	const labelOf = (id: string) => getCommand(id)?.label ?? id;

	const onCaptureKey = (e: React.KeyboardEvent) => {
		if (!capture) return;
		e.preventDefault();
		e.stopPropagation();
		if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
			setCapture(null);
			return;
		}
		const chord = chordFromEvent(e.nativeEvent, platform);
		const refused = chordAllowed(chord, platform, runtime);
		if (refused) {
			if (!/^(Control|Shift|Alt|Meta|OS)/.test(e.code)) setMessage({ kind: 'warning', text: refused });
			return;
		}
		remember();
		const shadowed = conflictsFor(keymap, chord, capture.row.scope, platform, runtime, capture.row.id).filter(
			(c) => c.shadow,
		);
		const lost = assignShortcut(capture.row.id, capture.row.scope, chord, platform, runtime, capture.replace);
		const parts = [`${formatChord(chord, platform)} → ${capture.row.label}.`];
		if (lost.length) parts.push(`Removed from: ${lost.map(labelOf).join(', ')}.`);
		if (shadowed.length)
			parts.push(
				`Also used in other scopes (the focused panel's wins): ${shadowed.map((c) => `${labelOf(c.command)} (${SCOPE_LABEL(c.scope)})`).join(', ')}.`,
			);
		setMessage({ kind: lost.length || shadowed.length ? 'warning' : 'info', text: parts.join(' ') });
		setCapture(null);
	};

	const layoutOptions = [
		...LAYOUTS.map((l) => ({ value: l.id as string, label: l.label })),
		...Object.keys(prefs.custom).map((n) => ({ value: `custom:${n}`, label: n })),
	];
	const isCustom = prefs.layout.startsWith('custom:');
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (!o) {
					setOpen(false);
					props.close();
				}
			}}
			title="Keyboard Shortcuts"
			size="large"
			primaryLabel="OK"
			onPrimary={() => true}
			data-testid="keyboard-shortcuts-dialog"
		>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: key capture surface while rebinding */}
			<div className="flex max-h-[70vh] min-h-[420px] flex-col gap-2 text-pr-ui" onKeyDown={onCaptureKey}>
				<div className="flex items-center gap-2">
					<span className="text-pr-muted">Keyboard Layout Preset</span>
					<Select
						value={prefs.layout}
						onValueChange={(v) => {
							undo.current = [];
							setLayout(v);
							setMessage(null);
						}}
						options={layoutOptions}
						label="Keyboard layout preset"
					/>
					{saveName === null ? (
						<Button
							onClick={() => setSaveName(isCustom ? prefs.layout.slice(7) : 'My Layout')}
							data-testid="kb-save-as"
						>
							Save As…
						</Button>
					) : (
						<>
							<TextField
								value={saveName}
								onChange={(e) => setSaveName(e.target.value)}
								aria-label="Layout name"
								data-testid="kb-save-name"
							/>
							<Button
								onClick={() => {
									const err = saveLayoutAs(saveName);
									if (err) setMessage({ kind: 'warning', text: err });
									else setSaveName(null);
								}}
								data-testid="kb-save-ok"
							>
								Save
							</Button>
						</>
					)}
					{isCustom ? (
						<Button onClick={() => deleteCustomLayout(prefs.layout.slice(7))} data-testid="kb-delete-layout">
							Delete
						</Button>
					) : null}
					<div className="flex-1" />
					<Button
						disabled={undo.current.length === 0}
						onClick={() => {
							const prev = undo.current.pop();
							if (prev) restoreBindings(prev);
							setMessage(null);
						}}
						data-testid="kb-undo"
					>
						Undo
					</Button>
				</div>
				<TextField
					value={query}
					placeholder="Search commands or keys"
					onChange={(e) => setQuery(e.target.value)}
					aria-label="Search shortcuts"
					data-testid="kb-search"
				/>
				{capture ? (
					<p className="text-pr-accent" role="status" data-testid="kb-capture">
						Press the new shortcut for “{capture.row.label}” (Esc cancels)…
					</p>
				) : message ? (
					<p
						className={message.kind === 'warning' ? 'text-pr-warning' : 'text-pr-muted'}
						role="status"
						data-testid="kb-message"
					>
						{message.text}
					</p>
				) : (
					<p className="text-pr-muted">Click + to add a shortcut, click a shortcut to change it.</p>
				)}
				<div className="min-h-0 flex-1 overflow-auto" data-testid="kb-list">
					{[...groups.entries()].map(([scope, list]) => (
						<section key={scope} className="mb-2">
							<h3 className="sticky top-0 bg-pr-panel py-0.5 font-semibold text-pr-strong">
								{SCOPE_LABEL(scope)}
							</h3>
							<ul>
								{list.map((r) => (
									<li
										key={`${scope}|${r.id}`}
										className="flex min-h-[24px] items-center gap-2 border-b border-pr-border-subtle"
										data-command={r.id}
									>
										<span className="min-w-0 flex-1 truncate" title={r.id}>
											{r.label}
										</span>
										{r.bindings.map((b) => {
											const k = fmt(b);
											if (!k) return null;
											return (
												<span key={`${b.key}|${b.mac ?? ''}`} className="inline-flex items-center gap-0.5">
													<button
														type="button"
														className="rounded-pr-control hover:bg-pr-hover"
														aria-label={`Change ${k} of ${r.label}`}
														onClick={() => setCapture({ row: r, replace: b })}
														data-testid={`kb-key-${r.scope}-${r.id}-${b.key}`}
													>
														<Kbd>{k}</Kbd>
													</button>
													<button
														type="button"
														className="rounded-pr-control px-0.5 text-pr-muted hover:bg-pr-hover hover:text-pr-text"
														aria-label={`Remove ${k} from ${r.label}`}
														onClick={() => {
															remember();
															removeShortcut(b);
															setMessage(null);
														}}
														data-testid={`kb-remove-${r.scope}-${r.id}-${b.key}`}
													>
														×
													</button>
												</span>
											);
										})}
										<button
											type="button"
											className="rounded-pr-control px-1 text-pr-muted hover:bg-pr-hover hover:text-pr-text"
											aria-label={`Add a shortcut to ${r.label}`}
											onClick={() => setCapture({ row: r })}
											data-testid={`kb-add-${r.scope}-${r.id}`}
										>
											+
										</button>
										<button
											type="button"
											className="rounded-pr-control px-1 text-pr-small text-pr-muted hover:bg-pr-hover"
											aria-label={`Clear the shortcuts of ${r.label}`}
											disabled={r.bindings.length === 0}
											onClick={() => {
												remember();
												clearShortcuts(r.id);
											}}
											data-testid={`kb-clear-${r.scope}-${r.id}`}
										>
											Clear
										</button>
										<button
											type="button"
											className="rounded-pr-control px-1 text-pr-small text-pr-muted hover:bg-pr-hover"
											aria-label={`Reset the shortcuts of ${r.label}`}
											onClick={() => {
												remember();
												resetShortcuts(r.id);
											}}
											data-testid={`kb-reset-${r.scope}-${r.id}`}
										>
											Reset
										</button>
									</li>
								))}
							</ul>
						</section>
					))}
				</div>
			</div>
		</Dialog>
	);
}
