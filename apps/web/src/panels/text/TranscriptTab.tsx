// wp captions: Text panel ▸ Transcript — the sequence transcript (words heard through the audio clips, derived on
// every edit), with the word under the playhead highlighted, click-to-seek, search, word selection (click, Shift-click,
// drag) → Mark In/Out, Extract, Lift, Insert into another sequence; Remove Fillers / Remove Pauses; speaker labels
// (rename, filter); word corrections (`transcript.editText`) and caption breaks (`transcript.setBreak`); Create
// Captions; Import Transcript (JSON or a caption file) for a media of the sequence.
import {
	captionBlocks,
	DEFAULT_CAPTION_RULES,
	fillerRanges,
	findFillers,
	findPauses,
	flicksPerFrame,
	mergeRanges,
	type ProjectDocument,
	paragraphs,
	type Sequence,
	type SeqWord,
	searchWords,
	sequenceWords,
	wordAt,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useStoreSelector, useTransportFrame } from '@jasper/session/react';
import { Button, EmptyState, SearchField, Select, TextField, toast } from '@jasper/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { bytesToBase64, loadFillers, saveFillers, type TranscriptTool, textPanelRequests } from './state.ts';

type Props = { session: EditorSession; seq: Sequence; request?: { tool?: TranscriptTool; seq: number } };
type Tool = null | 'fillers' | 'pauses' | 'captions' | 'import';

const S = 705_600_000;

export function TranscriptTab({ session, seq, request }: Props) {
	const doc = useStoreSelector(session.store, (s) => s.transient ?? s.document) as ProjectDocument;
	const playhead = useTransportFrame(66).frame;
	const words = useMemo(() => sequenceWords(doc, seq), [doc, seq]);
	const F = flicksPerFrame(seq.settings.frameRate);
	const [query, setQuery] = useState('');
	const [matchIndex, setMatchIndex] = useState(0);
	const [sel, setSel] = useState<[number, number] | null>(null);
	const [speakerFilter, setSpeakerFilter] = useState('all');
	const [tool, setTool] = useState<Tool>(null);
	const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null);
	const [editing, setEditing] = useState<number | null>(null);
	const [target, setTarget] = useState('');
	const dragging = useRef<number | null>(null);
	const requestSeq = request?.seq;
	const requestTool = request?.tool;
	useEffect(() => {
		if (requestSeq !== undefined && requestTool) setTool(requestTool);
	}, [requestSeq, requestTool]);

	const apply = (label: string, commands: unknown[]) => {
		const r = session.apply({ label, origin: 'user', sequenceId: seq.id, commands: commands as never[] });
		if (!r.ok) toast({ kind: 'warning', title: `${label}: not possible`, detail: r.errors[0]?.message });
		else if (r.warnings.length) toast({ kind: 'info', title: r.warnings[0]!.message });
		return r;
	};

	const matches = useMemo(() => searchWords(words, query), [words, query]);
	const matched = useMemo(() => {
		const m = new Set<number>();
		for (const [a, b] of matches) for (let i = a; i < b; i++) m.add(i);
		return m;
	}, [matches]);
	const current = wordAt(words, playhead * F + Math.floor(F / 2));
	const range = sel ? ([Math.min(sel[0], sel[1]), Math.max(sel[0], sel[1])] as const) : null;
	const speakers = [...new Set(words.map((w) => w.speaker).filter((s): s is string => !!s))];
	const paras = useMemo(() => paragraphs(words, Math.round(1.5 * S)), [words]);

	const seek = (w: SeqWord) => session.transport.seek(Math.floor(w.start / F));
	const goToMatch = (k: number) => {
		if (!matches.length) return;
		const i = ((k % matches.length) + matches.length) % matches.length;
		setMatchIndex(i);
		const [a, b] = matches[i]!;
		setSel([a, b - 1]);
		seek(words[a]!);
	};

	const audioMedia = useMemo(() => {
		const out = new Map<string, string>();
		for (const c of Object.values(seq.clips))
			if (c.kind === 'audio' || c.kind === 'video')
				out.set(c.mediaId, doc.media[c.mediaId]?.originalName ?? c.name);
		return [...out.entries()];
	}, [seq, doc]);

	if (!words.length)
		return (
			<div className="flex h-full flex-col" data-testid="text-transcript">
				<EmptyState
					icon="panel.text"
					message="No transcript for this sequence"
					detail="Import a transcript (JSON or a caption file) for the media of an audio clip; text-based editing then follows every edit."
				/>
				<ImportTranscript session={session} seq={seq} media={audioMedia} apply={apply} />
			</div>
		);

	const selText = range
		? words
				.slice(range[0], range[1] + 1)
				.map((w) => w.text)
				.join(' ')
		: '';
	const editWord = (index: number, text: string) => {
		const w = words[index]!;
		apply('Edit Transcript', [
			{ type: 'transcript.editText', transcriptId: w.transcriptId, fromWord: w.index, toWord: w.index, text },
		]);
	};
	const correctSelection = () => {
		if (!range) return;
		const ws = words.slice(range[0], range[1] + 1);
		const t = ws[0]!.transcriptId;
		const contiguous = ws.every(
			(w, k) => w.transcriptId === t && (k === 0 || w.index === ws[k - 1]!.index + 1),
		);
		if (!contiguous) {
			toast({ kind: 'info', title: 'Select words of one clip to correct them together' });
			return;
		}
		const text = window.prompt('Correct the text', selText);
		if (text !== null)
			apply('Edit Transcript', [
				{
					type: 'transcript.editText',
					transcriptId: t,
					fromWord: ws[0]!.index,
					toWord: ws[ws.length - 1]!.index,
					text,
				},
			]);
	};
	const textEdit = (type: 'transcript.select' | 'transcript.extract' | 'transcript.lift', label: string) =>
		range &&
		apply(label, [{ type, sequenceId: seq.id, fromWord: range[0], toWord: range[1] }]).ok &&
		type !== 'transcript.select' &&
		setSel(null);
	const otherSeqs = Object.values(doc.sequences).filter((s) => s.id !== seq.id);
	const seqName = (id: string) =>
		Object.values(doc.items).find((it) => it.kind === 'sequence' && it.sequenceId === id)?.name ?? id;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: closes the word menu
		// biome-ignore lint/a11y/useKeyWithClickEvents: the word menu also closes with its own items and Escape-less blur
		<div
			className="flex h-full min-h-0 flex-col"
			data-testid="text-transcript"
			onPointerUp={() => (dragging.current = null)}
			onClick={() => setMenu(null)}
		>
			{/* search + speakers */}
			<div className="flex shrink-0 items-center gap-1 border-b border-pr-border-subtle px-2 py-1">
				<SearchField
					value={query}
					onValueChange={(v) => {
						setQuery(v);
						setMatchIndex(0);
					}}
					onKeyDown={(e) =>
						e.key === 'Enter' &&
						goToMatch(e.shiftKey ? matchIndex - 1 : matches.length && sel ? matchIndex + 1 : 0)
					}
					placeholder="Search transcript"
					aria-label="Search transcript"
					className="flex-1"
					data-testid="text.transcript.search"
				/>
				<span className="pr-tabular text-pr-small text-pr-muted" data-testid="text.transcript.matches">
					{query.trim()
						? `${matches.length ? matchIndex + 1 : 0}/${matches.length}`
						: `${words.length} words`}
				</span>
				<Button
					variant="quiet"
					onClick={() => goToMatch(matchIndex - 1)}
					disabled={!matches.length}
					aria-label="Previous match"
				>
					↑
				</Button>
				<Button
					variant="quiet"
					onClick={() => goToMatch(matchIndex + 1)}
					disabled={!matches.length}
					aria-label="Next match"
				>
					↓
				</Button>
				<Select
					label="Speaker"
					className="w-28"
					value={speakerFilter}
					onValueChange={setSpeakerFilter}
					options={[
						{ value: 'all', label: 'All speakers' },
						...speakers.map((s) => ({ value: s, label: s })),
					]}
				/>
			</div>
			{/* actions on the selection */}
			<div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-pr-border-subtle px-2 py-1">
				<Button
					variant="quiet"
					disabled={!range}
					disabledReason="Select words first"
					onClick={() => textEdit('transcript.select', 'Mark Text Selection')}
					data-testid="text.transcript.markInOut"
				>
					Mark In/Out
				</Button>
				<Button
					variant="quiet"
					disabled={!range}
					disabledReason="Select words first"
					onClick={() => textEdit('transcript.extract', 'Extract Text')}
					data-testid="text.transcript.extract"
				>
					Extract
				</Button>
				<Button
					variant="quiet"
					disabled={!range}
					disabledReason="Select words first"
					onClick={() => textEdit('transcript.lift', 'Lift Text')}
					data-testid="text.transcript.lift"
				>
					Lift
				</Button>
				<Button
					variant="quiet"
					disabled={!range}
					disabledReason="Select words first"
					onClick={correctSelection}
					data-testid="text.transcript.correct"
				>
					Correct…
				</Button>
				{otherSeqs.length ? (
					<>
						<Select
							label="Insert into sequence"
							className="w-32"
							value={target}
							placeholder="Insert into…"
							onValueChange={setTarget}
							options={otherSeqs.map((s) => ({ value: s.id, label: seqName(s.id) }))}
						/>
						<Button
							variant="quiet"
							disabled={!range || !target}
							disabledReason="Select words and a sequence"
							onClick={() =>
								range &&
								apply('Insert Text Selection', [
									{
										type: 'transcript.insertInto',
										sequenceId: seq.id,
										fromWord: range[0],
										toWord: range[1],
										targetSequenceId: target,
									},
								])
							}
							data-testid="text.transcript.insert"
						>
							Insert
						</Button>
					</>
				) : null}
				<span className="flex-1" />
				<Button
					variant={tool === 'fillers' ? 'secondary' : 'quiet'}
					onClick={() => setTool(tool === 'fillers' ? null : 'fillers')}
					data-testid="text.transcript.fillers"
				>
					Remove Fillers…
				</Button>
				<Button
					variant={tool === 'pauses' ? 'secondary' : 'quiet'}
					onClick={() => setTool(tool === 'pauses' ? null : 'pauses')}
					data-testid="text.transcript.pauses"
				>
					Remove Pauses…
				</Button>
				<Button
					variant={tool === 'captions' ? 'secondary' : 'quiet'}
					onClick={() => setTool(tool === 'captions' ? null : 'captions')}
					data-testid="text.transcript.createCaptions"
				>
					Create Captions…
				</Button>
				<Button
					variant={tool === 'import' ? 'secondary' : 'quiet'}
					onClick={() => setTool(tool === 'import' ? null : 'import')}
					data-testid="text.transcript.import"
				>
					Import…
				</Button>
			</div>
			{tool === 'fillers' ? (
				<FillersTool
					words={words}
					seq={seq}
					apply={apply}
					onDone={() => {
						setTool(null);
						setSel(null);
					}}
				/>
			) : null}
			{tool === 'pauses' ? (
				<PausesTool
					words={words}
					seq={seq}
					apply={apply}
					onDone={() => {
						setTool(null);
						setSel(null);
					}}
				/>
			) : null}
			{tool === 'captions' ? (
				<CaptionsTool words={words} seq={seq} apply={apply} range={range} onDone={() => setTool(null)} />
			) : null}
			{tool === 'import' ? (
				<ImportTranscript
					session={session}
					seq={seq}
					media={audioMedia}
					apply={apply}
					onDone={() => setTool(null)}
				/>
			) : null}
			{/* words */}
			<div
				className="min-h-0 flex-1 overflow-auto px-2 py-1 font-pr text-pr-ui leading-[1.7]"
				data-testid="text.transcript.words"
			>
				{paras.map(([a, b]) => {
					const speaker = words[a]!.speaker;
					if (speakerFilter !== 'all' && speaker !== speakerFilter) return null;
					return (
						<div key={`${a}-${b}`} className="mb-2" data-testid="text.transcript.paragraph">
							{speaker ? (
								<button
									type="button"
									className="mb-[2px] block text-pr-small text-pr-muted hover:text-pr-text"
									title="Rename speaker"
									onClick={() => {
										const name = window.prompt('Rename speaker', speaker);
										if (name && name !== speaker)
											apply('Rename Speaker', [{ type: 'transcript.renameSpeaker', speaker, name }]);
									}}
									data-testid="text.transcript.speaker"
								>
									{speaker}
								</button>
							) : null}
							<p className="m-0">
								{words.slice(a, b).map((w, k) => {
									const i = a + k;
									const inSel = range && i >= range[0] && i <= range[1];
									const cls = [
										'cursor-text rounded-[2px] px-[1px]',
										inSel ? 'bg-pr-accent-fill text-pr-on-accent' : matched.has(i) ? 'bg-pr-selected' : '',
										current === i && !inSel ? 'text-pr-strong underline decoration-2' : '',
										w.confidence !== null && w.confidence < 0.6
											? 'decoration-pr-warning decoration-wavy underline'
											: '',
									].join(' ');
									if (editing === i)
										return (
											<TextField
												key={i}
												autoFocus
												defaultValue={w.text}
												className="inline-block w-28"
												onKeyDown={(e) => {
													e.stopPropagation();
													if (e.key === 'Enter') {
														const v = e.currentTarget.value.trim();
														setEditing(null);
														if (v !== w.text) editWord(i, v);
													} else if (e.key === 'Escape') setEditing(null);
												}}
												onBlur={() => setEditing(null)}
												data-testid="text.transcript.wordEdit"
											/>
										);
									return (
										<span key={i}>
											{/* biome-ignore lint/a11y/noStaticElementInteractions: words are click targets; keyboard search and actions cover the same edits */}
											<span
												className={cls}
												title={`${(w.start / S).toFixed(2)} s${w.confidence !== null ? ` · ${Math.round(w.confidence * 100)} %` : ''}`}
												onPointerDown={(e) => {
													if (e.button !== 0) return;
													if (e.shiftKey && sel) setSel([sel[0], i]);
													else {
														setSel([i, i]);
														seek(w);
													}
													dragging.current = i;
												}}
												onPointerEnter={() => {
													if (dragging.current !== null) setSel([dragging.current, i]);
												}}
												onDoubleClick={() => setEditing(i)}
												onContextMenu={(e) => {
													e.preventDefault();
													e.stopPropagation();
													setMenu({ x: e.clientX, y: e.clientY, index: i });
												}}
												data-testid={`text.transcript.word.${i}`}
												data-current={current === i ? 'true' : undefined}
											>
												{w.text}
											</span>{' '}
										</span>
									);
								})}
							</p>
						</div>
					);
				})}
			</div>
			{menu ? (
				<WordMenu
					x={menu.x}
					y={menu.y}
					onEdit={() => setEditing(menu.index)}
					onBreak={(b) => {
						const w = words[menu.index]!;
						apply('Caption Break', [
							{
								type: 'transcript.setBreak',
								transcriptId: w.transcriptId,
								wordIndex: w.index,
								breakBefore: b,
							},
						]);
					}}
					onSpeaker={() => {
						const w = words[menu.index]!;
						const name = window.prompt('Speaker of the selected words', w.speaker ?? '');
						if (name === null) return;
						const r = range ?? ([menu.index, menu.index] as const);
						const ws = words.slice(r[0], r[1] + 1).filter((x) => x.transcriptId === w.transcriptId);
						apply('Set Speaker', [
							{
								type: 'transcript.setSpeaker',
								transcriptId: w.transcriptId,
								fromWord: Math.min(...ws.map((x) => x.index)),
								toWord: Math.max(...ws.map((x) => x.index)),
								speaker: name || null,
							},
						]);
					}}
					onClose={() => setMenu(null)}
				/>
			) : null}
		</div>
	);
}

function WordMenu(p: {
	x: number;
	y: number;
	onEdit(): void;
	onBreak(b: 'none' | 'line' | 'segment'): void;
	onSpeaker(): void;
	onClose(): void;
}) {
	const item = (label: string, run: () => void, id: string) => (
		<button
			type="button"
			className="block w-full px-3 py-[3px] text-left font-pr text-pr-ui text-pr-text hover:bg-pr-accent-fill hover:text-pr-on-accent"
			onClick={(e) => {
				e.stopPropagation();
				run();
				p.onClose();
			}}
			data-testid={`text.transcript.menu.${id}`}
		>
			{label}
		</button>
	);
	return (
		<div
			className="fixed z-50 min-w-40 rounded-pr-menu border border-pr-menu-border bg-pr-menu py-1 shadow-pr-overlay"
			style={{ left: p.x, top: p.y }}
			role="menu"
		>
			{item('Correct Word', p.onEdit, 'edit')}
			{item('Speaker…', p.onSpeaker, 'speaker')}
			{item('Caption Line Break Before', () => p.onBreak('line'), 'line')}
			{item('New Caption Before', () => p.onBreak('segment'), 'segment')}
			{item('No Break Before', () => p.onBreak('none'), 'none')}
		</div>
	);
}

type ApplyFn = (label: string, commands: unknown[]) => { ok: boolean };

function FillersTool(p: { words: SeqWord[]; seq: Sequence; apply: ApplyFn; onDone(): void }) {
	const [list, setList] = useState(() => loadFillers().join(', '));
	const fillers = list
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const hits = findFillers(p.words, fillers);
	const frames = mergeRanges(fillerRanges(p.words, hits, p.seq.settings.frameRate)).reduce(
		(n, [a, b]) => n + b - a,
		0,
	);
	return (
		<div
			className="flex shrink-0 flex-wrap items-center gap-1 border-b border-pr-border-subtle bg-pr-panel-alt px-2 py-1 text-pr-small text-pr-muted"
			data-testid="text.transcript.fillersTool"
		>
			Filler words
			<TextField
				className="min-w-48 flex-1"
				value={list}
				onChange={(e) => setList(e.currentTarget.value)}
				aria-label="Filler words"
				data-testid="text.transcript.fillerList"
			/>
			<span data-testid="text.transcript.fillerCount">
				{hits.length} found · {frames} frames
			</span>
			<Button
				variant="primary"
				disabled={!hits.length}
				onClick={() => {
					saveFillers(fillers);
					if (
						p.apply('Remove Filler Words', [
							{ type: 'transcript.removeFillers', sequenceId: p.seq.id, fillers },
						]).ok
					)
						p.onDone();
				}}
				data-testid="text.transcript.fillersApply"
			>
				Remove
			</Button>
		</div>
	);
}

function PausesTool(p: { words: SeqWord[]; seq: Sequence; apply: ApplyFn; onDone(): void }) {
	const [min, setMin] = useState('1');
	const [keep, setKeep] = useState('0.1');
	const m = Number(min);
	const k = Number(keep);
	const valid = Number.isFinite(m) && m >= 0.04 && Number.isFinite(k) && k >= 0;
	const ranges = valid
		? findPauses(p.words, Math.round(m * S), Math.round(k * S), p.seq.settings.frameRate)
		: [];
	return (
		<div
			className="flex shrink-0 flex-wrap items-center gap-1 border-b border-pr-border-subtle bg-pr-panel-alt px-2 py-1 text-pr-small text-pr-muted"
			data-testid="text.transcript.pausesTool"
		>
			Pauses longer than
			<TextField
				type="number"
				step={0.1}
				min={0.04}
				className="w-14"
				value={min}
				onChange={(e) => setMin(e.currentTarget.value)}
				aria-label="Minimum pause (s)"
				data-testid="text.transcript.pauseMin"
			/>
			s, keep
			<TextField
				type="number"
				step={0.05}
				min={0}
				className="w-14"
				value={keep}
				onChange={(e) => setKeep(e.currentTarget.value)}
				aria-label="Air kept (s)"
				data-testid="text.transcript.pauseKeep"
			/>
			s<span data-testid="text.transcript.pauseCount">{ranges.length} found</span>
			<Button
				variant="primary"
				disabled={!ranges.length}
				onClick={() =>
					p.apply('Remove Pauses', [
						{ type: 'transcript.removePauses', sequenceId: p.seq.id, minSeconds: m, keepSeconds: k },
					]).ok && p.onDone()
				}
				data-testid="text.transcript.pausesApply"
			>
				Remove
			</Button>
		</div>
	);
}

function CaptionsTool(p: {
	words: SeqWord[];
	seq: Sequence;
	apply: ApplyFn;
	range: readonly [number, number] | null;
	onDone(): void;
}) {
	const d = DEFAULT_CAPTION_RULES;
	const [r, setR] = useState({
		maxChars: String(d.maxChars),
		lines: String(d.lines),
		minSeconds: '1',
		maxSeconds: '7',
		gapFrames: '0',
	});
	const rules = {
		maxChars: Math.max(1, Math.round(Number(r.maxChars) || d.maxChars)),
		lines: Math.max(1, Math.min(4, Math.round(Number(r.lines) || d.lines))),
		minSeconds: Math.max(0, Number(r.minSeconds) || 0),
		maxSeconds: Math.max(0.1, Number(r.maxSeconds) || 7),
		gapFrames: Math.max(0, Math.round(Number(r.gapFrames) || 0)),
	};
	const words = p.range ? p.words.slice(p.range[0], p.range[1] + 1) : p.words;
	const count = captionBlocks(
		words,
		{
			...d,
			maxChars: rules.maxChars,
			lines: rules.lines,
			minDuration: rules.minSeconds * S,
			maxDuration: rules.maxSeconds * S,
			gapFrames: rules.gapFrames,
		},
		p.seq.settings.frameRate,
	).length;
	const field = (k: keyof typeof r, label: string) => (
		<span className="flex items-center gap-1">
			{label}
			<TextField
				type="number"
				className="w-12"
				value={r[k]}
				onChange={(e) => setR({ ...r, [k]: e.currentTarget.value })}
				aria-label={label}
				data-testid={`text.transcript.rules.${k}`}
			/>
		</span>
	);
	return (
		<div
			className="flex shrink-0 flex-wrap items-center gap-2 border-b border-pr-border-subtle bg-pr-panel-alt px-2 py-1 text-pr-small text-pr-muted"
			data-testid="text.transcript.captionsTool"
		>
			{field('maxChars', 'Characters per line')}
			{field('lines', 'Lines')}
			{field('minSeconds', 'Min s')}
			{field('maxSeconds', 'Max s')}
			{field('gapFrames', 'Gap frames')}
			<span>
				{count} captions{p.range ? ' (selection)' : ''}
			</span>
			<Button
				variant="primary"
				onClick={() => {
					const ok = p.apply('Create Captions', [
						{
							type: 'transcript.createCaptions',
							sequenceId: p.seq.id,
							rules,
							...(p.range ? { fromWord: p.range[0], toWord: p.range[1] } : {}),
						},
					]).ok;
					if (ok) {
						p.onDone();
						textPanelRequests.open('captions');
					}
				}}
				data-testid="text.transcript.captionsApply"
			>
				Create
			</Button>
		</div>
	);
}

function ImportTranscript(p: {
	session: EditorSession;
	seq: Sequence;
	media: Array<[string, string]>;
	apply: ApplyFn;
	onDone?(): void;
}) {
	const [mediaId, setMediaId] = useState(p.media[0]?.[0] ?? '');
	const fileRef = useRef<HTMLInputElement>(null);
	if (!p.media.length)
		return (
			<p className="px-2 text-pr-small text-pr-muted">
				Place a clip with sound in the sequence to attach a transcript to its media.
			</p>
		);
	return (
		<div
			className="flex shrink-0 flex-wrap items-center gap-1 border-b border-pr-border-subtle bg-pr-panel-alt px-2 py-1 text-pr-small text-pr-muted"
			data-testid="text.transcript.importTool"
		>
			Transcript for
			<Select
				label="Media"
				className="w-40"
				value={mediaId}
				onValueChange={setMediaId}
				options={p.media.map(([id, name]) => ({ value: id, label: name }))}
			/>
			<Button
				variant="primary"
				onClick={() => fileRef.current?.click()}
				disabled={!mediaId}
				data-testid="text.transcript.importFile"
			>
				Choose File…
			</Button>
			<input
				ref={fileRef}
				type="file"
				accept=".json,.srt,.vtt,.scc,.mcc,.stl,.ttml,.dfxp,.xml"
				className="hidden"
				data-testid="text.transcript.importInput"
				onChange={async (e) => {
					const f = e.currentTarget.files?.[0];
					e.currentTarget.value = '';
					if (!f) return;
					const bytes = new Uint8Array(await f.arrayBuffer());
					const ok = p.apply('Import Transcript', [
						{ type: 'transcript.import', mediaId, contentBase64: bytesToBase64(bytes), fileName: f.name },
					]).ok;
					if (ok) p.onDone?.();
				}}
			/>
		</div>
	);
}
