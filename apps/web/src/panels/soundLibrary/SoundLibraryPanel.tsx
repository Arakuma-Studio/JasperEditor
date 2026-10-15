// Sound Library panel (spec 12 §2.7, P1-R7): search the engine's sound library (bundled starter kit, packs, your
// folders, Jasper Synth), filter by type chips grouped by family (disjunctive facet counts), Refine pills and the
// licence filter ("Commercial-safe" on by default), audition (Space, Loop, Auto-play, volume) and insert peak-aligned
// at the playhead (Enter / double-click) or by dragging onto the timeline. Collections: All, Favourites, Recent, Used
// in this project and each source. Results are a virtualised listbox with descriptor-rich accessible names.
import type { SoundEntry, SoundFacets, SoundLibraryStatus, SoundRoot } from '@jasper/api';
import type { SoundTypeId } from '@jasper/project';
import type { SessionState } from '@jasper/session';
import { useSessionOrNull, useStoreSelector } from '@jasper/session/react';
import {
	ContextMenu,
	cx,
	EmptyState,
	Icon,
	IconButton,
	openDialog,
	type ResolvedMenuItem,
	SearchField,
	Select,
	Slider,
	toast as uiToast,
} from '@jasper/ui';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createCommandContext } from '../../commands/context.ts';
import { chordFromEvent, resolveBindings, scopeChain } from '../../commands/keymap-defaults.ts';
import { getCommand, isCommandEnabled, runCommand } from '../../commands/registry.ts';
import type { CommandCtx, ToastRequest } from '../../commands/types.ts';
import { getDesktopBridge } from '../../runtime/platform.ts';
import { useShellRuntimeOrNull } from '../../shell/context.tsx';
import { PREFERENCES_DIALOG } from '../../shell/preferences/index.ts';
import { auditionPlayer } from '../../sound/audition.ts';
import {
	insertSoundWithFeedback,
	registerSoundLibraryController,
	toggleAuditionOf,
} from '../../sound/controller.ts';
import { registerSoundDialogs, SOUND_LICENSE_DIALOG } from '../../sound/dialogs.tsx';
import { endSoundDrag, writeSoundDrag } from '../../sound/insert.ts';
import {
	type Collection,
	DEFAULT_FILTERS,
	formatSeconds,
	type LibraryFilters,
	LOCAL_COLLECTIONS,
	licenseBadge,
	REFINE_LABELS,
	REFINE_OPTIONS,
	type RefineKey,
	SOUND_FAMILY_LABELS,
	SOUND_SOURCE_LABELS,
	SOUND_TYPE_LABELS,
	searchLocal,
	searchRequest,
	soundAccessibleName,
	soundTooltip,
	TYPE_GROUPS,
	typeLabel,
	usedSoundIds,
} from '../../sound/model.ts';
import {
	MAX_AUDITION_DB,
	MIN_AUDITION_DB,
	soundLibraryPrefs,
	useSoundLibraryPrefs,
} from '../../sound/prefs.ts';
import { useEngine } from '../../state/engine.tsx';
import { EMPTY_SESSION_STORE } from '../session-store.ts';
import type { PanelProps } from '../types.ts';
import { clearWaveformCache, MiniWaveform } from './MiniWaveform.tsx';

registerSoundDialogs();

const PAGE = 100;
const HOVER_DELAY_MS = 350;
const SEARCH_DEBOUNCE_MS = 150;
/** Rows rendered before the list has been measured (jsdom, first paint). */
const INITIAL_ROWS = 40;

type Results = {
	items: SoundEntry[];
	total: number;
	librarySize: number;
	facets: SoundFacets;
	indexing: boolean;
	/** Local collections: sounds of the collection no longer in the library. */
	missing: number;
};

const EMPTY_FACETS: SoundFacets = { types: {}, families: {}, licenses: {}, sources: {} };

/** A cache of library entries fetched by id (local collections). */
const entryCache = new Map<string, Promise<SoundEntry | null>>();

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

export function SoundLibraryPanel(props: PanelProps) {
	const { client: engine, status: engineStatus, subscribe } = useEngine();
	const session = useSessionOrNull();
	const runtime = useShellRuntimeOrNull();
	const prefs = useSoundLibraryPrefs();
	const hasSequence = useStoreSelector(
		session?.store ?? EMPTY_SESSION_STORE,
		(s: SessionState | null) => !!s?.activeSequenceId,
	);
	const readOnly = useStoreSelector(
		session?.store ?? EMPTY_SESSION_STORE,
		(s: SessionState | null) => !!s?.readOnly,
	);
	const usedKey = useStoreSelector(session?.store ?? EMPTY_SESSION_STORE, (s: SessionState | null) =>
		s ? usedSoundIds(s.document).join(',') : '',
	);
	const [filters, setFilters] = useState<LibraryFilters>(DEFAULT_FILTERS);
	const [queryInput, setQueryInput] = useState('');
	const [status, setStatus] = useState<SoundLibraryStatus | null>(null);
	const [roots, setRoots] = useState<SoundRoot[]>([]);
	const [results, setResults] = useState<Results | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [libraryEpoch, setLibraryEpoch] = useState(0);
	const audition = useStoreSelector(auditionPlayer().store, (s) => s);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const menuEntry = useRef<SoundEntry | null>(null);
	const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const loadingMore = useRef(false);

	const ctx = useCallback(
		(): CommandCtx => runtime?.getCtx() ?? createCommandContext({ engine, session }),
		[runtime, engine, session],
	);
	const notify = useCallback(
		(r: ToastRequest) => {
			if (runtime) runtime.getCtx().ui.toast(r);
			else
				uiToast({
					kind: r.kind,
					title: r.message,
					...(r.detail ? { detail: r.detail } : {}),
				});
		},
		[runtime],
	);

	// ---------------------------------------------------------------- library status, folders, change events
	const refreshStatus = useCallback(() => {
		void engine
			.soundLibraryStatus()
			.then(setStatus)
			.catch(() => setStatus(null));
		void engine
			.getSoundRoots()
			.then((r) => setRoots(r.roots))
			.catch(() => setRoots([]));
	}, [engine]);
	useEffect(() => {
		if (engineStatus !== 'connected') return;
		refreshStatus();
	}, [engineStatus, refreshStatus]);
	useEffect(
		() =>
			subscribe((e) => {
				if (e?.type !== 'sounds.changed') return;
				clearWaveformCache();
				entryCache.clear();
				refreshStatus();
				setLibraryEpoch((n) => n + 1);
			}),
		[subscribe, refreshStatus],
	);
	// While indexing, ask again every 2 s (progress; the event ends it).
	const indexing = !!status?.indexing;
	useEffect(() => {
		if (!indexing) return;
		const t = setInterval(refreshStatus, 2000);
		return () => clearInterval(t);
	}, [indexing, refreshStatus]);

	// ---------------------------------------------------------------- search
	useEffect(() => {
		const t = setTimeout(
			() => setFilters((f) => (f.query === queryInput ? f : { ...f, query: queryInput })),
			SEARCH_DEBOUNCE_MS,
		);
		return () => clearTimeout(t);
	}, [queryInput]);

	const local = LOCAL_COLLECTIONS.has(filters.collection);
	const localIds = useMemo(() => {
		if (filters.collection === 'favourites') return prefs.favourites;
		if (filters.collection === 'recent') return prefs.recents;
		if (filters.collection === 'used') return usedKey ? usedKey.split(',') : [];
		return [];
	}, [filters.collection, prefs.favourites, prefs.recents, usedKey]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `libraryEpoch` re-runs the search when the library changes
	useEffect(() => {
		if (engineStatus !== 'connected') return;
		const ac = new AbortController();
		setLoading(true);
		setError(null);
		const run = async (): Promise<Results> => {
			if (local) {
				const got = await Promise.all(
					localIds.map((id) => {
						let p = entryCache.get(id);
						if (!p) {
							p = engine.getSound(id).catch(() => null);
							entryCache.set(id, p);
						}
						return p;
					}),
				);
				const entries = got.filter((x): x is SoundEntry => !!x);
				const similar = filters.similarTo
					? ((await engine.getSound(filters.similarTo.id).catch(() => null)) ?? null)
					: null;
				const r = searchLocal(entries, filters, similar);
				return {
					items: r.results,
					total: r.total,
					librarySize: status?.sounds ?? entries.length,
					facets: r.facets,
					indexing: !!status?.indexing,
					missing: localIds.length - entries.length,
				};
			}
			const r = await engine.searchSounds(searchRequest(filters, { limit: PAGE, offset: 0 }), ac.signal);
			return {
				items: r.results.map((x) => x.sound),
				total: r.total,
				librarySize: r.librarySize,
				facets: r.facets,
				indexing: r.indexing,
				missing: 0,
			};
		};
		run()
			.then((r) => {
				if (ac.signal.aborted) return;
				setResults(r);
				setLoading(false);
				setSelectedId((cur) => (cur && r.items.some((x) => x.id === cur) ? cur : (r.items[0]?.id ?? null)));
			})
			.catch((e) => {
				if (ac.signal.aborted) return;
				setLoading(false);
				setError(errorText(e));
			});
		return () => ac.abort();
	}, [engine, engineStatus, filters, local, localIds, libraryEpoch]);

	const loadMore = useCallback(() => {
		if (local || !results || loadingMore.current || results.items.length >= results.total) return;
		loadingMore.current = true;
		void engine
			.searchSounds(searchRequest(filters, { limit: PAGE, offset: results.items.length }))
			.then((r) =>
				setResults((cur) => {
					if (!cur) return cur;
					const seen = new Set(cur.items.map((x) => x.id));
					return {
						...cur,
						items: [...cur.items, ...r.results.map((x) => x.sound).filter((x) => !seen.has(x.id))],
					};
				}),
			)
			.catch(() => undefined)
			.finally(() => {
				loadingMore.current = false;
			});
	}, [engine, filters, local, results]);

	const items = results?.items ?? [];
	const selected = items.find((x) => x.id === selectedId) ?? null;
	const rootLabel = useCallback((id: string) => roots.find((r) => r.id === id)?.label ?? null, [roots]);

	// ---------------------------------------------------------------- actions
	const canInsert = !!session && hasSequence && !readOnly;
	const doAudition = useCallback(
		(e: SoundEntry | null) => {
			if (e) toggleAuditionOf(engine, e);
		},
		[engine],
	);
	const doInsert = useCallback(
		(e: SoundEntry | null) => {
			if (!e) return;
			if (!session || !canInsert) {
				notify({
					kind: 'info',
					message: readOnly ? 'The project is read-only' : 'Open a sequence to add sounds',
				});
				return;
			}
			void insertSoundWithFeedback(session, engine, e, notify);
		},
		[session, canInsert, engine, notify, readOnly],
	);
	const doFavourite = useCallback((e: SoundEntry | null) => {
		if (e) soundLibraryPrefs.toggleFavourite(e.id);
	}, []);
	const doSimilar = useCallback((e: SoundEntry | null) => {
		if (!e) return;
		setFilters((f) => ({ ...f, similarTo: { id: e.id, title: e.title || e.id } }));
	}, []);
	const doLicense = useCallback(
		(e: SoundEntry | null) => {
			if (!e) return;
			void openDialog(SOUND_LICENSE_DIALOG, {
				entry: e,
				rootLabel: e.source.type === 'folder' ? rootLabel(e.source.rootId) : null,
			});
		},
		[rootLabel],
	);
	const folderPath = useCallback(
		(e: SoundEntry | null): string | null => {
			if (e?.source.type !== 'folder') return null;
			const src = e.source;
			const root = roots.find((r) => r.id === src.rootId);
			return root ? `${root.path.replace(/[\\/]+$/, '')}/${src.relPath}` : null;
		},
		[roots],
	);

	const select = useCallback(
		(id: string | null, opts: { play?: boolean } = {}) => {
			setSelectedId(id);
			const e = id ? items.find((x) => x.id === id) : null;
			if (e && opts.play && soundLibraryPrefs.get().autoPlay) {
				const p = auditionPlayer();
				p.setLoop(soundLibraryPrefs.get().loop);
				p.setVolumeDb(soundLibraryPrefs.get().volumeDb);
				soundLibraryPrefs.touchRecent(e.id);
				void p.play({ id: e.id, title: e.title || e.id, url: engine.soundAudioUrl(e.id) });
			}
		},
		[items, engine],
	);

	// The commands (keymap scope `soundLibrary`, menus, agents) reach the panel through its controller.
	const latest = useRef({ selected, doAudition, doInsert, doFavourite, doSimilar, doLicense });
	latest.current = { selected, doAudition, doInsert, doFavourite, doSimilar, doLicense };
	useEffect(
		() =>
			registerSoundLibraryController({
				selected: () => latest.current.selected,
				toggleAudition: () => latest.current.doAudition(latest.current.selected),
				insertSelected: () => latest.current.doInsert(latest.current.selected),
				toggleFavourite: () => latest.current.doFavourite(latest.current.selected),
				focusSearch: () => {
					searchRef.current?.focus();
					searchRef.current?.select();
				},
				setQuery: (q) => {
					setQueryInput(q);
					setFilters((f) => ({ ...f, query: q }));
				},
				findSimilar: () => latest.current.doSimilar(latest.current.selected),
				showLicense: () => latest.current.doLicense(latest.current.selected),
			}),
		[],
	);

	// Audition follows the panel's prefs.
	useEffect(() => {
		auditionPlayer().setLoop(prefs.loop);
	}, [prefs.loop]);
	useEffect(() => {
		auditionPlayer().setVolumeDb(prefs.volumeDb);
	}, [prefs.volumeDb]);
	useEffect(
		() => () => {
			if (hoverTimer.current) clearTimeout(hoverTimer.current);
		},
		[],
	);

	// ---------------------------------------------------------------- list geometry (virtualised)
	const rowH = prefs.density === 'compact' ? 24 : 36;
	const [view, setView] = useState({ top: 0, height: 0 });
	useEffect(() => {
		const el = listRef.current;
		if (!el) return;
		const measure = () => setView({ top: el.scrollTop, height: el.clientHeight });
		measure();
		const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
		ro?.observe(el);
		return () => ro?.disconnect();
	}, []);
	const first = view.height > 0 ? Math.max(0, Math.floor(view.top / rowH) - 8) : 0;
	const last =
		view.height > 0
			? Math.min(items.length, Math.ceil((view.top + view.height) / rowH) + 8)
			: Math.min(items.length, INITIAL_ROWS);
	useEffect(() => {
		if (results && last >= items.length - 10 && items.length < results.total) loadMore();
	}, [last, items.length, results, loadMore]);
	const scrollIntoView = useCallback(
		(index: number) => {
			const el = listRef.current;
			if (!el || !(el.clientHeight > 0)) return;
			const y = index * rowH;
			if (y < el.scrollTop) el.scrollTop = y;
			else if (y + rowH > el.scrollTop + el.clientHeight) el.scrollTop = y + rowH - el.clientHeight;
		},
		[rowH],
	);

	// ---------------------------------------------------------------- keyboard
	const runScopedKey = (e: KeyboardEvent): boolean => {
		const platform = runtime?.platform ?? 'linux';
		const chord = chordFromEvent(e.nativeEvent, platform);
		const c = ctx();
		for (const b of resolveBindings(chord, scopeChain('soundLibrary'), {
			platform,
			runtime: runtime?.runtime ?? 'web',
		})) {
			const cmd = getCommand(b.command);
			if (!cmd || !isCommandEnabled(cmd, c)) continue;
			e.preventDefault();
			if (e.repeat && !b.repeat && !cmd.repeat) return true;
			void runCommand(b.command, c, b.args);
			return true;
		}
		return false;
	};
	const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const index = items.findIndex((x) => x.id === selectedId);
		const page = Math.max(1, Math.floor((listRef.current?.clientHeight ?? 360) / rowH) - 1);
		const go = (i: number) => {
			const n = Math.max(0, Math.min(items.length - 1, i));
			const it = items[n];
			if (!it) return;
			e.preventDefault();
			select(it.id, { play: true });
			scrollIntoView(n);
		};
		if (!e.ctrlKey && !e.metaKey && !e.altKey) {
			if (e.key === 'ArrowDown') return go(index < 0 ? 0 : index + 1);
			if (e.key === 'ArrowUp') return go(index < 0 ? 0 : index - 1);
			if (e.key === 'Home') return go(0);
			if (e.key === 'End') return go(items.length - 1);
			if (e.key === 'PageDown') return go(index + page);
			if (e.key === 'PageUp') return go(index - page);
		}
		runScopedKey(e);
	};
	const onPanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		// Ctrl/Cmd+F anywhere in the panel focuses the search (the list handles its own keys).
		if (e.defaultPrevented || (e.target as HTMLElement).closest('[role="listbox"]')) return;
		if ((e.ctrlKey || e.metaKey) && e.code === 'KeyF') {
			e.preventDefault();
			searchRef.current?.focus();
			searchRef.current?.select();
		}
	};

	// ---------------------------------------------------------------- menus
	const rowMenu = (): ResolvedMenuItem[] => {
		const e = menuEntry.current ?? selected;
		if (!e) return [];
		const fav = soundLibraryPrefs.isFavourite(e.id);
		const playing = audition.soundId === e.id && audition.phase !== 'idle';
		const path = folderPath(e);
		const desktop = getDesktopBridge();
		return [
			{
				type: 'item',
				id: 'audition',
				label: playing ? 'Stop Audition' : 'Audition',
				shortcut: 'Space',
				onSelect: () => doAudition(e),
			},
			{
				type: 'item',
				id: 'insert',
				label: 'Insert at Playhead',
				shortcut: 'Enter',
				disabled: !canInsert,
				disabledReason: readOnly ? 'The project is read-only' : 'Open a sequence first',
				onSelect: () => doInsert(e),
			},
			{ type: 'separator', id: 's1' },
			{
				type: 'item',
				id: 'favourite',
				label: 'Favourite',
				shortcut: 'F',
				checked: fav,
				onSelect: () => doFavourite(e),
			},
			{ type: 'item', id: 'similar', label: 'Find Similar', onSelect: () => doSimilar(e) },
			{ type: 'separator', id: 's2' },
			{ type: 'item', id: 'license', label: 'Show Licence…', onSelect: () => doLicense(e) },
			...(desktop && path
				? [
						{
							type: 'item' as const,
							id: 'reveal',
							label: 'Reveal in Folder',
							onSelect: () => desktop.revealInFolder(path),
						},
					]
				: []),
		];
	};

	// ---------------------------------------------------------------- render helpers
	const setRefine = (key: RefineKey, value: string | undefined) =>
		setFilters((f) => {
			const refine = { ...f.refine } as Record<string, string | undefined>;
			if (!value || refine[key] === value) delete refine[key];
			else refine[key] = value;
			return { ...f, refine: refine as LibraryFilters['refine'] };
		});
	const toggleType = (t: SoundTypeId) =>
		setFilters((f) => ({
			...f,
			types: f.types.includes(t) ? f.types.filter((x) => x !== t) : [...f.types, t],
		}));
	const facets = results?.facets ?? EMPTY_FACETS;
	const bySource = status?.bySource ?? { starter: 0, pack: 0, folder: 0, synth: 0 };
	const collectionOptions = useMemo(() => {
		const opts: { value: string; label: string }[] = [
			{ value: 'all', label: 'All sounds' },
			{ value: 'favourites', label: `Favourites (${prefs.favourites.length})` },
			{ value: 'recent', label: 'Recent' },
			{ value: 'used', label: 'Used in this project' },
		];
		if (bySource.starter)
			opts.push({ value: 'source:starter', label: `Sources › ${SOUND_SOURCE_LABELS.starter}` });
		if (bySource.pack) opts.push({ value: 'source:pack', label: `Sources › ${SOUND_SOURCE_LABELS.pack}` });
		if (roots.length) opts.push({ value: 'source:folder', label: `Sources › ${SOUND_SOURCE_LABELS.folder}` });
		for (const r of roots) opts.push({ value: `root:${r.id}`, label: `Sources › ${r.label || r.path}` });
		if (bySource.synth) opts.push({ value: 'source:synth', label: `Sources › ${SOUND_SOURCE_LABELS.synth}` });
		if (!opts.some((o) => o.value === filters.collection))
			opts.push({ value: filters.collection, label: filters.collection });
		return opts;
	}, [prefs.favourites.length, bySource.starter, bySource.pack, bySource.synth, roots, filters.collection]);

	const libraryEmpty = status ? status.sounds === 0 : results ? results.librarySize === 0 : false;
	const playingId = audition.phase !== 'idle' ? audition.soundId : null;
	const announce =
		audition.error ??
		(audition.phase === 'playing'
			? `Playing ${audition.title ?? ''}`
			: audition.phase === 'loading'
				? `Loading ${audition.title ?? ''}`
				: audition.epoch > 0
					? 'Audition stopped'
					: '');

	const sourceCounts = (['starter', 'pack', 'folder', 'synth'] as const)
		.filter((s) => bySource[s])
		.map((s) => `${SOUND_SOURCE_LABELS[s]} ${bySource[s]}`)
		.join(' · ');

	const filtersActive =
		filters.query.trim() !== '' ||
		filters.types.length > 0 ||
		Object.keys(filters.refine).length > 0 ||
		!!filters.similarTo ||
		filters.collection !== 'all';

	// ---------------------------------------------------------------- render
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: panel-level Ctrl/Cmd+F
		<div
			className="flex h-full min-h-0 flex-col text-pr-ui text-pr-text"
			data-panel-kind="soundLibrary"
			data-instance-id={props.instanceId}
			onKeyDown={onPanelKeyDown}
		>
			{/* toolbar */}
			<div className="flex items-center gap-1 px-1 pt-1" role="toolbar" aria-label="Sound Library">
				<SearchField
					ref={searchRef}
					className="min-w-0 flex-1"
					placeholder="Search sounds"
					aria-label="Search sounds"
					data-testid="sound-search"
					value={queryInput}
					onValueChange={setQueryInput}
					onKeyDown={(e) => {
						if (e.key === 'Enter' || e.key === 'ArrowDown') {
							e.preventDefault();
							listRef.current?.focus();
							if (!selectedId && items[0]) select(items[0].id);
						}
					}}
				/>
				<IconButton
					icon="transport.loop"
					label="Loop audition"
					shortcut="L"
					size="small"
					toggled={prefs.loop ? 'on' : 'off'}
					onClick={() => soundLibraryPrefs.set({ loop: !prefs.loop })}
					data-testid="sound-loop"
				/>
				<IconButton
					icon="app.autoplay"
					label="Auto-play on select"
					size="small"
					toggled={prefs.autoPlay ? 'on' : 'off'}
					onClick={() => soundLibraryPrefs.set({ autoPlay: !prefs.autoPlay })}
					data-testid="sound-autoplay"
				/>
				<span className="text-pr-muted" title="Audition volume">
					<Icon id="app.volume" size={14} />
				</span>
				<div className="w-[64px] shrink-0">
					<Slider
						label="Audition volume"
						value={prefs.volumeDb}
						min={MIN_AUDITION_DB}
						max={MAX_AUDITION_DB}
						step={1}
						defaultValue={-6}
						valueText={`${prefs.volumeDb} dB`}
						onChange={(v) => soundLibraryPrefs.set({ volumeDb: v })}
						onCommit={(v) => soundLibraryPrefs.set({ volumeDb: v })}
					/>
				</div>
			</div>
			{/* collection */}
			<div className="flex items-center gap-1 px-1 pt-1">
				<Select
					label="Collection"
					className="min-w-0 flex-1"
					value={filters.collection}
					onValueChange={(v) => setFilters((f) => ({ ...f, collection: v as Collection }))}
					options={collectionOptions}
				/>
				{filters.similarTo ? (
					<button
						type="button"
						className="inline-flex max-w-[45%] items-center gap-1 rounded-pr-pill border border-pr-accent px-1.5 text-pr-small text-pr-text"
						aria-label={`Similar to ${filters.similarTo.title}: clear`}
						onClick={() => setFilters((f) => ({ ...f, similarTo: null }))}
						data-testid="sound-similar-chip"
					>
						<span className="truncate">Similar to {filters.similarTo.title}</span>
						<Icon id="app.close" size={10} />
					</button>
				) : null}
			</div>
			{/* type chips by family */}
			<div
				className="flex max-h-[96px] flex-col gap-0.5 overflow-y-auto px-1 pt-1"
				data-testid="sound-type-chips"
			>
				{TYPE_GROUPS.map((g) => {
					const chips = g.types.filter((t) => (facets.types[t] ?? 0) > 0 || filters.types.includes(t));
					if (!chips.length) return null;
					return (
						// biome-ignore lint/a11y/useSemanticElements: a chip row, not a form fieldset
						<div
							key={g.family}
							role="group"
							aria-label={SOUND_FAMILY_LABELS[g.family]}
							className="flex flex-wrap items-center gap-1"
						>
							<span className="w-[62px] shrink-0 text-pr-small text-pr-dim">
								{SOUND_FAMILY_LABELS[g.family]}
							</span>
							{chips.map((t) => {
								const on = filters.types.includes(t);
								return (
									<button
										key={t}
										type="button"
										aria-pressed={on}
										data-type-chip={t}
										onClick={() => toggleType(t)}
										className={cx(
											'rounded-pr-pill border px-1.5 text-pr-small leading-[16px]',
											on
												? 'border-pr-accent bg-pr-accent-fill text-pr-on-accent'
												: 'border-pr-border-subtle text-pr-muted hover:text-pr-text',
										)}
									>
										{on ? '✓ ' : ''}
										{SOUND_TYPE_LABELS[t]}{' '}
										<span className="pr-tabular opacity-80">{facets.types[t] ?? 0}</span>
									</button>
								);
							})}
						</div>
					);
				})}
			</div>
			{/* refine + licence */}
			<div className="flex flex-wrap items-center gap-1 px-1 pt-1">
				<button
					type="button"
					aria-expanded={prefs.refineOpen}
					className="inline-flex items-center gap-0.5 text-pr-small text-pr-muted hover:text-pr-text"
					onClick={() => soundLibraryPrefs.set({ refineOpen: !prefs.refineOpen })}
					data-testid="sound-refine-toggle"
				>
					<Icon id={prefs.refineOpen ? 'app.chevronDown' : 'app.chevronRight'} size={12} />
					Refine
					{Object.keys(filters.refine).length ? ` (${Object.keys(filters.refine).length})` : ''}
				</button>
				<button
					type="button"
					aria-pressed={filters.commercialSafe}
					data-testid="sound-commercial-safe"
					title="Only licences that allow commercial use (no NC / ND, no undeclared folders)"
					onClick={() => setFilters((f) => ({ ...f, commercialSafe: !f.commercialSafe }))}
					className={cx(
						'rounded-pr-pill border px-1.5 text-pr-small leading-[16px]',
						filters.commercialSafe
							? 'border-pr-accent bg-pr-accent-fill text-pr-on-accent'
							: 'border-pr-border-subtle text-pr-muted hover:text-pr-text',
					)}
				>
					{filters.commercialSafe ? '✓ ' : ''}Commercial-safe
				</button>
				{filtersActive ? (
					<button
						type="button"
						className="ml-auto text-pr-small text-pr-muted underline hover:text-pr-text"
						onClick={() => {
							setQueryInput('');
							setFilters(DEFAULT_FILTERS);
						}}
					>
						Clear filters
					</button>
				) : null}
			</div>
			{prefs.refineOpen ? (
				<div className="flex flex-col gap-0.5 px-1 pt-1" data-testid="sound-refine">
					{REFINE_OPTIONS.map(({ key, values }) => (
						// biome-ignore lint/a11y/useSemanticElements: a pill row, not a form fieldset
						<div
							key={key}
							role="group"
							aria-label={REFINE_LABELS[key]}
							className="flex flex-wrap items-center gap-1"
						>
							<span className="w-[62px] shrink-0 text-pr-small text-pr-dim">{REFINE_LABELS[key]}</span>
							{values.map((v) => {
								const on = filters.refine[key] === v;
								return (
									<button
										key={v}
										type="button"
										aria-pressed={on}
										data-refine={`${key}:${v}`}
										onClick={() => setRefine(key, v)}
										className={cx(
											'rounded-pr-pill border px-1.5 text-pr-small leading-[16px]',
											on
												? 'border-pr-accent bg-pr-accent-fill text-pr-on-accent'
												: 'border-pr-border-subtle text-pr-muted hover:text-pr-text',
										)}
									>
										{on ? '✓ ' : ''}
										{REFINE_LABELS[v]}
									</button>
								);
							})}
						</div>
					))}
				</div>
			) : null}
			{/* results */}
			<div className="relative mt-1 min-h-0 flex-1 border-t border-pr-border-subtle">
				{engineStatus !== 'connected' ? (
					<EmptyState
						icon="engine.offline"
						message="The engine is not connected"
						detail="The sound library lives in the engine."
					/>
				) : libraryEmpty && !indexing ? (
					<div
						className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center"
						data-testid="sound-empty"
					>
						<Icon id="panel.soundLibrary" size={24} />
						<p className="text-pr-ui text-pr-muted">No sounds yet</p>
						<p className="max-w-[260px] text-pr-small text-pr-dim">
							Install the bundled starter kit, or add a folder of your own sounds.
						</p>
						<div className="flex gap-2">
							<button
								type="button"
								className="rounded-pr-control border border-pr-border-strong px-2 py-0.5 text-pr-ui hover:bg-pr-hover disabled:opacity-40"
								disabled={!(status?.starter.status === 'ok' && status.starter.sounds > 0)}
								title={
									status?.starter.status === 'ok' && status.starter.sounds > 0
										? 'Index the bundled starter kit'
										: 'This build has no starter kit'
								}
								onClick={() => void runCommand('soundLibrary.installStarterKit', ctx())}
								data-testid="sound-install-starter"
							>
								Install Starter Kit
							</button>
							<button
								type="button"
								className="rounded-pr-control border border-pr-border-strong px-2 py-0.5 text-pr-ui hover:bg-pr-hover"
								onClick={() => void openDialog(PREFERENCES_DIALOG, { page: 'sound-library', session })}
								data-testid="sound-add-folder"
							>
								Add a Folder…
							</button>
						</div>
					</div>
				) : error ? (
					<EmptyState icon="status.error" message="The search failed" detail={error} />
				) : results && items.length === 0 && !loading ? (
					<EmptyState
						icon="app.search"
						message={indexing ? 'Indexing the sound library…' : 'No sounds match'}
						detail={
							results.missing
								? `${results.missing} sounds of this collection are no longer in the library`
								: filtersActive
									? 'Try fewer filters, or turn off Commercial-safe.'
									: undefined
						}
					/>
				) : (
					<ContextMenu items={rowMenu} onOpenChange={(o) => !o && (menuEntry.current = null)}>
						<div
							ref={listRef}
							role="listbox"
							tabIndex={0}
							aria-label="Sounds"
							aria-activedescendant={selected ? `snd-opt-${selected.id}` : undefined}
							data-testid="sound-results"
							className="absolute inset-0 overflow-y-auto outline-none focus-visible:ring-1 focus-visible:ring-pr-focus"
							onKeyDown={onListKeyDown}
							onScroll={(e) =>
								setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })
							}
						>
							<div style={{ height: items.length * rowH, position: 'relative' }}>
								{items.slice(first, last).map((it, k) => {
									const i = first + k;
									const fav = prefs.favourites.includes(it.id);
									const badge = licenseBadge(it);
									const sel = it.id === selectedId;
									const playing = playingId === it.id;
									return (
										// biome-ignore lint/a11y/useFocusableInteractive: listbox options are reached with aria-activedescendant
										// biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles the keyboard (arrows, Space, Enter)
										<div
											key={it.id}
											id={`snd-opt-${it.id}`}
											role="option"
											aria-selected={sel}
											aria-label={soundAccessibleName(it, fav)}
											data-sound-id={it.id}
											data-playing={playing || undefined}
											draggable
											title={soundTooltip(it, rootLabel)}
											style={{ position: 'absolute', top: i * rowH, height: rowH, left: 0, right: 0 }}
											className={cx(
												'flex cursor-default items-center gap-1.5 px-1 select-none',
												sel ? 'bg-pr-selected text-pr-strong' : 'hover:bg-pr-hover',
											)}
											onMouseDown={() => {
												listRef.current?.focus();
											}}
											onClick={() => select(it.id, { play: true })}
											onDoubleClick={() => doInsert(it)}
											onContextMenu={() => {
												menuEntry.current = it;
												setSelectedId(it.id);
											}}
											onMouseEnter={() => {
												if (!prefs.auditionOnHover) return;
												if (hoverTimer.current) clearTimeout(hoverTimer.current);
												hoverTimer.current = setTimeout(() => {
													const p = auditionPlayer();
													p.setVolumeDb(soundLibraryPrefs.get().volumeDb);
													void p.play(
														{ id: it.id, title: it.title || it.id, url: engine.soundAudioUrl(it.id) },
														{ loop: false },
													);
												}, HOVER_DELAY_MS);
											}}
											onMouseLeave={() => {
												if (hoverTimer.current) clearTimeout(hoverTimer.current);
												hoverTimer.current = null;
												if (prefs.auditionOnHover && auditionPlayer().state.soundId === it.id)
													auditionPlayer().stop();
											}}
											onDragStart={(e) => writeSoundDrag(e.dataTransfer, it)}
											onDragEnd={() => endSoundDrag()}
										>
											<span className="w-3 shrink-0 text-pr-accent" aria-hidden="true">
												{playing ? <Icon id="transport.play" size={10} /> : null}
											</span>
											<MiniWaveform
												engine={engine}
												soundId={it.id}
												peakSec={it.descriptors.peakSec}
												durationSec={it.format.durationSec || it.descriptors.durationSec}
												compact={prefs.density === 'compact'}
											/>
											<div className="flex min-w-0 flex-1 flex-col justify-center leading-tight">
												<span className="truncate">{it.title || it.id}</span>
												{prefs.density === 'normal' ? (
													<span className="truncate text-pr-small text-pr-dim">
														{it.types.map(typeLabel).join(', ') || 'Untyped'} ·{' '}
														{formatSeconds(it.format.durationSec)}
													</span>
												) : null}
											</div>
											{prefs.density === 'compact' ? (
												<span className="shrink-0 text-pr-small text-pr-dim pr-tabular">
													{formatSeconds(it.format.durationSec)}
												</span>
											) : null}
											<span
												className={cx(
													'shrink-0 rounded-[2px] border px-1 text-pr-small leading-[14px]',
													badge.warn
														? 'border-pr-warning text-pr-warning'
														: 'border-pr-border-strong text-pr-muted',
												)}
												title={badge.title}
												data-license-badge={badge.text}
											>
												{badge.text}
											</span>
											<button
												type="button"
												tabIndex={-1}
												aria-hidden="true"
												data-favourite={fav ? 'on' : 'off'}
												className={cx(
													'shrink-0 px-0.5',
													fav ? 'text-pr-accent' : 'text-pr-dim hover:text-pr-text',
												)}
												title={fav ? 'Remove from Favourites (F)' : 'Add to Favourites (F)'}
												onClick={(e) => {
													e.stopPropagation();
													soundLibraryPrefs.toggleFavourite(it.id);
												}}
												onDoubleClick={(e) => e.stopPropagation()}
											>
												<Icon id={fav ? 'app.favouriteOn' : 'app.favourite'} size={12} />
											</button>
										</div>
									);
								})}
							</div>
						</div>
					</ContextMenu>
				)}
			</div>
			{/* status line */}
			<footer
				className="flex items-center gap-1 border-t border-pr-border-subtle px-1 py-0.5 text-pr-small text-pr-dim"
				data-testid="sound-status"
			>
				<span className="truncate">
					{results
						? results.total === results.librarySize || local
							? `${results.total} ${results.total === 1 ? 'sound' : 'sounds'}`
							: `${results.total} of ${results.librarySize} sounds`
						: loading
							? 'Searching…'
							: ''}
					{sourceCounts ? ` · ${sourceCounts}` : ''}
					{indexing
						? ` · Indexing${status?.indexing?.progress !== null && status?.indexing?.progress !== undefined ? ` ${Math.round(status.indexing.progress * 100)} %` : '…'}`
						: ''}
				</span>
				{audition.error ? <span className="ml-auto truncate text-pr-warning">{audition.error}</span> : null}
				{!audition.error && !canInsert && items.length ? (
					<span className="ml-auto truncate">Open a sequence to add sounds</span>
				) : null}
			</footer>
			<div aria-live="polite" className="sr-only" data-testid="sound-live">
				{announce}
			</div>
		</div>
	);
}

/** For tests: forget fetched entries. */
export function clearSoundEntryCache(): void {
	entryCache.clear();
}
