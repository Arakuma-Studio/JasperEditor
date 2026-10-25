// Link Media (S04:AS-011, docs/wp-notes/link-media.md §5), after Premiere's dialog: the offline media (clip name, file
// name, last known path, status), Match File Properties, Align Timecode, Relink others automatically, Use Media
// Browser to locate files, Preserve Interpret Footage; Offline All / Offline / Cancel / Locate. Locating one file
// links it and — with Relink others automatically — every other offline file the engine finds from it, as one
// undoable transaction. Ambiguous matches and files that differ wait for the user.
import type { BrowseEntry, EngineJob, RelinkAnchor } from '@jasper/api';
import { type EngineClient, EngineError } from '@jasper/engine-client';
import {
	applyMapping,
	displayPath,
	fileExtensionOf,
	fileStemOf,
	formatPath,
	type HostPlatform,
	isForeignPath,
	isHostAbsolute,
	type MediaAsset,
	parsePath,
	planContext,
	segmentKey,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Button, Checkbox, Dialog, type HostedDialogProps, TextField, Tooltip } from '@jasper/ui';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDialogClose } from '../../extensions/dialog.ts';
import { t } from '../../i18n/runtime.ts';
import { getDesktopBridge } from '../../runtime/platform.ts';
import {
	anchorOf,
	applyLinks,
	criteriaOf,
	DEFAULT_LINK_OPTIONS,
	type Found,
	LinkCancelled,
	type LinkOptions,
	lastKnownPath,
	relinkBody,
	runScan,
	type ScanOutcome,
} from './flow.ts';

export type LinkMediaProps = {
	session: EditorSession;
	engine: EngineClient;
	/** The offline media to list (Project panel ▸ Link Media… on a selection); default every offline one. */
	mediaIds?: string[];
	/** Opened because the project opened with offline media. */
	atOpen?: boolean;
};

type RowStatus =
	| { kind: 'offline' }
	| { kind: 'skipped' }
	| { kind: 'linked'; path: string; how: string }
	| { kind: 'confirm'; found: Found; failed?: string[] }
	| { kind: 'ambiguous'; candidates: string[] };

const ROW_H = 24;
const LIST_H = 192;
/** Media that is offline: an imported placeholder (no file yet) or a file the engine cannot find. */
export function offlineMedia(session: EditorSession): MediaAsset[] {
	const st = session.getState();
	const doc = session.getCommitted();
	return (Object.values(doc.media) as MediaAsset[]).filter(
		(m) =>
			(m.kind === 'video' || m.kind === 'audio' || m.kind === 'image' || m.kind === 'animated-image') &&
			(m.fingerprint.startsWith('pending:interchange:') || st.media[m.id]?.availability === 'offline'),
	);
}

/** The folders above a file, nearest first (`/a/b/c.mov` → `/a/b`, `/a`, `/`). */
function parentChain(file: string): string[] {
	const p = parsePath(file);
	if (p.style === 'relative') return [];
	const out: string[] = [];
	for (let n = p.segments.length - 1; n >= 0; n--)
		out.push(formatPath({ ...p, segments: p.segments.slice(0, n) }));
	return out;
}

const errorText = (e: unknown) =>
	e instanceof EngineError ? `${e.message} (${e.code})` : e instanceof Error ? e.message : String(e);

const HOW_LABELS: Record<string, string> = {
	located: 'Located',
	original: 'Last known path',
	mapping: 'Same folder structure',
	relative: 'Project-relative path',
	'same-folder': 'Same folder',
	search: 'Search',
	fingerprint: 'Same content',
};

/** The Locate view's state: the asset being located, the folder shown and the file picked. */
type LocateState = {
	asset: MediaAsset;
	folder: string;
	parent: string | null;
	entries: BrowseEntry[];
	picked: string | null;
	candidates: string[] | null;
	message: string | null;
};

type Confirming = { asset: MediaAsset; path: string; found: Found; failed: string[] };

export function LinkMediaDialog(props: HostedDialogProps<LinkMediaProps>) {
	const { session, engine } = props;
	const { open, finish } = useDialogClose(props.close);
	const projectId = session.projectId;
	const rows = useMemo(() => {
		const all = offlineMedia(session);
		return props.mediaIds?.length ? all.filter((m) => props.mediaIds!.includes(m.id)) : all;
	}, [session, props.mediaIds]);
	const clipNames = useMemo(() => {
		const out = new Map<string, string>();
		for (const i of Object.values(session.getCommitted().items))
			if (i.kind === 'media' && !out.has(i.mediaId)) out.set(i.mediaId, i.name);
		return out;
	}, [session]);
	const [status, setStatus] = useState<Record<string, RowStatus>>({});
	const [selected, setSelected] = useState<string | null>(rows[0]?.id ?? null);
	const [opts, setOpts] = useState<LinkOptions>(DEFAULT_LINK_OPTIONS);
	const [useBrowser, setUseBrowser] = useState(true);
	const [anchors, setAnchors] = useState<RelinkAnchor[]>([]);
	const [busy, setBusy] = useState<{ text: string; jobId?: string } | null>(null);
	const [summary, setSummary] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [filter, setFilter] = useState('');
	const [folder, setFolder] = useState('');
	const [host, setHost] = useState<{ platform: HostPlatform; home: string } | null>(null);
	const [locate, setLocate] = useState<LocateState | null>(null);
	const [confirming, setConfirming] = useState<Confirming | null>(null);
	const [exactOnly, setExactOnly] = useState(true);
	const lastFolder = useRef<string | null>(null);
	const statusRef = useRef(status);
	statusRef.current = status;
	const desktop = getDesktopBridge();

	const stateOf = (id: string): RowStatus => status[id] ?? { kind: 'offline' };
	const pending = rows.filter((r) => {
		const s = stateOf(r.id).kind;
		return s === 'offline' || s === 'confirm' || s === 'ambiguous';
	});
	const stillOffline = (exclude?: string) =>
		rows.filter((r) => r.id !== exclude && (statusRef.current[r.id]?.kind ?? 'offline') === 'offline');

	const patch = (next: Record<string, RowStatus>) => {
		statusRef.current = { ...statusRef.current, ...next };
		setStatus(statusRef.current);
	};

	const onJob = (j: EngineJob) =>
		setBusy({
			text: `${j.stage ?? j.state}${typeof j.progress === 'number' && j.progress > 0 ? ` — ${Math.round(j.progress * 100)}%` : ''}`,
			jobId: j.id,
		});

	/** Statuses and links from a search; files that verified and need no confirmation are linked now. */
	const takeOutcome = async (
		r: ScanOutcome,
		extra: { assetId: string; found: Found; force: boolean }[] = [],
	) => {
		const auto = r.found.filter((f) => !f.needsConfirm);
		const links = [
			...extra.map((x) => ({ assetId: x.assetId, media: x.found.media, force: x.force })),
			...auto.map((f) => ({ assetId: f.assetId, media: f.media, force: false })),
		];
		const applied = await applyLinks(session, links, opts);
		if (!applied.ok) {
			setError(applied.error);
			return null;
		}
		const next: Record<string, RowStatus> = {};
		for (const x of extra) next[x.assetId] = { kind: 'linked', path: x.found.path, how: x.found.how };
		for (const f of auto) next[f.assetId] = { kind: 'linked', path: f.path, how: f.how };
		for (const f of r.found.filter((x) => x.needsConfirm)) next[f.assetId] = { kind: 'confirm', found: f };
		for (const a of r.ambiguous) next[a.assetId] = { kind: 'ambiguous', candidates: a.candidates };
		patch(next);
		const unaligned = applied.unaligned.length
			? t(' Timecode not aligned for {0} (their clips would leave the file).', applied.unaligned.length)
			: '';
		const searched = r.scannedFiles
			? t(
					' {0} files searched{1}.',
					r.scannedFiles,
					r.timedOut ? t(' (time limit reached)') : r.truncated ? t(' (file limit reached)') : '',
				)
			: '';
		setSummary(
			t(
				'Linked {0}; {1} ambiguous, {2} need confirmation, {3} still missing.',
				applied.linked.length,
				r.ambiguous.length,
				r.found.filter((x) => x.needsConfirm).length,
				r.notFound.length,
			) +
				searched +
				unaligned,
		);
		return applied.linked.length;
	};

	const guard = async (text: string, fn: () => Promise<void>) => {
		setError(null);
		setBusy({ text });
		try {
			await fn();
		} catch (e) {
			if (!(e instanceof LinkCancelled)) setError(errorText(e));
			else setSummary(t('Search cancelled.'));
		} finally {
			setBusy(null);
		}
	};

	// Premiere first tries the stored paths: the last known path of every row the engine can open as written.
	const checkedOnce = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once when the dialog opens
	useEffect(() => {
		if (checkedOnce.current || !rows.length) return;
		checkedOnce.current = true;
		void guard(t('Checking last known paths…'), async () => {
			const { match, ignoreExtension } = criteriaOf(DEFAULT_LINK_OPTIONS);
			const r = await runScan(
				engine,
				projectId,
				{ assets: rows.map(relinkBody), match, ignoreExtension },
				onJob,
			);
			if (!r.found.some((f) => !f.needsConfirm)) return setSummary(null);
			const n = await takeOutcome({ ...r, notFound: [], ambiguous: [] });
			if (n) setSummary(t('{0} found at their last known paths and linked.', n));
		});
		engine
			.browseRoots()
			.then((b) => setHost({ platform: b.sep === '\\' ? 'win32' : 'posix', home: b.home }))
			.catch(() => setHost(null));
	}, []);

	// Everything linked: the dialog is done.
	useEffect(() => {
		if (rows.length && !pending.length && !busy && Object.keys(status).length)
			finish({ linked: rows.filter((r) => stateOf(r.id).kind === 'linked').length });
	});

	/** Verify the located file, then link it and (Relink others automatically) the others it leads to. */
	const linkLocated = async (asset: MediaAsset, path: string, force = false) => {
		const { match, ignoreExtension } = criteriaOf(opts);
		let found: Found;
		let failed: string[] = [];
		if (confirming && confirming.asset.id === asset.id && confirming.path === path) found = confirming.found;
		else {
			setBusy({ text: t('Checking {0}…', asset.originalName) });
			const r = await engine.relinkAsset(asset.id, {
				projectId,
				path,
				asset: relinkBody(asset),
				match,
				ignoreExtension,
			});
			found = {
				assetId: asset.id,
				path,
				media: r.media,
				match: r.match,
				diff: r.diff,
				needsConfirm: r.needsConfirm,
				how: 'located',
			};
			failed = r.failed ?? [];
		}
		if (found.needsConfirm && !force) {
			setConfirming({ asset, path, found, failed });
			return;
		}
		setConfirming(null);
		setLocate(null);
		lastFolder.current = parentChain(path)[0] ?? null;
		const anchor = anchorOf(asset, path);
		const nextAnchors = anchor ? [...anchors, anchor] : anchors;
		setAnchors(nextAnchors);
		const others = stillOffline(asset.id);
		if (opts.relinkOthers && anchor && others.length) {
			const r = await runScan(
				engine,
				projectId,
				{ anchors: nextAnchors, assets: others.map(relinkBody), match, ignoreExtension },
				onJob,
			);
			await takeOutcome(r, [{ assetId: asset.id, found, force: found.needsConfirm }]);
		} else
			await takeOutcome(
				{
					found: [],
					ambiguous: [],
					notFound: [],
					scannedFiles: 0,
					truncated: false,
					timedOut: false,
					mappings: [],
				},
				[{ assetId: asset.id, found, force: found.needsConfirm }],
			);
		const next = stillOffline(asset.id)[0];
		if (next) setSelected(next.id);
	};

	const startLocate = async (asset: MediaAsset) => {
		if (!useBrowser && desktop) {
			const picked = await desktop.pickMedia();
			if (picked[0])
				await guard(t('Checking {0}…', asset.originalName), () => linkLocated(asset, picked[0]!));
			return;
		}
		await guard(t('Opening the media browser…'), async () => {
			const start = await startFolderFor(asset);
			await openFolder(asset, start, null);
		});
	};

	/**
	 * Premiere opens Locate at the closest existing folder of where the file should be: the located files' folder
	 * mapping applied to its last known path, the last known path itself (when on this computer), the folder of the
	 * last located file, else the home folder.
	 */
	const startFolderFor = async (asset: MediaAsset): Promise<string> => {
		const { path } = lastKnownPath(asset);
		const files: string[] = [];
		if (path) {
			for (const m of planContext(anchors).mappings) {
				const p = applyMapping(m, path);
				if (p) files.push(p);
			}
			if (host && isHostAbsolute(path, host.platform)) files.push(path);
		}
		const folders = files.flatMap((f) => parentChain(f));
		if (lastFolder.current) folders.push(lastFolder.current);
		for (const dir of folders.slice(0, 40)) {
			const ok = await engine.browseList(dir).catch(() => null);
			if (ok) return ok.path;
		}
		return host?.home ?? (await engine.browseRoots()).home;
	};

	const openFolder = async (asset: MediaAsset, dir: string, picked: string | null) => {
		const l = await engine.browseList(dir, { all: true });
		setLocate({
			asset,
			folder: l.path,
			parent: l.parent,
			entries: l.entries,
			picked,
			candidates: null,
			message: l.truncated ? t('Only the first entries of this folder are listed.') : null,
		});
	};

	const nameMatches = (asset: MediaAsset, name: string) => {
		if (segmentKey(fileStemOf(name)) !== segmentKey(fileStemOf(asset.originalName))) return false;
		return !opts.match.extension || fileExtensionOf(name) === fileExtensionOf(asset.originalName);
	};

	const searchHere = (l: LocateState) =>
		guard(t('Searching {0}…', l.folder), async () => {
			const { match, ignoreExtension } = criteriaOf(opts);
			const r = await runScan(
				engine,
				projectId,
				{ folder: l.folder, assets: [relinkBody(l.asset)], match, ignoreExtension },
				onJob,
			);
			const hit = r.found[0];
			const amb = r.ambiguous[0];
			setLocate({
				...l,
				picked: hit?.path ?? null,
				candidates: amb ? amb.candidates : hit ? [hit.path] : [],
				message: hit
					? null
					: amb
						? t('Several files match: choose one.')
						: t('No matching file under this folder ({0} files searched).', r.scannedFiles),
			});
		});

	const searchFolder = () =>
		guard(t('Searching…'), async () => {
			if (!folder.trim()) throw new Error(t('Enter the folder to search'));
			const { match, ignoreExtension } = criteriaOf(opts);
			const targets = stillOffline();
			if (!targets.length) return;
			const r = await runScan(
				engine,
				projectId,
				{
					folder: folder.trim(),
					...(anchors.length ? { anchors } : {}),
					assets: targets.map(relinkBody),
					match,
					ignoreExtension,
				},
				onJob,
			);
			await takeOutcome(r);
		});

	const linkAnyway = (id: string) => {
		const s = stateOf(id);
		if (s.kind !== 'confirm') return;
		void guard(t('Linking…'), async () => {
			await takeOutcome(
				{
					found: [],
					ambiguous: [],
					notFound: [],
					scannedFiles: 0,
					truncated: false,
					timedOut: false,
					mappings: [],
				},
				[{ assetId: id, found: s.found, force: true }],
			);
		});
	};

	const offlineSelected = () => {
		if (!selected) return;
		patch({ [selected]: { kind: 'skipped' } });
		const next = rows.find((r) => r.id !== selected && stateOf(r.id).kind === 'offline');
		setSelected(next?.id ?? null);
	};

	const visibleRows = useMemo(() => {
		const q = filter.trim().toLowerCase();
		if (!q) return rows;
		return rows.filter((r) => {
			const p = lastKnownPath(r).path ?? '';
			return (
				r.originalName.toLowerCase().includes(q) ||
				p.toLowerCase().includes(q) ||
				(clipNames.get(r.id) ?? '').toLowerCase().includes(q)
			);
		});
	}, [rows, filter, clipNames]);

	const selectedAsset = rows.find((r) => r.id === selected) ?? null;
	const canLocate =
		!!selectedAsset &&
		!busy &&
		['offline', 'ambiguous', 'confirm', 'skipped'].includes(stateOf(selectedAsset.id).kind);
	const linkedCount = rows.filter((r) => stateOf(r.id).kind === 'linked').length;

	const setMatch = (k: keyof LinkOptions['match'], v: boolean) =>
		setOpts((o) => ({ ...o, match: { ...o.match, [k]: v } }));
	const unavailable = t('JasperEditor projects do not record this property, so it cannot be compared.');

	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish({ linked: linkedCount })}
			title={t('Link Media')}
			size="large"
			primaryLabel={locate ? t('OK') : t('Locate')}
			primaryDisabled={locate ? !locate.picked || !!busy : !canLocate}
			onPrimary={() => {
				if (locate) {
					const l = locate;
					if (l.picked)
						void guard(t('Checking {0}…', l.asset.originalName), () => linkLocated(l.asset, l.picked!));
				} else if (selectedAsset) void startLocate(selectedAsset);
				return false;
			}}
			cancelLabel={t('Cancel')}
			onCancel={() => finish({ linked: linkedCount })}
			footerExtra={
				locate ? (
					<Button
						variant="secondary"
						onClick={() => setLocate(null)}
						disabled={!!busy}
						data-testid="link-media-back"
					>
						Back
					</Button>
				) : (
					<div className="flex gap-2">
						<Button
							variant="secondary"
							onClick={() => finish({ linked: linkedCount, offline: pending.length })}
							data-testid="link-media-offline-all"
						>
							Offline All
						</Button>
						<Button
							variant="secondary"
							onClick={offlineSelected}
							disabled={!selectedAsset || stateOf(selectedAsset.id).kind === 'linked'}
							data-testid="link-media-offline"
						>
							Offline
						</Button>
					</div>
				)
			}
			data-testid="link-media-dialog"
		>
			<div className="flex min-h-0 flex-col gap-3 text-pr-ui">
				{confirming ? (
					<ConfirmPanel
						c={confirming}
						onLink={() =>
							void guard(t('Linking…'), () => linkLocated(confirming.asset, confirming.path, true))
						}
						onBack={() => setConfirming(null)}
						busy={!!busy}
					/>
				) : locate ? (
					<LocatePanel
						l={locate}
						exactOnly={exactOnly}
						setExactOnly={setExactOnly}
						matches={(n) => nameMatches(locate.asset, n)}
						onOpen={(dir) => void guard(t('Opening…'), () => openFolder(locate.asset, dir, null))}
						onPick={(p) => setLocate({ ...locate, picked: p })}
						onChoose={(p) =>
							void guard(t('Checking {0}…', locate.asset.originalName), () => linkLocated(locate.asset, p))
						}
						onSearch={() => void searchHere(locate)}
						busy={!!busy}
					/>
				) : (
					<>
						<p className="text-pr-muted">
							{rows.length === 0
								? t('No media is offline.')
								: t(
										'{0} offline media file(s). Locate one and the others are found from it when they kept their folder structure.',
										rows.length,
									)}
						</p>
						<TextField
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							placeholder={t('Filter by name or path')}
							aria-label={t('Filter offline media')}
							data-testid="link-media-filter"
						/>
						<RowList
							rows={visibleRows}
							selected={selected}
							onSelect={setSelected}
							onLocate={(a) => {
								setSelected(a.id);
								void startLocate(a);
							}}
							render={(a) => (
								<RowCells
									a={a}
									clipName={clipNames.get(a.id) ?? a.originalName}
									status={stateOf(a.id)}
									host={host?.platform ?? null}
									onLinkAnyway={() => linkAnyway(a.id)}
									onChoose={(p) => void guard(t('Checking {0}…', a.originalName), () => linkLocated(a, p))}
									busy={!!busy}
								/>
							)}
						/>
						<fieldset className="flex flex-col gap-1.5">
							<legend className="mb-1 text-pr-muted">Match File Properties</legend>
							<div className="flex flex-wrap gap-x-4 gap-y-1.5">
								<Checkbox
									id="lm-name"
									label="File Name"
									checked={opts.match.name}
									onCheckedChange={(v) => setMatch('name', v)}
								/>
								<Checkbox
									id="lm-ext"
									label="File Extension"
									checked={opts.match.extension}
									onCheckedChange={(v) => setMatch('extension', v)}
								/>
								<Checkbox
									id="lm-start"
									label="Media Start"
									checked={opts.match.mediaStart}
									onCheckedChange={(v) => setMatch('mediaStart', v)}
								/>
								<Checkbox
									id="lm-duration"
									label="Media Duration"
									checked={opts.match.duration}
									onCheckedChange={(v) => setMatch('duration', v)}
								/>
								<Checkbox
									id="lm-size"
									label="File Size"
									checked={opts.match.size}
									onCheckedChange={(v) => setMatch('size', v)}
								/>
								<Checkbox
									id="lm-streams"
									label="Streams"
									checked={opts.match.streams}
									onCheckedChange={(v) => setMatch('streams', v)}
								/>
								<Tooltip content={unavailable}>
									<span>
										<Checkbox
											id="lm-tape"
											label="Tape Name"
											checked={false}
											disabled
											onCheckedChange={() => undefined}
										/>
									</span>
								</Tooltip>
								<Tooltip content={unavailable}>
									<span>
										<Checkbox
											id="lm-desc"
											label="Description"
											checked={false}
											disabled
											onCheckedChange={() => undefined}
										/>
									</span>
								</Tooltip>
								<Tooltip content={unavailable}>
									<span>
										<Checkbox
											id="lm-clipid"
											label="Clip ID"
											checked={false}
											disabled
											onCheckedChange={() => undefined}
										/>
									</span>
								</Tooltip>
							</div>
						</fieldset>
						<div className="flex flex-wrap gap-x-4 gap-y-1.5">
							<Checkbox
								id="lm-align"
								label="Align Timecode"
								checked={opts.alignTimecode}
								onCheckedChange={(v) => setOpts((o) => ({ ...o, alignTimecode: v }))}
							/>
							<Checkbox
								id="lm-others"
								label="Relink others automatically"
								checked={opts.relinkOthers}
								onCheckedChange={(v) => setOpts((o) => ({ ...o, relinkOthers: v }))}
							/>
							<Tooltip
								content={desktop ? undefined : t('The system file browser is available in the desktop app.')}
							>
								<span>
									<Checkbox
										id="lm-browser"
										label="Use Media Browser to locate files"
										checked={useBrowser || !desktop}
										disabled={!desktop}
										onCheckedChange={setUseBrowser}
									/>
								</span>
							</Tooltip>
							<Checkbox
								id="lm-interpret"
								label="Preserve Interpret Footage"
								checked={opts.preserveInterpretation}
								onCheckedChange={(v) => setOpts((o) => ({ ...o, preserveInterpretation: v }))}
							/>
						</div>
						<div className="flex items-center gap-2">
							<span className="w-[110px] shrink-0 text-pr-muted">Search folder</span>
							<TextField
								value={folder}
								onChange={(e) => setFolder(e.target.value)}
								placeholder="/path/to/media"
								aria-label={t('Search folder')}
								data-testid="link-media-folder"
							/>
							<Button
								variant="secondary"
								onClick={() => void searchFolder()}
								disabled={!!busy || !pending.length}
								data-testid="link-media-search"
							>
								Search
							</Button>
						</div>
					</>
				)}
				{busy || summary ? (
					<div className="flex items-center gap-2">
						<p
							className="min-w-0 flex-1 text-pr-small text-pr-muted"
							role="status"
							data-testid="link-media-status"
						>
							{busy?.text ?? summary}
						</p>
						{busy?.jobId ? (
							<Button
								variant="quiet"
								onClick={() => void engine.cancelJob(busy.jobId!).catch(() => undefined)}
								data-testid="link-media-cancel-search"
							>
								Stop
							</Button>
						) : null}
					</div>
				) : null}
				{error ? (
					<p className="text-pr-small text-pr-danger" role="alert">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

/** Fixed-height rows, only the visible ones rendered (thousands of offline media). */
function RowList(props: {
	rows: MediaAsset[];
	selected: string | null;
	onSelect(id: string): void;
	onLocate(a: MediaAsset): void;
	render(a: MediaAsset): ReactNode;
}) {
	const [top, setTop] = useState(0);
	const ref = useRef<HTMLDivElement>(null);
	const first = Math.max(0, Math.floor(top / ROW_H) - 5);
	const count = Math.ceil(LIST_H / ROW_H) + 10;
	const slice = props.rows.slice(first, first + count);
	const onKey = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
			e.preventDefault();
			const i = props.rows.findIndex((r) => r.id === props.selected);
			const n =
				props.rows[Math.max(0, Math.min(props.rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
			if (n) {
				props.onSelect(n.id);
				const el = ref.current;
				const y = props.rows.indexOf(n) * ROW_H;
				if (el && (y < el.scrollTop || y + ROW_H > el.scrollTop + LIST_H)) el.scrollTop = y - LIST_H / 2;
			}
		},
		[props],
	);
	return (
		<div className="flex flex-col rounded-pr border border-pr-border-subtle">
			<div className="grid grid-cols-[1fr_1fr_2fr_1.4fr] gap-2 border-b border-pr-border-subtle px-2 py-1 text-pr-small text-pr-muted">
				<span>Clip Name</span>
				<span>File Name</span>
				<span>Last Path</span>
				<span>Status</span>
			</div>
			<div
				ref={ref}
				role="listbox"
				aria-label={t('Offline media')}
				tabIndex={0}
				onKeyDown={onKey}
				onScroll={(e) => setTop(e.currentTarget.scrollTop)}
				className="relative overflow-y-auto outline-none"
				style={{ height: LIST_H }}
				data-testid="link-media-table"
			>
				<div style={{ height: props.rows.length * ROW_H, position: 'relative' }}>
					{slice.map((a, k) => (
						<div
							key={a.id}
							role="option"
							aria-selected={a.id === props.selected}
							tabIndex={-1}
							onClick={() => props.onSelect(a.id)}
							onDoubleClick={() => props.onLocate(a)}
							onKeyDown={(e) => e.key === 'Enter' && props.onLocate(a)}
							className={`absolute right-0 left-0 grid grid-cols-[1fr_1fr_2fr_1.4fr] items-center gap-2 px-2 text-pr-small ${
								a.id === props.selected ? 'bg-pr-selected' : 'hover:bg-pr-hover'
							}`}
							style={{ top: (first + k) * ROW_H, height: ROW_H }}
							data-testid="link-media-row"
							data-media-id={a.id}
						>
							{props.render(a)}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

function RowCells(props: {
	a: MediaAsset;
	clipName: string;
	status: RowStatus;
	host: HostPlatform | null;
	onLinkAnyway(): void;
	onChoose(path: string): void;
	busy: boolean;
}) {
	const { a, status } = props;
	const last = lastKnownPath(a).path;
	const foreign = last && props.host ? isForeignPath(last, props.host) : false;
	return (
		<>
			<span className="truncate text-pr-text">{props.clipName}</span>
			<span className="truncate text-pr-text">{a.originalName}</span>
			<span className="truncate text-pr-muted" title={last ? displayPath(last) : undefined}>
				{last ? displayPath(last) : '—'}
				{foreign ? <span className="ml-1 text-pr-dim">({t('another computer')})</span> : null}
			</span>
			<span className="flex min-w-0 items-center gap-1 truncate" data-testid="link-media-row-status">
				{status.kind === 'offline' ? <span className="text-pr-warning">Offline</span> : null}
				{status.kind === 'skipped' ? <span className="text-pr-muted">Left offline</span> : null}
				{status.kind === 'linked' ? (
					<span className="truncate text-pr-success" title={status.path}>
						{t('Linked ({0})', t(HOW_LABELS[status.how] ?? status.how))}
					</span>
				) : null}
				{status.kind === 'confirm' ? (
					<>
						<span
							className="truncate text-pr-warning"
							title={status.found.diff.map((d) => `${d.field}: ${d.was} → ${d.now}`).join('\n')}
						>
							Differs
						</span>
						<Button variant="quiet" onClick={props.onLinkAnyway} disabled={props.busy}>
							Link anyway
						</Button>
					</>
				) : null}
				{status.kind === 'ambiguous' ? (
					<select
						className="min-w-0 flex-1 rounded-pr border border-pr-border-strong bg-pr-field text-pr-small text-pr-text"
						aria-label={t('Choose the file for {0}', a.originalName)}
						value=""
						disabled={props.busy}
						onChange={(e) => e.target.value && props.onChoose(e.target.value)}
					>
						<option value="">{t('{0} matches — choose…', status.candidates.length)}</option>
						{status.candidates.map((c) => (
							<option key={c} value={c}>
								{c}
							</option>
						))}
					</select>
				) : null}
			</span>
		</>
	);
}

function ConfirmPanel(props: { c: Confirming; onLink(): void; onBack(): void; busy: boolean }) {
	const { c } = props;
	return (
		<div className="flex flex-col gap-2" data-testid="link-media-confirm">
			<p className="text-pr-text">
				{t('"{0}" is not the same as "{1}":', displayPath(c.path), c.asset.originalName)}
			</p>
			<ul className="list-disc pl-5 text-pr-warning">
				{c.failed.map((f) => (
					<li key={`f-${f}`}>
						{t('Does not match the selected property: {0}', t(CRITERION_LABELS[f] ?? f))}
					</li>
				))}
				{c.found.diff.map((d) => (
					<li key={`d-${d.field}`}>{`${t(DIFF_LABELS[d.field] ?? d.field)}: ${d.was} → ${d.now}`}</li>
				))}
			</ul>
			<div className="flex gap-2">
				<Button
					variant="primary"
					onClick={props.onLink}
					disabled={props.busy}
					data-testid="link-media-link-anyway"
				>
					Link anyway
				</Button>
				<Button variant="secondary" onClick={props.onBack} disabled={props.busy}>
					Choose another file
				</Button>
			</div>
		</div>
	);
}

const CRITERION_LABELS: Record<string, string> = {
	name: 'File Name',
	extension: 'File Extension',
	size: 'File Size',
	duration: 'Media Duration',
	mediaStart: 'Media Start',
	streams: 'Streams',
};
const DIFF_LABELS: Record<string, string> = {
	kind: 'Kind',
	duration: 'Duration',
	resolution: 'Resolution',
	frameRate: 'Frame rate',
	audio: 'Audio',
	name: 'Name',
	size: 'Size',
	mediaStart: 'Media start',
};

/** Premiere's Locate File dialog: a media browser on the engine's computer with "Display only exact name matches". */
function LocatePanel(props: {
	l: LocateState;
	exactOnly: boolean;
	setExactOnly(v: boolean): void;
	matches(name: string): boolean;
	onOpen(dir: string): void;
	onPick(path: string): void;
	onChoose(path: string): void;
	onSearch(): void;
	busy: boolean;
}) {
	const { l } = props;
	const [typed, setTyped] = useState(l.folder);
	useEffect(() => setTyped(l.folder), [l.folder]);
	const last = lastKnownPath(l.asset).path;
	const entries = l.entries.filter((e) =>
		e.kind === 'folder' ? !e.hidden : !props.exactOnly || props.matches(e.name),
	);
	return (
		<div className="flex flex-col gap-2" data-testid="link-media-locate">
			<p className="text-pr-text">{t('Where is the file "{0}"?', l.asset.originalName)}</p>
			<p className="truncate text-pr-small text-pr-muted">
				{t('Last Path: {0}', last ? displayPath(last) : t('none'))}
			</p>
			<div className="flex items-center gap-2">
				<Button
					variant="secondary"
					onClick={() => l.parent && props.onOpen(l.parent)}
					disabled={!l.parent || props.busy}
					aria-label={t('Up one folder')}
				>
					Up
				</Button>
				<TextField
					value={typed}
					onChange={(e) => setTyped(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							props.onOpen(typed.trim());
						}
					}}
					aria-label={t('Folder')}
					data-testid="link-media-locate-folder"
				/>
				<Button
					variant="secondary"
					onClick={props.onSearch}
					disabled={props.busy}
					data-testid="link-media-locate-search"
				>
					Search
				</Button>
			</div>
			<Checkbox
				id="lm-exact"
				label="Display only exact name matches"
				checked={props.exactOnly}
				onCheckedChange={props.setExactOnly}
			/>
			<div
				className="h-[240px] overflow-y-auto rounded-pr border border-pr-border-subtle"
				role="listbox"
				aria-label={t('Files')}
				data-testid="link-media-locate-list"
			>
				{(l.candidates ?? []).length ? (
					<div className="border-b border-pr-border-subtle px-2 py-1 text-pr-small text-pr-muted">
						Search results
					</div>
				) : null}
				{(l.candidates ?? []).map((c) => (
					<EntryRow
						key={`c-${c}`}
						label={displayPath(c)}
						selected={l.picked === c}
						onClick={() => props.onPick(c)}
						onDoubleClick={() => props.onChoose(c)}
					/>
				))}
				{entries.map((e) => (
					<EntryRow
						key={e.path}
						label={e.kind === 'folder' ? `${e.name}/` : e.name}
						muted={e.kind === 'file' && !props.matches(e.name)}
						selected={l.picked === e.path}
						onClick={() => (e.kind === 'folder' ? props.onOpen(e.path) : props.onPick(e.path))}
						onDoubleClick={() => e.kind === 'file' && props.onChoose(e.path)}
					/>
				))}
				{!entries.length && !(l.candidates ?? []).length ? (
					<p className="px-2 py-1 text-pr-small text-pr-muted">{t('Nothing to show in this folder.')}</p>
				) : null}
			</div>
			{l.message ? <p className="text-pr-small text-pr-muted">{l.message}</p> : null}
		</div>
	);
}

function EntryRow(props: {
	label: string;
	selected: boolean;
	muted?: boolean;
	onClick(): void;
	onDoubleClick(): void;
}) {
	return (
		<div
			role="option"
			aria-selected={props.selected}
			tabIndex={-1}
			onClick={props.onClick}
			onDoubleClick={props.onDoubleClick}
			onKeyDown={(e) => e.key === 'Enter' && props.onDoubleClick()}
			className={`cursor-default truncate px-2 py-0.5 text-pr-small ${props.selected ? 'bg-pr-selected' : 'hover:bg-pr-hover'} ${
				props.muted ? 'text-pr-dim' : 'text-pr-text'
			}`}
			data-testid="link-media-locate-entry"
		>
			{props.label}
		</div>
	);
}
