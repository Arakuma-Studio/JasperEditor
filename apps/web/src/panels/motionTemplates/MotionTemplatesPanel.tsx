// Motion Templates panel (S05 §16.14 MGT-001/002): a gallery of motion-graphic templates with search,
// category and engine filters, posters with an animated hover preview, and insert by double-click / Enter /
// drag onto the timeline. Templates come from @jasper/mg-templates: fframes templates (poster = the SVG twin at
// 50 %; the engine catalog tells whether the native renderer jasper-mg is ready for them) and, since M2, anime
// templates (S11:ATP-007: badge "R", label "anime · Remotion", poster = a Remotion <Thumbnail> at `posterAt`).
// Both kinds get the shared hover <Player> (PreviewThumb) over `MgTemplatePreview` from @jasper/compositions.
import type { MgTemplateCatalogEntry } from '@jasper/api';
import { MgTemplatePreview } from '@jasper/compositions';
import {
	type AnyMgTemplate,
	type AnySvgMgTemplate,
	isAnimeTemplate,
	isSvgTemplate,
	mgRegistry,
} from '@jasper/mg-templates';
import type { SessionState } from '@jasper/session';
import { useSessionOrNull, useStoreSelector } from '@jasper/session/react';
import { cx, Icon, openDialog, Tabs } from '@jasper/ui';
import { useEffect, useMemo, useState } from 'react';
import { MG_IMPORT_DIALOG } from '../../mg-bundles/ImportDialog.tsx';
import { useEngine } from '../../state/engine.tsx';
import { TextAnimationsTab } from '../../text-animation/TextAnimationsTab.tsx';
import type { PanelProps } from '../types.ts';
import { insertMotionTemplate, type MgTemplateRef, writeMgTemplateDrag } from './insert.ts';
import { PreviewThumb } from './PreviewThumb.tsx';
import { RemotionTab } from './RemotionTab.tsx';

/** Engine filter of the Templates tab (S11:ATP-007 adds `anime`). */
type EngineFilter = 'all' | 'fframes' | 'anime';

type GalleryEntry = {
	ref: MgTemplateRef;
	name: string;
	category: string;
	description: string;
	engine: 'fframes' | 'anime';
	/** "fframes" / "anime · Remotion" (S11:ATP-007). */
	engineLabel: string;
	/** fframes: rendered natively by jasper-mg (false: preview/export through the TS twin + Remotion). Anime: false. */
	native: boolean;
	durationSeconds: number;
	aspects: string[];
	def: AnyMgTemplate;
};

/** Frame rate of the gallery previews. */
const PREVIEW_FPS = 30;
/** Composition size of the gallery previews (16:9; templates fit their design canvas into it). */
const PREVIEW_SIZE = { width: 640, height: 360 } as const;

const NO_SESSION_STORE = { getState: (): SessionState | null => null, subscribe: () => () => {} };

const ASPECTS: Record<string, string> = { '1920x1080': '16:9', '1080x1920': '9:16', '1080x1080': '1:1' };

/** Merges the TS catalog with the engine's native flags for fframes templates. */
function galleryEntries(engineTemplates: MgTemplateCatalogEntry[] | null): GalleryEntry[] {
	return mgRegistry.definitions().map((def) => {
		const remote = engineTemplates?.find((t) => t.id === def.id && t.version === def.version);
		const anime = isAnimeTemplate(def);
		return {
			ref: { id: def.id, version: def.version },
			name: def.name,
			category: def.category,
			description: def.description ?? '',
			engine: anime ? 'anime' : 'fframes',
			engineLabel: anime ? 'anime · Remotion' : 'fframes',
			native: !anime && remote?.native === true,
			durationSeconds: def.defaultDurationSeconds,
			aspects: def.canvases.map((c) => ASPECTS[`${c.width}x${c.height}`] ?? `${c.width}x${c.height}`),
			def,
		};
	});
}

/** Poster frame of a template at the preview rate: `posterAt` (anime) or the middle of its default length. */
function posterFrameOf(def: AnyMgTemplate, fps = PREVIEW_FPS): number {
	const duration = Math.max(1, Math.round(def.defaultDurationSeconds * fps));
	const at =
		isAnimeTemplate(def) && def.posterAt !== undefined ? def.posterAt : def.defaultDurationSeconds / 2;
	return Math.min(duration - 1, Math.max(0, Math.round(at * fps)));
}

function filterEntries(
	entries: GalleryEntry[],
	f: { query: string; category: string | null; engine: EngineFilter },
): GalleryEntry[] {
	const q = f.query.trim().toLowerCase();
	return entries.filter(
		(e) =>
			(f.engine === 'all' || e.engine === f.engine) &&
			(!f.category || e.category === f.category) &&
			(!q ||
				`${e.name} ${e.category} ${e.description} ${e.ref.id} ${e.engineLabel}`.toLowerCase().includes(q)),
	);
}

/** Static preview: the twin at 50 % of the default duration, 16:9 canvas. */
function previewSvg(def: AnySvgMgTemplate): string {
	const fps = 30;
	const duration = Math.max(1, Math.round(def.defaultDurationSeconds * fps));
	return def.renderSvg(
		def.defaults,
		Math.floor(duration / 2),
		fps,
		{ width: 1920, height: 1080 },
		{
			durationFrames: duration,
			idPrefix: `mgt-${def.id}-${def.version}`,
		},
	);
}

function useEngineCatalog(): { templates: MgTemplateCatalogEntry[] | null; renderer: string } {
	const { client, status } = useEngine();
	const [state, setState] = useState<{ templates: MgTemplateCatalogEntry[] | null; renderer: string }>({
		templates: null,
		renderer: 'unknown',
	});
	useEffect(() => {
		if (status !== 'connected') return;
		let cancelled = false;
		client
			.mgTemplates()
			.then((r) => {
				if (!cancelled)
					setState({
						templates: r.templates,
						renderer:
							r.renderer.status === 'ready'
								? 'ready'
								: `unavailable${r.renderer.reason ? `: ${r.renderer.reason}` : ''}`,
					});
			})
			.catch(() => {
				if (!cancelled) setState({ templates: null, renderer: 'unavailable: engine catalog not reachable' });
			});
		return () => {
			cancelled = true;
		};
	}, [client, status]);
	return state;
}

/** The engine badge of a card: "F" (fframes; "F*" without the native renderer) or "R" (anime · Remotion). */
function EngineBadge({ entry }: { entry: GalleryEntry }) {
	if (entry.engine === 'anime')
		return (
			<span
				data-engine-badge="R"
				className="absolute top-1 right-1 rounded-pr-pill bg-pr-engine-anime px-1 text-pr-small text-pr-on-accent"
				title="anime · Remotion (preview and export through Remotion; native exports bake it)"
			>
				R
			</span>
		);
	return (
		<span
			data-engine-badge="F"
			className="absolute top-1 right-1 rounded-pr-pill bg-pr-engine-fframes px-1 text-pr-small text-pr-on-accent"
			title={
				entry.native
					? 'fframes · native renderer ready'
					: 'fframes · SVG preview (native renderer unavailable)'
			}
		>
			F{entry.native ? '' : '*'}
		</span>
	);
}

function TemplateCard({
	entry,
	svg,
	onInsert,
	disabled,
}: {
	entry: GalleryEntry;
	/** fframes poster (the SVG twin); null for anime templates (Remotion <Thumbnail> poster). */
	svg: string | null;
	onInsert(): void;
	disabled: boolean;
}) {
	return (
		<li
			// biome-ignore lint/a11y/noNoninteractiveTabindex: grid cells are focusable (Enter inserts)
			tabIndex={0}
			draggable
			data-template={`${entry.ref.id}@${entry.ref.version}`}
			aria-label={`${entry.name} (${entry.category})`}
			title={`${entry.name} — ${entry.description}\nDouble-click or drag to the timeline to insert`}
			className={cx(
				'group flex cursor-pointer flex-col gap-1 rounded-pr-control border border-pr-border-subtle bg-pr-panel-alt p-1 outline-none',
				'hover:border-pr-border-strong focus-visible:border-pr-focus',
			)}
			onDoubleClick={() => !disabled && onInsert()}
			onKeyDown={(e) => {
				if (e.key === 'Enter' && !disabled) {
					e.preventDefault();
					onInsert();
				}
			}}
			onDragStart={(e) => writeMgTemplateDrag(e.dataTransfer, entry.ref)}
		>
			<div
				className="relative aspect-video w-full overflow-hidden rounded-pr-control bg-pr-field-deep"
				data-mg-preview={entry.engine}
			>
				<PreviewThumb
					component={MgTemplatePreview}
					inputProps={{ templateId: entry.ref.id, version: entry.ref.version }}
					durationInFrames={Math.max(1, Math.round(entry.durationSeconds * PREVIEW_FPS))}
					fps={PREVIEW_FPS}
					width={PREVIEW_SIZE.width}
					height={PREVIEW_SIZE.height}
					posterFrame={posterFrameOf(entry.def)}
					label={`${entry.name} preview`}
					className="absolute inset-0"
					poster={
						svg === null ? undefined : (
							<div
								className="absolute inset-0 [&>svg]:h-full [&>svg]:w-full"
								// Twin output: params are XML-escaped by @jasper/mg-templates.
								// biome-ignore lint/security/noDangerouslySetInnerHtml: trusted, escaped template output
								dangerouslySetInnerHTML={{ __html: svg }}
							/>
						)
					}
				/>
				<EngineBadge entry={entry} />
			</div>
			<div className="flex items-baseline justify-between gap-1 px-0.5">
				<span className="truncate text-pr-ui text-pr-text">{entry.name}</span>
				<span className="shrink-0 text-pr-small text-pr-dim">{entry.durationSeconds.toFixed(1)} s</span>
			</div>
			<div className="flex gap-1 px-0.5 text-pr-small text-pr-muted">
				<span className="truncate">{entry.category}</span>
				<span className="ml-auto shrink-0">{entry.aspects.join(' · ')}</span>
			</div>
			<div className="truncate px-0.5 text-pr-small text-pr-dim" data-engine-label={entry.engine}>
				{entry.engineLabel}
			</div>
		</li>
	);
}

type MotionTemplatesTab = 'templates' | 'textAnimations' | 'remotion';
const TABS: readonly MotionTemplatesTab[] = ['templates', 'textAnimations', 'remotion'];

/** Last tab used (per browser), so the chosen tab stays open across reloads. */
function initialTab(): MotionTemplatesTab {
	try {
		const t = globalThis.localStorage?.getItem('jasper.motionTemplates.tab');
		return TABS.includes(t as MotionTemplatesTab) ? (t as MotionTemplatesTab) : 'templates';
	} catch {
		return 'templates';
	}
}

export function MotionTemplatesPanel(props: PanelProps) {
	const session = useSessionOrNull();
	const hasSequence = useStoreSelector(
		session?.store ?? NO_SESSION_STORE,
		(s: SessionState | null) => !!s?.activeSequenceId,
	);
	const catalog = useEngineCatalog();
	const [query, setQuery] = useState('');
	const [category, setCategory] = useState<string | null>(null);
	const [engine, setEngine] = useState<EngineFilter>('all');
	const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
	const [tab, setTab] = useState<MotionTemplatesTab>(() => initialTab());
	const { client } = useEngine();
	const entries = useMemo(() => galleryEntries(catalog.templates), [catalog.templates]);
	const previews = useMemo(
		() => new Map(entries.map((e) => [e.def, isSvgTemplate(e.def) ? previewSvg(e.def) : null])),
		[entries],
	);
	const categories = useMemo(() => [...new Set(entries.map((e) => e.category))].sort(), [entries]);
	const visible = filterEntries(entries, { query, category, engine });
	const canInsert = !!session && hasSequence;

	const insert = (entry: GalleryEntry) => {
		if (!session) return;
		try {
			insertMotionTemplate(session, entry.ref);
			setMessage({ kind: 'info', text: `Added ${entry.name} at the playhead` });
		} catch (e) {
			setMessage({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
		}
	};

	const templates = (
		<div className="flex h-full min-h-0 flex-col gap-1 p-1 text-pr-ui text-pr-text">
			<div className="flex items-center gap-1">
				<label className="flex min-w-0 flex-1 items-center gap-1 rounded-pr-control bg-pr-field px-1">
					<Icon id="app.search" size={14} />
					<input
						type="search"
						aria-label="Search templates"
						placeholder="Search templates"
						className="min-w-0 flex-1 bg-transparent py-0.5 text-pr-ui text-pr-text outline-none placeholder:text-pr-dim"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
				</label>
				<select
					aria-label="Engine"
					data-testid="motion-templates-engine"
					className="rounded-pr-control bg-pr-field px-1 py-0.5 text-pr-ui text-pr-text"
					value={engine}
					onChange={(e) => setEngine(e.target.value as EngineFilter)}
				>
					<option value="all">All engines</option>
					<option value="fframes">fframes</option>
					<option value="anime">anime · Remotion</option>
				</select>
			</div>
			<div className="flex flex-wrap gap-1" role="toolbar" aria-label="Categories">
				{[null, ...categories].map((c) => (
					<button
						key={c ?? 'all'}
						aria-pressed={category === c}
						className={cx(
							'rounded-pr-pill border px-1.5 text-pr-small',
							category === c
								? 'border-pr-accent bg-pr-accent-fill text-pr-on-accent'
								: 'border-pr-border-subtle text-pr-muted hover:text-pr-text',
						)}
						onClick={() => setCategory(c)}
					>
						{c ?? 'All'}
					</button>
				))}
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				{visible.length === 0 ? (
					<p className="p-2 text-center text-pr-small text-pr-muted">No templates match.</p>
				) : (
					<ul
						className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1"
						aria-label="Motion templates"
					>
						{visible.map((e) => (
							<TemplateCard
								key={`${e.ref.id}@${e.ref.version}`}
								entry={e}
								svg={previews.get(e.def) ?? null}
								disabled={!canInsert}
								onInsert={() => insert(e)}
							/>
						))}
					</ul>
				)}
			</div>
			<footer
				className="flex items-center gap-1 text-pr-small text-pr-dim"
				data-mg-renderer={catalog.renderer}
			>
				<Icon id="engine.fframes" size={12} />
				<span className="truncate">
					{message ? (
						<span className={message.kind === 'error' ? 'text-pr-danger' : 'text-pr-muted'}>
							{message.text}
						</span>
					) : !canInsert ? (
						'Open a sequence to insert templates'
					) : catalog.renderer === 'ready' ? (
						'Native renderer ready · double-click or drag to insert'
					) : (
						`SVG preview only (${catalog.renderer}) · double-click or drag to insert`
					)}
				</span>
			</footer>
		</div>
	);
	return (
		<div
			className="flex h-full min-h-0 flex-col text-pr-ui text-pr-text"
			data-panel-kind="motionTemplates"
			data-instance-id={props.instanceId}
		>
			<Tabs
				className="h-full"
				value={tab}
				onValueChange={(v) => {
					setTab(v as MotionTemplatesTab);
					try {
						globalThis.localStorage?.setItem('jasper.motionTemplates.tab', v);
					} catch {
						// storage unavailable
					}
				}}
				items={[
					{ value: 'templates', label: 'Templates', content: templates },
					// M2 (S11:TXA-020, wp-m2-text-anim)
					{ value: 'textAnimations', label: 'Text Animations', content: <TextAnimationsTab /> },
					{
						value: 'remotion',
						label: 'Remotion',
						content: (
							<RemotionTab
								session={session}
								onImport={() => void openDialog(MG_IMPORT_DIALOG, { session, engine: client })}
							/>
						),
					},
				]}
			/>
		</div>
	);
}
