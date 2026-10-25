// In-place editing of anime-template text on the Program monitor (WP7b canvas-edit; design 2026-10-25 §7.5, §7.9;
// docs/wp-notes/social-comments.md "Program monitor editing"). Opened by a double-click on a template text
// (`data-template-param`, register.ts): the clip is held at its rest frame (template-edit-hold in
// @jasper/compositions), the rendered text is measured in the Program's own DOM (measure.ts) and hidden, and an editor
// takes its place — same box, font, size, colour and wrapping, mapped through the layer's Motion / corner pin and the
// monitor zoom like the layer itself.
// - Enter or a click elsewhere applies the text as one History step; Shift+Enter is a new line in multi-line params;
//   Esc cancels what was typed since the last applied step.
// - Word-marks params (`data-template-marks="true"`) are edited as their visible text: every edit is mapped back onto
//   the markup (social-comments/marks-edit.ts), so highlights, blurs and removals stay on their words. Selecting words
//   shows a floating Highlight / Blur / Remove / Clear toolbar; each button is one History step (with the text typed
//   so far).
// - Read-only projects and locked tracks never open it (register.ts); a refused apply keeps the editor open with the
//   reason, so nothing typed is lost. Any failure inside is caught and reported without touching the monitor.
import { setTemplateEditHold } from '@jasper/compositions';
import { applyMark, mgRegistry, type SocialMark, type SocialMarkKind } from '@jasper/mg-templates';
import { mat3ToCss, matrixToCss, type ResolvedLayer, type Vec2 } from '@jasper/project';
import type { EditorSession, TransportStore } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import {
	Component,
	type CSSProperties,
	type ErrorInfo,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { useStore } from 'zustand';
import type { ProgramOverlayHostProps } from '../extensions/index.ts';
import { t } from '../i18n/runtime.ts';
import { activeSequence } from '../panels/program/edits.ts';
import type { View } from '../panels/program/viewport.ts';
import { toScreen } from '../panels/program/viewport.ts';
import { decodeMarkup, replaceVisible, selectionHas, selectionMarks } from '../social-comments/marks-edit.ts';
import { resolveProgramScene } from '../three-d/scene.ts';
import { offsetAtPoint, readSelection, selectOffsets, type TextRange, wordAt } from './caret.ts';
import { layerToSequence } from './hit.ts';
import { measureTemplateLayer, type ParamBox, rootIsHeld, templateLayerRoot } from './measure.ts';
import {
	endTemplateEdit,
	showTemplateEditMessage,
	type TemplateEditMessage,
	type TemplateTextEdit,
	templateEditStore,
} from './store.ts';

/** Animation frames to wait for the held layer before giving up (≈ 2 s at 60 Hz). */
const MEASURE_FRAMES = 120;
/** Editor-local undo states kept per editing session. */
const MAX_LOCAL_UNDO = 200;
const MESSAGE_MS = 3500;

const MARK_LABELS: Record<SocialMark, string> = {
	highlight: 'Highlight',
	blur: 'Blur',
	remove: 'Remove',
};
const MARK_STEP_LABELS: Record<SocialMark | 'clear', string> = {
	highlight: 'Highlight Words',
	blur: 'Blur Words',
	remove: 'Remove Words',
	clear: 'Clear Word Marks',
};

/** Program overlay (always mounted): renders the editor or message open on this session. */
export function TemplateTextEditorHost(props: ProgramOverlayHostProps) {
	const cur = useStore(templateEditStore, (s) => s.current);
	if (!cur || cur.session !== props.session) return null;
	return (
		<EditorBoundary key={cur.seq} state={cur}>
			{cur.kind === 'message' ? (
				<EditMessage message={cur} view={props.view} />
			) : (
				<TemplateTextEditor edit={cur} {...props} />
			)}
		</EditorBoundary>
	);
}

type BoundaryProps = { state: TemplateTextEdit | TemplateEditMessage; children: ReactNode };

/** A failure inside the editor closes it with a message; the Program monitor keeps working (AGENTS §0). */
class EditorBoundary extends Component<BoundaryProps, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	componentDidCatch(error: unknown, info: ErrorInfo) {
		console.warn('[program] template text editor failed', error, info.componentStack);
		const { state } = this.props;
		setTemplateEditHold(null);
		if (state.kind === 'edit')
			showTemplateEditMessage(
				state.session,
				t(
					'Could not edit this text on the monitor: {0}',
					error instanceof Error ? error.message : String(error),
				),
				state.point,
			);
		else endTemplateEdit(state.seq);
	}

	render() {
		return this.state.failed ? null : this.props.children;
	}
}

function EditMessage({ message, view }: { message: TemplateEditMessage; view: View }) {
	useEffect(() => {
		const timer = setTimeout(() => endTemplateEdit(message.seq), MESSAGE_MS);
		return () => clearTimeout(timer);
	}, [message.seq]);
	const at = toScreen(view, message.point);
	return (
		<div
			className="pointer-events-none absolute z-10 max-w-[320px] rounded-pr-control bg-pr-tooltip px-2 py-1 text-pr-small text-pr-strong shadow"
			style={{ left: at[0], top: at[1] + 12 }}
			role="status"
			data-testid="template-text-message"
		>
			{message.text}
		</div>
	);
}

/** Playhead frame and play state (one React update per animation frame at most). */
function usePlayhead(transport: TransportStore): { frame: number; playing: boolean } {
	const [state, setState] = useState(() => {
		const s = transport.getState();
		return { frame: s.frame, playing: s.playing };
	});
	useEffect(() => {
		let raf: number | null = null;
		const flush = () => {
			raf = null;
			const s = transport.getState();
			setState((p) =>
				p.frame === s.frame && p.playing === s.playing ? p : { frame: s.frame, playing: s.playing },
			);
		};
		const off = transport.subscribe(() => {
			if (raf === null) raf = requestAnimationFrame(flush);
		});
		return () => {
			off();
			if (raf !== null) cancelAnimationFrame(raf);
		};
	}, [transport]);
	return state;
}

/** The clip's stored string value of the param (the template default when the clip does not set it). */
function storedValue(session: EditorSession, clipId: string, param: string): string | null {
	const c = activeSequence(session)?.clips[clipId];
	if (c?.kind !== 'motion-graphic') return null;
	const mg = c as { template: { id: string; version: number }; params: Record<string, unknown> };
	const v = mg.params[param];
	if (typeof v === 'string') return v;
	const d = mgRegistry.get(mg.template.id, mg.template.version)?.defaults[param];
	return typeof d === 'string' ? d : null;
}

/** Why `value` cannot be stored in the param (the template's schema), or null. */
function schemaIssue(session: EditorSession, clipId: string, param: string, value: string): string | null {
	const c = activeSequence(session)?.clips[clipId];
	if (c?.kind !== 'motion-graphic') return t('The clip no longer exists');
	const mg = c as { template: { id: string; version: number }; params: Record<string, unknown> };
	const info = mgRegistry.get(mg.template.id, mg.template.version);
	if (!info) return null;
	const r = info.paramsSchema.safeParse({ ...info.defaults, ...mg.params, [param]: value });
	if (r.success) return null;
	const issue = r.error.issues.find((i) => i.path[0] === param) ?? r.error.issues[0];
	return issue ? t('Not valid for this template: {0}', issue.message) : null;
}

function isMultiline(session: EditorSession, clipId: string, param: string): boolean {
	const c = activeSequence(session)?.clips[clipId] as
		| { template?: { id: string; version: number } }
		| undefined;
	if (!c?.template) return false;
	return mgRegistry.get(c.template.id, c.template.version)?.ui?.params?.[param]?.multiline === true;
}

type Geometry = { box: ParamBox };

function TemplateTextEditor({
	edit,
	session,
	doc,
	view,
	transport,
}: { edit: TemplateTextEdit } & ProgramOverlayHostProps) {
	const { clipId, param } = edit;
	const hostRef = useRef<HTMLDivElement>(null);
	const [geometry, setGeometry] = useState<Geometry | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	const { frame, playing } = usePlayhead(transport);
	const scene = useMemo(() => resolveProgramScene(doc, frame), [doc, frame]);
	const layer = scene.find((l) => l.clip.clipId === clipId);
	// The last place the clip was drawn: the editor stays there to apply its text when the clip leaves the monitor.
	const lastLayer = useRef(layer);
	if (layer) lastLayer.current = layer;
	const stored = useStoreSelector(session.store, () => storedValue(session, clipId, param));
	const live = useRef({ layer, geometry });
	live.current = { layer, geometry };

	// Hold the clip at rest for the editor's life, paused.
	useEffect(() => {
		if (transport.getState().playing) transport.pause();
		setTemplateEditHold(clipId);
		return () => setTemplateEditHold(null);
	}, [clipId, transport]);

	// Measure the held text in the Program's DOM; again whenever the drawn document changes (an applied step).
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measured per drawn document and layer box
	useEffect(() => {
		let raf: number | null = null;
		let frames = 0;
		let heldFrames = 0;
		const step = () => {
			raf = null;
			const scope = hostRef.current
				?.closest('[data-testid="program-viewport"]')
				?.querySelector<HTMLElement>('[data-testid="program-player-wrapper"]');
			const l = live.current.layer;
			const root = scope ? templateLayerRoot(scope, clipId) : null;
			if (root && l && rootIsHeld(root)) heldFrames++;
			// Two frames after the hold reached the DOM: the template's layout effects (fit passes) have settled.
			if (root && l && heldFrames >= 2) {
				const m = measureTemplateLayer(root, l.props.box);
				const boxes = m?.params.filter((b) => b.param === param) ?? [];
				const box = boxes[Math.min(edit.ordinal, boxes.length - 1)] ?? null;
				if (box) {
					setGeometry((g) => (g && sameBox(g.box, box) ? g : { box }));
					return;
				}
			}
			if (++frames > MEASURE_FRAMES) {
				if (!live.current.geometry)
					setFailed(t('This text is not drawn on the monitor here — edit it in Properties.'));
				return;
			}
			raf = requestAnimationFrame(step);
		};
		raf = requestAnimationFrame(step);
		return () => {
			if (raf !== null) cancelAnimationFrame(raf);
		};
	}, [doc, layer?.props.box.width, layer?.props.box.height]);

	useEffect(() => {
		if (failed) showTemplateEditMessage(session, failed, edit.point);
	}, [failed, session, edit.point]);
	// The clip was deleted (or its sequence closed): there is nothing left to apply the text to.
	useEffect(() => {
		if (stored === null) endTemplateEdit(edit.seq);
	}, [stored, edit.seq]);

	const shown = layer ?? lastLayer.current;
	if (stored === null || failed) return <div ref={hostRef} hidden />;
	// The text the editor replaces is hidden while it is open (every copy of it in this clip).
	const hideCss = `[data-testid="program-player-wrapper"] [data-clip-id="${cssString(clipId)}"] [data-template-param="${cssString(param)}"]{visibility:hidden !important}`;
	return (
		<div
			ref={hostRef}
			className="pointer-events-none absolute inset-0 overflow-hidden"
			data-testid="template-text-editor"
		>
			<style>{hideCss}</style>
			{geometry && shown ? (
				<EditorBox
					edit={edit}
					session={session}
					layer={shown}
					gone={!layer}
					box={geometry.box}
					view={view}
					seqSize={{ width: doc.settings.width, height: doc.settings.height }}
					stored={stored}
					playing={playing}
					transport={transport}
					hostRef={hostRef}
				/>
			) : null}
		</div>
	);
}

const sameBox = (a: ParamBox, b: ParamBox) =>
	Math.abs(a.rect.x - b.rect.x) < 0.01 &&
	Math.abs(a.rect.y - b.rect.y) < 0.01 &&
	Math.abs(a.rect.width - b.rect.width) < 0.01 &&
	Math.abs(a.rect.height - b.rect.height) < 0.01 &&
	Math.abs(a.scale - b.scale) < 1e-6 &&
	JSON.stringify(a.typography) === JSON.stringify(b.typography);

/** A string for a CSS attribute selector in double quotes. */
function cssString(s: string): string {
	return s.replace(/["\\]/g, '\\$&').replace(/[\n\r\f]/g, ' ');
}

/** Screen px per layer px of a layer map (the square root of its area scale). */
function layerScale(l: ResolvedLayer): number {
	const m = l.props.matrix;
	const det = Math.abs(m.a * m.d - m.b * m.c);
	return Number.isFinite(det) && det > 0 ? Math.sqrt(det) : 1;
}

type DraftState = { value: string; undo: string[]; redo: string[] };

function EditorBox({
	edit,
	session,
	layer,
	gone,
	box,
	view,
	seqSize,
	stored,
	playing,
	transport,
	hostRef,
}: {
	edit: TemplateTextEdit;
	session: EditorSession;
	layer: ResolvedLayer;
	/** The clip is no longer drawn at the playhead (the editor stays where it was). */
	gone: boolean;
	box: ParamBox;
	view: View;
	seqSize: { width: number; height: number };
	stored: string;
	playing: boolean;
	transport: TransportStore;
	hostRef: { current: HTMLDivElement | null };
}) {
	const { clipId, param, marks } = edit;
	const multiline = useMemo(() => isMultiline(session, clipId, param), [session, clipId, param]);
	const readOnly = useStoreSelector(session.store, (s) => s.readOnly);
	/** The value last applied (or found) in the document: Esc returns to it. */
	const baseline = useRef(stored);
	const [draft, setDraftState] = useState<DraftState>({ value: stored, undo: [], redo: [] });
	const [error, setError] = useState<string | null>(null);
	const [sel, setSel] = useState<TextRange | null>(null);
	const [toolbarAt, setToolbarAt] = useState<Vec2 | null>(null);
	const ref = useRef<HTMLDivElement>(null);
	const composing = useRef(false);
	const pendingSel = useRef<TextRange | null>(null);
	const closed = useRef(false);
	const visible = marks ? decodeMarkup(draft.value) : null;
	const text = visible ? visible.visible : draft.value;

	const setDraft = useCallback((value: string, opts: { record?: boolean } = {}) => {
		setDraftState((d) =>
			d.value === value
				? d
				: {
						value,
						undo: opts.record === false ? d.undo : [...d.undo, d.value].slice(-MAX_LOCAL_UNDO),
						redo: opts.record === false ? d.redo : [],
					},
		);
		setError(null);
	}, []);

	// The document changed under the editor (undo, an agent): follow it while nothing is typed.
	useEffect(() => {
		if (stored === baseline.current) return;
		setDraftState((d) => (d.value === baseline.current ? { value: stored, undo: [], redo: [] } : d));
		baseline.current = stored;
	}, [stored]);

	const finish = useCallback(() => {
		closed.current = true;
		endTemplateEdit(edit.seq);
	}, [edit.seq]);

	/** Applies `value` as one History step; false (editor kept open with the reason) when it is refused. */
	const apply = useCallback(
		(value: string, label: string): boolean => {
			if (value === baseline.current) return true;
			if (session.getState().readOnly) {
				setError(t('The project is read-only'));
				return false;
			}
			const issue = schemaIssue(session, clipId, param, value);
			if (issue) {
				setError(issue);
				return false;
			}
			let r: ReturnType<EditorSession['apply']>;
			try {
				r = session.apply({
					label,
					origin: 'user',
					commands: [{ type: 'param.set', target: ['clip', clipId, 'params', param], value }] as never,
				});
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
				return false;
			}
			if (!r.ok) {
				setError(
					r.errors[0]?.code === 'E_TRACK_LOCKED'
						? t('The clip’s track is locked')
						: r.errors.map((x) => x.message).join('; '),
				);
				return false;
			}
			baseline.current = value;
			return true;
		},
		[session, clipId, param],
	);

	const commit = useCallback(() => {
		if (closed.current) return true;
		const ok = apply(draft.value, t('Edit Text'));
		if (ok) finish();
		return ok;
	}, [apply, draft.value, finish]);

	const cancel = useCallback(() => {
		closed.current = true;
		endTemplateEdit(edit.seq);
	}, [edit.seq]);

	// Playback started: apply what was typed and close; a refused value stops playback and stays (nothing is lost).
	useEffect(() => {
		if (!playing || closed.current) return;
		if (!commit()) transport.pause();
	}, [playing, commit, transport]);
	// The playhead left the clip (or another sequence opened): apply and close; a refused value stays open.
	useEffect(() => {
		if (gone && !closed.current) commit();
	}, [gone, commit]);

	// Line breaks come from Enter only; the browser's own undo stack would fight the rebuilt DOM.
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const onBeforeInput = (e: InputEvent) => {
			const type = e.inputType ?? '';
			if (type === 'insertParagraph' || type === 'insertLineBreak' || type.startsWith('history'))
				e.preventDefault();
		};
		el.addEventListener('beforeinput', onBeforeInput);
		return () => el.removeEventListener('beforeinput', onBeforeInput);
	}, []);

	// Rebuild the DOM from the draft (marks drawn as styled runs), then restore the selection.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `visible` and `text` are derived from `draft.value`
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || composing.current) return;
		const nodes: Node[] = [];
		if (visible) {
			let run = '';
			let mark: SocialMarkKind = 'none';
			const flush = () => {
				if (!run) return;
				if (mark === 'none') nodes.push(document.createTextNode(run));
				else {
					const s = document.createElement('span');
					s.dataset.mark = mark;
					Object.assign(s.style, MARK_STYLE[mark]);
					s.textContent = run;
					nodes.push(s);
				}
				run = '';
			};
			for (let i = 0; i < visible.visible.length; i++) {
				const m = visible.marks[i] ?? 'none';
				if (m !== mark) {
					flush();
					mark = m;
				}
				run += visible.visible[i];
			}
			flush();
		} else nodes.push(document.createTextNode(text));
		if (nodes.length === 0) nodes.push(document.createTextNode(''));
		// A trailing line break needs content after it to be displayed.
		if (text.endsWith('\n')) nodes.push(document.createElement('br'));
		el.replaceChildren(...nodes);
		const want = pendingSel.current;
		pendingSel.current = null;
		if (want && document.activeElement === el) selectOffsets(el, want.start, want.end);
	}, [draft.value]);

	// Open: focus, and select the word that was double-clicked (all of it when the caret API is missing).
	// biome-ignore lint/correctness/useExhaustiveDependencies: once per editor
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.focus({ preventScroll: true });
		let range: TextRange = { start: 0, end: text.length };
		const host = hostRef.current?.getBoundingClientRect();
		if (edit.at && host) {
			const lp: Vec2 = [box.rect.x + edit.at[0] * box.rect.width, box.rect.y + edit.at[1] * box.rect.height];
			const sp = toScreen(view, layerToSequence(layer, lp));
			const off = offsetAtPoint(el, host.left + sp[0], host.top + sp[1]);
			if (off !== null) range = wordAt(text, off);
		}
		selectOffsets(el, range.start, range.end);
		setSel(range);
	}, []);

	// The selection (for the toolbar), and where to show the toolbar.
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const onSel = () => {
			if (document.activeElement !== el) return;
			const r = readSelection(el);
			setSel((p) => (p && r && p.start === r.start && p.end === r.end ? p : r));
			const host = hostRef.current?.getBoundingClientRect();
			const s = el.ownerDocument.getSelection?.();
			if (!host || !s || s.rangeCount === 0 || s.isCollapsed) return setToolbarAt(null);
			const rect = s.getRangeAt(0).getBoundingClientRect?.();
			setToolbarAt(
				rect && rect.width + rect.height > 0
					? [rect.left + rect.width / 2 - host.left, rect.top - host.top]
					: null,
			);
		};
		document.addEventListener('selectionchange', onSel);
		return () => document.removeEventListener('selectionchange', onSel);
	}, [hostRef]);

	const readText = () => {
		const el = ref.current!;
		let s = '';
		const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		let n: Node | null;
		while ((n = w.nextNode())) s += (n as Text).data;
		return s;
	};

	/** Visible text `next` (typed or pasted) → the draft (marks mapped back), selection at `caret`. */
	const takeVisible = (next: string, caret: TextRange | null) => {
		const clean = multiline ? next.replace(/\r\n?/g, '\n') : next.replace(/[\r\n]+/g, ' ');
		pendingSel.current = caret;
		setDraft(marks ? replaceVisible(draft.value, clean) : clean);
	};

	const insert = (s: string) => {
		const el = ref.current;
		if (!el) return;
		const r = readSelection(el) ?? { start: text.length, end: text.length };
		const piece = multiline ? s.replace(/\r\n?/g, '\n') : s.replace(/[\r\n]+/g, ' ');
		const next = text.slice(0, r.start) + piece + text.slice(r.end);
		const at = r.start + piece.length;
		takeVisible(next, { start: at, end: at });
	};

	const markAction = (mark: SocialMark | null) => {
		const el = ref.current;
		const r = (el && readSelection(el)) ?? sel;
		if (!r || r.start === r.end) return;
		const next = applyMark(draft.value, r, mark);
		if (next === draft.value && next === baseline.current) return;
		if (!apply(next, MARK_STEP_LABELS[mark ?? 'clear'])) return;
		pendingSel.current = r;
		setDraftState({ value: next, undo: [], redo: [] });
		if (next === draft.value && el) selectOffsets(el, r.start, r.end);
	};

	const localUndo = (redo: boolean): boolean => {
		const stack = redo ? draft.redo : draft.undo;
		if (stack.length === 0) return false;
		const value = stack[stack.length - 1]!;
		setDraftState({
			value,
			undo: redo ? [...draft.undo, draft.value] : draft.undo.slice(0, -1),
			redo: redo ? draft.redo.slice(0, -1) : [...draft.redo, draft.value],
		});
		const len = (marks ? decodeMarkup(value).visible : value).length;
		pendingSel.current = { start: len, end: len };
		return true;
	};

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		// Keys typed here never reach the editor's shortcuts.
		e.stopPropagation();
		if (e.nativeEvent.isComposing || composing.current) return;
		const mod = e.ctrlKey || e.metaKey;
		if (e.key === 'Escape') {
			e.preventDefault();
			cancel();
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (e.shiftKey && multiline) insert('\n');
			else commit();
		} else if (mod && !e.altKey && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
			// Undo / redo: what was typed first, then the History steps this editor applied.
			e.preventDefault();
			const redo = e.key === 'y' || e.key === 'Y' || e.shiftKey;
			if (localUndo(redo)) return;
			if (draft.value !== baseline.current) return;
			const r = redo ? session.redo() : session.undo();
			if (!r.ok && r.code) setError(r.code);
		}
	};

	const layerCss = layer.props.projective
		? mat3ToCss(layer.props.projective)
		: matrixToCss(layer.props.matrix);
	const k = Math.max(1e-6, box.scale);
	const ty = box.typography;
	const screenPerLocal = Math.max(1e-6, view.scale * layerScale(layer) * k);
	const editorStyle: CSSProperties = {
		position: 'absolute',
		left: box.rect.x,
		top: box.rect.y,
		transformOrigin: '0 0',
		transform: `scale(${k})`,
		boxSizing: 'border-box',
		...(ty.inline
			? { minWidth: box.rect.width / k, whiteSpace: 'pre' }
			: { width: box.rect.width / k, whiteSpace: multiline ? 'pre-wrap' : ty.whiteSpace }),
		minHeight: box.rect.height / k,
		margin: 0,
		padding: ty.padding.map((p) => `${p}px`).join(' '),
		border: 0,
		outline: `${2 / screenPerLocal}px solid var(--pr-accent)`,
		outlineOffset: 3 / screenPerLocal,
		borderRadius: 2 / screenPerLocal,
		background: ty.background ?? 'color-mix(in srgb, var(--pr-overlay-scrim) 60%, transparent)',
		color: ty.color,
		caretColor: ty.color,
		fontFamily: ty.fontFamily,
		fontSize: ty.fontSize,
		fontWeight: ty.fontWeight as CSSProperties['fontWeight'],
		fontStyle: ty.fontStyle,
		lineHeight: ty.lineHeight !== null ? `${ty.lineHeight}px` : 'normal',
		letterSpacing: `${ty.letterSpacing}px`,
		wordSpacing: `${ty.wordSpacing}px`,
		textAlign: ty.textAlign as CSSProperties['textAlign'],
		textTransform: ty.textTransform as CSSProperties['textTransform'],
		overflowWrap: ty.overflowWrap as CSSProperties['overflowWrap'],
		wordBreak: ty.wordBreak as CSSProperties['wordBreak'],
		direction: ty.direction as CSSProperties['direction'],
		cursor: 'text',
		pointerEvents: 'auto',
	};

	// Screen-space tip under the text box, toolbar over the selection (or the box's top edge).
	const corners = [
		[box.rect.x, box.rect.y],
		[box.rect.x + box.rect.width, box.rect.y],
		[box.rect.x + box.rect.width, box.rect.y + box.rect.height],
		[box.rect.x, box.rect.y + box.rect.height],
	].map((p) => toScreen(view, layerToSequence(layer, p as Vec2)));
	const minX = Math.min(...corners.map((c) => c[0]));
	const maxY = Math.max(...corners.map((c) => c[1]));
	const minY = Math.min(...corners.map((c) => c[1]));
	const midX = (Math.min(...corners.map((c) => c[0])) + Math.max(...corners.map((c) => c[0]))) / 2;
	const info = marks && sel ? selectionMarks(draft.value, sel.start, sel.end) : null;
	const showToolbar = !!info?.range && !!sel && sel.start !== sel.end;
	const tb = toolbarAt ?? [midX, minY];
	const keyHint = multiline
		? t('Enter to apply · Shift+Enter for a new line · Esc to cancel')
		: t('Enter to apply · Esc to cancel');

	return (
		<>
			<div
				style={{
					position: 'absolute',
					left: 0,
					top: 0,
					width: seqSize.width,
					height: seqSize.height,
					transformOrigin: '0 0',
					transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
				}}
			>
				<div
					style={{
						position: 'absolute',
						left: 0,
						top: 0,
						width: layer.props.box.width,
						height: layer.props.box.height,
						transformOrigin: '0 0',
						transform: layerCss,
					}}
				>
					{/* biome-ignore lint/a11y/useSemanticElements: a rich text field (styled word marks) — a textarea cannot style runs */}
					<div
						ref={ref}
						role="textbox"
						tabIndex={0}
						aria-multiline={multiline}
						aria-label={t('Edit {0}', param)}
						contentEditable={readOnly ? false : 'plaintext-only'}
						suppressContentEditableWarning
						spellCheck={false}
						data-testid="template-text-input"
						data-param={param}
						data-value={draft.value}
						style={editorStyle}
						onInput={() => {
							if (composing.current) return;
							const el = ref.current;
							if (!el) return;
							const v = readText();
							if (v !== text) takeVisible(v, readSelection(el));
						}}
						onCompositionStart={() => {
							composing.current = true;
						}}
						onCompositionEnd={() => {
							composing.current = false;
							const el = ref.current;
							if (!el) return;
							const v = readText();
							if (v !== text) takeVisible(v, readSelection(el));
						}}
						onPaste={(e) => {
							e.preventDefault();
							insert(e.clipboardData.getData('text/plain'));
						}}
						onDrop={(e) => e.preventDefault()}
						onKeyDown={onKeyDown}
						onKeyUp={(e) => e.stopPropagation()}
						onBlur={() => {
							if (!closed.current) commit();
						}}
					/>
				</div>
			</div>
			{showToolbar ? (
				<div
					role="toolbar"
					aria-label={t('Word marks')}
					className="pointer-events-auto absolute z-20 flex gap-0.5 rounded-pr-control border border-pr-border-strong bg-pr-menu-bg p-0.5 shadow"
					style={{ left: tb[0], top: tb[1] - 6, transform: 'translate(-50%, -100%)' }}
					data-testid="template-marks-toolbar"
					// Keep the editor's focus and selection while a button is pressed.
					onPointerDown={(e) => e.preventDefault()}
					onMouseDown={(e) => e.preventDefault()}
				>
					{(['highlight', 'blur', 'remove'] as const).map((m) => (
						<button
							key={m}
							type="button"
							aria-pressed={info ? selectionHas(info, m) : false}
							className="rounded-pr-control px-2 py-0.5 text-pr-small text-pr-text hover:bg-pr-hover aria-pressed:bg-pr-bg-selected-row"
							data-mark-action={m}
							disabled={readOnly}
							onClick={() => markAction(m)}
						>
							{MARK_LABELS[m]}
						</button>
					))}
					<button
						type="button"
						className="rounded-pr-control px-2 py-0.5 text-pr-small text-pr-text hover:bg-pr-hover"
						data-mark-action="clear"
						disabled={readOnly}
						onClick={() => markAction(null)}
					>
						Clear
					</button>
				</div>
			) : null}
			<div
				className="absolute z-10 max-w-[360px] rounded-pr-control bg-pr-tooltip px-2 py-1 text-pr-small shadow"
				style={{ left: Math.max(4, minX), top: maxY + 10 }}
				data-testid="template-text-tip"
			>
				{error ? (
					<p className="text-pr-danger" role="alert">
						{error}
					</p>
				) : null}
				<p className="text-pr-muted">{keyHint}</p>
			</div>
		</>
	);
}

/** Editor-only look of the marks (the template draws the real one): clear while typing, never blurred. */
const MARK_STYLE: Record<SocialMark, Partial<CSSStyleDeclaration>> = {
	highlight: {
		background: 'color-mix(in srgb, var(--pr-accent) 40%, transparent)',
		borderRadius: '0.2em',
	},
	blur: {
		textDecorationLine: 'underline',
		textDecorationStyle: 'wavy',
		textDecorationColor: 'var(--pr-accent)',
		opacity: '0.7',
	},
	remove: {
		textDecorationLine: 'line-through',
		opacity: '0.5',
	},
};
