// Spec 19 TL-086: search, categories, recents, tile size and the grid of looks, shared by Motion Templates ▸ Looks and
// `Graphics ▸ Apply Look…`. The status line always says what a click does, so nothing depends on a tooltip.
import type { Clip, Colorway, ProjectDocument } from '@jasper/project';
import { titleLookOf } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSessionState } from '@jasper/session/react';
import { cx, Icon, type ResolvedMenuItem } from '@jasper/ui';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../i18n/runtime.ts';
import { useEngineOrNull } from '../state/engine.tsx';
import {
	announce,
	applyLookToClips,
	insertTitleWithLook,
	type LookOutcome,
	pickLook,
	playheadOnClip,
	setColorway,
} from './actions.ts';
import { LookGrid, type TileSize } from './LookGrid.tsx';
import {
	filterLooks,
	type LookEntry,
	lookCategories,
	lookEntries,
	myLooksLabel,
	readRecents,
	recentLooks,
} from './library.ts';
import { deleteProjectLook, renameProjectLook, updateProjectLook } from './look-actions.ts';
import { MyLooksBar } from './MyLooksBar.tsx';
import { type PosterSample, posterStoreFor } from './posters.ts';
import { colorwayPreviewCommands, endPreview, lookPreviewCommands, schedulePreview } from './preview.ts';
import { lookedClip, takesLook } from './selection.ts';
import { userLooksUnavailable, useUserLooks } from './user-library.ts';
import { deleteMyLook, exportMyLooks, renameMyLook } from './user-look-actions.ts';

const TILE_KEY = 'jasper.titleLooks.tile';
const RECENT = '$recent';
const TILES: readonly TileSize[] = ['small', 'medium', 'large'];

function initialTile(): TileSize {
	try {
		const v = globalThis.localStorage?.getItem(TILE_KEY);
		return TILES.includes(v as TileSize) ? (v as TileSize) : 'medium';
	} catch {
		return 'medium';
	}
}

/** TL-087: the selected title's own words and font, else the sample. */
export function posterSample(doc: ProjectDocument, clips: readonly Clip[]): PosterSample | null {
	const text = clips.find((c): c is Extract<Clip, { kind: 'text' }> => c.kind === 'text');
	if (!text) return null;
	const line =
		text.content.text
			.split('\n')
			.find((l) => l.trim())
			?.trim() ?? '';
	if (!line) return null;
	const style = text.content.style;
	const family = doc.fonts[style.fontId]?.family;
	return {
		text: [...line].slice(0, 40).join(''),
		...(family ? { font: { family, weight: style.weight, italic: style.italic } } : {}),
	};
}

/** Does this clip already wear this look? Library looks are matched through their project copy. */
function wears(doc: ProjectDocument, clip: Clip, entry: LookEntry): boolean {
	const id = lookedClip(clip)?.appearance.lookId;
	if (!id) return false;
	return id === entry.lookId || titleLookOf(doc, id)?.sourceId === entry.lookId;
}

function statusLine(selected: number, targets: number): string {
	if (selected === 0) return 'Click a look to add a title at the playhead.';
	if (targets === 0)
		return 'The selected clips cannot take a look. Select a title, shape, still, solid or video.';
	if (targets === 1) return 'Click a look to apply it to the selected clip.';
	return t('Click a look to apply it to the {0} selected clips.', targets);
}

export function LooksBrowser(props: {
	session: EditorSession;
	/** After a look was used (the dialog closes). */
	onUsed?(): void;
	/** What a panel adds to its footer. */
	links?: ReactNode;
}) {
	const { session } = props;
	const titleLooks = useSessionState((s) => s.document.titleLooks);
	const doc = useSessionState((s) => s.document);
	const selectedIds = useSessionState((s) => s.selection.timeline.clips);
	const seqId = useSessionState((s) => s.activeSequenceId);
	const readOnly = useSessionState((s) => s.readOnly);
	const client = useEngineOrNull()?.client ?? null;
	const seq = seqId ? doc.sequences[seqId] : undefined;
	const [query, setQuery] = useState('');
	const [category, setCategory] = useState<string | null>(null);
	const [tile, setTile] = useState<TileSize>(initialTile);
	const [recents, setRecents] = useState(readRecents);
	const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
	const [outside, setOutside] = useState(false);
	const user = useUserLooks();
	const myLooks = myLooksLabel();

	// biome-ignore lint/correctness/useExhaustiveDependencies: `doc` matters to entries only through `titleLooks`
	const entries = useMemo(() => lookEntries(doc, undefined, undefined, user.looks), [titleLooks, user.looks]);
	// My Looks has a chip even while it is empty: it is where saving and importing start.
	const categories = useMemo(() => {
		const list = lookCategories(entries);
		return list.includes(myLooks) ? list : [...list, myLooks];
	}, [entries, myLooks]);
	const recentEntries = useMemo(() => recentLooks(entries, recents), [entries, recents]);
	const visible = useMemo(
		() =>
			category === RECENT
				? filterLooks(recentEntries, { query, category: null })
				: filterLooks(entries, { query, category }),
		[entries, recentEntries, query, category],
	);
	const selected = useMemo(
		() => selectedIds.map((id) => seq?.clips[id]).filter((c): c is Clip => !!c),
		[selectedIds, seq],
	);
	const targets = useMemo(() => selected.filter(takesLook), [selected]);
	const sample = useMemo(() => posterSample(doc, selected), [doc, selected]);
	const store = useMemo(() => (client ? posterStoreFor(client) : null), [client]);
	const current = useRef({ doc, targets, session });
	current.current = { doc, targets, session };

	useEffect(() => () => endPreview(session), [session]);

	const finish = useCallback(
		(o: LookOutcome) => {
			announce(o);
			setMessage({ kind: o.ok ? 'info' : 'error', text: o.message });
			if (!o.ok) return;
			setRecents(readRecents());
			props.onUsed?.();
		},
		[props.onUsed],
	);

	const onUse = useCallback(
		(entry: LookEntry, colorway?: Colorway) => {
			const { doc, targets, session } = current.current;
			endPreview(session);
			// The look is already there: only the colours change, and cycling through them is one History entry.
			if (colorway && targets.length > 0 && targets.every((c) => wears(doc, c, entry))) {
				const r = setColorway(
					session,
					targets.map((c) => c.id),
					colorway,
				);
				setMessage(
					r.ok
						? { kind: 'info', text: t('Colourway: {0}', colorway.name) }
						: { kind: 'error', text: r.errors[0]?.message ?? t('The colourway could not be applied') },
				);
				return;
			}
			finish(pickLook(session, entry, colorway?.id));
		},
		[finish],
	);

	const onHover = useCallback((entry: LookEntry | null, colorway?: Colorway) => {
		const { doc, targets, session } = current.current;
		if (!entry || targets.length === 0) {
			endPreview(session);
			setOutside(false);
			return;
		}
		const ids = targets.map((c) => c.id);
		const frame = session.transport.getState().frame;
		setOutside(!targets.some((c) => playheadOnClip(c, frame)));
		const swatchOnly = !!colorway && targets.every((c) => wears(doc, c, entry));
		schedulePreview(session, {
			label: colorway ? t('{0} in {1}', entry.name, colorway.name) : entry.name,
			commands: swatchOnly
				? colorwayPreviewCommands(ids, colorway)
				: lookPreviewCommands(ids, entry, colorway?.id),
		});
	}, []);

	const colorwayOf = useCallback(
		(entry: LookEntry) => {
			const c = targets[0];
			return c && wears(doc, c, entry) ? lookedClip(c)?.appearance.colorwayId : undefined;
		},
		[doc, targets],
	);

	const menu = useCallback(
		(entry: LookEntry): ResolvedMenuItem[] => {
			const { targets, session } = current.current;
			const items: ResolvedMenuItem[] = [
				{
					type: 'item',
					id: 'apply',
					label: 'Apply to Selection',
					disabled: targets.length === 0 || readOnly,
					disabledReason: 'Select a clip that can take a look',
					onSelect: () =>
						finish(
							applyLookToClips(
								session,
								entry,
								targets.map((c) => c.id),
							),
						),
				},
				{
					type: 'item',
					id: 'title',
					label: 'Add as New Title',
					disabled: !seqId || readOnly,
					onSelect: () => finish(insertTitleWithLook(session, entry)),
				},
			];
			if (entry.source === 'user') {
				const why = userLooksUnavailable(user) ?? undefined;
				const look = { id: entry.lookId, name: entry.name };
				return [
					...items,
					{ type: 'separator', id: 'sep' },
					{
						type: 'item',
						id: 'rename',
						label: 'Rename…',
						disabled: !!why,
						...(why ? { disabledReason: why } : {}),
						onSelect: () => void renameMyLook(look),
					},
					{
						type: 'item',
						id: 'export',
						label: 'Export…',
						disabled: user.status !== 'ready',
						...(user.status !== 'ready' && why ? { disabledReason: why } : {}),
						onSelect: () =>
							void exportMyLooks([entry.lookId], entry.name).then((r) =>
								setMessage({ kind: r.ok ? 'info' : 'error', text: r.message }),
							),
					},
					{
						type: 'item',
						id: 'delete',
						label: 'Delete…',
						disabled: !!why,
						...(why ? { disabledReason: why } : {}),
						onSelect: () => void deleteMyLook(look),
					},
				];
			}
			if (entry.source !== 'project') return items;
			return [
				...items,
				{ type: 'separator', id: 'sep' },
				{
					type: 'item',
					id: 'update',
					label: 'Update from Selected Clip',
					disabled: targets.length !== 1 || !lookedClip(targets[0]!) || readOnly,
					disabledReason: 'Select one clip with a look',
					onSelect: () => updateProjectLook(session, entry.lookId, targets[0]!.id),
				},
				{
					type: 'item',
					id: 'rename',
					label: 'Rename…',
					disabled: readOnly,
					onSelect: () => void renameProjectLook(session, entry.lookId),
				},
				{
					type: 'item',
					id: 'delete',
					label: 'Delete…',
					disabled: readOnly,
					onSelect: () => void deleteProjectLook(session, entry.lookId),
				},
			];
		},
		[finish, readOnly, seqId, user],
	);

	const chip = (value: string | null, label: string) => (
		<button
			key={value ?? 'all'}
			type="button"
			aria-pressed={category === value}
			className={cx(
				'rounded-pr-pill border px-1.5 text-pr-small',
				category === value
					? 'border-pr-accent bg-pr-accent-fill text-pr-on-accent'
					: 'border-pr-border-subtle text-pr-muted hover:text-pr-text',
			)}
			onClick={() => setCategory(value)}
		>
			{label}
		</button>
	);

	return (
		<div
			className="flex h-full min-h-0 flex-col gap-1 p-1 text-pr-ui text-pr-text"
			data-testid="looks-browser"
		>
			<div className="flex items-center gap-1">
				<label className="flex min-w-0 flex-1 items-center gap-1 rounded-pr-control bg-pr-field px-1">
					<Icon id="app.search" size={14} />
					<input
						type="search"
						aria-label="Search looks"
						placeholder="Search looks"
						className="min-w-0 flex-1 bg-transparent py-0.5 text-pr-ui text-pr-text outline-none placeholder:text-pr-dim"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						data-testid="looks-search"
					/>
				</label>
				<fieldset className="flex items-center gap-[2px]" aria-label="Tile size">
					{TILES.map((s, i) => (
						<button
							key={s}
							type="button"
							aria-pressed={tile === s}
							aria-label={s === 'small' ? 'Small tiles' : s === 'medium' ? 'Medium tiles' : 'Large tiles'}
							title={s === 'small' ? 'Small tiles' : s === 'medium' ? 'Medium tiles' : 'Large tiles'}
							className={cx(
								'h-[20px] w-[20px] rounded-pr-control text-pr-small',
								tile === s ? 'bg-pr-selected text-pr-strong' : 'text-pr-muted hover:text-pr-text',
							)}
							onClick={() => {
								setTile(s);
								try {
									globalThis.localStorage?.setItem(TILE_KEY, s);
								} catch {
									// storage unavailable: the size lasts for this panel
								}
							}}
							data-testid={`looks-tile-${s}`}
						>
							{'SML'[i]}
						</button>
					))}
				</fieldset>
			</div>
			<div className="flex flex-wrap gap-1" role="toolbar" aria-label="Categories">
				{chip(null, t('All'))}
				{recentEntries.length ? chip(RECENT, t('Recent')) : null}
				{categories.map((c) => chip(c, c))}
			</div>
			{category === myLooks ? (
				<MyLooksBar session={session} library={user} onMessage={(kind, text) => setMessage({ kind, text })} />
			) : null}
			{visible.length === 0 ? (
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 p-3 text-center">
					{category === myLooks && !query.trim() ? (
						<p className="text-pr-small text-pr-muted" data-testid="my-looks-empty">
							{userLooksUnavailable(user) && user.status !== 'ready'
								? userLooksUnavailable(user)
								: t(
										'No looks of your own yet. Select a clip with a look and choose Save to My Looks…, or import a looks file.',
									)}
						</p>
					) : entries.length === 0 ? (
						<p className="text-pr-small text-pr-muted" data-testid="looks-empty">
							No looks yet. Style a title in Properties, then choose Graphics ▸ Save Look… to keep it here.
						</p>
					) : (
						<>
							<p className="text-pr-small text-pr-muted" data-testid="looks-no-match">
								No looks match this search.
							</p>
							<button
								type="button"
								className="text-pr-small text-pr-accent hover:underline"
								onClick={() => {
									setQuery('');
									setCategory(null);
								}}
							>
								Show all looks
							</button>
						</>
					)}
				</div>
			) : (
				<LookGrid
					entries={visible}
					tile={tile}
					sample={sample}
					store={store}
					colorwayOf={colorwayOf}
					onUse={onUse}
					onHover={onHover}
					menu={menu}
				/>
			)}
			<footer className="flex min-h-[18px] items-center gap-2 text-pr-small text-pr-dim">
				<span className="min-w-0 flex-1 truncate" data-testid="looks-status" role="status">
					{outside ? (
						<span className="text-pr-warning">Move the playhead over the clip to see the preview.</span>
					) : message ? (
						<span className={message.kind === 'error' ? 'text-pr-danger' : 'text-pr-muted'}>
							{message.text}
						</span>
					) : !seqId ? (
						'Open a sequence to use looks.'
					) : readOnly ? (
						'This project is read-only.'
					) : (
						statusLine(selected.length, targets.length)
					)}
				</span>
				{props.links}
			</footer>
		</div>
	);
}
