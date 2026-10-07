// wp captions: Text panel ▸ Captions — the captions of the active caption track (Premiere's caption list): editable
// in/out timecodes and text (committed on blur / Ctrl+Enter), search and replace, jump to a caption, add / split /
// merge / delete, import and export in every supported format, and the track style strip (preset, font size,
// colours, background box, outline, alignment, position). Every change is one undoable document transaction.
import {
	activeCaptionTrack,
	BUILTIN_CAPTION_PRESETS,
	CAPTION_FILE_FORMATS,
	CAPTION_FORMAT_INFO,
	type CaptionFileFormat,
	type CaptionStyle,
	type CaptionsClip,
	captionClipSpeaker,
	captionClipsOf,
	captionClipText,
	captionCuesForTrack,
	type ProjectDocument,
	resolveCaptionStyle,
	type Sequence,
	supportsDropFrame,
	writeCaptionFileBytes,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useStoreSelector, useTransportFrame } from '@jasper/session/react';
import {
	Button,
	ColorSwatch,
	EmptyState,
	SearchField,
	Select,
	TextField,
	TimecodeField,
	toast,
} from '@jasper/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { bytesToBase64, downloadBytes } from './state.ts';

type Props = { session: EditorSession; seq: Sequence; reveal?: string };

const IMPORT_ACCEPT = `${CAPTION_FILE_FORMATS.map((f) => `.${CAPTION_FORMAT_INFO[f].extension}`).join(',')},.xml`;

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function CaptionsTab({ session, seq, reveal }: Props) {
	const doc = useStoreSelector(session.store, (s) => s.transient ?? s.document) as ProjectDocument;
	const selection = useStoreSelector(session.store, (s) => s.selection.timeline.clips);
	const playhead = useTransportFrame(66).frame;
	const [query, setQuery] = useState('');
	const [replacement, setReplacement] = useState('');
	const [exportFormat, setExportFormat] = useState<CaptionFileFormat>('srt');
	const fileRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const track = activeCaptionTrack(seq);
	const rate = seq.settings.frameRate;
	const tcOpts = { dropFrame: seq.settings.dropFrame, startFrames: seq.settings.startTimecodeFrames };

	const apply = (label: string, commands: unknown[]) => {
		const r = session.apply({ label, origin: 'user', sequenceId: seq.id, commands: commands as never[] });
		if (!r.ok) toast({ kind: 'warning', title: `${label}: not possible`, detail: r.errors[0]?.message });
		return r;
	};

	const clips = useMemo(() => (track ? captionClipsOf(seq, track.id) : []), [seq, track]);
	const rows = useMemo(
		() =>
			clips.map((c) => ({
				clip: c,
				text: captionClipText(doc, c, rate),
				speaker: captionClipSpeaker(doc, c, rate),
			})),
		[clips, doc, rate],
	);
	const q = query.trim().toLowerCase();
	const shown = q ? rows.filter((r) => r.text.toLowerCase().includes(q)) : rows;
	const selected = new Set(selection);
	const current = clips.find((c) => c.start <= playhead && playhead < c.start + c.duration)?.id ?? null;

	useEffect(() => {
		if (!reveal) return;
		listRef.current
			?.querySelector(`[data-testid="text.captions.${reveal}.row"]`)
			?.scrollIntoView({ block: 'nearest' });
	}, [reveal]);

	if (!seq.captionTracks.length)
		return (
			<EmptyState
				icon="panel.text"
				message="This sequence has no captions"
				detail="Add a caption track, import a caption file, or create captions from the transcript."
				action={{
					label: 'Add Caption Track',
					onClick: () => apply('Add Caption Track', [{ type: 'caption.addTrack' }]),
				}}
			/>
		);

	const font = Object.values(doc.fonts)[0]?.id ?? '';
	const style = resolveCaptionStyle(track?.styleDefaults, null, font, seq.settings.height);
	const setStyle = (patch: Partial<CaptionStyle>) =>
		track && apply('Caption Style', [{ type: 'caption.setStyle', trackId: track.id, style: patch }]);
	const presets = [...BUILTIN_CAPTION_PRESETS, ...(doc.settings.captionStylePresets ?? [])];
	const go = (c: CaptionsClip) => {
		session.select('timeline', [c.id], 'replace', { primary: c.id });
		session.transport.seek(c.start);
	};
	const selectedCaptions = clips.filter((c) => selected.has(c.id)).map((c) => c.id);

	const importFile = async (file: File) => {
		const bytes = new Uint8Array(await file.arrayBuffer());
		apply('Import Captions', [
			{ type: 'caption.import', contentBase64: bytesToBase64(bytes), fileName: file.name },
		]);
	};
	const exportFile = () => {
		if (!track) return;
		const cues = captionCuesForTrack(doc, seq, track.id);
		const bytes = writeCaptionFileBytes(
			{ cues, blocks: [...(track.vttBlocks ?? [])], warnings: [] },
			exportFormat,
			{
				rate,
				dropFrame: supportsDropFrame(rate) ? seq.settings.dropFrame : true,
				language: track.language ?? 'en',
			},
		);
		const name = `${(track.name ?? 'captions').replace(/[^\w.-]+/g, '_')}.${CAPTION_FORMAT_INFO[exportFormat].extension}`;
		downloadBytes(bytes, name, CAPTION_FORMAT_INFO[exportFormat].mime);
	};
	const replaceAll = () => {
		if (!q) return;
		const re = new RegExp(escapeRe(query.trim()), 'gi');
		const commands = rows
			.filter((r) => r.text.toLowerCase().includes(q))
			.map((r) => ({ type: 'caption.setText', clipId: r.clip.id, text: r.text.replace(re, replacement) }));
		if (commands.length) apply('Replace in Captions', commands);
	};

	return (
		<div className="flex h-full min-h-0 flex-col" data-testid="text-captions">
			{/* track + actions */}
			<div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-pr-border-subtle px-2 py-1">
				<Select
					label="Caption track"
					className="w-40"
					value={track?.id ?? ''}
					onValueChange={(id) =>
						apply('Active Caption Track', [{ type: 'caption.setActiveTrack', trackId: id }])
					}
					options={seq.captionTracks.map((t, i) => ({
						value: t.id,
						label: `C${i + 1} · ${t.name ?? `Subtitles C${i + 1}`}${t.language ? ` (${t.language})` : ''}`,
					}))}
					id="text-captions-track"
				/>
				<Button
					variant="quiet"
					onClick={() => apply('Add Caption Track', [{ type: 'caption.addTrack' }])}
					data-testid="text.captions.newTrack"
				>
					New Track
				</Button>
				<TextField
					aria-label="Track language"
					placeholder="Language"
					className="w-16"
					defaultValue={track?.language ?? ''}
					key={`lang-${track?.id}`}
					onBlur={(e) => {
						const v = e.currentTarget.value.trim();
						if (track && v !== (track.language ?? ''))
							apply('Caption Language', [
								{ type: 'track.update', trackId: track.id, patch: { language: v } },
							]);
					}}
					data-testid="text.captions.language"
				/>
				<span className="flex-1" />
				<Button
					variant="quiet"
					onClick={() =>
						track && apply('Add Caption', [{ type: 'caption.add', track: track.id, at: playhead, text: '' }])
					}
					disabled={!track || !!current}
					disabledReason="A caption already covers the playhead"
					data-testid="text.captions.add"
				>
					Add
				</Button>
				<Button
					variant="quiet"
					onClick={() =>
						apply('Split Caption', [
							{
								type: 'caption.split',
								at: playhead,
								...(selectedCaptions.length ? { clipIds: selectedCaptions } : {}),
							},
						])
					}
					disabled={!current}
					disabledReason="No caption under the playhead"
					data-testid="text.captions.split"
				>
					Split
				</Button>
				<Button
					variant="quiet"
					onClick={() => apply('Merge Captions', [{ type: 'caption.merge', clipIds: selectedCaptions }])}
					disabled={selectedCaptions.length < 2}
					disabledReason="Select two or more consecutive captions"
					data-testid="text.captions.merge"
				>
					Merge
				</Button>
				<Button
					variant="quiet"
					onClick={() => apply('Delete Captions', [{ type: 'caption.delete', clipIds: selectedCaptions }])}
					disabled={!selectedCaptions.length}
					disabledReason="Select captions first"
					data-testid="text.captions.delete"
				>
					Delete
				</Button>
				<Button variant="quiet" onClick={() => fileRef.current?.click()} data-testid="text.captions.import">
					Import…
				</Button>
				<input
					ref={fileRef}
					type="file"
					accept={IMPORT_ACCEPT}
					className="hidden"
					data-testid="text.captions.importFile"
					onChange={(e) => {
						const f = e.currentTarget.files?.[0];
						e.currentTarget.value = '';
						if (f) void importFile(f);
					}}
				/>
				<Select
					label="Export format"
					className="w-24"
					value={exportFormat}
					onValueChange={(v) => setExportFormat(v as CaptionFileFormat)}
					options={CAPTION_FILE_FORMATS.map((f) => ({
						value: f,
						label: CAPTION_FORMAT_INFO[f].extension.toUpperCase(),
					}))}
				/>
				<Button
					variant="quiet"
					onClick={exportFile}
					disabled={!rows.length}
					data-testid="text.captions.export"
				>
					Export
				</Button>
			</div>
			{/* search / replace */}
			<div className="flex shrink-0 items-center gap-1 border-b border-pr-border-subtle px-2 py-1">
				<SearchField
					value={query}
					onValueChange={setQuery}
					placeholder="Search captions"
					aria-label="Search captions"
					className="flex-1"
					data-testid="text.captions.search"
				/>
				<TextField
					value={replacement}
					onChange={(e) => setReplacement(e.currentTarget.value)}
					placeholder="Replace with"
					aria-label="Replace with"
					className="w-28"
					data-testid="text.captions.replace"
				/>
				<Button
					variant="quiet"
					onClick={replaceAll}
					disabled={!q || !shown.length}
					data-testid="text.captions.replaceAll"
				>
					Replace All
				</Button>
				<span className="pr-tabular text-pr-small text-pr-muted" data-testid="text.captions.count">
					{q ? `${shown.length}/${rows.length}` : rows.length}
				</span>
			</div>
			{/* style strip (track style) */}
			<div
				className="flex shrink-0 flex-wrap items-center gap-1 border-b border-pr-border-subtle px-2 py-1 text-pr-small text-pr-muted"
				data-testid="text.captions.style"
			>
				<Select
					label="Track style preset"
					className="w-32"
					value=""
					placeholder="Track Style…"
					onValueChange={(id) =>
						track &&
						apply('Apply Caption Style', [{ type: 'caption.applyPreset', presetId: id, trackId: track.id }])
					}
					options={presets.map((p) => ({ value: p.id, label: p.name }))}
				/>
				<Button
					variant="quiet"
					onClick={() => {
						const name = window.prompt('Save track style as', track?.name ?? 'Caption style');
						if (name && track)
							apply('Save Caption Style', [{ type: 'caption.savePreset', name, trackId: track.id }]);
					}}
					data-testid="text.captions.style.save"
				>
					Save Style…
				</Button>
				<span className="flex items-center gap-1">
					Size
					<TextField
						aria-label="Font size"
						type="number"
						min={4}
						max={400}
						className="w-14"
						key={`size-${track?.id}-${style.sizePx}`}
						defaultValue={Math.round(style.sizePx)}
						onBlur={(e) => {
							const v = Number(e.currentTarget.value);
							if (Number.isFinite(v) && v >= 4 && v !== style.sizePx) setStyle({ sizePx: v });
						}}
						data-testid="text.captions.style.size"
					/>
				</span>
				<ColorSwatch
					label="Text color"
					value={[...style.fill] as [number, number, number, number]}
					onChange={(c, ch) => ch.final && setStyle({ fill: c })}
				/>
				<label className="flex items-center gap-1">
					<input
						type="checkbox"
						checked={!!style.background}
						onChange={(e) =>
							setStyle({
								background: e.currentTarget.checked
									? { color: [0, 0, 0, 0.6], paddingPx: Math.round(style.sizePx / 4), radiusPx: 0 }
									: null,
							})
						}
						data-testid="text.captions.style.box"
					/>
					Box
				</label>
				{style.background ? (
					<ColorSwatch
						label="Box color"
						value={[...style.background.color] as [number, number, number, number]}
						onChange={(c, ch) =>
							ch.final && style.background && setStyle({ background: { ...style.background, color: c } })
						}
					/>
				) : null}
				<span className="flex items-center gap-1">
					Outline
					<TextField
						aria-label="Outline width"
						type="number"
						min={0}
						max={40}
						className="w-12"
						key={`outline-${track?.id}-${style.strokes[0]?.widthPx ?? 0}`}
						defaultValue={style.strokes[0]?.widthPx ?? 0}
						onBlur={(e) => {
							const w = Number(e.currentTarget.value);
							if (!Number.isFinite(w) || w === (style.strokes[0]?.widthPx ?? 0)) return;
							setStyle({
								strokes:
									w > 0
										? [{ color: style.strokes[0]?.color ?? [0, 0, 0, 1], widthPx: w, position: 'outside' }]
										: [],
							});
						}}
						data-testid="text.captions.style.outline"
					/>
				</span>
				<Select
					label="Alignment"
					className="w-20"
					value={style.align === 'justify' ? 'center' : style.align}
					onValueChange={(v) => setStyle({ align: v as CaptionStyle['align'] })}
					options={[
						{ value: 'left', label: 'Left' },
						{ value: 'center', label: 'Center' },
						{ value: 'right', label: 'Right' },
					]}
				/>
				<Select
					label="Position"
					className="w-20"
					value={style.placement}
					onValueChange={(v) => setStyle({ placement: v as 'bottom' | 'middle' | 'top' })}
					options={[
						{ value: 'bottom', label: 'Bottom' },
						{ value: 'middle', label: 'Middle' },
						{ value: 'top', label: 'Top' },
					]}
				/>
				<Select
					label="Highlight"
					className="w-24"
					value={style.highlight.mode}
					onValueChange={(v) =>
						setStyle({ highlight: { ...style.highlight, mode: v as 'none' | 'word' | 'karaoke' } })
					}
					options={[
						{ value: 'none', label: 'No highlight' },
						{ value: 'word', label: 'Active word' },
						{ value: 'karaoke', label: 'Karaoke' },
					]}
				/>
			</div>
			{/* list */}
			<div ref={listRef} className="min-h-0 flex-1 overflow-auto" data-testid="text.captions.list">
				{shown.length === 0 ? (
					<EmptyState icon="panel.text" message={q ? 'No caption matches' : 'No captions on this track'} />
				) : (
					shown.map(({ clip: c, text, speaker }, i) => {
						const isSel = selected.has(c.id);
						const isCur = current === c.id;
						return (
							// biome-ignore lint/a11y/noStaticElementInteractions: row click selects; every field inside is keyboard reachable
							// biome-ignore lint/a11y/useKeyWithClickEvents: the goto button is the keyboard path
							<div
								key={c.id}
								className={`flex gap-2 border-b border-pr-border-subtle px-2 py-1 ${isSel ? 'bg-pr-selected' : isCur ? 'bg-pr-hover' : ''}`}
								onClick={(e) => {
									if ((e.target as HTMLElement).closest('textarea,input')) return;
									if (e.shiftKey) session.select('timeline', [c.id], 'toggle', { primary: c.id });
									else go(c);
								}}
								data-testid={`text.captions.${c.id}.row`}
								data-current={isCur ? 'true' : undefined}
							>
								<div className="flex w-[92px] shrink-0 flex-col gap-[2px]">
									<button
										type="button"
										className="w-6 rounded-pr-control text-left text-pr-small text-pr-muted hover:bg-pr-hover"
										title="Go to caption"
										onClick={(e) => {
											e.stopPropagation();
											go(c);
										}}
										data-testid={`text.captions.${c.id}.goto`}
									>
										{rows.indexOf(rows.find((r) => r.clip.id === c.id)!) + 1 || i + 1}
									</button>
									<span data-testid={`text.captions.${c.id}.in`}>
										<TimecodeField
											frame={c.start}
											rate={rate}
											{...tcOpts}
											size="ui"
											tone="primary"
											label="Caption in"
											onCommit={(f) =>
												apply('Caption Timing', [{ type: 'caption.setTimes', clipId: c.id, start: f }])
											}
										/>
									</span>
									<span data-testid={`text.captions.${c.id}.out`}>
										<TimecodeField
											frame={c.start + c.duration}
											rate={rate}
											{...tcOpts}
											size="ui"
											tone="muted"
											label="Caption out"
											onCommit={(f) =>
												apply('Caption Timing', [{ type: 'caption.setTimes', clipId: c.id, end: f }])
											}
										/>
									</span>
								</div>
								<div className="flex min-w-0 flex-1 flex-col gap-[2px]">
									{speaker ? <span className="text-pr-small text-pr-muted">{speaker}</span> : null}
									<CaptionText
										key={`${c.id}:${text}`}
										text={text}
										onCommit={(t) =>
											t !== text &&
											apply('Edit Caption', [{ type: 'caption.setText', clipId: c.id, text: t }])
										}
										testId={`text.captions.${c.id}.text`}
									/>
								</div>
							</div>
						);
					})
				)}
			</div>
		</div>
	);
}

/** Caption text editor: committed on blur or Ctrl/Cmd+Enter; Esc reverts. */
function CaptionText(p: { text: string; onCommit(t: string): void; testId: string }) {
	const [draft, setDraft] = useState(p.text);
	const lines = Math.max(1, draft.split('\n').length);
	return (
		<textarea
			className="w-full resize-none rounded-pr-control border border-pr-border-subtle bg-pr-field px-1 font-pr text-pr-ui text-pr-text outline-none focus:border-pr-focus"
			rows={Math.min(6, lines)}
			value={draft}
			onChange={(e) => setDraft(e.currentTarget.value)}
			onBlur={() => p.onCommit(draft)}
			onKeyDown={(e) => {
				e.stopPropagation();
				if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
					e.preventDefault();
					(e.currentTarget as HTMLTextAreaElement).blur();
				} else if (e.key === 'Escape') {
					setDraft(p.text);
				}
			}}
			aria-label="Caption text"
			data-testid={p.testId}
		/>
	);
}
