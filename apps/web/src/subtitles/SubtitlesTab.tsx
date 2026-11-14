// spec 13 AS-040 / AS-005 / AS-006 / AS-012 / AS-020: Text panel ▸ Subtitles — the sequence's subtitle groups (text
// clips made by Create Subtitles) with their actions (Align to Cuts, Regenerate, Apply Template, Save as Template,
// Convert to a caption track and back, Export SRT / VTT, Select, Rename, Delete) and a virtualised list of the
// group's subtitles (thousands of rows): click a time to go there, edit a text inline (the unchanged words keep their
// timing), lock or unlock a subtitle (a locked one — any edited by hand — is kept by Regenerate). Own Words… sets the
// words that always get a subtitle of their own and regenerates. Every change is one undoable transaction.
import {
	CAPTION_FORMAT_INFO,
	type CaptionFileFormat,
	type Clip,
	type CommandInput,
	captionCuesForGroup,
	captionGroupsOf,
	captionOf,
	findSubtitleTemplate,
	groupClips,
	MAX_OWN_WORDS,
	type ProjectDocument,
	type Sequence,
	supportsDropFrame,
	writeCaptionFileBytes,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useStoreSelector, useTransportFrame } from '@jasper/session/react';
import { Button, confirmDialog, EmptyState, IconButton, Select, toast } from '@jasper/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatTimecode } from '../gaps/time-display.ts';
import { t } from '../i18n/runtime.ts';
import { downloadBytes } from '../panels/text/state.ts';
import { availableTemplates, parseWordList } from './model.ts';
import { openApplyTemplate, openCreateSubtitles, openSaveTemplate } from './open.ts';
import { useSubtitleLibrary } from './store.ts';
import { templateIdName, templateName } from './templates.ts';

type TextClip = Extract<Clip, { kind: 'text' }>;
type Props = { session: EditorSession; seq: Sequence };

export const SUBTITLE_ROW_HEIGHT = 30;
/** Rows drawn above and below the visible window. */
const OVERSCAN = 8;

/** The rows of a virtualised list that are drawn for a scroll position: `[first, last)`. */
export function visibleRows(
	count: number,
	scrollTop: number,
	height: number,
	rowHeight = SUBTITLE_ROW_HEIGHT,
	overscan = OVERSCAN,
): [number, number] {
	if (count <= 0) return [0, 0];
	const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
	const last = Math.min(count, Math.ceil((scrollTop + Math.max(height, rowHeight)) / rowHeight) + overscan);
	return [first, Math.max(first, last)];
}

const EXPORT_FORMATS: CaptionFileFormat[] = ['srt', 'vtt', 'ttml', 'scc', 'stl'];

export function SubtitlesTab({ session, seq }: Props) {
	const doc = useStoreSelector(session.store, (s) => s.transient ?? s.document) as ProjectDocument;
	const readOnly = useStoreSelector(session.store, (s) => s.readOnly);
	const selection = useStoreSelector(session.store, (s) => s.selection.timeline);
	const library = useSubtitleLibrary();
	const groups = captionGroupsOf(seq);
	const ids = Object.keys(groups);
	const [active, setActive] = useState<string | null>(ids[0] ?? null);
	const groupId = active && groups[active] ? active : (ids[0] ?? null);
	const group = groupId ? groups[groupId]! : null;
	const clips = useMemo(() => (groupId ? (groupClips(seq, groupId) as TextClip[]) : []), [seq, groupId]);
	const templates = useMemo(() => availableTemplates(doc, library.templates), [doc, library.templates]);
	const [applyId, setApplyId] = useState<string>('builtin:pixel-pop');
	const [format, setFormat] = useState<CaptionFileFormat>('srt');
	const primary = selection.primaryClip ? seq.clips[selection.primaryClip] : undefined;

	// a newly created group becomes the shown one
	const known = useRef(new Set(ids));
	const idsKey = ids.join('|');
	useEffect(() => {
		const now = idsKey ? idsKey.split('|') : [];
		const fresh = now.find((id) => !known.current.has(id));
		known.current = new Set(now);
		if (fresh) setActive(fresh);
	}, [idsKey]);

	const apply = (label: string, commands: CommandInput[]) => {
		const r = session.apply({ label, origin: 'user', sequenceId: seq.id, commands });
		if (!r.ok) toast({ kind: 'warning', title: t('{0}: not possible', label), detail: r.errors[0]?.message });
		else for (const w of r.warnings.slice(0, 3)) toast({ kind: 'info', title: label, detail: w.message });
		return r;
	};

	const exportGroup = () => {
		if (!group) return;
		const cues = captionCuesForGroup(seq, group.id);
		const rate = seq.settings.frameRate;
		const bytes = writeCaptionFileBytes({ cues, blocks: [], warnings: [] }, format, {
			rate,
			dropFrame: supportsDropFrame(rate) ? seq.settings.dropFrame : true,
			language: group.language === 'und' ? 'en' : group.language,
		});
		const info = CAPTION_FORMAT_INFO[format];
		downloadBytes(bytes, `${group.name.replace(/[^\w.-]+/g, '_')}.${info.extension}`, info.mime);
	};

	const convertTracks = seq.captionTracks.filter((tr) =>
		Object.values(seq.clips).some((c) => c.trackId === tr.id && c.kind === 'captions'),
	);

	const header = (
		<div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-pr-border-subtle px-2 py-1">
			<Button
				variant="primary"
				disabled={readOnly}
				onClick={() => openCreateSubtitles(session, seq.id)}
				data-testid="subtitles.create"
			>
				Create Subtitles…
			</Button>
			{convertTracks.length ? (
				<Button
					disabled={readOnly}
					onClick={() =>
						apply('Convert Subtitles', [
							{ type: 'captions.convert', captionTrackId: convertTracks[0]!.id, to: 'text-clips' },
						])
					}
					title={t('Turn the captions of {0} into editable text clips', convertTracks[0]!.name ?? 'C1')}
					data-testid="subtitles.fromCaptions"
				>
					Captions to Text Clips
				</Button>
			) : null}
			{primary?.kind === 'text' ? (
				<Button
					disabled={readOnly}
					onClick={() => openSaveTemplate(session, primary.id)}
					data-testid="subtitles.saveTemplate"
				>
					Save as Template…
				</Button>
			) : null}
		</div>
	);

	if (!group)
		return (
			<div className="flex h-full min-h-0 flex-col" data-testid="text.subtitles">
				{header}
				<EmptyState
					icon="panel.text"
					message="No subtitles yet"
					detail="Create Subtitles makes editable text clips from the transcript, timed to the picture's cuts."
				/>
			</div>
		);

	return (
		<div className="flex h-full min-h-0 flex-col" data-testid="text.subtitles">
			{header}
			<div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-pr-border-subtle bg-pr-panel-alt px-2 py-1 text-pr-small">
				<Select
					label="Subtitle group"
					className="w-48"
					value={group.id}
					onValueChange={setActive}
					options={ids.map((id) => ({ value: id, label: groups[id]!.name }))}
				/>
				<span className="text-pr-muted" data-testid="subtitles.summary">
					{t(
						'{0} subtitles · {1} · {2}',
						clips.length,
						templateIdName(group.templateId, (id) => findSubtitleTemplate(doc, id)),
						group.language,
					)}
				</span>
				<span className="flex-1" />
				<Button
					disabled={readOnly}
					onClick={() =>
						apply('Align Subtitles to Cuts', [{ type: 'captions.alignToCuts', groupId: group.id }])
					}
					data-testid="subtitles.align"
				>
					Align to Cuts
				</Button>
				<Button
					disabled={readOnly}
					onClick={() => apply('Regenerate Subtitles', [{ type: 'captions.regenerate', groupId: group.id }])}
					title={t(
						'Make the subtitles again from the current transcript (locked subtitles, and clips that still match, keep their edits)',
					)}
					data-testid="subtitles.regenerate"
				>
					Regenerate
				</Button>
				<Button
					disabled={readOnly}
					onClick={() => {
						const typed = globalThis.prompt?.(
							t('Words that always get a subtitle of their own (comma-separated, e.g. boing)'),
							(group.rules.ownWords ?? []).join(', '),
						);
						if (typed === undefined || typed === null) return;
						const ownWords = parseWordList(typed).slice(0, MAX_OWN_WORDS);
						apply('Regenerate Subtitles', [
							{ type: 'captions.regenerate', groupId: group.id, rules: { ownWords } },
						]);
					}}
					title={t('Words that always get a subtitle of their own; the subtitles are regenerated')}
					data-testid="subtitles.ownWords"
				>
					{group.rules.ownWords?.length
						? t('Own Words ({0})…', group.rules.ownWords.length)
						: t('Own Words…')}
				</Button>
				<Button
					disabled={readOnly}
					onClick={() =>
						session.select(
							'timeline',
							clips.map((c) => c.id),
							'replace',
							{ linked: false },
						)
					}
					data-testid="subtitles.select"
				>
					Select
				</Button>
			</div>
			<div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-pr-border-subtle px-2 py-1 text-pr-small">
				<Select
					label="Template"
					className="w-44"
					value={applyId}
					onValueChange={setApplyId}
					options={templates.map((x) => ({ value: x.template.id, label: templateName(x.template) }))}
				/>
				<Button
					disabled={readOnly}
					onClick={() => openApplyTemplate(session, { groupId: group.id, templateId: applyId })}
					data-testid="subtitles.applyTemplate"
				>
					Apply Template…
				</Button>
				<span className="flex-1" />
				<Select
					label="Format"
					className="w-24"
					value={format}
					onValueChange={(v) => setFormat(v as CaptionFileFormat)}
					options={EXPORT_FORMATS.map((f) => ({ value: f, label: `.${CAPTION_FORMAT_INFO[f].extension}` }))}
				/>
				<Button onClick={exportGroup} data-testid="subtitles.export">
					Export
				</Button>
				<Button
					disabled={readOnly}
					onClick={() =>
						apply('Convert Subtitles', [{ type: 'captions.convert', groupId: group.id, to: 'caption-track' }])
					}
					title={t(
						'Turn the group into a caption track (subtitle streams and files; effects and animation are not kept)',
					)}
					data-testid="subtitles.toCaptions"
				>
					To Caption Track
				</Button>
				<Button
					disabled={readOnly}
					onClick={async () => {
						const name = globalThis.prompt?.(t('Subtitle group name'), group.name)?.trim();
						if (name)
							apply('Subtitle Group Settings', [{ type: 'captions.updateGroup', groupId: group.id, name }]);
					}}
					data-testid="subtitles.rename"
				>
					Rename…
				</Button>
				<Button
					variant="danger"
					disabled={readOnly}
					onClick={async () => {
						const ok = await confirmDialog({
							title: t('Delete the subtitle group "{0}"?', group.name),
							body: t('Its {0} subtitles are removed from the sequence. You can undo this.', clips.length),
							confirmLabel: 'Delete Subtitles',
						});
						if (ok) apply('Delete Subtitle Group', [{ type: 'captions.deleteGroup', groupId: group.id }]);
					}}
					data-testid="subtitles.delete"
				>
					Delete
				</Button>
			</div>
			<SubtitleList session={session} seq={seq} clips={clips} readOnly={readOnly} />
		</div>
	);
}

/** The group's subtitles, virtualised: only the rows in view (plus overscan) are in the DOM. */
export function SubtitleList(props: {
	session: EditorSession;
	seq: Sequence;
	clips: readonly TextClip[];
	readOnly: boolean;
}) {
	const { session, seq, clips } = props;
	const ref = useRef<HTMLDivElement>(null);
	const [view, setView] = useState({ top: 0, height: 400 });
	const playhead = useTransportFrame(66).frame;
	const rate = seq.settings.frameRate;
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const update = () => setView({ top: el.scrollTop, height: el.clientHeight || 400 });
		update();
		const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
		ro?.observe(el);
		return () => ro?.disconnect();
	}, []);
	const [first, last] = visibleRows(clips.length, view.top, view.height);
	const go = (c: TextClip) => {
		session.select('timeline', [c.id], 'replace', { primary: c.id, linked: false });
		session.transport.seek(c.start);
	};
	return (
		<div
			ref={ref}
			className="min-h-0 flex-1 overflow-auto"
			onScroll={(e) =>
				setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight || 400 })
			}
			data-testid="subtitles.list"
			data-rows={clips.length}
		>
			<div style={{ height: clips.length * SUBTITLE_ROW_HEIGHT, position: 'relative' }}>
				{clips.slice(first, last).map((c, k) => {
					const i = first + k;
					const current = playhead >= c.start && playhead < c.start + c.duration;
					return (
						<div
							key={c.id}
							className={`absolute inset-x-0 flex items-center gap-2 border-b border-pr-border-subtle px-2 text-pr-small ${current ? 'bg-pr-selected' : ''}`}
							style={{ top: i * SUBTITLE_ROW_HEIGHT, height: SUBTITLE_ROW_HEIGHT }}
							data-testid="subtitles.row"
							data-clip-id={c.id}
						>
							<button
								type="button"
								className="w-24 shrink-0 text-left font-pr-mono text-pr-muted hover:text-pr-text"
								onClick={() => go(c)}
								title={t('Go to this subtitle')}
							>
								{formatTimecode(c.start, rate)}
							</button>
							<RowText session={session} seq={seq} clip={c} readOnly={props.readOnly} />
							<RowLock session={session} seq={seq} clip={c} readOnly={props.readOnly} />
							<span className="w-8 shrink-0 text-right text-pr-dim" title={t('Words with timing')}>
								{captionOf(c)?.words.length ?? 0}
							</span>
						</div>
					);
				})}
			</div>
		</div>
	);
}

/** The lock of one subtitle: a locked subtitle (edited by hand, or locked here) is kept as it is by Regenerate. */
function RowLock(props: { session: EditorSession; seq: Sequence; clip: TextClip; readOnly: boolean }) {
	const locked = captionOf(props.clip)?.locked === true;
	const label = locked ? 'Unlock Subtitle' : 'Lock Subtitle';
	return (
		<IconButton
			size="small"
			icon={locked ? 'track.lock' : 'track.unlock'}
			label={
				locked
					? 'Locked: Regenerate keeps this subtitle. Click to unlock'
					: 'Lock: Regenerate keeps this subtitle'
			}
			toggled={locked ? 'on' : 'off'}
			disabledReason={props.readOnly ? 'The project is read-only' : undefined}
			onClick={() => {
				const r = props.session.apply({
					label,
					origin: 'user',
					sequenceId: props.seq.id,
					commands: [{ type: 'captions.lock', clipIds: [props.clip.id], locked: !locked }],
				});
				if (!r.ok)
					toast({ kind: 'warning', title: t('{0}: not possible', label), detail: r.errors[0]?.message });
			}}
			data-testid="subtitles.rowLock"
		/>
	);
}

function RowText(props: { session: EditorSession; seq: Sequence; clip: TextClip; readOnly: boolean }) {
	const { clip } = props;
	const [value, setValue] = useState(clip.content.text);
	useEffect(() => setValue(clip.content.text), [clip.content.text]);
	const commit = () => {
		if (value === clip.content.text) return;
		const r = props.session.apply({
			label: 'Edit Subtitle',
			origin: 'user',
			sequenceId: props.seq.id,
			commands: [{ type: 'clip.update', clipId: clip.id, patch: { content: { text: value } } }],
		});
		if (!r.ok) {
			toast({ kind: 'warning', title: t('Edit Subtitle: not possible'), detail: r.errors[0]?.message });
			setValue(clip.content.text);
		}
	};
	return (
		<textarea
			rows={1}
			spellCheck={false}
			className="h-[22px] min-w-0 flex-1 resize-none overflow-hidden rounded-pr-control border border-transparent bg-pr-field px-2 py-[2px] font-pr text-pr-ui leading-[16px] text-pr-text outline-none hover:border-pr-border-strong focus:border-pr-focus disabled:opacity-40"
			value={value}
			disabled={props.readOnly}
			onChange={(e) => setValue(e.currentTarget.value)}
			onBlur={commit}
			onKeyDown={(e) => {
				// Enter commits, Shift+Enter starts a new line of the subtitle
				if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault();
					commit();
				} else if (e.key === 'Escape') setValue(clip.content.text);
			}}
			aria-label="Subtitle text"
			data-testid="subtitles.rowText"
		/>
	);
}
