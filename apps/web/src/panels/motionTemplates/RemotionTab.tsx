// Motion Templates ▸ Remotion (M2, S08:MGU-001/002): the Remotion bundles of the project, each with its
// compositions (poster at the manifest's thumbnailFrame or frame 0, size, duration, fps); double-click or Enter
// inserts at the playhead on the targeted video track, dragging drops onto the Timeline / Program monitor
// (`clip.addComposition`). Also the entry point to import a project folder or a bundle zip, and to rebuild.
import type { MediaAsset, MgCompositionInfo } from '@jasper/project';
import type { EditorSession, SessionState } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { Button, cx, EmptyState, Icon } from '@jasper/ui';
import { useMemo, useState } from 'react';
import { mediaKeyOf } from '../../import/assets.ts';
import { bundleErrorText, rebuildBundle } from '../../mg-bundles/import.ts';
import { insertComposition } from '../../mg-bundles/insert.ts';
import { useMgRuntimeAttach } from '../../mg-bundles/RuntimeHost.tsx';
import { writeMgTemplateDrag } from './insert.ts';

type NullableStore = {
	getState(): SessionState | null;
	subscribe(l: (s: SessionState | null, p: SessionState | null) => void): () => void;
};
const NO_SESSION_STORE: NullableStore = { getState: () => null, subscribe: () => () => {} };

type BundleEntry = { asset: MediaAsset; compositions: MgCompositionInfo[] };

/** The project's bundles (sorted by name) with their compositions, filtered by a query. */
function bundleEntries(media: Record<string, MediaAsset>, query = ''): BundleEntry[] {
	const q = query.trim().toLowerCase();
	return Object.values(media)
		.filter((m) => m.kind === 'mg-bundle' && m.mgBundle)
		.sort((a, b) =>
			(a.mgBundle!.source.name || a.originalName).localeCompare(b.mgBundle!.source.name || b.originalName),
		)
		.map((asset) => ({
			asset,
			compositions: asset.mgBundle!.compositions.filter(
				(c) => !q || `${c.id} ${c.category ?? ''} ${asset.mgBundle!.source.name}`.toLowerCase().includes(q),
			),
		}))
		.filter((b) => !q || b.compositions.length > 0);
}

const secs = (c: MgCompositionInfo) => `${(c.durationInFrames / c.fps).toFixed(1)} s`;

function CompositionCard(props: {
	asset: MediaAsset;
	comp: MgCompositionInfo;
	onInsert(): void;
	disabled: boolean;
}) {
	const { asset, comp } = props;
	const key = mediaKeyOf(asset);
	const [failed, setFailed] = useState(false);
	const poster = key
		? `/api/mg-bundles/${encodeURIComponent(key)}/poster/${encodeURIComponent(comp.id)}`
		: null;
	return (
		<li
			// biome-ignore lint/a11y/noNoninteractiveTabindex: grid cells are focusable (Enter inserts)
			tabIndex={0}
			draggable={!props.disabled}
			data-composition={comp.id}
			data-bundle={asset.id}
			aria-label={`${comp.id} (${comp.width}×${comp.height}, ${secs(comp)})`}
			title={`${comp.id} — ${comp.width}×${comp.height} · ${comp.fps} fps · ${comp.durationInFrames} frames\nDouble-click or drag to the timeline to insert`}
			className={cx(
				'group flex cursor-pointer flex-col gap-1 rounded-pr-control border border-pr-border-subtle bg-pr-panel-alt p-1 outline-none',
				'hover:border-pr-border-strong focus-visible:border-pr-focus',
			)}
			onDoubleClick={() => !props.disabled && props.onInsert()}
			onKeyDown={(e) => {
				if (e.key === 'Enter' && !props.disabled) {
					e.preventDefault();
					props.onInsert();
				}
			}}
			onDragStart={(e) =>
				writeMgTemplateDrag(e.dataTransfer, {
					id: comp.id,
					version: 1,
					composition: { mediaId: asset.id, compositionId: comp.id },
				})
			}
		>
			<div
				className="relative aspect-video w-full overflow-hidden rounded-pr-control bg-pr-field-deep"
				data-mg-poster
			>
				{poster && !failed ? (
					<img
						src={poster}
						alt=""
						loading="lazy"
						draggable={false}
						className="absolute inset-0 h-full w-full object-contain"
						onError={() => setFailed(true)}
					/>
				) : (
					<span className="absolute inset-0 flex items-center justify-center text-pr-small text-pr-dim">
						{comp.width}×{comp.height}
					</span>
				)}
				<span
					className="absolute top-1 right-1 rounded-pr-pill bg-pr-engine-remotion px-1 text-pr-small text-pr-on-accent"
					title="Remotion composition"
				>
					R
				</span>
			</div>
			<div className="flex items-baseline justify-between gap-1 px-0.5">
				<span className="truncate text-pr-ui text-pr-text">{comp.id}</span>
				<span className="shrink-0 text-pr-small text-pr-dim">{secs(comp)}</span>
			</div>
			<div className="flex gap-1 px-0.5 text-pr-small text-pr-muted">
				<span className="truncate">{comp.category ?? `${comp.fps} fps`}</span>
				<span className="ml-auto shrink-0">
					{comp.width}×{comp.height}
				</span>
			</div>
		</li>
	);
}

export function RemotionTab(props: { session: EditorSession | null; onImport(): void }) {
	const { session } = props;
	useMgRuntimeAttach(session);
	const store = (session?.store as NullableStore | undefined) ?? NO_SESSION_STORE;
	const media = useStoreSelector(store, (s) => s?.document.media ?? null);
	const hasSequence = useStoreSelector(store, (s) => !!s?.activeSequenceId);
	const [query, setQuery] = useState('');
	const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
	const bundles = useMemo(() => (media ? bundleEntries(media, query) : []), [media, query]);
	const canInsert = !!session && hasSequence;

	const insert = (asset: MediaAsset, comp: MgCompositionInfo) => {
		if (!session) return;
		try {
			insertComposition(session, { mediaId: asset.id, compositionId: comp.id });
			setMessage({ kind: 'info', text: `Added ${comp.id} at the playhead` });
		} catch (e) {
			setMessage({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
		}
	};

	return (
		<div className="flex h-full min-h-0 flex-col gap-1 p-1" data-testid="remotion-tab">
			<div className="flex items-center gap-1">
				<label className="flex min-w-0 flex-1 items-center gap-1 rounded-pr-control bg-pr-field px-1">
					<Icon id="app.search" size={14} />
					<input
						type="search"
						aria-label="Search compositions"
						placeholder="Search compositions"
						className="min-w-0 flex-1 bg-transparent py-0.5 text-pr-ui text-pr-text outline-none placeholder:text-pr-dim"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
				</label>
				<Button
					variant="secondary"
					onClick={props.onImport}
					disabled={!session}
					data-testid="remotion-import"
				>
					Import…
				</Button>
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				{bundles.length === 0 ? (
					<EmptyState
						icon="panel.motionTemplates"
						message={query ? 'No compositions match.' : 'No Remotion projects in this project yet.'}
						detail={
							query
								? undefined
								: 'Import a Remotion 4.0.499 project folder (or a zip of a built bundle) to use its compositions as clips.'
						}
					/>
				) : (
					bundles.map((b) => (
						<section key={b.asset.id} className="mb-2" data-bundle-section={b.asset.id}>
							<header className="flex h-[24px] items-center gap-1 px-0.5 text-pr-ui text-pr-strong">
								<span className="truncate" title={b.asset.mgBundle!.source.path ?? b.asset.originalName}>
									{b.asset.mgBundle!.source.name || b.asset.originalName}
								</span>
								<span className="shrink-0 text-pr-small text-pr-dim">
									{b.asset.mgBundle!.compositions.length} compositions
								</span>
								{b.asset.mgBundle!.source.type === 'project-dir' && session?.engine ? (
									<button
										type="button"
										className="ml-auto rounded-pr-control px-1 text-pr-small text-pr-muted hover:bg-pr-hover hover:text-pr-text"
										onClick={() => {
											setMessage({ kind: 'info', text: `Rebuilding ${b.asset.mgBundle!.source.name}…` });
											rebuildBundle(session.engine!, b.asset, session.projectId).catch((e) =>
												setMessage({ kind: 'error', text: bundleErrorText(e) }),
											);
										}}
										data-testid="remotion-rebuild"
									>
										Rebuild
									</button>
								) : null}
							</header>
							<ul
								className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1"
								aria-label="Compositions"
							>
								{b.compositions.map((c) => (
									<CompositionCard
										key={c.id}
										asset={b.asset}
										comp={c}
										disabled={!canInsert}
										onInsert={() => insert(b.asset, c)}
									/>
								))}
							</ul>
						</section>
					))
				)}
			</div>
			<footer className="flex items-center gap-1 text-pr-small text-pr-dim">
				<Icon id="engine.remotion" size={12} />
				<span className="truncate">
					{message ? (
						<span className={message.kind === 'error' ? 'text-pr-danger' : 'text-pr-muted'}>
							{message.text}
						</span>
					) : !canInsert ? (
						'Open a sequence to insert compositions'
					) : (
						'Remotion 4.0.499 · double-click or drag to insert'
					)}
				</span>
			</footer>
		</div>
	);
}
