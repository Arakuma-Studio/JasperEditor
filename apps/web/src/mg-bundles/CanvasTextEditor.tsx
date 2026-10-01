// On-canvas editing of composition texts (M3, wp-m3-mgtext, S08:MGU-005). Double-click a composition clip's text
// in the Program monitor (or "Edit on canvas" in Properties ▸ Composition): the clip switches to its live frame
// host (the bundle's own page), the page's text probe locates the text under the pointer, the rendered text is
// hidden and an editor takes its place — same box, size, weight, colour, alignment and the bundle's own fonts,
// mapped through the layer's Motion (and corner pin) like the layer itself. Enter (Ctrl+Enter for multi-line
// texts) or a click elsewhere applies the text as one History step ("Edit Text"), Esc cancels. Invalid values
// (schema) are refused with the reason; soft limits show as warnings while typing.
import { locateTexts, textProbeOf } from '@jasper/compositions';
import {
	applyMat3,
	applyMatrix,
	type CompositionTextLayer,
	checkCompositionText,
	compositionFrameAt,
	compositionSequenceFrames,
	compositionTextLayers,
	invertMat3,
	invertMatrix,
	type MgCompositionInfo,
	type MgTextMeasurement,
	mat3ToCss,
	matrixToCss,
	type RenderCompositionSource,
	type ResolvedLayer,
	resolveSceneAt,
	textLayerValue,
	validateTextEdit,
} from '@jasper/project';
import type { EditorSession, TransportStore } from '@jasper/session';
import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { ProgramOverlayHostProps } from '../extensions/index.ts';
import type { View } from '../panels/program/viewport.ts';
import { aliasFontFamily, registerBundleFonts } from './bundle-fonts.ts';
import { currentMgRuntime } from './runtime.ts';
import {
	type CanvasTextEdit,
	canvasTextEditStore,
	endCanvasTextEdit,
	requestTextFieldFocus,
} from './text-edit.ts';

type Vec2 = [number, number];
const HOST_WAIT_MS = 15_000;
/** Pointer slack around a text's line boxes, composition px. */
const HIT_SLACK = 12;

/** Program overlay (always mounted): renders the editor while one is open on this session. */
export function CanvasTextEditorHost(props: ProgramOverlayHostProps) {
	const edit = useStore(canvasTextEditStore, (s) => s.edit);
	if (!edit || edit.session !== props.session) return null;
	return (
		<CanvasTextEditor
			key={edit.seq}
			edit={edit}
			doc={props.doc as Parameters<typeof resolveSceneAt>[0]}
			view={props.view as View}
			transport={props.transport as TransportStore}
		/>
	);
}

type Target = {
	layer: CompositionTextLayer;
	original: string;
	m: MgTextMeasurement;
	fontFamily: string;
	win: Window;
};

type Phase =
	| { kind: 'waiting' }
	| { kind: 'editing'; target: Target }
	| { kind: 'message'; text: string; at: Vec2 | null };

function compositionOf(l: ResolvedLayer | undefined): RenderCompositionSource | null {
	return l && 'composition' in l.clip.source ? l.clip.source.composition : null;
}

/** The full composition info (schema, texts) of a render source, from the session's document. */
function fullInfo(session: EditorSession, src: RenderCompositionSource): MgCompositionInfo | undefined {
	return session
		.getState()
		.document.media[src.mediaId]?.mgBundle?.compositions.find((c) => c.id === src.compositionId) as
		| MgCompositionInfo
		| undefined;
}

/** The host iframe of a clip in the Program monitor. */
function hostFrame(clipId: string): HTMLIFrameElement | null {
	return document.querySelector<HTMLIFrameElement>(
		`[data-testid="program-monitor"] iframe[data-mg-host-clip="${CSS.escape(clipId)}"]`,
	);
}

/** Layer-local (= host page) point of a sequence point. */
function toLocal(l: ResolvedLayer, p: Vec2): Vec2 | null {
	if (l.props.projective) {
		const inv = invertMat3(l.props.projective);
		return inv ? (applyMat3(inv, p) as Vec2) : null;
	}
	const inv = invertMatrix(l.props.matrix);
	return inv ? (applyMatrix(inv, p) as Vec2) : null;
}

function toSequence(l: ResolvedLayer, p: Vec2): Vec2 {
	return (l.props.projective ? applyMat3(l.props.projective, p) : applyMatrix(l.props.matrix, p)) as Vec2;
}

/** The text under a page point: inside a line box (smallest wins), else the nearest box within reach. */
function textAt(ms: readonly MgTextMeasurement[], p: Vec2): MgTextMeasurement | null {
	const drawn = ms.filter((m) => m.found && m.rect);
	const inside = drawn.filter((m) =>
		(m.lines.length ? m.lines : [m.rect!]).some(
			(r) =>
				p[0] >= r.x - HIT_SLACK &&
				p[0] <= r.x + r.width + HIT_SLACK &&
				p[1] >= r.y - HIT_SLACK &&
				p[1] <= r.y + r.height + HIT_SLACK,
		),
	);
	if (inside.length)
		return inside.sort((a, b) => a.rect!.width * a.rect!.height - b.rect!.width * b.rect!.height)[0]!;
	let best: MgTextMeasurement | null = null;
	let bestD = 64;
	for (const m of drawn) {
		const r = m.rect!;
		const dx = Math.max(r.x - p[0], 0, p[0] - (r.x + r.width));
		const dy = Math.max(r.y - p[1], 0, p[1] - (r.y + r.height));
		const d = Math.hypot(dx, dy);
		if (d < bestD) {
			best = m;
			bestD = d;
		}
	}
	return best;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

function CanvasTextEditor({
	edit,
	doc,
	view,
	transport,
}: {
	edit: CanvasTextEdit;
	doc: Parameters<typeof resolveSceneAt>[0];
	view: View;
	transport: TransportStore;
}) {
	const { session, clipId } = edit;
	const [phase, setPhase] = useState<Phase>({ kind: 'waiting' });
	const { frame, playing } = usePlayhead(transport);
	const scene = useMemo(() => resolveSceneAt(doc, frame), [doc, frame]);
	const layer = scene.find((l) => l.clip.clipId === clipId);
	const src = compositionOf(layer);
	const live = useRef({ layer, src });
	live.current = { layer, src };

	// Start: live host on, playback paused, the playhead inside the clip; then locate the text and take over.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once per editor (keyed by edit.seq)
	useEffect(() => {
		const rt = currentMgRuntime();
		rt?.setTextEditing(clipId);
		if (transport.getState().playing) transport.pause();
		let cancelled = false;
		let hiddenIn: Window | null = null;
		void (async () => {
			const st = session.getState();
			const seq = st.document.sequences[st.activeSequenceId ?? ''];
			const clip = seq?.clips[clipId];
			if (!seq || !clip) return endCanvasTextEdit();
			// From Properties: show the clip at the text's measuring frame when the playhead is elsewhere.
			const f0 = transport.getState().frame;
			if (f0 < clip.start || f0 >= clip.start + clip.duration) {
				const info = st.document.media[
					(clip as { composition?: { mediaId?: string } }).composition?.mediaId ?? ''
				]?.mgBundle?.compositions.find(
					(c) => c.id === (clip as { composition?: { id?: string } }).composition?.id,
				);
				const want =
					edit.path && info
						? compositionTextLayers(info).find((l) => l.path.join('.') === edit.path!.join('.'))?.frame
						: undefined;
				const first = compositionFrameAt(clip.sourceIn, seq.settings.frameRate);
				const target =
					want !== undefined ? clip.start + (want - first) : clip.start + Math.floor(clip.duration / 2);
				transport.seek(Math.max(clip.start, Math.min(clip.start + clip.duration - 1, target)));
			}
			const until = Date.now() + HOST_WAIT_MS;
			let win: Window | null = null;
			for (;;) {
				if (cancelled) return;
				const { layer: l } = live.current;
				const f = hostFrame(clipId);
				const info = compositionOf(l)?.info;
				const total = info ? compositionSequenceFrames(info, doc.settings.fps) : 0;
				const expected =
					l && total
						? Math.max(0, Math.min(total - 1, compositionFrameAt(l.contentTime, doc.settings.fps)))
						: -1;
				if (
					f?.contentWindow &&
					f.dataset.mgHostState === 'ready' &&
					Number(f.dataset.mgHostFrame) === expected &&
					textProbeOf(f.contentWindow)
				) {
					win = f.contentWindow;
					break;
				}
				if (Date.now() > until) {
					setPhase({
						kind: 'message',
						text: 'The composition did not finish rendering; edit its text in Properties.',
						at: edit.point,
					});
					return;
				}
				await sleep(40);
			}
			const { layer: l, src: s } = live.current;
			const info = s ? fullInfo(session, s) : undefined;
			if (!l || !s || !info) return endCanvasTextEdit();
			const layers = compositionTextLayers(info);
			if (layers.length === 0) {
				setPhase({ kind: 'message', text: 'This composition exposes no texts.', at: edit.point });
				return;
			}
			const ms = locateTexts(
				win,
				layers.map((t) => ({ id: t.path.join('.'), text: textLayerValue(s.props, t) })),
				{ width: s.canvas.width, height: s.canvas.height },
			);
			let m: MgTextMeasurement | null = null;
			if (edit.path) m = ms.find((x) => x.id === edit.path!.join('.') && x.found) ?? null;
			else if (edit.point) {
				const local = toLocal(l, edit.point);
				m = local ? textAt(ms, local) : null;
			}
			if (!m && !edit.path) {
				const found = ms.filter((x) => x.found && x.visible);
				if (found.length === 1) m = found[0]!;
			}
			if (!m) {
				const path = edit.path ?? layers[0]!.path;
				setPhase({
					kind: 'message',
					text: edit.path
						? 'This text is not drawn at this frame — edit it in Properties.'
						: 'No editable text here — the composition texts are in Properties ▸ Composition.',
					at: edit.point,
				});
				requestTextFieldFocus(clipId, path);
				return;
			}
			const tl = layers.find((t) => t.path.join('.') === m!.id)!;
			// The bundle's fonts, so the editor draws with the composition's typeface.
			const probe = textProbeOf(win)!;
			const aliases = await registerBundleFonts(s.bundle?.key ?? '', probe.fonts()).catch(
				() => new Map<string, string>(),
			);
			if (cancelled) return;
			const value = textLayerValue(s.props, tl);
			probe.hide(value);
			hiddenIn = win;
			setPhase({
				kind: 'editing',
				target: {
					layer: tl,
					original: value,
					m,
					fontFamily: aliasFontFamily(m.style?.fontFamily ?? 'sans-serif', aliases),
					win,
				},
			});
		})().catch((e) => setPhase({ kind: 'message', text: String(e?.message ?? e), at: edit.point }));
		return () => {
			cancelled = true;
			if (hiddenIn) textProbeOf(hiddenIn)?.restore();
			currentMgRuntime()?.setTextEditing(null);
		};
	}, []);

	// The clip went away (deleted, playhead left it, other sequence) or playback started: close.
	useEffect(() => {
		if (phase.kind === 'waiting') return;
		if (!layer) endCanvasTextEdit();
	}, [layer, phase.kind]);
	useEffect(() => {
		if (playing) endCanvasTextEdit();
	}, [playing]);

	// Messages close themselves.
	useEffect(() => {
		if (phase.kind !== 'message') return;
		const t = setTimeout(endCanvasTextEdit, 3500);
		return () => clearTimeout(t);
	}, [phase]);

	if (phase.kind === 'waiting') return null;
	if (phase.kind === 'message') {
		const at = phase.at ? [view.x + phase.at[0] * view.scale, view.y + phase.at[1] * view.scale] : [16, 16];
		return (
			<div
				className="pointer-events-none absolute z-10 max-w-[320px] rounded-pr-control bg-pr-tooltip px-2 py-1 text-pr-small text-pr-strong shadow"
				style={{ left: at[0], top: at[1] + 12 }}
				role="status"
				data-testid="mg-text-canvas-message"
			>
				{phase.text}
			</div>
		);
	}
	if (!layer || !src) return null;
	return (
		<EditorBox
			session={session}
			clipId={clipId}
			layer={layer}
			src={src}
			view={view}
			seqSize={{ width: doc.settings.width, height: doc.settings.height }}
			target={phase.target}
		/>
	);
}

function EditorBox({
	session,
	clipId,
	layer,
	src,
	view,
	seqSize,
	target,
}: {
	session: EditorSession;
	clipId: string;
	layer: ResolvedLayer;
	src: RenderCompositionSource;
	view: View;
	seqSize: { width: number; height: number };
	target: Target;
}) {
	const { layer: tl, m } = target;
	const [text, setText] = useState(target.original);
	const [error, setError] = useState<string | null>(null);
	const ref = useRef<HTMLTextAreaElement>(null);
	const done = useRef(false);
	const info = fullInfo(session, src)!;
	const st = m.style;
	const rect = m.rect!;
	const first = m.lines[0] ?? rect;
	const lineHeight = st?.lineHeight ?? (st ? st.fontSize * 1.2 : first.height);
	const align = st?.textAlign ?? 'left';
	const anchorX =
		align === 'center'
			? rect.x + rect.width / 2
			: align === 'right' || align === 'end'
				? rect.x + rect.width
				: rect.x;
	const shift = align === 'center' ? '-50%' : align === 'right' || align === 'end' ? '-100%' : '0';
	const top = first.y - Math.max(0, (lineHeight - first.height) / 2);
	// Texts in the lower half are usually bottom-anchored (captions, lower thirds): the editor grows upwards.
	const last = m.lines[m.lines.length - 1] ?? rect;
	const anchorBottom = rect.y + rect.height / 2 > src.canvas.height / 2;
	const bottom = last.y + last.height + Math.max(0, (lineHeight - last.height) / 2);

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.focus({ preventScroll: true });
		el.select();
	}, []);

	const issues = useMemo(() => checkCompositionText(tl, text), [tl, text]);

	const finish = () => {
		done.current = true;
		endCanvasTextEdit();
	};
	const commit = () => {
		if (done.current) return;
		if (text === target.original) return finish();
		const schema = validateTextEdit(info, currentOverrides(session, clipId), [
			{ path: tl.path, value: text },
		]);
		const hard = issues.filter((i) => i.severity === 'error').map((i) => i.message);
		if (hard.length || schema.length) {
			setError(hard[0] ?? `Not valid for this composition: ${schema[0]}`);
			return;
		}
		const r = session.apply({
			label: `Edit Text «${tl.label}»`,
			origin: 'user',
			commands: [{ type: 'param.set', target: ['clip', clipId, 'props', ...tl.path], value: text }] as never,
		});
		if (!r.ok) {
			setError(r.errors.map((e) => e.message).join('; '));
			return;
		}
		finish();
	};

	const layerCss = layer.props.projective
		? mat3ToCss(layer.props.projective)
		: matrixToCss(layer.props.matrix);
	const color = opaque(st?.color ?? 'white');
	const inv = 1 / Math.max(1e-6, view.scale);
	const editorStyle: CSSProperties & { fieldSizing?: string } = {
		position: 'absolute',
		left: anchorX,
		top: anchorBottom ? bottom : top,
		transform: `translate(${shift}, ${anchorBottom ? '-100%' : '0'})`,
		minWidth: Math.max(rect.width, (st?.fontSize ?? 40) * 2),
		maxWidth: src.canvas.width * 1.5,
		margin: 0,
		padding: 0,
		border: 0,
		outline: `${2 * inv}px solid var(--pr-accent)`,
		outlineOffset: 4 * inv,
		borderRadius: 2 * inv,
		background: 'color-mix(in srgb, var(--pr-overlay-scrim) 60%, transparent)',
		color,
		caretColor: color,
		fontFamily: target.fontFamily,
		fontSize: st?.fontSize ?? 40,
		fontWeight: st?.fontWeight as CSSProperties['fontWeight'],
		fontStyle: st?.fontStyle,
		lineHeight: `${lineHeight}px`,
		letterSpacing: st ? `${st.letterSpacing}px` : undefined,
		textAlign: align as CSSProperties['textAlign'],
		textTransform: st?.textTransform as CSSProperties['textTransform'],
		whiteSpace: 'pre',
		overflow: 'hidden',
		resize: 'none',
		fieldSizing: 'content',
		pointerEvents: 'auto',
	};
	// Help/warnings under the text, in screen space (UI size, not scaled with the frame).
	// The tip goes on the side the editor does not grow to.
	const below = toSequence(layer, [
		anchorX,
		anchorBottom ? bottom : rect.y + Math.max(rect.height, lineHeight),
	]);
	const tip = [view.x + below[0] * view.scale, view.y + below[1] * view.scale];
	const warn = error ?? issues.find((i) => i.severity !== 'info')?.message ?? null;
	const keyHint = tl.multiline
		? 'Ctrl+Enter to apply · Enter for a new line · Esc to cancel'
		: 'Enter to apply · Esc to cancel';
	return (
		<div className="pointer-events-none absolute inset-0 overflow-hidden" data-testid="mg-text-canvas-editor">
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
					<textarea
						ref={ref}
						aria-label={`Edit ${tl.label}`}
						data-testid="mg-text-canvas-input"
						data-text-path={tl.path.join('.')}
						spellCheck={false}
						rows={1}
						value={text}
						style={editorStyle}
						onChange={(e) => {
							setText(e.target.value);
							setError(null);
						}}
						onBlur={commit}
						onKeyDown={(e) => {
							e.stopPropagation();
							if (e.key === 'Escape') {
								e.preventDefault();
								finish();
							} else if (e.key === 'Enter' && (!tl.multiline || e.ctrlKey || e.metaKey)) {
								e.preventDefault();
								commit();
							}
						}}
						onKeyUp={(e) => e.stopPropagation()}
					/>
				</div>
			</div>
			<div
				className="absolute z-10 max-w-[360px] rounded-pr-control bg-pr-tooltip px-2 py-1 text-pr-small shadow"
				style={{ left: tip[0], top: tip[1] + 10, transform: `translateX(${shift})` }}
				data-anchor={anchorBottom ? 'bottom' : 'top'}
				data-testid="mg-text-canvas-tip"
			>
				{warn ? (
					<p className={error ? 'text-pr-danger' : 'text-pr-warning'} role={error ? 'alert' : 'status'}>
						{warn}
					</p>
				) : null}
				<p className="text-pr-muted">
					{tl.label} · {keyHint}
				</p>
			</div>
		</div>
	);
}

function currentOverrides(session: EditorSession, clipId: string): Record<string, unknown> {
	const s = session.getState();
	const c = s.document.sequences[s.activeSequenceId ?? '']?.clips[clipId] as
		| { props?: Record<string, unknown> }
		| undefined;
	return c?.props ?? {};
}

/** The text's colour without its (animated) transparency: the editor must stay readable. */
function opaque(css: string): string {
	const m = /^rgba\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*[\d.]+\s*\)$/i.exec(css.trim());
	return m ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : css; // tokens-allow: document colour (composition text)
}
