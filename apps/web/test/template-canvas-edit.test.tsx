// Program-monitor text editing of anime templates (WP7b canvas-edit, docs/wp-notes/social-comments.md "Program monitor
// editing"): hit-testing, DOM measurement, the double-click handler and the in-place editor (commit, cancel, word marks
// kept through edits, the marks toolbar, undo/redo, refusals and crash isolation). The Program's rendered template
// is faked here (happy-dom has no layout: boxes come from `data-rect`); e2e/template-canvas-edit.spec.ts runs the real
// Player in Chrome.
import { setTemplateEditHold, useTemplateEditHold } from '@jasper/compositions';
import {
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
	type ResolvedLayer,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const flags = vi.hoisted(() => ({ sceneBoom: false }));

vi.mock('../src/three-d/scene.ts', async (importOriginal) => {
	const m = await importOriginal<typeof import('../src/three-d/scene.ts')>();
	return {
		...m,
		resolveProgramScene: (...a: Parameters<typeof m.resolveProgramScene>) => {
			if (flags.sceneBoom) throw new Error('boom');
			return m.resolveProgramScene(...a);
		},
	};
});

vi.mock('@jasper/mg-templates', async (importOriginal) => {
	const m = await importOriginal<typeof import('@jasper/mg-templates')>();
	const { CANVAS_EDIT_TEMPLATE } = await import('./fixtures/canvas-edit-template.ts');
	return { ...m, mgRegistry: m.createMgRegistry([...m.MG_CATALOG, CANVAS_EDIT_TEMPLATE]) };
});

const { mgRegistry } = await import('@jasper/mg-templates');
const { pickTemplateParam } = await import('../src/template-edit/hit.ts');
const { measureTemplateLayer, templateLayerRoot } = await import('../src/template-edit/measure.ts');
const { templateTextDoubleClick, isAnimeTemplateLayer } = await import('../src/template-edit/register.ts');
const { TemplateTextEditorHost } = await import('../src/template-edit/TemplateTextEditor.tsx');
const { templateEditStore, endTemplateEdit } = await import('../src/template-edit/store.ts');
const caretModule = await import('../src/template-edit/caret.ts');
const { wordAt } = caretModule;
const { resolveProgramScene } = await import('../src/three-d/scene.ts');
const { monitorStores } = await import('../src/panels/program/monitor-store.ts');

type LayerMeasurement = import('../src/template-edit/measure.ts').LayerMeasurement;

// ---------------------------------------------------------------------------------------------------------------
// Fixtures

function newSession(document?: ProjectDocument, readOnly = false) {
	const ids = createCounterIdSource(1);
	const doc = document ?? createEmptyProject({ ids, name: 'Canvas edit', preset: 'hd-1080p-30' });
	return new EditorSession({
		projectId: doc.projectId,
		document: doc,
		ctx: { ids, now: () => 't', registries: defaultRegistries(mgRegistry) },
		coalesceWindowMs: 0,
		readOnly,
	});
}

function addTemplate(
	session: EditorSession,
	track: string,
	params: Record<string, unknown> = {},
	extra: unknown[] = [],
): string {
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		commands: [
			{
				type: 'clip.addMotionGraphic',
				at: 0,
				duration: 90,
				track,
				template: { id: 'canvas-edit-test', version: 1 },
				params,
				ref: '$t',
			},
			...extra,
		] as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return r.refs.$t!;
}

const snapshot = (session: EditorSession) =>
	buildRenderSnapshot(session.getDrawn(), session.getState().activeSequenceId!, {
		resolveMedia: () => null,
		resolveFont: () => null,
	});

const paramsOf = (session: EditorSession, clipId: string) =>
	(
		session.getCommitted().sequences[session.getState().activeSequenceId!]!.clips[clipId] as unknown as {
			params: Record<string, unknown>;
		}
	).params;

const trackOf = (session: EditorSession, clipId: string) =>
	session.getCommitted().sequences[session.getState().activeSequenceId!]!.clips[clipId]!.trackId;

/** Labels of the applied History entries. */
const historyLabels = (session: EditorSession) => {
	const h = session.getState().history;
	return h.entries.slice(0, h.index).map((e) => e.label);
};

// Layout of the fake Program: view scale 0.5 at the viewport origin, layer box 1920×1080 (identity Motion).
// Element boxes in screen px (`data-rect`), `data-k` = screen px per element px, `data-font` = element font px.
const VIEW = { scale: 0.5, x: 0, y: 0 };
const NAME_RECT = '100,400,200,30'; // layer px 200,800 400×60
const TEXT_RECT = '100,435,400,60'; // layer px 200,870 800×120
const CARD_RECT = '90,390,420,110';

function rectOf(el: Element): DOMRect {
	const d = (el as HTMLElement).dataset?.rect;
	if (d) {
		const [x, y, w, h] = d.split(',').map(Number) as [number, number, number, number];
		return new DOMRect(x, y, w, h);
	}
	const h = el as HTMLElement;
	if (h.getAttribute?.('aria-hidden') === 'true' && h.style?.width === '100px') {
		const p = h.parentElement!;
		const k = Number(p.dataset.k ?? 1);
		const f = Number(p.dataset.font ?? 16);
		return new DOMRect(0, 0, 100 * k, f * k);
	}
	return new DOMRect(0, 0, 0, 0);
}

/** What the Player draws for a template clip (as MotionGraphicLayer + LayerBox do: hold attribute, layer root). */
function FakeLayer({ clipId, text, name }: { clipId: string; text: string; name: string }) {
	const held = useTemplateEditHold(clipId);
	return (
		<div
			data-clip-id={clipId}
			data-kind="motion-graphic"
			data-rect="0,0,960,540"
			style={{ transform: 'matrix(1, 0, 0, 1, 0, 0)' }}
		>
			<div data-mg-renderer="anime" data-template-hold={held ? 'true' : undefined}>
				<div data-rect={CARD_RECT} style={{ backgroundColor: 'white' }}>
					<div data-template-param="name" data-rect={NAME_RECT} data-k="0.5" data-font="30">
						{name}
					</div>
					<div
						data-template-param="text"
						data-template-marks="true"
						data-rect={TEXT_RECT}
						data-k="0.5"
						data-font="40"
						style={{ lineHeight: '48px', color: 'black' }}
					>
						{text}
					</div>
				</div>
			</div>
		</div>
	);
}

function mountProgram(session: EditorSession, clipIds: string[]) {
	session.transport.setMaxFrame(10_000);
	const Program = () => {
		// Re-renders with the document, like the Program monitor's Player does.
		useStoreSelector(session.store, (s) => s.transient ?? s.document);
		const doc = snapshot(session);
		return (
			<div data-testid="program-viewport">
				<div data-testid="program-player-wrapper">
					{clipIds.map((id) => {
						const p = paramsOf(session, id);
						return <FakeLayer key={id} clipId={id} text={String(p.text)} name={String(p.name)} />;
					})}
				</div>
				<svg data-testid="program-overlay" />
				<TemplateTextEditorHost
					session={session}
					doc={doc}
					view={VIEW}
					viewport={{ width: 960, height: 540 }}
					transport={session.transport}
					monitor={monitorStores.program.getState()}
				/>
			</div>
		);
	};
	const r = render(<Program />);
	return { ...r, unsub: () => {} };
}

function dblclick(session: EditorSession, point: [number, number], frame = 30): boolean {
	const scene = resolveProgramScene(snapshot(session), frame);
	return templateTextDoubleClick({
		session,
		clip: null,
		point,
		frame,
		scene,
		viewScale: VIEW.scale,
		surface: screen.getByTestId('program-overlay'),
	});
}

/** Sequence px of a screen rect's centre (view 0.5 at the origin; the layer map is the identity). */
const centreOf = (rect: string): [number, number] => {
	const [x, y, w, h] = rect.split(',').map(Number) as [number, number, number, number];
	return [(x + w / 2) / VIEW.scale, (y + h / 2) / VIEW.scale];
};

let caretAt: number | null = null;

beforeEach(() => {
	vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
		return rectOf(this);
	});
	// The caret API (absent in happy-dom): the offset the test chooses, in the editor's first text run.
	caretAt = null;
	(document as unknown as { caretRangeFromPoint?: unknown }).caretRangeFromPoint = () => {
		const input = document.querySelector('[data-testid="template-text-input"]');
		if (caretAt === null || !input) return null;
		const walker = document.createTreeWalker(input, NodeFilter.SHOW_TEXT);
		let n = 0;
		let t: Node | null;
		while ((t = walker.nextNode())) {
			const len = (t as Text).data.length;
			if (caretAt <= n + len) {
				const r = document.createRange();
				r.setStart(t, caretAt - n);
				return r;
			}
			n += len;
		}
		return null;
	};
});

afterEach(() => {
	act(() => endTemplateEdit());
	setTemplateEditHold(null);
	cleanup();
	vi.restoreAllMocks();
	delete (document as unknown as { caretRangeFromPoint?: unknown }).caretRangeFromPoint;
});

// ---------------------------------------------------------------------------------------------------------------

describe('pickTemplateParam (hit-testing)', () => {
	const box = (param: string, x: number, y: number, w: number, h: number) => ({
		param,
		marks: false,
		rect: { x, y, width: w, height: h },
		scale: 1,
		typography: {} as never,
	});
	function scene(session: EditorSession, frame = 30): ResolvedLayer[] {
		return resolveProgramScene(snapshot(session), frame);
	}

	it('finds the text under the point in layer px, with where in the box it landed', () => {
		const session = newSession();
		const a = addTemplate(session, 'V1');
		const m: LayerMeasurement = { params: [box('text', 100, 100, 400, 100)], opaque: [] };
		const hit = pickTemplateParam(scene(session), [200, 125], {
			viewScale: 0.5,
			selected: new Set(),
			isTemplate: isAnimeTemplateLayer,
			measure: () => m,
		})!;
		expect(hit.layer.clip.clipId).toBe(a);
		expect(hit.box.param).toBe('text');
		expect(hit.at[0]).toBeCloseTo(0.25);
		expect(hit.at[1]).toBeCloseTo(0.25);
		expect(
			pickTemplateParam(scene(session), [900, 900], {
				viewScale: 0.5,
				selected: new Set(),
				isTemplate: isAnimeTemplateLayer,
				measure: () => m,
			}),
		).toBeNull();
	});

	it('the topmost hit wins; a card body above blocks the text below; a selected clip wins over the topmost', () => {
		const session = newSession();
		const low = addTemplate(session, 'V1');
		const high = addTemplate(session, 'V2');
		const ms: Record<string, LayerMeasurement> = {
			[low]: { params: [box('text', 100, 100, 400, 100)], opaque: [] },
			[high]: {
				params: [box('name', 100, 100, 200, 40)],
				opaque: [{ x: 50, y: 50, width: 600, height: 300 }],
			},
		};
		const opts = (selected: string[]) => ({
			viewScale: 1,
			selected: new Set(selected),
			isTemplate: isAnimeTemplateLayer,
			measure: (l: ResolvedLayer) => ms[l.clip.clipId] ?? null,
		});
		// Both texts under the point: the upper card's.
		expect(pickTemplateParam(scene(session), [150, 120], opts([]))!.layer.clip.clipId).toBe(high);
		// Only the lower text there, but the upper card's body covers it.
		expect(pickTemplateParam(scene(session), [450, 180], opts([]))).toBeNull();
		// Selected in the Timeline: the lower card is reachable.
		expect(pickTemplateParam(scene(session), [150, 120], opts([low]))!.layer.clip.clipId).toBe(low);
		// The upper card on a locked track: it is still the hit (refused by the caller), even with the lower one selected.
		expect(
			pickTemplateParam(scene(session), [150, 120], {
				...opts([low]),
				locked: new Set([trackOf(session, high)]),
			})!.layer.clip.clipId,
		).toBe(high);
		// A selected card on a locked track does not win over the topmost unlocked one.
		expect(
			pickTemplateParam(scene(session), [150, 120], {
				...opts([low]),
				locked: new Set([trackOf(session, low)]),
			})!.layer.clip.clipId,
		).toBe(high);
		// Outside the upper card: the lower text is hit (templates are transparent elsewhere).
		ms[high] = { params: [box('name', 100, 100, 200, 40)], opaque: [] };
		expect(pickTemplateParam(scene(session), [450, 180], opts([]))!.layer.clip.clipId).toBe(low);
	});

	it('another layer above blocks the template; a layer that cannot be measured is transparent', () => {
		const session = newSession();
		addTemplate(session, 'V1');
		const r = session.apply({
			label: 'solid',
			origin: 'user',
			commands: [
				{ type: 'clip.addShape', at: 0, track: 'V2', shape: { type: 'rect', size: [400, 400] } },
			] as never,
		});
		expect(r.ok).toBe(true);
		const m: LayerMeasurement = { params: [box('text', 700, 300, 520, 480)], opaque: [] };
		const opts = {
			viewScale: 1,
			selected: new Set<string>(),
			isTemplate: isAnimeTemplateLayer,
			measure: () => m,
		};
		// The rectangle (centred, 400×400) covers the frame centre.
		expect(pickTemplateParam(scene(session), [960, 540], opts)).toBeNull();
		// Beside the rectangle the text is reachable.
		expect(pickTemplateParam(scene(session), [720, 320], opts)!.box.param).toBe('text');
		expect(pickTemplateParam(scene(session), [720, 320], { ...opts, measure: () => null })).toBeNull();
	});

	it('maps through the layer Motion (rotation, scale) and keeps a few screen px of slack', () => {
		const session = newSession();
		addTemplate(session, 'V1', {}, [
			{ type: 'param.set', target: ['clip', '$t', 'transform', 'rotation'], value: 90 },
			{ type: 'param.set', target: ['clip', '$t', 'transform', 'scale'], value: 50 },
		]);
		const m: LayerMeasurement = { params: [box('text', 100, 100, 400, 100)], opaque: [] };
		const opts = {
			viewScale: 1,
			selected: new Set<string>(),
			isTemplate: isAnimeTemplateLayer,
			measure: () => m,
		};
		// Rotation 90° and 50% around [960, 540]: local [300, 150] lands at [1155, 210].
		const hit = pickTemplateParam(scene(session), [1155, 210], opts)!;
		expect(hit.box.param).toBe('text');
		expect(hit.local[0]).toBeCloseTo(300);
		expect(hit.local[1]).toBeCloseTo(150);
		// 2 screen px outside the box edge (4 layer px at 50 %): still a hit; 40 screen px: not.
		expect(pickTemplateParam(scene(session), [1182, 210], opts)).not.toBeNull();
		expect(pickTemplateParam(scene(session), [1220, 210], opts)).toBeNull();
	});

	it('the innermost of nested editable boxes wins', () => {
		const session = newSession();
		addTemplate(session, 'V1');
		const m: LayerMeasurement = {
			params: [box('text', 0, 0, 1000, 1000), box('name', 100, 100, 50, 50)],
			opaque: [],
		};
		const opts = {
			viewScale: 1,
			selected: new Set<string>(),
			isTemplate: isAnimeTemplateLayer,
			measure: () => m,
		};
		expect(pickTemplateParam(scene(session), [120, 120], opts)!.box.param).toBe('name');
		expect(pickTemplateParam(scene(session), [500, 500], opts)!.box.param).toBe('text');
	});

	it('never throws on arbitrary points and boxes (fast-check)', () => {
		const session = newSession();
		addTemplate(session, 'V1');
		const sc = scene(session);
		fc.assert(
			fc.property(
				fc.tuple(fc.double(), fc.double()),
				fc.array(fc.tuple(fc.double(), fc.double(), fc.double(), fc.double()), { maxLength: 5 }),
				fc.double({ min: 0, max: 100 }),
				(p, boxes, scale) => {
					const m: LayerMeasurement = {
						params: boxes.map(([x, y, w, h]) => box('text', x, y, w, h)),
						opaque: [],
					};
					const hit = pickTemplateParam(sc, p, {
						viewScale: scale,
						selected: new Set(),
						isTemplate: isAnimeTemplateLayer,
						measure: () => m,
					});
					if (hit) {
						expect(hit.at[0]).toBeGreaterThanOrEqual(0);
						expect(hit.at[0]).toBeLessThanOrEqual(1);
					}
				},
			),
		);
	});
});

describe('measureTemplateLayer (rendered DOM → layer px)', () => {
	it('reads boxes, scale, font size and the card background with the layer transform switched off', () => {
		const transforms: string[] = [];
		const session = newSession();
		const id = addTemplate(session, 'V1');
		const r = render(
			<div data-testid="program-player-wrapper">
				<FakeLayer clipId={id} text="Hello big world" name="username" />
			</div>,
		);
		const root = templateLayerRoot(r.container, id)!;
		expect(root).toBeTruthy();
		vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(function (this: Element) {
			if (this === root) transforms.push(root.style.transform);
			return rectOf(this);
		});
		const m = measureTemplateLayer(root, { width: 1920, height: 1080 })!;
		expect(transforms.every((t) => t === 'none')).toBe(true);
		expect(root.style.transform).toBe('matrix(1, 0, 0, 1, 0, 0)');
		const text = m.params.find((b) => b.param === 'text')!;
		expect(text.marks).toBe(true);
		expect(text.rect).toEqual({ x: 200, y: 870, width: 800, height: 120 });
		expect(text.scale).toBeCloseTo(1);
		expect(text.typography.fontSize).toBeCloseTo(40);
		expect(text.typography.background).toBe('white');
		expect(m.params.find((b) => b.param === 'name')!.marks).toBe(false);
		// The card body is painted (it blocks clicks to layers below).
		expect(m.opaque).toContainEqual({ x: 180, y: 780, width: 840, height: 220 });
		// The probes are gone.
		expect(root.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0);
	});

	it('returns null for a layer that is not laid out, and ignores malformed param names', () => {
		const session = newSession();
		const id = addTemplate(session, 'V1');
		const r = render(
			<div data-clip-id={id} data-rect="0,0,960,540">
				<div data-mg-renderer="anime">
					<div data-template-param="not a name" data-rect="0,0,10,10">
						x
					</div>
				</div>
			</div>,
		);
		const root = r.container.firstElementChild as HTMLElement;
		expect(measureTemplateLayer(root, { width: 0, height: 0 })).toBeNull();
		expect(measureTemplateLayer(root, { width: 1920, height: 1080 })!.params).toEqual([]);
	});
});

describe('wordAt', () => {
	it('grows a caret to its word; between spaces it stays a caret', () => {
		expect(wordAt('Hello big world', 7)).toEqual({ start: 6, end: 9 });
		expect(wordAt('Hello big world', 9)).toEqual({ start: 6, end: 9 });
		expect(wordAt('a  b', 2)).toEqual({ start: 2, end: 2 });
		expect(wordAt('', 5)).toEqual({ start: 0, end: 0 });
	});
});

// ---------------------------------------------------------------------------------------------------------------

async function openEditor(session: EditorSession, id: string, at = centreOf(TEXT_RECT)) {
	const ui = mountProgram(session, [id]);
	let handled = false;
	act(() => {
		handled = dblclick(session, at);
	});
	expect(handled).toBe(true);
	const input = await screen.findByTestId('template-text-input');
	return { ui, input };
}

const press = (el: Element, key: string, opts: Record<string, unknown> = {}) =>
	act(() => {
		fireEvent.keyDown(el, { key, ...opts });
	});

/** Types visible text by replacing the editor's content (what the browser's editing does) and firing input. */
function typeVisible(el: HTMLElement, visible: string) {
	act(() => {
		el.textContent = visible;
		fireEvent.input(el);
	});
}

describe('double-click → in-place editor', () => {
	it('opens on the text under the pointer, holds the clip at rest, hides the original and selects the clicked word', async () => {
		const session = newSession();
		const id = addTemplate(session, 'V1', { text: 'Hello ==big== world' });
		caretAt = 7;
		const { input, ui } = await openEditor(session, id);
		const edit = templateEditStore.getState().current!;
		expect(edit).toMatchObject({ kind: 'edit', clipId: id, param: 'text', marks: true });
		expect(session.getState().selection.timeline.clips).toEqual([id]);
		expect(ui.container.querySelector(`[data-clip-id="${id}"] [data-template-hold="true"]`)).not.toBeNull();
		expect(ui.container.querySelector('style')!.textContent).toContain('[data-template-param="text"]');
		// The visible text, with the mark drawn as a styled run.
		expect(input.textContent).toBe('Hello big world');
		expect(input.querySelector('[data-mark="highlight"]')!.textContent).toBe('big');
		expect(input.getAttribute('data-value')).toBe('Hello ==big== world');
		// Placed on the measured box (layer px) with the element's scale.
		expect(input.style.left).toBe('200px');
		expect(input.style.top).toBe('870px');
		expect(input.style.transform).toBe('scale(1)');
		expect(input.style.fontSize).toBe('40px');
		const sel = document.getSelection()!;
		expect(sel.toString()).toBe('big');
		ui.unsub();
	});

	it('typing keeps the marks on their words; Enter applies one "Edit Text" step; undo / redo', async () => {
		const session = newSession();
		const id = addTemplate(session, 'V1', { text: 'Hello ==big== world' });
		const { input, ui } = await openEditor(session, id);
		const before = historyLabels(session).length;
		typeVisible(input, 'Hello big wide world');
		expect(input.getAttribute('data-value')).toBe('Hello ==big== wide world');
		typeVisible(input, 'Oh Hello big wide world');
		typeVisible(input, 'Oh Hello bigger wide world');
		expect(input.getAttribute('data-value')).toBe('Oh Hello ==bigger== wide world');
		press(input, 'Enter');
		expect(paramsOf(session, id).text).toBe('Oh Hello ==bigger== wide world');
		expect(historyLabels(session).slice(before)).toEqual(['Edit Text']);
		expect(templateEditStore.getState().current).toBeNull();
		act(() => {
			session.undo();
		});
		expect(paramsOf(session, id).text).toBe('Hello ==big== world');
		act(() => {
			session.redo();
		});
		expect(paramsOf(session, id).text).toBe('Oh Hello ==bigger== wide world');
		ui.unsub();
	});

	it('Esc cancels; Shift+Enter is a new line in a multi-line param; blur applies', async () => {
		const session = newSession();
		const id = addTemplate(session, 'V1', { text: 'Line' });
		let { input, ui } = await openEditor(session, id);
		typeVisible(input, 'Changed');
		press(input, 'Escape');
		expect(templateEditStore.getState().current).toBeNull();
		expect(paramsOf(session, id).text).toBe('Line');
		ui.unsub();
		cleanup();

		({ input, ui } = await openEditor(session, id));
		// Caret at the end, then Shift+Enter.
		act(() => {
			input.focus();
			const r = document.createRange();
			r.selectNodeContents(input);
			r.collapse(false);
			document.getSelection()!.removeAllRanges();
			document.getSelection()!.addRange(r);
		});
		press(input, 'Enter', { shiftKey: true });
		expect(input.getAttribute('data-value')).toBe('Line\n');
		expect(templateEditStore.getState().current).not.toBeNull();
		typeVisible(input, 'Line\ntwo');
		act(() => {
			fireEvent.blur(input);
		});
		expect(paramsOf(session, id).text).toBe('Line\ntwo');
		expect(templateEditStore.getState().current).toBeNull();
		ui.unsub();
	});

	it('a single-line param turns pasted / typed line breaks into spaces and applies on Shift+Enter too', async () => {
		const session = newSession();
		const id = addTemplate(session, 'V1', { name: 'ada' });
		const { input, ui } = await openEditor(session, id, centreOf(NAME_RECT));
		expect(templateEditStore.getState().current).toMatchObject({ param: 'name', marks: false });
		typeVisible(input, 'ada\nlovelace');
		expect(input.getAttribute('data-value')).toBe('ada lovelace');
		press(input, 'Enter', { shiftKey: true });
		expect(paramsOf(session, id).name).toBe('ada lovelace');
		ui.unsub();
	});

	it('the marks toolbar applies Highlight / Blur / Remove / Clear to the selected words, one step each', async () => {
		const session = newSession();
		const id = addTemplate(session, 'V1', { text: 'Hello ==big== world' });
		caretAt = 1;
		const { input, ui } = await openEditor(session, id);
		// "Hello" is selected (the double-clicked word): the toolbar shows.
		const toolbar = screen.getByTestId('template-marks-toolbar');
		const before = historyLabels(session).length;
		act(() => {
			fireEvent.click(toolbar.querySelector('[data-mark-action="blur"]')!);
		});
		expect(paramsOf(session, id).text).toBe('||Hello|| ==big== world');
		expect(input.querySelector('[data-mark="blur"]')!.textContent).toBe('Hello');
		// Typing then a mark: one step with both.
		typeVisible(input, 'Hello big world!');
		act(() => {
			const { selectOffsets } = caretModule;
			selectOffsets(input, 10, 15);
			document.dispatchEvent(new Event('selectionchange'));
		});
		act(() => {
			fireEvent.click(
				screen.getByTestId('template-marks-toolbar').querySelector('[data-mark-action="remove"]')!,
			);
		});
		expect(paramsOf(session, id).text).toBe('||Hello|| ==big== ~~world!~~');
		act(() => {
			caretModule.selectOffsets(input, 0, 15);
			document.dispatchEvent(new Event('selectionchange'));
		});
		act(() => {
			fireEvent.click(
				screen.getByTestId('template-marks-toolbar').querySelector('[data-mark-action="clear"]')!,
			);
		});
		expect(paramsOf(session, id).text).toBe('Hello big world!');
		act(() => {
			caretModule.selectOffsets(input, 6, 9);
			document.dispatchEvent(new Event('selectionchange'));
		});
		const hl = screen.getByTestId('template-marks-toolbar').querySelector('[data-mark-action="highlight"]')!;
		act(() => {
			fireEvent.click(hl);
		});
		expect(paramsOf(session, id).text).toBe('Hello ==big== world!');
		expect(historyLabels(session).slice(before)).toEqual([
			'Blur Words',
			'Remove Words',
			'Clear Word Marks',
			'Highlight Words',
		]);
		// The editor is still open and in sync; undo (from inside the editor, nothing typed) reverts the last step.
		expect(templateEditStore.getState().current).not.toBeNull();
		press(input, 'z', { ctrlKey: true });
		expect(paramsOf(session, id).text).toBe('Hello big world!');
		expect(input.getAttribute('data-value')).toBe('Hello big world!');
		press(input, 'z', { ctrlKey: true, shiftKey: true });
		expect(paramsOf(session, id).text).toBe('Hello ==big== world!');
		ui.unsub();
	});

	it('Ctrl+Z inside the editor first undoes typing locally (no History entry)', async () => {
		const session = newSession();
		const id = addTemplate(session, 'V1', { text: 'abc' });
		const { input, ui } = await openEditor(session, id);
		const before = historyLabels(session).length;
		typeVisible(input, 'abcd');
		typeVisible(input, 'abcde');
		press(input, 'z', { ctrlKey: true });
		expect(input.getAttribute('data-value')).toBe('abcd');
		press(input, 'y', { ctrlKey: true });
		expect(input.getAttribute('data-value')).toBe('abcde');
		expect(historyLabels(session)).toHaveLength(before);
		press(input, 'Escape');
		expect(paramsOf(session, id).text).toBe('abc');
		ui.unsub();
	});

	it('a value the template refuses keeps the editor open with the reason (nothing typed is lost)', async () => {
		const session = newSession();
		const id = addTemplate(session, 'V1', { name: 'ada' });
		const { input, ui } = await openEditor(session, id, centreOf(NAME_RECT));
		const before = historyLabels(session).length;
		typeVisible(input, 'x'.repeat(30));
		press(input, 'Enter');
		expect(screen.getByRole('alert').textContent).toMatch(/Not valid for this template/);
		expect(templateEditStore.getState().current).not.toBeNull();
		expect(input.getAttribute('data-value')).toBe('x'.repeat(30));
		expect(historyLabels(session)).toHaveLength(before);
		expect(paramsOf(session, id).name).toBe('ada');
		ui.unsub();
	});

	it('playback start applies what was typed and closes', async () => {
		const session = newSession();
		const id = addTemplate(session, 'V1', { text: 'one' });
		const { input, ui } = await openEditor(session, id);
		typeVisible(input, 'one two');
		act(() => session.transport.play());
		await vi.waitFor(() => expect(templateEditStore.getState().current).toBeNull());
		expect(paramsOf(session, id).text).toBe('one two');
		act(() => session.transport.pause());
		ui.unsub();
	});

	it('the playhead leaving the clip applies the text and closes', async () => {
		const session = newSession();
		const id = addTemplate(session, 'V1', { text: 'one' });
		const { input, ui } = await openEditor(session, id);
		typeVisible(input, 'one two');
		act(() => session.transport.seek(500)); // past the clip's end (90)
		await vi.waitFor(() => expect(templateEditStore.getState().current).toBeNull());
		expect(paramsOf(session, id).text).toBe('one two');
		ui.unsub();
	});
});

describe('refusals', () => {
	it('a locked track refuses with a message; nothing opens (even with an unlocked card selected below)', () => {
		const session = newSession();
		const low = addTemplate(session, 'V1');
		const top = addTemplate(session, 'V2');
		session.apply({
			label: 'lock',
			origin: 'user',
			commands: [{ type: 'track.update', trackId: 'V2', patch: { locked: true } }] as never,
		});
		// What the first click of the double-click does: the unlocked layer under the locked one is selected.
		session.select('timeline', [low], 'replace', { primary: low });
		const ui = mountProgram(session, [low, top]);
		let handled = false;
		act(() => {
			handled = dblclick(session, centreOf(TEXT_RECT));
		});
		expect(handled).toBe(true);
		expect(screen.getByTestId('template-text-message').textContent).toBe('The clip’s track is locked');
		expect(screen.queryByTestId('template-text-input')).toBeNull();
		ui.unsub();
	});

	it('a read-only project refuses with a message', () => {
		const setup = newSession();
		const id = addTemplate(setup, 'V1');
		const session = newSession(setup.getCommitted(), true);
		const ui = mountProgram(session, [id]);
		let handled = false;
		act(() => {
			handled = dblclick(session, centreOf(TEXT_RECT));
		});
		expect(handled).toBe(true);
		expect(screen.getByTestId('template-text-message').textContent).toBe('The project is read-only');
		expect(screen.queryByTestId('template-text-input')).toBeNull();
		ui.unsub();
	});

	it('a double-click off every template text is left to the other handlers', () => {
		const session = newSession();
		const id = addTemplate(session, 'V1');
		const ui = mountProgram(session, [id]);
		expect(dblclick(session, [1800, 50])).toBe(false);
		expect(templateEditStore.getState().current).toBeNull();
		ui.unsub();
	});

	it('a text that is not drawn after the hold gives a message instead of an editor', async () => {
		const session = newSession();
		const id = addTemplate(session, 'V1');
		const ui = mountProgram(session, [id]);
		act(() => {
			dblclick(session, centreOf(TEXT_RECT));
		});
		// The template stops drawing the text (e.g. a variant without it): the measurement finds no box.
		const el = ui.container.querySelector('[data-template-param="text"]')!;
		el.removeAttribute('data-template-param');
		expect(await screen.findByTestId('template-text-message', {}, { timeout: 5000 })).toBeTruthy();
		expect(screen.queryByTestId('template-text-input')).toBeNull();
		ui.unsub();
	});

	it('a crash inside the editor is contained: message, hold released, monitor intact', async () => {
		const session = newSession();
		const id = addTemplate(session, 'V1');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { ui } = await openEditor(session, id);
		// The next render of the editor fails.
		flags.sceneBoom = true;
		act(() => session.transport.seek(31));
		await vi.waitFor(() => expect(screen.getByTestId('template-text-message').textContent).toMatch(/boom/));
		flags.sceneBoom = false;
		expect(screen.queryByTestId('template-text-input')).toBeNull();
		expect(ui.container.querySelector('[data-template-hold="true"]')).toBeNull();
		expect(screen.getByTestId('program-player-wrapper')).toBeTruthy();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
		err.mockRestore();
		ui.unsub();
	});
});
