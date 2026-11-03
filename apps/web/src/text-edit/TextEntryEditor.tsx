// Direct text entry on the Program monitor (spec 19 TL-085, TL-093; docs/wp-notes/title-looks.md "Text"). Adapted from
// the template text editor (template-edit/TemplateTextEditor.tsx); what differs is that the real layer keeps drawing:
// - the editor is an invisible copy of the text block, same CSS and same layer map, laid exactly over the render, so a
//   look shows the letters as they are typed and a click lands where the letter is drawn ("ghost");
// - the caret is our own, two-tone and in layer space, because no single colour stays visible on every look;
// - where the block cannot match the render (text on a path, per-paragraph settings, optical kerning) and during IME
//   composition, whose underlines need visible text, the editor shows its text over a scrim ("plain");
// - Esc, a click away or Ctrl+Enter commit, Enter is a new line, and the whole entry is one History step. Ctrl+Z inside
//   undoes typing only: the entry holds a gesture, and History is out of reach until it ends.
// What was typed lives in `EntryDraft`, outside React: a render failure, the page closing and the overlay unmounting all
// commit it. A refused commit keeps the editor open with the reason; where no editor stays open (a failure, an unmount)
// a new one opens on the text. While typing pauses the draft is checkpointed to the tab (checkpoint.ts), and a Program
// monitor with no entry open offers a checkpoint left by a killed renderer back. Keys typed here reach no shortcut: the
// element carries `data-keymap-suspend` and stops propagation.
import {
	contentSpans,
	rgbaCss,
	runLayoutCss,
	setTemplateEditHold,
	textBlockStyle,
	UPRIGHT_TEXT_CSS,
} from '@jasper/compositions';
import {
	applyRunPatch,
	clearRuns,
	defaultTextStyle,
	isVerticalText,
	mat3ToCss,
	matrixToCss,
	type ResolvedLayer,
	type RunPatch,
	type TextContent,
	type TextStyle,
	TITLE_LOOK_EFFECT_ID,
	type Vec2,
} from '@jasper/project';
import { useStoreSelector } from '@jasper/session/react';
import { Button } from '@jasper/ui';
import {
	Component,
	type CSSProperties,
	type ErrorInfo,
	type FocusEvent,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';
import { useStore } from 'zustand';
import type { ProgramOverlayHostProps } from '../extensions/index.ts';
import { t } from '../i18n/runtime.ts';
import { activeSequence } from '../panels/program/edits.ts';
import type { View } from '../panels/program/viewport.ts';
import { offsetAtPoint, readSelection, selectOffsets, type TextRange } from '../template-edit/caret.ts';
import { sequenceToLayer } from '../template-edit/hit.ts';
import { showTemplateEditMessage } from '../template-edit/store.ts';
import { layerScale, usePlayhead } from '../template-edit/TemplateTextEditor.tsx';
import { resolveProgramScene } from '../three-d/scene.ts';
import { beginTextEntry } from './begin.ts';
import { checkpointEpoch, clearCheckpoint, readCheckpoint } from './checkpoint.ts';
import { EntryDraft, liveDraft, setLiveDraft, storedContent } from './draft.ts';
import { RunToolbar, runStateOf } from './RunToolbar.tsx';
import { endTextEntry, startTextEntry, type TextEntry, textEntryStore } from './store.ts';

/** Marks controls of the entry: focus moving to one of them is not a click away. */
const ENTRY_UI = 'data-text-entry-ui';

/** Program overlay (always mounted): renders the entry open on this session, or offers a checkpoint back. */
export function TextEntryHost(props: ProgramOverlayHostProps) {
	const cur = useStore(textEntryStore, (s) => s.current);
	if (!cur || cur.session !== props.session) return <RestoreOffer session={props.session} />;
	return (
		<EntryBoundary key={cur.seq} entry={cur}>
			<TextEntryEditor entry={cur} {...props} />
		</EntryBoundary>
	);
}

const SNIPPET_LENGTH = 48;

/** A checkpoint of this project with no entry open: a renderer was killed mid-entry (or a refusal left the text). */
function RestoreOffer({ session }: { session: ProgramOverlayHostProps['session'] }) {
	useStore(checkpointEpoch, (s) => s.n);
	const sequenceId = useStoreSelector(session.store, (s) => s.activeSequenceId);
	const cp = readCheckpoint(session.projectId);
	if (!cp || cp.sequenceId !== sequenceId) return null;
	const flat = cp.text.replace(/\s+/g, ' ').trim();
	const snippet = flat.length > SNIPPET_LENGTH ? `${flat.slice(0, SNIPPET_LENGTH - 1)}…` : flat;
	const restore = () =>
		beginTextEntry(session, {
			point: cp.point,
			frame: cp.frame,
			clipId: cp.clipId,
			recovered: { text: cp.text, runs: cp.runs },
		});
	return (
		<div
			role="status"
			className="pointer-events-auto absolute top-2 left-1/2 z-10 flex max-w-[480px] -translate-x-1/2 items-center gap-2 rounded-pr-control bg-pr-tooltip px-2 py-1 text-pr-small shadow"
			data-testid="text-entry-restore"
		>
			<span className="min-w-0 flex-1 truncate" title={cp.text}>
				{t('Text you were typing was not added: “{0}”', snippet)}
			</span>
			<Button variant="primary" onClick={restore} data-testid="text-entry-restore-button">
				Restore
			</Button>
			<Button variant="quiet" onClick={() => clearCheckpoint(session.projectId)}>
				Discard
			</Button>
		</div>
	);
}

/**
 * A commit refused where no editor stays open to show why (AGENTS §0): the entry's own editor gives way to a new one
 * on the same text, unless `reopen` is false or a newer entry took its place; then the message carries the text. The
 * tab's checkpoint keeps it either way until it is written.
 */
function keepRefused(
	entry: TextEntry,
	draft: EntryDraft,
	message: (text: string) => string,
	reopen: boolean,
) {
	const { text, runs } = draft.getState();
	draft.cancel({ keepText: true });
	const current = textEntryStore.getState().current;
	if (reopen && (!current || current.seq === entry.seq))
		startTextEntry({ ...entry, recovered: { text, runs } });
	else showTemplateEditMessage(entry.session, message(text), entry.point);
}

/**
 * A failure inside the editor must not cost what was typed (AGENTS §0): it is committed, or, when that is refused, a new
 * editor opens on it. A second failure hands the text to the message rather than loop.
 */
class EntryBoundary extends Component<{ entry: TextEntry; children: ReactNode }, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	componentDidCatch(error: unknown, info: ErrorInfo) {
		console.warn('[program] text entry failed', error, info.componentStack);
		const { entry } = this.props;
		setTemplateEditHold(null);
		const draft = liveDraft();
		const r = draft?.entry === entry ? draft.commit() : null;
		endTextEntry(entry.seq);
		if (!r || r.ok) {
			showTemplateEditMessage(
				entry.session,
				t('Text entry stopped: {0}. What you typed was kept.', errorText(error)),
				entry.point,
			);
			return;
		}
		keepRefused(
			entry,
			draft!,
			(text) => t('Text entry stopped: {0}. Your text: {1}', errorText(error), text),
			!entry.recovered,
		);
	}

	render() {
		return this.state.failed ? null : this.props.children;
	}
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What a clip's render does that an inline block cannot follow, so the editor must show its own text. */
function matchesRender(clip: { pathOptions?: unknown } | undefined, content: TextContent): boolean {
	if (clip?.pathOptions || content.paragraphs?.length) return false;
	const spaced = (s: Partial<TextStyle>) =>
		(s.tsume ?? 0) !== 0 || (s.kerning !== undefined && s.kerning !== 'metrics');
	return !spaced(content.style) && !(content.runs ?? []).some((r) => spaced(r.style));
}

function readText(el: HTMLElement): string {
	let s = '';
	const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	let n: Node | null;
	while ((n = w.nextNode())) s += (n as Text).data;
	return s;
}

type Caret = { x: number; y: number; length: number };

/** The selection over invisible text, and the caret's blink. */
const entryCss = (ghost: boolean) =>
	`[data-testid="text-entry-input"]::selection,[data-testid="text-entry-input"] *::selection{background:color-mix(in srgb,var(--pr-accent) 40%,transparent);color:${ghost ? 'transparent' : 'inherit'}}@keyframes text-entry-blink{0%,55%{opacity:1}56%,100%{opacity:0}}`;

function TextEntryEditor({
	entry,
	session,
	doc,
	view,
	transport,
}: { entry: TextEntry } & ProgramOverlayHostProps) {
	const [draft] = useState(() => new EntryDraft(entry));
	const state = useSyncExternalStore(draft.subscribe, draft.getState);
	const { text, runs, error } = state;
	const hostRef = useRef<HTMLDivElement>(null);
	const ref = useRef<HTMLDivElement>(null);
	const composingRef = useRef(false);
	const mounted = useRef(false);
	const [composing, setComposing] = useState(false);
	const pendingSel = useRef<TextRange | null>(null);
	const [sel, setSel] = useState<TextRange | null>(null);
	const [toolbarAt, setToolbarAt] = useState<Vec2 | null>(null);
	const [caret, setCaret] = useState<Caret | null>(null);
	const { frame, playing } = usePlayhead(transport);
	const scene = useMemo(() => resolveProgramScene(doc, frame), [doc, frame]);
	const drawn = draft.clipId ? scene.find((l) => l.clip.clipId === draft.clipId) : undefined;
	// A new text gets a new id per keystroke, and the document that draws it follows: stay on the last place it was.
	const lastLayer = useRef(drawn);
	if (drawn) lastLayer.current = drawn;
	const layer: ResolvedLayer | undefined = text ? (drawn ?? lastLayer.current) : drawn;
	const live = useRef({ layer, view });
	live.current = { layer, view };

	const clip = entry.clipId ? activeSequence(session)?.clips[entry.clipId] : undefined;
	const content = useMemo((): TextContent => {
		const source = layer?.clip.source as { text?: TextContent } | undefined;
		const c = clip?.kind === 'text' ? storedContent(session, clip as never, entry.frame) : source?.text;
		const base = c ?? ({ text: '', style: defaultTextStyle('') } as TextContent);
		return { ...base, text, ...(runs.length ? { runs } : { runs: undefined }) };
	}, [layer, clip, session, entry.frame, text, runs]);
	const style = content.style;
	const vertical = isVerticalText(content);
	const ghost = !!layer && !composing && matchesRender(clip as never, content);
	const hasLook = !!(clip as { effects?: { effectId: string }[] } | undefined)?.effects?.some(
		(f) => f.effectId === TITLE_LOOK_EFFECT_ID,
	);

	useEffect(() => {
		setLiveDraft(draft);
		// A recovered entry draws at once.
		if (entry.recovered) draft.push();
		return () => {
			if (liveDraft() === draft) setLiveDraft(null);
		};
	}, [draft, entry.recovered]);

	// Rest at the playhead, paused, with animators and a warp out of the way of the caret.
	useEffect(() => {
		if (transport.getState().playing) transport.pause();
		if (entry.clipId) setTemplateEditHold(entry.clipId);
		return () => setTemplateEditHold(null);
	}, [entry.clipId, transport]);

	/** The text in the element, which may hold what an IME has not finished. */
	const syncFromDom = useCallback(() => {
		const el = ref.current;
		if (!el) return;
		const v = readText(el).replace(/\r\n?/g, '\n');
		if (v !== draft.getState().text) draft.typed(v);
	}, [draft]);

	const finish = useCallback((): boolean => {
		syncFromDom();
		const r = draft.commit();
		if (r.ok) endTextEntry(entry.seq);
		return r.ok;
	}, [draft, entry.seq, syncFromDom]);

	// Whatever closes the page or takes the overlay away commits first.
	useEffect(() => {
		const onHide = () => {
			if (!draft.closed) finish();
		};
		mounted.current = true;
		window.addEventListener('pagehide', onHide);
		return () => {
			window.removeEventListener('pagehide', onHide);
			mounted.current = false;
			// After the commit phase: an effect that is only being replayed (React's StrictMode) is back by then. A refusal
			// (a locked track, a removed clip, read-only) must not cost the text when the overlay mounts again, as a change
			// of language does: a new editor opens on it.
			queueMicrotask(() => {
				if (mounted.current || draft.closed) return;
				const r = draft.commit();
				if (!r.ok)
					keepRefused(
						entry,
						draft,
						(text) => t('The text could not be written: {0}. Your text: {1}', r.error, text),
						true,
					);
			});
		};
	}, [draft, entry, finish]);

	// Playback started, or the clip left the monitor: the entry ends.
	useEffect(() => {
		if (playing && !draft.closed && !finish()) transport.pause();
	}, [playing, draft, finish, transport]);
	const wasDrawn = useRef(false);
	useEffect(() => {
		if (drawn) wasDrawn.current = true;
		else if (entry.clipId && wasDrawn.current && !draft.closed) finish();
	}, [drawn, entry.clipId, draft, finish]);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const onBeforeInput = (e: InputEvent) => {
			// Line breaks come from Enter only; the browser's undo stack would fight the rebuilt DOM.
			const type = e.inputType ?? '';
			if (type === 'insertParagraph' || type === 'insertLineBreak' || type.startsWith('history'))
				e.preventDefault();
		};
		el.addEventListener('beforeinput', onBeforeInput);
		return () => el.removeEventListener('beforeinput', onBeforeInput);
	}, []);

	// Rebuild the text from the draft, runs as spans, then restore the selection. Never during a composition.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `content` follows text and runs
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || composingRef.current) return;
		const want = pendingSel.current ?? (document.activeElement === el ? readSelection(el) : null);
		pendingSel.current = null;
		const nodes: Node[] = [];
		for (const s of contentSpans(content)) {
			const piece = text.slice(s.from, s.to);
			if (!s.style && !s.upright) {
				nodes.push(document.createTextNode(piece));
				continue;
			}
			const span = document.createElement('span');
			const css = {
				...(s.style ? runLayoutCss(s.style, style, doc.fonts) : {}),
				...(s.upright ? UPRIGHT_TEXT_CSS : {}),
			} as Record<string, unknown>;
			for (const [k, v] of Object.entries(css))
				if (v !== undefined)
					(span.style as unknown as Record<string, string>)[k] =
						typeof v === 'number' && k !== 'fontWeight' && k !== 'lineHeight' ? `${v}px` : String(v);
			if (!ghost && s.style?.fill) span.style.color = rgbaCss(s.style.fill as never);
			span.textContent = piece;
			nodes.push(span);
		}
		if (nodes.length === 0) nodes.push(document.createTextNode(''));
		// A trailing line break needs content after it to be displayed.
		if (text.endsWith('\n')) nodes.push(document.createElement('br'));
		el.replaceChildren(...nodes);
		if (want && document.activeElement === el) selectOffsets(el, want.start, want.end);
	}, [content, ghost]);

	const positionCaret = useCallback(() => {
		const el = ref.current;
		const host = hostRef.current?.getBoundingClientRect();
		const selection = el?.ownerDocument.getSelection?.();
		if (!el || !host || !selection || selection.rangeCount === 0 || document.activeElement !== el)
			return setCaret(null);
		const r = readSelection(el);
		setSel((p) => (p && r && p.start === r.start && p.end === r.end ? p : r));
		const range = selection.getRangeAt(0);
		if (!selection.isCollapsed) {
			setCaret(null);
			const b = range.getBoundingClientRect?.();
			setToolbarAt(b && b.width + b.height > 0 ? [b.left + b.width / 2 - host.left, b.top - host.top] : null);
			return;
		}
		setToolbarAt(null);
		if (composingRef.current) return setCaret(null);
		const rects = range.getClientRects?.();
		const box = rects?.length ? rects[rects.length - 1]! : el.getBoundingClientRect();
		const size = Number.parseFloat(
			getComputedStyle(
				range.startContainer.nodeType === Node.ELEMENT_NODE
					? (range.startContainer as Element)
					: (range.startContainer.parentElement ?? el),
			).fontSize,
		);
		const { layer: l, view: v } = live.current;
		const seqPoint: Vec2 = [
			(box.left + box.width / 2 - host.left - v.x) / v.scale,
			(box.top + box.height / 2 - host.top - v.y) / v.scale,
		];
		const p = l ? sequenceToLayer(l, seqPoint) : ([0, 0] as Vec2);
		if (!p) return setCaret(null);
		setCaret({ x: p[0], y: p[1], length: (Number.isFinite(size) ? size : 100) * 1.2 });
	}, []);

	useEffect(() => {
		const onSel = () => positionCaret();
		document.addEventListener('selectionchange', onSel);
		return () => document.removeEventListener('selectionchange', onSel);
	}, [positionCaret]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the caret moves with the text, the layer and the view
	useLayoutEffect(() => positionCaret(), [content, layer, view, composing]);

	// Open: focus, with the caret under the click (at the end of the text otherwise).
	// biome-ignore lint/correctness/useExhaustiveDependencies: once per editor
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.focus({ preventScroll: true });
		const at = entry.client ? offsetAtPoint(el, entry.client[0], entry.client[1]) : null;
		const pos = at ?? text.length;
		selectOffsets(el, pos, pos);
		positionCaret();
	}, []);

	const take = (next: string, caretAt: TextRange | null) => {
		pendingSel.current = caretAt;
		draft.typed(next);
	};

	const insert = (s: string) => {
		const el = ref.current;
		if (!el) return;
		const r = readSelection(el) ?? { start: text.length, end: text.length };
		const piece = s.replace(/\r\n?/g, '\n');
		const at = r.start + piece.length;
		take(text.slice(0, r.start) + piece + text.slice(r.end), { start: at, end: at });
	};

	const patchRuns = (patch: RunPatch | null) => {
		const el = ref.current;
		const r = (el && readSelection(el)) ?? sel;
		if (!r || r.start === r.end) return;
		pendingSel.current = r;
		draft.update({
			text,
			runs: patch
				? applyRunPatch(text, runs, r.start, r.end, patch, style)
				: clearRuns(text, runs, r.start, r.end, style),
		});
	};

	const toggleRun = (field: 'bold' | 'italic') => {
		if (!sel || sel.start === sel.end) return;
		const now = runStateOf(content, sel);
		patchRuns(
			field === 'bold' ? { style: { weight: now.bold ? 400 : 700 } } : { style: { italic: !now.italic } },
		);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		// Keys typed here reach no shortcut.
		e.stopPropagation();
		if (e.nativeEvent.isComposing || composingRef.current) return;
		const mod = e.ctrlKey || e.metaKey;
		const key = e.key.toLowerCase();
		if (e.key === 'Escape') {
			e.preventDefault();
			finish();
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (mod) finish();
			else insert('\n');
		} else if (e.key === 'Tab') e.preventDefault();
		else if (mod && !e.altKey && (key === 'z' || key === 'y')) {
			e.preventDefault();
			const redo = key === 'y' || e.shiftKey;
			const len = (redo ? state.redo : state.undo).at(-1)?.text.length ?? text.length;
			pendingSel.current = { start: len, end: len };
			draft.undoLocal(redo);
		} else if (mod && !e.altKey && (key === 'b' || key === 'i')) {
			e.preventDefault();
			toggleRun(key === 'b' ? 'bold' : 'italic');
		} else if (mod && !e.altKey && !['a', 'c', 'v', 'x'].includes(key) && key.length === 1)
			// The browser's own commands (save page, print, find) would take the focus.
			e.preventDefault();
	};

	const onBlur = (e: FocusEvent<HTMLDivElement>) => {
		if ((e.relatedTarget as Element | null)?.closest?.(`[${ENTRY_UI}]`)) return;
		if (!draft.closed) finish();
	};

	const layerCss = layer
		? layer.props.projective
			? mat3ToCss(layer.props.projective)
			: matrixToCss(layer.props.matrix)
		: `translate(${entry.point[0]}px, ${entry.point[1]}px)`;
	const box = layer?.props.box ?? { width: 0, height: 0 };
	const screenPerLocal = Math.max(1e-6, view.scale * (layer ? layerScale(layer) : 1));
	const source = layer?.clip.source;
	const autoSize = source && 'text' in source ? source.box.autoSize : 'width';
	const block = textBlockStyle({ text: content, box: { autoSize } }, doc.fonts);
	const editorStyle: CSSProperties = {
		...block,
		...(layer
			? {}
			: { transform: 'translate(-50%, -50%)', minWidth: 2, minHeight: style.sizePx * style.lineHeight }),
		border: 0,
		outline: `${1 / screenPerLocal}px dashed var(--pr-accent)`,
		outlineOffset: 3 / screenPerLocal,
		background:
			ghost || !layer ? 'transparent' : 'color-mix(in srgb, var(--pr-overlay-scrim) 60%, transparent)',
		color: ghost ? 'transparent' : rgbaCss(style.fill as never),
		// Our own caret, except while an IME draws its composition.
		caretColor: composing ? 'var(--pr-accent)' : 'transparent',
		cursor: 'text',
		pointerEvents: 'auto',
		userSelect: 'text',
	};
	const thick = 2 / screenPerLocal;
	const edge = 1 / screenPerLocal;
	const state0 = sel && sel.start !== sel.end ? runStateOf(content, sel) : null;
	const hint = vertical
		? t('Esc or a click away to finish · Enter for a new column')
		: t('Esc or a click away to finish · Enter for a new line');
	const tip = toTip(view, layer, entry.point);
	return (
		<div
			ref={hostRef}
			className="pointer-events-none absolute inset-0 overflow-hidden"
			data-testid="text-entry"
		>
			<style>{entryCss(ghost)}</style>
			<div
				style={{
					position: 'absolute',
					left: 0,
					top: 0,
					width: doc.settings.width,
					height: doc.settings.height,
					transformOrigin: '0 0',
					transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
				}}
			>
				<div
					style={{
						position: 'absolute',
						left: 0,
						top: 0,
						width: box.width,
						height: box.height,
						transformOrigin: '0 0',
						transform: layerCss,
					}}
				>
					{/* biome-ignore lint/a11y/useSemanticElements: a rich text field (styled runs) — a textarea cannot style runs */}
					<div
						ref={ref}
						role="textbox"
						tabIndex={0}
						aria-multiline
						aria-label={t('Text')}
						contentEditable="plaintext-only"
						suppressContentEditableWarning
						spellCheck={false}
						data-keymap-suspend=""
						data-testid="text-entry-input"
						data-mode={ghost ? 'ghost' : 'plain'}
						data-value={text}
						style={editorStyle}
						onInput={() => {
							if (composingRef.current) return;
							const el = ref.current;
							if (!el) return;
							const v = readText(el).replace(/\r\n?/g, '\n');
							if (v !== text) take(v, readSelection(el));
						}}
						onCompositionStart={() => {
							composingRef.current = true;
							setComposing(true);
						}}
						onCompositionEnd={() => {
							composingRef.current = false;
							setComposing(false);
							const el = ref.current;
							if (!el) return;
							const v = readText(el).replace(/\r\n?/g, '\n');
							if (v !== text) take(v, readSelection(el));
						}}
						onPaste={(e) => {
							e.preventDefault();
							e.stopPropagation();
							insert(e.clipboardData.getData('text/plain'));
						}}
						onDrop={(e) => e.preventDefault()}
						onKeyDown={onKeyDown}
						onKeyUp={(e) => e.stopPropagation()}
						onBlur={onBlur}
					/>
					{caret ? (
						<div
							data-testid="text-entry-caret"
							className="pointer-events-none"
							style={{
								position: 'absolute',
								...(vertical
									? {
											left: caret.x - caret.length / 2,
											top: caret.y - thick / 2,
											width: caret.length,
											height: thick,
										}
									: {
											left: caret.x - thick / 2,
											top: caret.y - caret.length / 2,
											width: thick,
											height: caret.length,
										}),
								// Two tones: one of them shows on any look.
								background: '#fff', // tokens-allow: fixed on purpose, over any picture
								boxShadow: `0 0 0 ${edge}px #000`, // tokens-allow: fixed on purpose, over any picture
								animation: 'text-entry-blink 1.1s step-end infinite',
							}}
						/>
					) : null}
				</div>
			</div>
			{state0 && toolbarAt ? (
				<RunToolbar
					at={toolbarAt}
					state={state0}
					look={hasLook}
					uiAttr={ENTRY_UI}
					onPatch={patchRuns}
					onDone={() => ref.current?.focus({ preventScroll: true })}
					onLeave={() => {
						if (!draft.closed) finish();
					}}
				/>
			) : null}
			<div
				className="absolute z-10 max-w-[360px] rounded-pr-control bg-pr-tooltip px-2 py-1 text-pr-small shadow"
				style={{ left: Math.max(4, tip[0]), top: tip[1] + 10 }}
				data-testid="text-entry-tip"
			>
				{error ? (
					<p className="text-pr-danger" role="alert">
						{error}
					</p>
				) : null}
				<p className="text-pr-muted">{hint}</p>
			</div>
		</div>
	);
}

/** Overlay px under the text: the lowest corner of the box. */
function toTip(view: View, layer: ResolvedLayer | undefined, point: readonly number[]): Vec2 {
	const toScreen = (p: readonly number[]): Vec2 => [view.x + p[0]! * view.scale, view.y + p[1]! * view.scale];
	if (!layer) return toScreen(point);
	const { width, height } = layer.props.box;
	const m = layer.props.matrix;
	const corners = [
		[0, 0],
		[width, 0],
		[width, height],
		[0, height],
	].map(([x, y]) => toScreen([m.a * x! + m.c * y! + m.e, m.b * x! + m.d * y! + m.f]));
	return [Math.min(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))];
}
