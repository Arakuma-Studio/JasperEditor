// Sound Library panel (spec 12 §2.7, P1-R7): search the engine's sound library (bundled starter kit, packs, your
// folders, Jasper Synth), filter by type chips grouped by family (disjunctive facet counts), Refine pills and the
// licence filter ("Commercial-safe" on by default), audition (Space, Loop, Auto-play, volume) and insert peak-aligned
// at the playhead (Enter / double-click) or by dragging onto the timeline. Collections: All, Favourites, Recent, Used
// in this project and each source. Results are a virtualised listbox with descriptor-rich accessible names. A
// multi-hit recording (a typing run, a clock) has a disclosure listing its takes (spec 12 P6-E9) under its row: each
// take is a row of its own (mini waveform, audition, insert, drag); → opens and ← closes it from the keyboard.
import {
	offeredTakes,
	type SoundDescribeInfo,
	type SoundEntry,
	type SoundFacets,
	type SoundLibraryStatus,
	type SoundMatch,
	type SoundRoot,
	takeEntryOf,
} from '@jasper/api';
import { isSoundTypeId, parseTakeId, type SoundTypeId } from '@jasper/project';
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
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';
import { createCommandContext } from '../../commands/context.ts';
import { chordFromEvent, resolveBindings, scopeChain } from '../../commands/keymap-defaults.ts';
import { getCommand, isCommandEnabled, runCommand } from '../../commands/registry.ts';
import type { CommandCtx, ToastRequest } from '../../commands/types.ts';
import { t } from '../../i18n/runtime.ts';
import { getDesktopBridge } from '../../runtime/platform.ts';
import { useShellRuntimeOrNull } from '../../shell/context.tsx';
import { PREFERENCES_DIALOG } from '../../shell/preferences/index.ts';
import { auditionPlayer } from '../../sound/audition.ts';
import {
	auditionPlaysAlone,
	auditionSoundOf,
	cancelLibraryMode,
	clipSoundTarget,
	cueFillTarget,
	insertSoundWithFeedback,
	libraryModeKey,
	pruneLibraryMode,
	registerSoundLibraryController,
	requestClipTarget,
	requestCueFill,
	subscribeCueFill,
	toggleAuditionOf,
} from '../../sound/controller.ts';
import { paletteOf } from '../../sound/design-model.ts';
import { registerSoundDialogs, SOUND_LICENSE_DIALOG } from '../../sound/dialogs.tsx';
import { FIND_MOMENT_MIN_SEC, SOUND_FIND_MOMENT_DIALOG } from '../../sound/FindMomentDialog.tsx';
import { addLayerToClip, fillCueWithSound, fillTargetFor } from '../../sound/fill.ts';
import {
	auditionInContext,
	inContextEndedBy,
	inContextStore,
	stopInContext,
} from '../../sound/in-context.ts';
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
	searchLocal,
	searchRequest,
	soundAccessibleName,
	soundTooltip,
	TYPE_GROUPS,
	takeLabel,
	typeLabel,
	usedSoundIds,
} from '../../sound/model.ts';
import {
	MAX_AUDITION_DB,
	MAX_FAVOURITES,
	MIN_AUDITION_DB,
	soundLibraryPrefs,
	useSoundLibraryPrefs,
} from '../../sound/prefs.ts';
import { swapClipSound } from '../../sound/swap.ts';
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
	/** The search these results answer (`loadMore` pages only append to the search they belong to). */
	epoch: number;
	filters: LibraryFilters;
	/** No more pages: a page added nothing new (the engine's total counts more than it pages through). */
	exhausted?: boolean;
	items: SoundEntry[];
	total: number;
	librarySize: number;
	facets: SoundFacets;
	indexing: boolean;
	/** Local collections: sounds of the collection no longer in the library. */
	missing: number;
	/** Offered takes of the recordings among `items`, by id (spec 12 P6-E9). */
	takeCounts: Record<string, number>;
	/** P6-E14: how each sound matches the description (Describe mode with the model), by id. */
	matches: Record<string, SoundMatch>;
	/** P6-E14: what the engine did with the description (model or words, sounds still being prepared). */
	describe?: SoundDescribeInfo;
};

const EMPTY_FACETS: SoundFacets = { types: {}, families: {}, licenses: {}, sources: {} };

/** A cache of library entries fetched by id (local collections). Failures are not kept: the next search retries. */
const entryCache = new Map<string, Promise<SoundEntry | null>>();

function cachedEntry(
	engine: { getSound(id: string): Promise<SoundEntry> },
	id: string,
): Promise<SoundEntry | null> {
	let p = entryCache.get(id);
	if (!p) {
		const fetched: Promise<SoundEntry | null> = engine.getSound(id).catch(() => {
			if (entryCache.get(id) === fetched) entryCache.delete(id);
			return null;
		});
		p = fetched;
		entryCache.set(id, p);
	}
	return p;
}

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

const verdictText = (v: SoundMatch['verdict']): string =>
	v === 'strong' ? t('strong') : v === 'plausible' ? t('plausible') : v === 'weak' ? t('weak') : t('unclear');

/** A described sound's match (P6-E14): its verdict, the z in the tooltip. */
function MatchChip({ match }: { match: SoundMatch }) {
	return (
		<span
			className={cx(
				'shrink-0 rounded-pr-pill border px-1 text-pr-small leading-[14px]',
				match.verdict === 'strong'
					? 'border-pr-accent text-pr-accent'
					: match.verdict === 'none'
						? 'border-pr-border-subtle text-pr-dim'
						: 'border-pr-border-strong text-pr-muted',
			)}
			title={t(
				'How well it matches the description: z {0} among our reference descriptions (strong ≥ 3, plausible ≥ 2.5, weak ≥ 2). Listen before you trust it.',
				match.z.toFixed(1),
			)}
			data-match-verdict={match.verdict}
		>
			{verdictText(match.verdict)}
		</span>
	);
}

/** What Describe did with the query (P6-E14): the model, the words instead, or sounds still being prepared. */
function DescribeLine(props: { info: SoundDescribeInfo | undefined; query: string; local: boolean }) {
	const { info } = props;
	let text: string;
	let warn = false;
	if (props.local) text = t('Describe searches the whole library; this collection is searched by its words.');
	else if (!props.query.trim())
		text = t('Describe the sound: source, material, action and character, in English (“glass bottle shattering on concrete”).');
	else if (!info) text = t('Searching…');
	else if (info.mode === 'keywords') {
		warn = true;
		text = t(
			'Describe-it search needs its optional model (Preferences ▸ Sound Library): searching the words instead.',
		);
	} else if (info.pending > 0)
		text = t('{0} sounds are still being prepared; they are matched by their words for now.', info.pending);
	else text = t('Ranked by what the sounds sound like ({0} sounds).', info.embedded);
	return (
		<p
			className={cx('px-1 pt-0.5 text-pr-small', warn ? 'text-pr-warning' : 'text-pr-muted')}
			role="status"
			data-testid="sound-describe-info"
			data-describe-mode={info?.mode}
		>
			{text}
		</p>
	);
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
	// The active sequence's sound palette (Palette collection and strip).
	const paletteKey = useStoreSelector(session?.store ?? EMPTY_SESSION_STORE, (s: SessionState | null) =>
		s?.activeSequenceId ? paletteOf(s.document.sequences[s.activeSequenceId]).join(',') : '',
	);
	const palette = useMemo(() => (paletteKey ? paletteKey.split(',') : []), [paletteKey]);
	// Fill / Replace / layer mode (spec 12 §2.7): re-render when it changes.
	useSyncExternalStore(subscribeCueFill, libraryModeKey, libraryModeKey);
	const clipTarget = clipSoundTarget();
	const inContext = useStoreSelector(inContextStore, (s) => s);
	const [filters, setFilters] = useState<LibraryFilters>(DEFAULT_FILTERS);
	// Fill mode (spec 12 §2.7): the cue the library is choosing a sound for.
	const fill = useSyncExternalStore(subscribeCueFill, cueFillTarget, cueFillTarget);
	const [queryInput, setQueryInput] = useState('');
	const [status, setStatus] = useState<SoundLibraryStatus | null>(null);
	const [roots, setRoots] = useState<SoundRoot[]>([]);
	/** Installed packs (id → title) for the Sources › Packs collections. */
	const [installedPacks, setInstalledPacks] = useState<{ id: string; title: string }[]>([]);
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
	/** The current search (bumped whenever the filters, collection or library change). */
	const searchEpoch = useRef(0);
	/** The filters of the results on screen (a new search scrolls the list to the top). */
	const shownFilters = useRef<LibraryFilters | null>(null);
	/** The page being fetched by `loadMore`, if any. */
	const more = useRef<{ epoch: number; ac: AbortController } | null>(null);

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
	// Outside the shell (no runtime) the panel's own context still has the engine when it is connected, so the
	// engine commands it runs (Install Starter Kit) are enabled, and its toasts are shown.
	const ctx = useCallback(
		(): CommandCtx =>
			runtime?.getCtx() ??
			createCommandContext({
				engine,
				session,
				capabilities: engineStatus === 'connected' ? ['engine'] : [],
				toast: notify,
			}),
		[runtime, engine, session, engineStatus, notify],
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
		void engine
			.listSoundPacks()
			.then((r) =>
				setInstalledPacks(
					r.packs.filter((p) => p.state !== 'available').map((p) => ({ id: p.id, title: p.title })),
				),
			)
			.catch(() => setInstalledPacks([]));
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
	// Recent is read when the collection is entered or the search changes, not on every audition: auditioning moves a
	// sound to the front of Recent, and re-sorting the list under the selection would make ↓ skip around.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the snapshot is taken per search (`filters`) on purpose
	const recentSnapshot = useMemo(() => soundLibraryPrefs.get().recents, [filters, libraryEpoch]);
	const localIds = useMemo(() => {
		if (filters.collection === 'favourites') return prefs.favourites;
		if (filters.collection === 'recent') return recentSnapshot;
		if (filters.collection === 'used') return usedKey ? usedKey.split(',') : [];
		if (filters.collection === 'palette') return palette;
		return [];
	}, [filters.collection, prefs.favourites, recentSnapshot, usedKey, palette]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `libraryEpoch` re-runs the search when the library changes
	useEffect(() => {
		if (engineStatus !== 'connected') return;
		const ac = new AbortController();
		const epoch = ++searchEpoch.current;
		// A page of the previous search still loading is dropped.
		more.current?.ac.abort();
		more.current = null;
		setLoading(true);
		setError(null);
		const run = async (): Promise<Results> => {
			if (local) {
				const got = await Promise.all(localIds.map((id) => cachedEntry(engine, id)));
				const entries = got.filter((x): x is SoundEntry => !!x);
				const similar = filters.similarTo
					? ((await engine.getSound(filters.similarTo.id).catch(() => null)) ?? null)
					: null;
				const r = searchLocal(entries, filters, similar);
				const takeCounts: Record<string, number> = {};
				for (const e of r.results) if (offeredTakes(e).length) takeCounts[e.id] = offeredTakes(e).length;
				return {
					epoch,
					filters,
					items: r.results,
					total: r.total,
					librarySize: status?.sounds ?? entries.length,
					facets: r.facets,
					indexing: !!status?.indexing,
					missing: localIds.length - entries.length,
					takeCounts,
					matches: {},
				};
			}
			const r = await engine.searchSounds(searchRequest(filters, { limit: PAGE, offset: 0 }), ac.signal);
			const takeCounts: Record<string, number> = {};
			const matches: Record<string, SoundMatch> = {};
			for (const x of r.results) {
				if (x.takeCount) takeCounts[x.sound.id] = x.takeCount;
				if (x.match) matches[x.sound.id] = x.match;
			}
			return {
				epoch,
				filters,
				items: r.results.map((x) => x.sound),
				total: r.total,
				librarySize: r.librarySize,
				facets: r.facets,
				indexing: r.indexing,
				missing: 0,
				takeCounts,
				matches,
				...(r.describe ? { describe: r.describe } : {}),
			};
		};
		run()
			.then((r) => {
				if (ac.signal.aborted) return;
				setResults(r);
				setLoading(false);
				// New filters show their results from the top (a library refresh keeps the scroll position).
				if (shownFilters.current !== r.filters) {
					shownFilters.current = r.filters;
					if (listRef.current) listRef.current.scrollTop = 0;
					setView((v) => (v.top === 0 ? v : { ...v, top: 0 }));
				}
				const want = revealId.current;
				// a take stays selected while its recording is listed (and open)
				const listed = (id: string) => r.items.some((x) => x.id === id || x.id === parseTakeId(id)?.parentId);
				if (want && listed(want)) {
					revealId.current = null;
					setSelectedId(want);
				} else setSelectedId((cur) => (cur && listed(cur) ? cur : (r.items[0]?.id ?? null)));
			})
			.catch((e) => {
				if (ac.signal.aborted) return;
				setLoading(false);
				setError(errorText(e));
			});
		return () => ac.abort();
	}, [engine, engineStatus, filters, local, localIds, libraryEpoch]);

	/**
	 * The next page of an engine search. It belongs to the search of the results on screen: a page answering an older
	 * search (the filters changed meanwhile) is dropped, and a page that adds nothing ends the list (the engine's total
	 * was larger than what it can page through) instead of asking for the same page again.
	 */
	const loadMore = useCallback(() => {
		if (!results || LOCAL_COLLECTIONS.has(results.filters.collection) || more.current) return;
		if (results.epoch !== searchEpoch.current || results.exhausted || results.items.length >= results.total)
			return;
		const epoch = results.epoch;
		const job = { epoch, ac: new AbortController() };
		more.current = job;
		void engine
			.searchSounds(
				searchRequest(results.filters, { limit: PAGE, offset: results.items.length }),
				job.ac.signal,
			)
			.then((r) => {
				if (job.ac.signal.aborted || epoch !== searchEpoch.current) return;
				setResults((cur) => {
					if (!cur || cur.epoch !== epoch) return cur;
					const seen = new Set(cur.items.map((x) => x.id));
					const added = r.results.filter((x) => !seen.has(x.sound.id));
					if (!added.length) return { ...cur, exhausted: true };
					const takeCounts = { ...cur.takeCounts };
					const matches = { ...cur.matches };
					for (const x of added) {
						if (x.takeCount) takeCounts[x.sound.id] = x.takeCount;
						if (x.match) matches[x.sound.id] = x.match;
					}
					return { ...cur, items: [...cur.items, ...added.map((x) => x.sound)], takeCounts, matches };
				});
			})
			// A failed page is asked again when the list scrolls (nothing re-renders, so it does not loop).
			.catch(() => undefined)
			.finally(() => {
				if (more.current === job) more.current = null;
			});
	}, [engine, results]);

	const items = results?.items ?? [];
	// ---------------------------------------------------------------- takes (spec 12 P6-E9)
	/** Recordings whose takes are shown under them. */
	const [expanded, setExpanded] = useState<Record<string, true>>({});
	/** The offered take entries of each opened recording (fetched once per library change). */
	const [takesOf, setTakesOf] = useState<Record<string, SoundEntry[]>>({});
	// biome-ignore lint/correctness/useExhaustiveDependencies: a library change refetches the takes
	useEffect(() => setTakesOf({}), [libraryEpoch]);
	const takeCountOf = useCallback((e: SoundEntry) => results?.takeCounts[e.id] ?? 0, [results]);
	/** The rows: each result, and under an opened recording its clean takes. */
	const rows = useMemo(() => {
		const out: SoundEntry[] = [];
		for (const it of items) {
			out.push(it);
			if (expanded[it.id]) for (const tk of takesOf[it.id] ?? []) out.push(tk);
		}
		return out;
	}, [items, expanded, takesOf]);
	useEffect(() => {
		for (const id of Object.keys(expanded)) {
			if (takesOf[id]) continue;
			void cachedEntry(engine, id).then((full) => {
				if (!full) return;
				setTakesOf((m) =>
					m[id] ? m : { ...m, [id]: offeredTakes(full).map((tk) => takeEntryOf(full, tk)) },
				);
			});
		}
	}, [expanded, takesOf, engine]);
	const toggleTakes = useCallback((e: SoundEntry, open?: boolean) => {
		setExpanded((x) => {
			const want = open ?? !x[e.id];
			if (!!x[e.id] === want) return x;
			const n = { ...x };
			if (want) n[e.id] = true;
			else delete n[e.id];
			return n;
		});
		if (open === false || open === undefined)
			setSelectedId((cur) => (cur && parseTakeId(cur)?.parentId === e.id ? e.id : cur));
	}, []);
	const selected = rows.find((x) => x.id === selectedId) ?? null;
	const rootLabel = useCallback((id: string) => roots.find((r) => r.id === id)?.label ?? null, [roots]);

	// ---------------------------------------------------------------- actions
	const canInsert = !!session && hasSequence && !readOnly;
	const doAuditionInContext = useCallback(
		(e: SoundEntry | null) => {
			if (!e || !session) return;
			// the Space / Shift+Space that has just stopped an In Context audition does not start one again
			if (inContextEndedBy(['Space'])) return;
			const st = inContextStore.getState();
			if ((st.active || st.loading) && st.soundId === e.id) {
				stopInContext();
				return;
			}
			soundLibraryPrefs.touchRecent(e.id);
			void auditionInContext(session, engine, e).then((r) => {
				if (!r.ok && !r.cancelled)
					notify({ kind: 'warning', message: t('Could not audition in context'), detail: r.message });
			});
		},
		[session, engine, notify],
	);
	const doAudition = useCallback(
		(e: SoundEntry | null) => {
			if (!e) return;
			// Space while an In Context audition plays stops it (its key listener already did): nothing starts
			if (inContextEndedBy(['Space'])) return;
			// The In Context toggle makes Space play the sound in the timeline (spec 12 §2.7).
			if (soundLibraryPrefs.get().inContext && session?.getState().activeSequenceId) doAuditionInContext(e);
			else toggleAuditionOf(engine, e);
		},
		[engine, session, doAuditionInContext],
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
			stopInContext({ returnToAnchor: false });
			// Enter / double-click (spec 12 §2.7): fill the selected cue, else swap (Replace mode), else insert.
			const fill = fillTargetFor(session);
			const target = clipSoundTarget();
			const ok = (message: string, trimmed = 0) =>
				notify({
					kind: 'success',
					message,
					...(trimmed > 0
						? { detail: t('The sound started before 0: its first {0} s were trimmed', trimmed.toFixed(2)) }
						: {}),
					action: { label: t('Undo'), command: 'history.undo' },
				});
			const failed = (message: string) => (err: unknown) =>
				notify({ kind: 'error', message, detail: err instanceof Error ? err.message : String(err) });
			if (fill) {
				// the next rows are the alternatives: for a take, its sibling takes
				const at = rows.findIndex((x) => x.id === e.id);
				const alternatives = rows.slice(at + 1, at + 4).map((x) => x.id);
				void fillCueWithSound(session, engine, e, {
					sequenceId: fill.sequenceId,
					cueId: fill.cueId,
					layer: !!fill.layer,
					alternatives,
				})
					.then((r) => ok(r.message, r.trimmedHeadSec))
					.catch(failed(t('Could not fill the cue')));
				return;
			}
			if (target?.kind === 'replace') {
				void swapClipSound(session, engine, target.sequenceId, target.clipId, e)
					.then((message) => {
						requestClipTarget(null);
						ok(message);
					})
					.catch(failed(t('Could not swap the sound')));
				return;
			}
			if (target?.kind === 'layer') {
				void addLayerToClip(session, engine, e, { sequenceId: target.sequenceId, clipId: target.clipId })
					.then((r) => {
						requestClipTarget(null);
						ok(r.message, r.trimmedHeadSec);
					})
					.catch(failed(t('Could not add the layer')));
				return;
			}
			void insertSoundWithFeedback(session, engine, e, notify);
		},
		[session, canInsert, engine, notify, readOnly, rows],
	);
	const doFavourite = useCallback(
		(e: SoundEntry | null) => {
			if (!e) return;
			// The 501st favourite is refused (never by dropping the oldest one silently).
			if (soundLibraryPrefs.toggleFavourite(e.id) === 'full')
				notify({
					kind: 'warning',
					message: t('Favourites are full ({0} sounds)', MAX_FAVOURITES),
					detail: t('Remove a favourite to star another sound.'),
				});
		},
		[notify],
	);
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
			const e = id ? rows.find((x) => x.id === id) : null;
			if (
				e &&
				opts.play &&
				soundLibraryPrefs.get().autoPlay &&
				soundLibraryPrefs.get().inContext &&
				session
			) {
				doAuditionInContext(e);
				return;
			}
			if (e && opts.play && soundLibraryPrefs.get().autoPlay) {
				const p = auditionPlayer();
				p.setLoop(soundLibraryPrefs.get().loop);
				p.setVolumeDb(soundLibraryPrefs.get().volumeDb);
				soundLibraryPrefs.touchRecent(e.id);
				void p.play(auditionSoundOf(engine, e));
			}
		},
		[rows, engine, session, doAuditionInContext],
	);

	// The commands (keymap scope `soundLibrary`, menus, agents) reach the panel through its controller.
	const latest = useRef({
		selected,
		doAudition,
		doInsert,
		doFavourite,
		doSimilar,
		doLicense,
		doAuditionInContext,
	});
	latest.current = { selected, doAudition, doInsert, doFavourite, doSimilar, doLicense, doAuditionInContext };
	/** Reveal in Sound Library: the sound to select once its search answers. */
	const revealId = useRef<string | null>(null);
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
				setTypes: (types) =>
					setFilters((f) => ({
						...f,
						types: types.filter(isSoundTypeId),
					})),
				findSimilar: () => latest.current.doSimilar(latest.current.selected),
				showLicense: () => latest.current.doLicense(latest.current.selected),
				setSimilar: (sound) =>
					setFilters((f) => ({
						...f,
						collection: LOCAL_COLLECTIONS.has(f.collection) ? 'all' : f.collection,
						similarTo: sound,
					})),
				reveal: (sound) => {
					revealId.current = sound.id;
					setQueryInput(sound.title);
					setFilters((f) => ({
						...DEFAULT_FILTERS,
						commercialSafe: f.commercialSafe,
						includeShareAlike: f.includeShareAlike,
						query: sound.title,
					}));
				},
				auditionInContext: () => latest.current.doAuditionInContext(latest.current.selected),
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
	// The audition belongs to the panel: closing the panel stops it (a looped audition could not be stopped otherwise),
	// and an In Context audition with it (its toggle and its live region go with the panel).
	useEffect(
		() => () => {
			if (hoverTimer.current) clearTimeout(hoverTimer.current);
			auditionPlayer().stop();
			const st = inContextStore.getState();
			if (st.active || st.loading) stopInContext();
		},
		[],
	);
	// Fill / Replace / layer mode ends with its target (deleted, undone, another project opened).
	useEffect(() => {
		if (!session) return;
		pruneLibraryMode(session.getCommitted());
		return session.store.subscribe((s, prev) => {
			if (s.document !== prev.document) pruneLibraryMode(s.document);
		});
	}, [session]);
	// It plays alone (spec 12 §2.7): an audition pauses the Program, and the Program starting stops the audition.
	useEffect(() => (session ? auditionPlaysAlone(auditionPlayer(), session.transport) : undefined), [session]);

	// ---------------------------------------------------------------- list geometry (virtualised)
	const rowH = prefs.density === 'compact' ? 24 : 36;
	const [view, setView] = useState({ top: 0, height: 0 });
	// The list element comes and goes (empty states replace it): a callback ref measures and observes each new one,
	// so a remounted list starts from its own scroll position, not the last one of the list it replaces.
	const listObserver = useRef<ResizeObserver | null>(null);
	const bindList = useCallback((el: HTMLDivElement | null) => {
		listObserver.current?.disconnect();
		listObserver.current = null;
		listRef.current = el;
		if (!el) {
			setView({ top: 0, height: 0 });
			return;
		}
		const measure = () => setView({ top: el.scrollTop, height: el.clientHeight });
		measure();
		if (typeof ResizeObserver !== 'undefined') {
			listObserver.current = new ResizeObserver(measure);
			listObserver.current.observe(el);
		}
	}, []);
	const first = view.height > 0 ? Math.max(0, Math.floor(view.top / rowH) - 8) : 0;
	const last =
		view.height > 0
			? Math.min(rows.length, Math.ceil((view.top + view.height) / rowH) + 8)
			: Math.min(rows.length, INITIAL_ROWS);
	// The rows in view, plus the selected row wherever it is: `aria-activedescendant` must name a rendered element.
	const selectedIndex = selectedId ? rows.findIndex((x) => x.id === selectedId) : -1;
	const rendered: number[] = [];
	if (selectedIndex >= 0 && selectedIndex < first) rendered.push(selectedIndex);
	for (let i = first; i < last; i++) rendered.push(i);
	if (selectedIndex >= last) rendered.push(selectedIndex);
	const shownTakes = rows.length - items.length;
	const setSize = results?.exhausted
		? rows.length
		: Math.max(rows.length, (results?.total ?? 0) + shownTakes);
	useEffect(() => {
		if (results && last >= rows.length - 10 && items.length < results.total) loadMore();
	}, [last, rows.length, items.length, results, loadMore]);
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
		const index = rows.findIndex((x) => x.id === selectedId);
		const page = Math.max(1, Math.floor((listRef.current?.clientHeight ?? 360) / rowH) - 1);
		const go = (i: number) => {
			const n = Math.max(0, Math.min(rows.length - 1, i));
			const it = rows[n];
			if (!it) return;
			e.preventDefault();
			select(it.id, { play: true });
			scrollIntoView(n);
		};
		if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && selected) {
			// takes: → opens a recording's takes (then moves into them), ← goes back to the recording and closes them
			const parentId = parseTakeId(selected.id)?.parentId;
			if (e.key === 'ArrowRight' && !parentId && takeCountOf(selected) > 0) {
				e.preventDefault();
				if (!expanded[selected.id]) toggleTakes(selected, true);
				else if (rows[index + 1] && parseTakeId(rows[index + 1]!.id)) go(index + 1);
				return;
			}
			if (e.key === 'ArrowLeft' && (parentId || expanded[selected.id])) {
				e.preventDefault();
				if (parentId) {
					const at = rows.findIndex((x) => x.id === parentId);
					if (at >= 0) go(at);
				} else toggleTakes(selected, false);
				return;
			}
		}
		if (!e.ctrlKey && !e.metaKey && !e.altKey) {
			if (e.key === 'ArrowDown') return go(index < 0 ? 0 : index + 1);
			if (e.key === 'ArrowUp') return go(index < 0 ? 0 : index - 1);
			if (e.key === 'Home') return go(0);
			if (e.key === 'End') return go(rows.length - 1);
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

	// ---------------------------------------------------------------- palette and mode
	const togglePalette = (id: string) => {
		const seqId = session?.getState().activeSequenceId;
		if (!session || !seqId) return;
		const remove = palette.includes(id);
		const r = session.apply({
			label: remove ? t('Remove from Palette') : t('Add to Palette'),
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{
					type: 'soundDesign.setPalette',
					sequenceId: seqId,
					soundIds: [id],
					mode: remove ? 'remove' : 'add',
				},
			],
		});
		if (!r.ok) notify({ kind: 'warning', message: r.errors[0]?.message ?? t('Edit failed') });
	};
	const fillNow = session ? fillTargetFor(session) : null;
	const modeLabel = fillNow
		? fillNow.layer
			? t('Add as Layer')
			: t('Fill Cue')
		: clipTarget?.kind === 'replace'
			? t('Swap Sound')
			: clipTarget?.kind === 'layer'
				? t('Add as Layer')
				: t('Insert at Playhead');

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
				id: 'auditionInContext',
				label: t('Audition in Context'),
				shortcut: 'Shift+Space',
				disabled: !hasSequence,
				disabledReason: t('Open a sequence first'),
				onSelect: () => doAuditionInContext(e),
			},
			{
				type: 'item',
				id: 'insert',
				label: modeLabel,
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
			{
				type: 'item',
				id: 'findMoment',
				label: t('Find Moment…'),
				disabled: !((e.format.durationSec || e.descriptors.durationSec) >= FIND_MOMENT_MIN_SEC),
				disabledReason: t('The sound is too short to search inside'),
				onSelect: () => void openDialog(SOUND_FIND_MOMENT_DIALOG, { entry: e, session }),
			},
			{
				type: 'item',
				id: 'palette',
				label: t('Add to Palette'),
				checked: palette.includes(e.id),
				disabled: !canInsert,
				onSelect: () => togglePalette(e.id),
			},
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
			{ value: 'palette', label: `Palette (${palette.length})` },
		];
		if (bySource.starter)
			opts.push({ value: 'source:starter', label: `Sources › ${SOUND_SOURCE_LABELS.starter}` });
		if (bySource.pack) opts.push({ value: 'source:pack', label: `Sources › ${SOUND_SOURCE_LABELS.pack}` });
		for (const p of installedPacks)
			opts.push({ value: `pack:${p.id}`, label: `Sources › ${SOUND_SOURCE_LABELS.pack} › ${p.title}` });
		if (roots.length) opts.push({ value: 'source:folder', label: `Sources › ${SOUND_SOURCE_LABELS.folder}` });
		for (const r of roots) opts.push({ value: `root:${r.id}`, label: `Sources › ${r.label || r.path}` });
		if (bySource.synth) opts.push({ value: 'source:synth', label: `Sources › ${SOUND_SOURCE_LABELS.synth}` });
		if (!opts.some((o) => o.value === filters.collection))
			opts.push({ value: filters.collection, label: filters.collection });
		return opts;
	}, [
		prefs.favourites.length,
		bySource.starter,
		bySource.pack,
		bySource.synth,
		roots,
		installedPacks,
		filters.collection,
		palette.length,
	]);

	const libraryEmpty = status ? status.sounds === 0 : results ? results.librarySize === 0 : false;
	const playingId = audition.phase !== 'idle' ? audition.soundId : null;
	const announce =
		(inContext.active ? t('Playing {0} in context', inContext.title ?? '') : null) ??
		inContext.error ??
		audition.error ??
		(audition.phase === 'playing'
			? t('Playing {0}', audition.title ?? '')
			: audition.phase === 'loading'
				? t('Loading {0}', audition.title ?? '')
				: audition.epoch > 0
					? t('Audition stopped')
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
					placeholder={filters.describe ? t('Describe the sound (source, material, action)') : t('Search sounds')}
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
				<button
					type="button"
					aria-pressed={filters.describe}
					title="Describe: search by what the sound sounds like — source, material, action and character, in English (“glass bottle shattering on concrete”). Needs the optional Describe-it search model (Preferences ▸ Sound Library); without it, its words are searched."
					onClick={() => setFilters((f) => ({ ...f, describe: !f.describe }))}
					className={cx(
						'shrink-0 rounded-pr-pill border px-1.5 text-pr-small leading-[16px]',
						filters.describe
							? 'border-pr-accent bg-pr-accent-fill text-pr-on-accent'
							: 'border-pr-border-subtle text-pr-muted hover:text-pr-text',
					)}
					data-testid="sound-describe"
				>
					{filters.describe ? '✓ ' : ''}Describe
				</button>
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
				<button
					type="button"
					aria-pressed={prefs.inContext}
					title="In Context: Space plays the sound in the timeline, on the selected cue (Shift+Space always does)"
					onClick={() => soundLibraryPrefs.set({ inContext: !prefs.inContext })}
					className={cx(
						'shrink-0 rounded-pr-pill border px-1.5 text-pr-small leading-[16px]',
						prefs.inContext
							? 'border-pr-accent bg-pr-accent-fill text-pr-on-accent'
							: 'border-pr-border-subtle text-pr-muted hover:text-pr-text',
					)}
					data-testid="sound-in-context"
				>
					{prefs.inContext ? '✓ ' : ''}In Context
				</button>
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
			{filters.describe ? <DescribeLine info={results?.describe} query={filters.query} local={local} /> : null}
			{/* collection */}
			<div className="flex items-center gap-1 px-1 pt-1">
				<Select
					label="Collection"
					className="min-w-0 flex-1"
					value={filters.collection}
					onValueChange={(v) => setFilters((f) => ({ ...f, collection: v as Collection }))}
					options={collectionOptions}
				/>
				{fill ? (
					<button
						type="button"
						className="inline-flex max-w-[45%] items-center gap-1 rounded-pr-pill border px-1.5 text-pr-small text-pr-text"
						style={{ borderColor: 'var(--pr-cue)', borderStyle: 'dashed' }}
						aria-label={t('Filling {0}: leave Fill mode', fill.label)}
						title={t('Filling {0}', fill.label)}
						onClick={() => requestCueFill(null)}
						data-testid="sound-fill-chip"
					>
						<span className="truncate">
							{fill.layer ? t('Add layer: {0}', fill.label) : t('Fill: {0}', fill.label)}
						</span>
						<Icon id="app.close" size={10} />
					</button>
				) : null}
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
			{clipTarget ? (
				<div
					className="mx-1 mt-1 flex items-center gap-1 rounded-pr-control border px-1.5 py-0.5 text-pr-small text-pr-text"
					style={{ borderColor: 'var(--pr-accent)', borderStyle: 'dashed' }}
					role="status"
					data-testid="sound-replace-banner"
				>
					<span className="min-w-0 flex-1 truncate">
						{clipTarget.kind === 'replace'
							? t('Replacing {0} · Enter to swap · Esc to cancel', clipTarget.label)
							: t('Adding a layer to {0} · Enter to add · Esc to cancel', clipTarget.label)}
					</span>
					<button
						type="button"
						className="shrink-0 text-pr-muted hover:text-pr-text"
						aria-label={t('Cancel')}
						onClick={() => cancelLibraryMode()}
					>
						<Icon id="app.close" size={10} />
					</button>
				</div>
			) : null}
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
										{typeLabel(t)} <span className="pr-tabular opacity-80">{facets.types[t] ?? 0}</span>
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
					title="Only licences that allow commercial use (no NC / ND, no undeclared folders, no ShareAlike unless included)"
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
				{filters.commercialSafe ? (
					<button
						type="button"
						aria-pressed={filters.includeShareAlike}
						data-testid="sound-include-share-alike"
						title="Also list CC BY-SA sounds: a video synced with one must be shared under CC BY-SA"
						onClick={() => setFilters((f) => ({ ...f, includeShareAlike: !f.includeShareAlike }))}
						className={cx(
							'rounded-pr-pill border px-1.5 text-pr-small leading-[16px]',
							filters.includeShareAlike
								? 'border-pr-warning text-pr-warning'
								: 'border-pr-border-subtle text-pr-muted hover:text-pr-text',
						)}
					>
						{filters.includeShareAlike ? '✓ ' : ''}Include ShareAlike
					</button>
				) : null}
				{filtersActive ? (
					<button
						type="button"
						className="ml-auto text-pr-small text-pr-muted underline hover:text-pr-text"
						onClick={() => {
							setQueryInput('');
							// Describe stays as chosen: it is how the search box reads, not a filter
							setFilters((f) => ({ ...DEFAULT_FILTERS, describe: f.describe }));
						}}
					>
						Clear filters
					</button>
				) : null}
			</div>
			{prefs.refineOpen ? (
				<div className="flex flex-col gap-0.5 px-1 pt-1" data-testid="sound-refine">
					{REFINE_OPTIONS.map(({ key, values: all }) => {
						// Material (P6-E10): only the materials the results name, with their counts
						const counts = key === 'material' ? (facets.materials ?? {}) : null;
						const values = counts
							? all.filter((v) => (counts[v] ?? 0) > 0 || filters.refine[key] === v)
							: all;
						if (!values.length) return null;
						return (
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
											{counts ? <span className="pr-tabular opacity-80"> {counts[v] ?? 0}</span> : null}
										</button>
									);
								})}
							</div>
						);
					})}
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
							Install the bundled starter kit, download a sound pack, or add a folder of your own sounds.
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
								// The status is asked again at once: it says "indexing", which starts the 2 s polling.
								onClick={() => void runCommand('soundLibrary.installStarterKit', ctx()).then(refreshStatus)}
								data-testid="sound-install-starter"
							>
								Install Starter Kit
							</button>
							<button
								type="button"
								className="rounded-pr-control border border-pr-border-strong px-2 py-0.5 text-pr-ui hover:bg-pr-hover"
								onClick={() => void runCommand('soundLibrary.installPacks', ctx())}
								data-testid="sound-install-packs"
							>
								Install Sound Packs…
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
							ref={bindList}
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
							<div style={{ height: rows.length * rowH, position: 'relative' }}>
								{rendered.map((i) => {
									const it = rows[i]!;
									const fav = prefs.favourites.includes(it.id);
									const badge = licenseBadge(it);
									const sel = it.id === selectedId;
									const playing = playingId === it.id;
									const isTake = !!it.take;
									const takes = isTake ? 0 : takeCountOf(it);
									const open = !!expanded[it.id];
									return (
										// biome-ignore lint/a11y/useFocusableInteractive: listbox options are reached with aria-activedescendant
										// biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles the keyboard (arrows, Space, Enter)
										<div
											key={it.id}
											id={`snd-opt-${it.id}`}
											role="option"
											aria-selected={sel}
											aria-setsize={setSize}
											aria-posinset={i + 1}
											aria-label={soundAccessibleName(it, fav, takes ? { count: takes, open } : undefined)}
											data-sound-id={it.id}
											data-take={isTake ? it.take!.index : undefined}
											data-playing={playing || undefined}
											draggable
											title={soundTooltip(it, rootLabel)}
											style={{ position: 'absolute', top: i * rowH, height: rowH, left: 0, right: 0 }}
											className={cx(
												'flex cursor-default items-center gap-1.5 px-1 select-none',
												isTake && 'pl-5',
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
													// the In Context toggle applies to hover too (spec 12 §2.7)
													if (soundLibraryPrefs.get().inContext && session?.getState().activeSequenceId) {
														if (inContextStore.getState().soundId !== it.id) doAuditionInContext(it);
														return;
													}
													const p = auditionPlayer();
													p.setVolumeDb(soundLibraryPrefs.get().volumeDb);
													void p.play(auditionSoundOf(engine, it), { loop: false });
												}, HOVER_DELAY_MS);
											}}
											onMouseLeave={() => {
												if (hoverTimer.current) clearTimeout(hoverTimer.current);
												hoverTimer.current = null;
												if (!prefs.auditionOnHover) return;
												if (auditionPlayer().state.soundId === it.id) auditionPlayer().stop();
												if (inContextStore.getState().soundId === it.id) stopInContext();
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
												<span className="truncate">{isTake ? takeLabel(it) : it.title || it.id}</span>
												{prefs.density === 'normal' ? (
													<span className="truncate text-pr-small text-pr-dim">
														{it.types.map(typeLabel).join(', ') || 'Untyped'} ·{' '}
														{formatSeconds(it.format.durationSec)}
														{it.take?.strokes === 2 ? ` · ${t('2 strokes')}` : ''}
													</span>
												) : null}
											</div>
											{results?.matches[it.id] ? <MatchChip match={results.matches[it.id]!} /> : null}
											{takes > 0 ? (
												<button
													type="button"
													tabIndex={-1}
													aria-hidden="true"
													aria-expanded={open}
													title={
														open
															? t('Hide the takes (←)')
															: t(
																	'Show the takes: the single hits of this recording, each a sound of its own (→)',
																)
													}
													data-takes-toggle={it.id}
													className="inline-flex shrink-0 items-center gap-0.5 rounded-pr-pill border border-pr-border-subtle px-1 text-pr-small leading-[14px] text-pr-muted hover:text-pr-text"
													onClick={(ev) => {
														ev.stopPropagation();
														toggleTakes(it);
													}}
													onDoubleClick={(ev) => ev.stopPropagation()}
												>
													<Icon id={open ? 'app.chevronDown' : 'app.chevronRight'} size={10} />
													<span className="pr-tabular">{takeLabel(it, takes)}</span>
												</button>
											) : null}
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
												data-share-alike={badge.shareAlike ? 'true' : undefined}
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
													doFavourite(it);
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
			{/* palette strip (spec 12 §2.7): the sequence's preferred sounds; "Palette only" filters the list to them */}
			{palette.length || filters.collection === 'palette' ? (
				<div
					className="flex items-center gap-1 border-t border-pr-border-subtle px-1 py-0.5"
					data-testid="sound-palette-strip"
				>
					<label className="inline-flex shrink-0 items-center gap-1 text-pr-small text-pr-muted">
						<input
							type="checkbox"
							checked={filters.collection === 'palette'}
							onChange={(ev) =>
								setFilters((f) => ({ ...f, collection: ev.currentTarget.checked ? 'palette' : 'all' }))
							}
							data-testid="sound-palette-only"
						/>
						{t('Palette only')}
					</label>
					<ul className="flex min-w-0 flex-1 gap-1 overflow-x-auto" aria-label={t('Palette')}>
						{palette.map((id) => (
							<PaletteChip
								key={id}
								id={id}
								engine={engine}
								selected={selectedId === id}
								onPick={(entry) => {
									if (items.some((x) => x.id === id)) select(id, { play: true });
									else if (entry) doAudition(entry);
								}}
								onRemove={canInsert ? () => togglePalette(id) : undefined}
							/>
						))}
					</ul>
				</div>
			) : null}
			{/* status line */}
			<footer
				className="flex items-center gap-1 border-t border-pr-border-subtle px-1 py-0.5 text-pr-small text-pr-dim"
				data-testid="sound-status"
			>
				<span className="truncate">
					{results
						? results.total === results.librarySize || local
							? results.total === 1
								? t('1 sound')
								: t('{0} sounds', results.total)
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

/** A palette sound in the strip: its title (fetched by id), click to audition / select, × to remove. */
function PaletteChip(props: {
	id: string;
	engine: { getSound(id: string): Promise<SoundEntry> };
	selected: boolean;
	onPick(entry: SoundEntry | null): void;
	onRemove?: () => void;
}) {
	const [entry, setEntry] = useState<SoundEntry | null>(null);
	useEffect(() => {
		let live = true;
		void cachedEntry(props.engine, props.id).then((e) => live && setEntry(e));
		return () => {
			live = false;
		};
	}, [props.engine, props.id]);
	return (
		<li
			className={cx(
				'inline-flex shrink-0 items-center gap-0.5 rounded-pr-pill border px-1.5 text-pr-small leading-[16px]',
				props.selected ? 'border-pr-accent text-pr-text' : 'border-pr-border-subtle text-pr-muted',
			)}
			data-palette-sound={props.id}
		>
			<button
				type="button"
				className="max-w-[120px] truncate hover:text-pr-text"
				onClick={() => props.onPick(entry)}
			>
				{entry?.title || props.id}
			</button>
			{props.onRemove ? (
				<button
					type="button"
					aria-label={t('Remove {0} from the palette', entry?.title || props.id)}
					className="hover:text-pr-text"
					onClick={props.onRemove}
				>
					<Icon id="app.close" size={8} />
				</button>
			) : null}
		</li>
	);
}

/** For tests: forget fetched entries. */
export function clearSoundEntryCache(): void {
	entryCache.clear();
}
