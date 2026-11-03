// Command palette (S05:MN-040…043): Ctrl+Shift+P or the header search button opens a centered 560 px
// palette at 20 % from the top. Fuzzy search over commands (with shortcut and enabled state), panels,
// workspaces and project items; prefixes `>` commands, `@` project items, `#` markers, `:` go to
// timecode, `?` help. Recent commands come first when the query is empty. (There is no in-app agent row:
// agents drive the editor over MCP.)
import { mgRegistry } from '@jasper/mg-templates';
import { type Sequence, TITLE_GENERATORS, TITLE_LAYER_TYPES } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { cx, Dialog, Icon, type IconId, Kbd, toast } from '@jasper/ui';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { listCommands } from '../../commands/registry.ts';
import { formatTimecode, parseTimecodeEntry } from '../../gaps/time-display.ts';
import { t } from '../../i18n/runtime.ts';
import { applyEffectToClips, clipsAccepting } from '../../panels/effects/drag.ts';
import { insertMotionTemplate } from '../../panels/motionTemplates/insert.ts';
import type { PanelDefinition } from '../../panels/types.ts';
import { announce, pickLook } from '../../title-looks/actions.ts';
import { lookEntries } from '../../title-looks/library.ts';
import { lookedTargets } from '../../title-looks/look-actions.ts';
import { currentUserLooks } from '../../title-looks/user-library.ts';
import { recentCommands, useCommandCtx, useShellRuntime } from '../context.tsx';
import { commandState } from '../menus/resolve.ts';
import { workspaceName } from '../workspaces/definitions.ts';
import type { WorkspaceStore } from '../workspaces/store.ts';
import { fuzzyScore, parsePaletteQuery, rankByGroup } from './fuzzy.ts';

export type PaletteRow = {
	key: string;
	group: string;
	label: string;
	detail?: string;
	shortcut?: string | null;
	icon?: IconId;
	disabled?: boolean;
	reason?: string;
	score: number;
	run(): void;
};

export type PaletteSources = {
	session: EditorSession | null;
	panels: readonly PanelDefinition[];
	workspaces: WorkspaceStore;
	focusPanel(kind: PanelDefinition['kind']): void;
	switchWorkspace(id: string): void;
};

function activeSequence(session: EditorSession | null): Sequence | null {
	const s = session?.getState();
	if (!s?.activeSequenceId) return null;
	return (s.document.sequences[s.activeSequenceId] as Sequence | undefined) ?? null;
}

/** Builds palette rows for a query. */
function buildPaletteRows(
	raw: string,
	env: ReturnType<typeof useShellRuntime> & { getCtx: ReturnType<typeof useCommandCtx> },
	src: PaletteSources,
	close: () => void,
): PaletteRow[] {
	const { prefix, text } = parsePaletteQuery(raw);
	const ctx = env.getCtx();
	const rows: PaletteRow[] = [];
	const menuEnv = { ctx, platform: env.platform, runtime: env.runtime };
	const exec = (fn: () => void) => () => {
		close();
		fn();
	};

	const commandRows = (limit: number) => {
		const out: PaletteRow[] = [];
		const recent = recentCommands();
		for (const cmd of listCommands()) {
			if (cmd.hidden) continue;
			const st = commandState(cmd.id, menuEnv);
			const score = text
				? fuzzyScore(text, `${st.label} ${cmd.id}`)
				: recent.includes(cmd.id)
					? 500 - recent.indexOf(cmd.id)
					: null;
			if (score === null) continue;
			out.push({
				key: `cmd:${cmd.id}`,
				group: text ? 'Commands' : 'Recent commands',
				label: st.label,
				detail: cmd.description,
				shortcut: st.shortcut,
				icon: cmd.icon,
				disabled: !st.enabled,
				reason: st.reason,
				score,
				run: exec(() => void env.run(cmd.id)),
			});
		}
		return out.sort((a, b) => b.score - a.score).slice(0, limit);
	};

	const panelRows = (limit: number) =>
		src.panels
			.map((d) => {
				const label = `Open ${d.title({})} panel`;
				const score = text ? fuzzyScore(text, label) : 0;
				return score === null
					? null
					: ({
							key: `panel:${d.kind}`,
							group: 'Panels',
							label,
							icon: d.icon,
							score,
							run: exec(() => src.focusPanel(d.kind)),
						} satisfies PaletteRow);
			})
			.filter((r): r is NonNullable<typeof r> => r !== null)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);

	const workspaceRows = (limit: number) =>
		src.workspaces
			.list()
			.map((w) => {
				const label = t('Workspace: {0}', workspaceName(w));
				const score = text ? fuzzyScore(text, label) : 0;
				const n = src.workspaces.shortcutNumber(w.id);
				return score === null
					? null
					: ({
							key: `ws:${w.id}`,
							group: 'Workspaces',
							label,
							icon: 'app.workspaces' as IconId,
							shortcut: n ? `Alt+Shift+${n}` : null,
							score,
							run: exec(() => src.switchWorkspace(w.id)),
						} satisfies PaletteRow);
			})
			.filter((r): r is NonNullable<typeof r> => r !== null)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);

	const itemRows = (limit: number) => {
		const s = src.session;
		if (!s) return [];
		const doc = s.getState().document;
		const out: PaletteRow[] = [];
		for (const it of Object.values(doc.items)) {
			const score = text ? fuzzyScore(text, it.name) : 0;
			if (score === null) continue;
			const seqId = (it as { sequenceId?: string }).sequenceId;
			out.push({
				key: `item:${it.id}`,
				group: 'Project items',
				label: it.name,
				detail: it.kind,
				icon: it.kind === 'bin' ? 'panel.project' : it.kind === 'sequence' ? 'panel.timeline' : 'media.video',
				score,
				run: exec(() => {
					if (it.kind === 'sequence' && seqId) s.openSequence(seqId);
					s.select('project', [it.id], 'replace', { primary: it.id });
					src.focusPanel('project');
				}),
			});
		}
		return out.sort((a, b) => b.score - a.score).slice(0, limit);
	};

	/** TL-097: effects, templates, looks and look layers answer a search like commands do. */
	const contentRows = (limit: number): PaletteRow[] => {
		const session = src.session;
		if (!session || !text) return [];
		const out: PaletteRow[] = [];
		const add = (row: Omit<PaletteRow, 'score'>, haystack: string) => {
			const score = fuzzyScore(text, haystack);
			if (score !== null) out.push({ ...row, score });
		};
		const selected = session.getState().selection.timeline.clips;
		for (const e of session.ctx.registries.effects.list()) {
			if (e.internal) continue;
			const score = fuzzyScore(text, [e.label, ...(e.keywords ?? [])].join(' '));
			if (score === null) continue;
			const targets = clipsAccepting(session, e.id, selected);
			out.push({
				key: `effect:${e.id}`,
				group: 'Effects',
				label: e.label,
				detail: e.category,
				disabled: targets.length === 0,
				reason: 'Select a clip that can take this effect first.',
				score,
				run: exec(() => void applyEffectToClips(session, e.id, targets)),
			});
		}
		const hasSequence = !!session.getState().activeSequenceId;
		for (const def of mgRegistry.definitions())
			add(
				{
					key: `template:${def.id}@${def.version}`,
					group: 'Templates',
					label: def.name,
					detail: def.category,
					disabled: !hasSequence,
					reason: 'Open a sequence first',
					run: exec(() => {
						try {
							insertMotionTemplate(session, { id: def.id, version: def.version });
						} catch (e) {
							toast({ kind: 'error', title: e instanceof Error ? e.message : String(e) });
						}
					}),
				},
				`${def.name} ${def.category}`,
			);
		for (const look of lookEntries(session.getCommitted(), undefined, undefined, currentUserLooks()))
			add(
				{
					key: `look:${look.lookId}`,
					group: 'Looks',
					label: look.name,
					detail: look.category,
					disabled: !hasSequence,
					reason: 'Open a sequence first',
					run: exec(() => announce(pickLook(session, look))),
				},
				look.searchText,
			);
		for (const l of TITLE_LAYER_TYPES) {
			const label = t('Add Layer: {0}', l.label);
			add(
				{
					key: `look-layer:${l.type}`,
					group: 'Look layers',
					label,
					detail: l.description,
					disabled: lookedTargets(session).length === 0,
					reason: 'Select a clip with a look first.',
					run: exec(() => void env.run('graphics.addLookLayer', { layerType: l.type })),
				},
				label,
			);
		}
		// TL-063: a generator layer below the selected title (or at the playhead), with any of its presets.
		for (const g of TITLE_GENERATORS) {
			const label = t('New Generator Layer: {0}', g.label);
			add(
				{
					key: `generator:${g.id}`,
					group: 'Generators',
					label,
					detail: g.description,
					disabled: !hasSequence,
					reason: 'Open a sequence first',
					run: exec(() => void env.run('graphics.addGenerator', { generatorId: g.id })),
				},
				`${label} ${(g.keywords ?? []).join(' ')}`,
			);
			for (const p of g.presets ?? []) {
				if (Object.keys(p.params).length === 0) continue;
				const named = t('New Generator Layer: {0} › {1}', g.label, p.label);
				add(
					{
						key: `generator:${g.id}:${p.id}`,
						group: 'Generators',
						label: named,
						detail: g.description,
						disabled: !hasSequence,
						reason: 'Open a sequence first',
						run: exec(() => void env.run('graphics.addGenerator', { generatorId: g.id, preset: p.id })),
					},
					named,
				);
			}
		}
		return out.sort((a, b) => b.score - a.score).slice(0, limit);
	};

	if (prefix === '?') {
		const help: [string, string][] = [
			['>', 'Commands only'],
			['@', 'Project items'],
			['#', 'Markers'],
			[':', 'Go to timecode, e.g. :00:01:10:00'],
		];
		return help.map(([p, d], i) => ({
			key: `help:${p}`,
			group: 'Help',
			label: `${p}  ${d}`,
			score: -i,
			run: () => {},
		}));
	}

	if (prefix === ':') {
		const seq = activeSequence(src.session);
		if (!seq || !src.session)
			return [
				{
					key: 'tc:none',
					group: 'Go to',
					label: 'Open a sequence to go to a timecode',
					disabled: true,
					score: 0,
					run: () => {},
				},
			];
		const rate = seq.settings.frameRate;
		const opts = { dropFrame: seq.settings.dropFrame, startFrames: seq.settings.startTimecodeFrames };
		const transport = src.session.transport;
		const frame = text
			? parseTimecodeEntry(text, rate, { ...opts, current: transport.getState().frame })
			: null;
		if (frame === null)
			return [
				{
					key: 'tc:invalid',
					group: 'Go to',
					label: text ? `“${text}” is not a timecode` : 'Type a timecode, e.g. 00:01:10:00 or +15',
					disabled: true,
					score: 0,
					run: () => {},
				},
			];
		return [
			{
				key: 'tc:go',
				group: 'Go to',
				label: `Go to ${formatTimecode(frame, rate, opts)}`,
				icon: 'transport.goToIn',
				score: 1,
				run: exec(() => transport.seek(frame)),
			},
		];
	}

	if (prefix === '#') {
		const seq = activeSequence(src.session);
		if (!seq || !src.session) return [];
		const transport = src.session.transport;
		return seq.markers
			.map((m) => {
				const label =
					m.name ||
					`Marker at ${formatTimecode(m.frame, seq.settings.frameRate, { dropFrame: seq.settings.dropFrame })}`;
				const score = text ? fuzzyScore(text, `${label} ${m.comment}`) : 0;
				return score === null
					? null
					: ({
							key: `marker:${m.id}`,
							group: 'Markers',
							label,
							detail: m.comment || undefined,
							icon: 'timeline.addMarker',
							score,
							run: exec(() => transport.seek(m.frame)),
						} satisfies PaletteRow);
			})
			.filter((r): r is NonNullable<typeof r> => r !== null)
			.sort((a, b) => b.score - a.score);
	}

	if (prefix === '>') rows.push(...commandRows(60));
	else if (prefix === '@') rows.push(...itemRows(60));
	else {
		rows.push(...commandRows(text ? 20 : 8));
		if (text) {
			// TL-097: a look or an effect named exactly comes before commands that only happen to contain the letters.
			rows.splice(0, rows.length, ...rankByGroup([...rows, ...contentRows(12)]));
			rows.push(...panelRows(6), ...workspaceRows(6), ...itemRows(8));
		} else rows.push(...panelRows(20));
	}
	return rows;
}

export function CommandPalette(props: { query: string | null; onClose(): void; sources: PaletteSources }) {
	const runtime = useShellRuntime();
	const getCtx = useCommandCtx();
	const [q, setQ] = useState('');
	const [sel, setSel] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);
	const open = props.query !== null;

	useEffect(() => {
		if (props.query !== null) {
			setQ(props.query);
			setSel(0);
		}
	}, [props.query]);

	const rows = useMemo(
		() => (open ? buildPaletteRows(q, { ...runtime, getCtx }, props.sources, props.onClose) : []),
		[open, q, runtime, getCtx, props.sources, props.onClose],
	);
	const selectable = rows.map((r, i) => (r.disabled ? -1 : i)).filter((i) => i >= 0);
	const current = rows[sel];

	useEffect(() => {
		listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
	});

	const move = (dir: 1 | -1) => {
		if (!selectable.length) return;
		const at = selectable.indexOf(sel);
		const next = selectable[(at + dir + selectable.length) % selectable.length] ?? selectable[0] ?? 0;
		setSel(next);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			move(1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			move(-1);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const row = current && !current.disabled ? current : rows[selectable[0] ?? -1];
			row?.run();
		}
	};

	let lastGroup = '';
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && props.onClose()}
			title="Command palette"
			bare
			size="medium"
			contentClassName="top-[20%] left-1/2 -translate-x-1/2"
			data-testid="command-palette"
		>
			<div className="flex max-h-[60vh] flex-col">
				<div className="flex h-10 shrink-0 items-center gap-2 border-b border-pr-border-subtle px-3">
					<span className="text-pr-muted">
						<Icon id="app.search" size={16} />
					</span>
					<input
						autoFocus
						value={q}
						onChange={(e) => {
							setQ(e.target.value);
							setSel(0);
						}}
						onKeyDown={onKeyDown}
						placeholder="Type a command, > commands, @ items, : timecode, ? help"
						aria-label="Command palette search"
						aria-controls="palette-results"
						aria-activedescendant={current ? `palette-${current.key}` : undefined}
						data-testid="palette-input"
						className="h-full min-w-0 flex-1 bg-transparent font-pr text-[13px] text-pr-text outline-none placeholder:text-pr-dim"
					/>
				</div>
				<div
					ref={listRef}
					id="palette-results"
					role="listbox"
					aria-label="Results"
					className="min-h-0 flex-1 overflow-y-auto p-1"
				>
					{rows.length === 0 ? <div className="px-3 py-2 text-pr-muted">No results</div> : null}
					{rows.map((r, i) => {
						const header = r.group !== lastGroup ? r.group : null;
						lastGroup = r.group;
						return (
							<div key={r.key}>
								{header ? <div className="px-2 pt-2 pb-1 text-pr-small text-pr-muted">{header}</div> : null}
								<div
									id={`palette-${r.key}`}
									role="option"
									tabIndex={-1}
									aria-selected={i === sel}
									aria-disabled={r.disabled || undefined}
									data-selected={i === sel}
									data-testid="palette-row"
									title={r.disabled ? r.reason : undefined}
									onMouseMove={() => !r.disabled && setSel(i)}
									onClick={() => !r.disabled && r.run()}
									onKeyDown={() => {}}
									className={cx(
										'flex h-7 cursor-default items-center gap-2 rounded-[3px] px-2 font-pr text-pr-ui',
										r.disabled
											? 'text-pr-dim'
											: i === sel
												? 'bg-pr-accent-fill text-pr-on-accent'
												: 'text-pr-text',
									)}
								>
									<span className="inline-flex w-4 shrink-0 justify-center">
										{r.icon ? <Icon id={r.icon} size={14} /> : null}
									</span>
									<span className="min-w-0 truncate">{r.label}</span>
									{r.detail ? (
										<span
											className={cx(
												'min-w-0 truncate',
												i === sel && !r.disabled ? 'text-pr-on-accent' : 'text-pr-muted',
											)}
										>
											{r.detail}
										</span>
									) : null}
									{r.shortcut ? (
										<Kbd className={cx('ml-auto shrink-0', i === sel && !r.disabled && 'text-pr-on-accent')}>
											{r.shortcut}
										</Kbd>
									) : null}
								</div>
							</div>
						);
					})}
				</div>
			</div>
		</Dialog>
	);
}
