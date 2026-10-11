import type { Command, CommandOf } from '@jasper/project';
import {
	ALIGN_MODES,
	type AlignMode,
	buildItemsPayload,
	type Clip,
	GRAPHIC_TEMPLATE_EXTENSION,
	type GraphicRoll,
	type GraphicTemplate,
	GraphicTemplateSchema,
	graphicLayers,
	graphicSettingsOf,
	graphicTemplateOf,
	isGraphic,
	type LayerPins,
	PIN_EDGES,
	type PinEdge,
	type ProjectDocument,
	type Sequence,
} from '@jasper/project';
import type { EditorSession, SessionState } from '@jasper/session';
import { useSessionOrNull, useStoreSelector } from '@jasper/session/react';
import { Button, Checkbox, cx, EmptyState, Select, Tabs, TextField, toast } from '@jasper/ui';
import { type ReactNode, useMemo, useState, useSyncExternalStore } from 'react';
import { runCommand } from '../../commands/registry.ts';
import { useCommandCtx } from '../../shell/context.tsx';
import { EMPTY_SESSION_STORE } from '../session-store.ts';
import type { PanelProps } from '../types.ts';
import { type GraphicLibraryEntry, parseGraphicLibrary } from './library.ts';

const ALIGN_LABELS: Record<AlignMode, string> = {
	left: 'Align Left',
	center: 'Align Horizontal Center',
	right: 'Align Right',
	top: 'Align Top',
	middle: 'Align Vertical Center',
	bottom: 'Align Bottom',
	distributeHorizontal: 'Distribute Horizontally',
	distributeVertical: 'Distribute Vertically',
};
const EDGE_LABELS: Record<PinEdge, string> = { left: 'Left', top: 'Top', right: 'Right', bottom: 'Bottom' };

const LIB_KEY = 'jasper:graphic-templates';
let lib: GraphicLibraryEntry[] = readLib();
const libListeners = new Set<() => void>();
function readLib(): GraphicLibraryEntry[] {
	try {
		const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(LIB_KEY);
		return raw ? parseGraphicLibrary(JSON.parse(raw)) : [];
	} catch {
		return [];
	}
}
function writeLib(next: GraphicLibraryEntry[]): void {
	lib = next;
	try {
		localStorage.setItem(LIB_KEY, JSON.stringify(next));
	} catch {
		toast({
			kind: 'warning',
			title: 'My Templates',
			detail: 'The browser storage is full: export the template as a file instead.',
		});
	}
	for (const l of libListeners) l();
}
const useLib = () =>
	useSyncExternalStore(
		(l) => {
			libListeners.add(l);
			return () => libListeners.delete(l);
		},
		() => lib,
	);

function download(name: string, text: string): void {
	const blob = new Blob([text], { type: 'application/json' });
	const a = document.createElement('a');
	a.href = URL.createObjectURL(blob);
	a.download = name;
	a.click();
	setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

type Target = { graphic: Sequence; nestClipId: string | null; itemId: string | null } | null;

function targetOf(s: SessionState | null): Target {
	if (!s?.activeSequenceId) return null;
	const doc = s.document;
	const seq = doc.sequences[s.activeSequenceId];
	if (!seq) return null;
	const itemOf = (id: string) =>
		Object.values(doc.items).find((i) => i.kind === 'sequence' && i.sequenceId === id)?.id ?? null;
	for (const id of s.selection.timeline.clips) {
		const c = seq.clips[id];
		const g = c?.kind === 'nest-video' ? doc.sequences[c.sequenceId] : undefined;
		if (g && isGraphic(g)) return { graphic: g, nestClipId: c!.id, itemId: itemOf(g.id) };
	}
	if (isGraphic(seq)) return { graphic: seq, nestClipId: null, itemId: itemOf(seq.id) };
	return null;
}

function apply(session: EditorSession, label: string, commands: Command[], sequenceId?: string): boolean {
	const r = session.apply({
		label,
		origin: 'user',
		...(sequenceId ? { sequenceId } : {}),
		commands,
	});
	if (!r.ok) toast({ kind: 'error', title: label, detail: r.errors.map((e) => e.message).join('; ') });
	return r.ok;
}

/** New graphic at the playhead: a text layer nested into a graphic sequence on the lowest free track above V1. */
export function newGraphic(session: EditorSession, kind: 'text' | 'rectangle' | 'ellipse'): boolean {
	const s = session.getState();
	const seq = s.activeSequenceId ? s.document.sequences[s.activeSequenceId] : undefined;
	if (!seq) return false;
	const at = session.transport.getState().frame;
	const rate = seq.settings.frameRate;
	const dur = Math.round((5 * rate.num) / rate.den);
	const free = seq.videoTracks.find(
		(t, i) =>
			i > 0 &&
			!Object.values(seq.clips).some(
				(c) => c.trackId === t.id && c.start < at + dur && c.start + c.duration > at,
			),
	);
	const track = free?.id ?? null;
	const place = {
		at: { frames: at },
		duration: { frames: dur },
		track: track ?? seq.videoTracks[seq.videoTracks.length - 1]!.id,
	};
	const first: Command =
		kind === 'text'
			? { type: 'clip.addText', ...place, content: { text: 'New Text' }, ref: '$l' }
			: {
					type: 'clip.addShape',
					...place,
					shape: { type: kind === 'rectangle' ? 'rect' : 'ellipse', size: [400, 240] },
					ref: '$l',
				};
	const nestAt = track ? 1 : 2;
	const r = session.apply({
		label: 'New Graphic',
		origin: 'user',
		commands: [
			...(track ? [] : [{ type: 'track.add', kind: 'video' } satisfies Command]),
			...(track ? [first] : [{ ...first, track: `V${seq.videoTracks.length + 1}` }]),
			{ type: 'clip.nest', clipIds: ['$l'], name: 'Graphic', ref: '$g' },
			{ type: 'graphic.update', sequenceId: '$g', graphic: { intro: 0, outro: 0 } },
		],
		// The new nest clip becomes the selection, so the panel edits the new graphic right away.
		selectAfter: (res) => ({
			timeline: (res.results[nestAt] as { clipIds?: string[] } | undefined)?.clipIds ?? [],
		}),
	});
	if (!r.ok)
		toast({ kind: 'error', title: 'New Graphic', detail: r.errors.map((e) => e.message).join('; ') });
	return r.ok;
}

function Section(props: { title: string; children: ReactNode; testId?: string }) {
	return (
		<section
			className="flex flex-col gap-1.5 border-b border-pr-border-subtle px-2 py-2"
			data-testid={props.testId}
		>
			<h3 className="text-pr-small font-semibold text-pr-strong">{props.title}</h3>
			{props.children}
		</section>
	);
}

function FramesField(props: {
	label: string;
	value: number;
	onCommit(v: number): void;
	testId?: string;
	disabled?: boolean;
}) {
	const [text, setText] = useState(String(props.value));
	const [last, setLast] = useState(props.value);
	if (last !== props.value) {
		setLast(props.value);
		setText(String(props.value));
	}
	return (
		<div className="flex items-center justify-between gap-2 text-pr-small">
			<span>{props.label}</span>
			<TextField
				aria-label={props.label}
				className="w-20"
				type="number"
				min={0}
				disabled={props.disabled}
				value={text}
				onChange={(e) => setText(e.target.value)}
				onBlur={() => {
					const v = Math.max(0, Math.round(Number(text)));
					if (Number.isFinite(v) && v !== props.value) props.onCommit(v);
				}}
				onKeyDown={(e) => {
					if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
				}}
				data-testid={props.testId}
			/>
		</div>
	);
}

function EditTab({ session, target }: { session: EditorSession; target: Target }) {
	const [selected, setSelected] = useState<string[]>([]);
	const doc = useStoreSelector(session.store, (s: SessionState) => s.document);
	if (!target)
		return (
			<div className="flex flex-col gap-2 p-2" data-testid="eg-empty">
				<p className="text-pr-small text-pr-muted">
					Select a graphic clip, or make a new graphic at the playhead:
				</p>
				<div className="flex flex-wrap gap-1">
					<Button onClick={() => newGraphic(session, 'text')} data-testid="eg-new-text">
						New Layer ▸ Text
					</Button>
					<Button variant="secondary" onClick={() => newGraphic(session, 'rectangle')}>
						Rectangle
					</Button>
					<Button variant="secondary" onClick={() => newGraphic(session, 'ellipse')}>
						Ellipse
					</Button>
				</div>
			</div>
		);
	const g = doc.sequences[target.graphic.id] ?? target.graphic;
	const layers = graphicLayers(g);
	const sel = selected.filter((id) => g.clips[id]);
	const set = graphicSettingsOf(g) ?? { intro: 0, outro: 0, roll: null };
	const end = Math.max(1, ...Object.values(g.clips).map((c) => c.start + c.duration));
	const one = sel.length === 1 ? g.clips[sel[0]!] : undefined;
	const pins = (one as { pins?: LayerPins } | undefined)?.pins;
	const update = (graphic: CommandOf<'graphic.update'>['graphic'], label = 'Essential Graphics') =>
		apply(session, label, [{ type: 'graphic.update', sequenceId: g.id, graphic }]);
	const roll: GraphicRoll | null = set.roll ?? null;
	const setRoll = (patch: Partial<GraphicRoll> | null) =>
		update(
			{
				roll:
					patch === null
						? null
						: {
								mode: 'roll',
								startOffScreen: true,
								endOffScreen: true,
								preRoll: 0,
								easeIn: 0,
								easeOut: 0,
								postRoll: 0,
								...(roll ?? {}),
								...patch,
							},
			},
			'Roll / Crawl',
		);
	return (
		<div className="flex min-h-0 flex-col overflow-auto" data-testid="eg-edit">
			<Section title={`Graphic: ${nameOf(doc, target.itemId) ?? 'Graphic'}`}>
				<div
					className="flex flex-col rounded-pr-control border border-pr-border-subtle"
					role="listbox"
					aria-label="Layers"
					aria-multiselectable
				>
					{layers.map(({ clip }) => (
						<LayerRow
							key={clip.id}
							clip={clip}
							selected={sel.includes(clip.id)}
							onSelect={(add) =>
								setSelected((cur) =>
									add
										? cur.includes(clip.id)
											? cur.filter((x) => x !== clip.id)
											: [...cur, clip.id]
										: [clip.id],
								)
							}
							session={session}
							sequenceId={g.id}
						/>
					))}
				</div>
				<div className="flex flex-wrap gap-1">
					{(['text', 'rectangle', 'ellipse'] as const).map((k) => (
						<Button
							key={k}
							variant="secondary"
							onClick={() =>
								apply(session, 'New Layer', [{ type: 'graphic.addLayer', sequenceId: g.id, kind: k }])
							}
							data-testid={`eg-add-${k}`}
						>
							{k === 'text' ? 'New Text' : k === 'rectangle' ? 'Rectangle' : 'Ellipse'}
						</Button>
					))}
					<Button variant="quiet" onClick={() => session.openSequence(g.id)} data-testid="eg-open">
						Open Graphic
					</Button>
				</div>
			</Section>
			<Section title="Align and Transform" testId="eg-align">
				<div className="flex flex-wrap gap-1">
					{ALIGN_MODES.map((m) => (
						<Button
							key={m}
							variant="secondary"
							disabled={!sel.length || (m.startsWith('distribute') && sel.length < 3)}
							aria-label={ALIGN_LABELS[m]}
							title={ALIGN_LABELS[m]}
							onClick={() =>
								apply(session, ALIGN_LABELS[m], [
									{
										type: 'graphic.align',
										sequenceId: g.id,
										clipIds: sel,
										mode: m,
										relativeTo: sel.length === 1 ? 'frame' : 'selection',
									},
								])
							}
							data-testid={`eg-align-${m}`}
						>
							{ALIGN_LABELS[m].replace('Align ', '').replace('Distribute ', 'Dist. ')}
						</Button>
					))}
				</div>
				<p className="text-pr-small text-pr-dim">
					One layer aligns to the video frame; several to their selection.
				</p>
			</Section>
			{one ? (
				<Section title="Responsive Design – Position" testId="eg-pins">
					<Select
						label="Pin To"
						value={pins?.target ?? 'frame'}
						onValueChange={(v) =>
							apply(session, 'Responsive Design – Position', [
								{
									type: 'graphic.setPins',
									sequenceId: g.id,
									clipId: one.id,
									target: v,
									edges: Object.keys(pins?.edges ?? {}) as PinEdge[],
								},
							])
						}
						options={[
							{ value: 'frame', label: 'Video Frame' },
							...layers
								.filter((l) => l.clip.id !== one.id)
								.map((l) => ({ value: l.clip.id, label: l.clip.name || l.clip.id })),
						]}
					/>
					<div className="flex gap-2">
						{PIN_EDGES.map((e) => (
							<Checkbox
								key={e}
								label={EDGE_LABELS[e]}
								checked={pins?.edges[e] !== undefined}
								onCheckedChange={(c) => {
									const edges = new Set(Object.keys(pins?.edges ?? {}) as PinEdge[]);
									if (c) edges.add(e);
									else edges.delete(e);
									apply(session, 'Responsive Design – Position', [
										{
											type: 'graphic.setPins',
											sequenceId: g.id,
											clipId: one.id,
											target: pins?.target ?? 'frame',
											edges: [...edges],
										},
									]);
								}}
								data-testid={`eg-pin-${e}`}
							/>
						))}
					</div>
				</Section>
			) : (
				<>
					<Section title="Responsive Design – Time" testId="eg-time">
						<FramesField
							label="Intro Duration (frames)"
							value={set.intro}
							onCommit={(v) => update({ intro: v })}
							testId="eg-intro"
						/>
						<FramesField
							label="Outro Duration (frames)"
							value={set.outro}
							onCommit={(v) => update({ outro: v })}
							testId="eg-outro"
						/>
						<FramesField
							label="Graphic Duration (frames)"
							value={end}
							onCommit={(v) => update({ duration: Math.max(1, v) })}
							testId="eg-duration"
						/>
					</Section>
					<Section title="Roll / Crawl" testId="eg-roll">
						<Select
							label="Motion"
							value={roll?.mode ?? 'none'}
							onValueChange={(v) => setRoll(v === 'none' ? null : { mode: v as GraphicRoll['mode'] })}
							options={[
								{ value: 'none', label: 'Still' },
								{ value: 'roll', label: 'Roll' },
								{ value: 'crawlLeft', label: 'Crawl Left' },
								{ value: 'crawlRight', label: 'Crawl Right' },
							]}
						/>
						{roll ? (
							<>
								<Checkbox
									label="Start Off Screen"
									checked={roll.startOffScreen}
									onCheckedChange={(c) => setRoll({ startOffScreen: !!c })}
								/>
								<Checkbox
									label="End Off Screen"
									checked={roll.endOffScreen}
									onCheckedChange={(c) => setRoll({ endOffScreen: !!c })}
								/>
								<FramesField
									label="Pre-roll"
									value={roll.preRoll}
									onCommit={(v) => setRoll({ preRoll: v })}
								/>
								<FramesField label="Ease-in" value={roll.easeIn} onCommit={(v) => setRoll({ easeIn: v })} />
								<FramesField
									label="Ease-out"
									value={roll.easeOut}
									onCommit={(v) => setRoll({ easeOut: v })}
								/>
								<FramesField
									label="Post-roll"
									value={roll.postRoll}
									onCommit={(v) => setRoll({ postRoll: v })}
								/>
							</>
						) : null}
					</Section>
				</>
			)}
			<Section title="Template">
				<div className="flex flex-wrap gap-1">
					<Button
						variant="secondary"
						disabled={!target.itemId}
						onClick={() => {
							const t = templateOf(session.getCommitted(), target.itemId!);
							if (t) download(`${t.name}${GRAPHIC_TEMPLATE_EXTENSION}`, JSON.stringify(t));
						}}
						data-testid="eg-export"
					>
						Export As Template…
					</Button>
					<Button
						variant="secondary"
						disabled={!target.itemId}
						onClick={() => {
							const t = templateOf(session.getCommitted(), target.itemId!);
							if (!t) return;
							writeLib([...lib, { id: `tpl_${Date.now()}`, template: t, savedAt: new Date().toISOString() }]);
							toast({ kind: 'info', title: 'Saved to My Templates', detail: t.name });
						}}
						data-testid="eg-save-template"
					>
						Save to My Templates
					</Button>
				</div>
			</Section>
		</div>
	);
}

function nameOf(doc: ProjectDocument, itemId: string | null): string | null {
	return itemId ? (doc.items[itemId]?.name ?? null) : null;
}

function templateOf(doc: ProjectDocument, itemId: string): GraphicTemplate | null {
	return graphicTemplateOf(doc, itemId, nameOf(doc, itemId) ?? 'Graphic', (d, ids) =>
		buildItemsPayload(d, ids),
	);
}

function LayerRow(props: {
	clip: Clip;
	selected: boolean;
	onSelect(add: boolean): void;
	session: EditorSession;
	sequenceId: string;
}) {
	const { clip, session, sequenceId } = props;
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(clip.name);
	const kind = clip.kind === 'text' ? 'T' : clip.kind === 'shape' ? '■' : '▶';
	return (
		<div
			role="option"
			aria-selected={props.selected}
			tabIndex={0}
			className={cx(
				'flex items-center gap-2 px-2 py-1 text-pr-small',
				props.selected ? 'bg-pr-selected text-pr-strong' : 'hover:bg-pr-hover',
			)}
			onClick={(e) => props.onSelect(e.shiftKey || e.metaKey || e.ctrlKey)}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					props.onSelect(e.shiftKey);
				} else if (e.key === 'F2') {
					e.preventDefault();
					setEditing(true);
				}
			}}
			data-testid={`eg-layer-${clip.id}`}
		>
			<Checkbox
				aria-label={`Show ${clip.name}`}
				checked={clip.enabled}
				onCheckedChange={(c) =>
					apply(
						session,
						c ? 'Show Layer' : 'Hide Layer',
						[{ type: 'clip.update', clipId: clip.id, patch: { enabled: !!c } }],
						sequenceId,
					)
				}
			/>
			<span aria-hidden className="w-4 text-center text-pr-muted">
				{kind}
			</span>
			{editing ? (
				<TextField
					aria-label="Layer name"
					autoFocus
					value={name}
					onChange={(e) => setName(e.target.value)}
					onBlur={() => {
						setEditing(false);
						if (name.trim() && name !== clip.name)
							apply(
								session,
								'Rename Layer',
								[{ type: 'clip.update', clipId: clip.id, patch: { name: name.trim() } }],
								sequenceId,
							);
					}}
					onKeyDown={(e) => {
						if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
						if (e.key === 'Escape') {
							setName(clip.name);
							setEditing(false);
						}
					}}
				/>
			) : (
				// biome-ignore lint/a11y/noStaticElementInteractions: double-click renames; the keyboard path is F2 on the row
				<span className="min-w-0 flex-1 truncate" onDoubleClick={() => setEditing(true)}>
					{clip.name || clip.kind}
				</span>
			)}
			{'pins' in clip && clip.pins ? (
				<span className="text-pr-dim" title="Pinned (Responsive Design – Position)">
					⌖
				</span>
			) : null}
			<Button
				variant="quiet"
				aria-label={`Delete ${clip.name}`}
				onClick={(e) => {
					e.stopPropagation();
					apply(session, 'Delete Layer', [{ type: 'clip.lift', clipIds: [clip.id] }], sequenceId);
				}}
			>
				✕
			</Button>
		</div>
	);
}

function BrowseTab({ session }: { session: EditorSession }) {
	const entries = useLib();
	const commandCtx = useCommandCtx();
	const add = (t: GraphicTemplate) => {
		const s = session.getState();
		const seq = s.activeSequenceId ? s.document.sequences[s.activeSequenceId] : undefined;
		if (!seq) return toast({ kind: 'warning', title: 'Add Graphic', detail: 'Open a sequence first.' });
		const at = session.transport.getState().frame;
		const track = seq.videoTracks[Math.min(1, seq.videoTracks.length - 1)]!.id;
		apply(session, 'Add Graphic Template', [
			{ type: 'graphic.importTemplate', template: t, at: { frames: at }, track },
		]);
	};
	const importFile = async (file: File) => {
		try {
			const parsed = GraphicTemplateSchema.safeParse(JSON.parse(await file.text()));
			if (!parsed.success) throw new Error('not a Jasper Graphic Template (.jgt)');
			writeLib([
				...lib,
				{ id: `tpl_${Date.now()}`, template: parsed.data, savedAt: new Date().toISOString() },
			]);
			toast({ kind: 'info', title: 'Template imported', detail: parsed.data.name });
		} catch (e) {
			toast({
				kind: 'error',
				title: 'Import Template',
				detail: `${file.name}: ${(e as Error).message}${file.name.toLowerCase().endsWith('.mogrt') ? ' — MOGRT files are not supported (see Help).' : ''}`,
			});
		}
	};
	return (
		<div className="flex min-h-0 flex-col gap-2 overflow-auto p-2" data-testid="eg-browse">
			<div className="flex flex-wrap items-center gap-2">
				<label className="inline-flex cursor-pointer items-center rounded-pr-control border border-pr-border px-2 py-1 text-pr-small hover:bg-pr-hover">
					Import Template (.jgt)…
					<input
						type="file"
						accept=".jgt,application/json"
						className="sr-only"
						onChange={(e) => {
							const f = e.target.files?.[0];
							if (f) void importFile(f);
							e.target.value = '';
						}}
						data-testid="eg-import"
					/>
				</label>
				<Button variant="quiet" onClick={() => void runCommand('panel.open.motionTemplates', commandCtx())}>
					Motion Templates…
				</Button>
			</div>
			<h3 className="text-pr-small font-semibold text-pr-strong">My Templates</h3>
			{entries.length === 0 ? (
				<p className="text-pr-small text-pr-muted">
					No templates yet. Select a graphic and use Edit ▸ Save to My Templates, or import a .jgt file.
				</p>
			) : (
				<ul className="flex flex-col gap-1">
					{entries.map((e) => (
						<li
							key={e.id}
							className="flex items-center gap-2 rounded-pr-control border border-pr-border-subtle px-2 py-1 text-pr-small"
						>
							<span className="min-w-0 flex-1 truncate">
								{e.template.name}{' '}
								<span className="text-pr-dim">
									{e.template.frame.width}×{e.template.frame.height}
								</span>
							</span>
							<Button onClick={() => add(e.template)} data-testid={`eg-tpl-add-${e.id}`}>
								Add
							</Button>
							<Button
								variant="quiet"
								onClick={() =>
									download(`${e.template.name}${GRAPHIC_TEMPLATE_EXTENSION}`, JSON.stringify(e.template))
								}
							>
								Export
							</Button>
							<Button
								variant="quiet"
								aria-label={`Delete ${e.template.name}`}
								onClick={() => writeLib(lib.filter((x) => x.id !== e.id))}
							>
								✕
							</Button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

export function EssentialGraphicsPanel(_props: PanelProps) {
	const session = useSessionOrNull();
	const target = useStoreSelector(
		session?.store ?? EMPTY_SESSION_STORE,
		(s: SessionState | null) => targetOf(s),
		(a, b) => a?.graphic === b?.graphic && a?.nestClipId === b?.nestClipId && a?.itemId === b?.itemId,
	);
	const [tab, setTab] = useState<'browse' | 'edit'>('edit');
	const items = useMemo(
		() => [
			{ value: 'browse', label: 'Browse', content: session ? <BrowseTab session={session} /> : null },
			{
				value: 'edit',
				label: 'Edit',
				content: session ? <EditTab session={session} target={target} /> : null,
			},
		],
		[session, target],
	);
	if (!session)
		return <EmptyState icon="panel.essentialGraphics" message="Open a project to use Essential Graphics" />;
	return (
		<div className="flex h-full min-h-0 flex-col" data-testid="essential-graphics-panel">
			<Tabs
				items={items}
				value={tab}
				onValueChange={(v) => setTab(v as 'browse' | 'edit')}
				className="h-full"
			/>
		</div>
	);
}
