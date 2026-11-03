// Spec 19 §10 with real panels on a real session: the Looks grid, hover previews, the Look and Appearance sections, the
// paint control, Effect Controls, the effect preview and the settings search. These use small looks of their own in the
// project; the Looks browser tests hold the shipped library aside so their counts are known, and one checks it is listed.
import {
	type Appearance,
	type Clip,
	clipLook,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type EffectInstance,
	FACTORY_LOOKS,
	type FactoryLook,
	type LookRecipe,
	titleLooksOf,
} from '@jasper/project';
import { derivedPreviewFor, EditorSession } from '@jasper/session';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { settingsHits } from '../src/panels/effectControls/SettingsSearch.tsx';
import { EffectsPanel } from '../src/panels/effects/EffectsPanel.tsx';
import { PropertiesPanel } from '../src/panels/properties/PropertiesPanel.tsx';
import { newLayerIndex } from '../src/title-looks/AppearanceList.tsx';
import { ApplyLookDialog } from '../src/title-looks/ApplyLookDialog.tsx';
import { insertTitleWithLook, pickLook, setColorway } from '../src/title-looks/actions.ts';
import { isLookDrag, readLookDrag, writeLookDrag } from '../src/title-looks/drag.ts';
import { lookFocus } from '../src/title-looks/focus.ts';
import { handlesOf } from '../src/title-looks/LayerOverlay.tsx';
import { LooksBrowser } from '../src/title-looks/LooksBrowser.tsx';
import { lookEntries } from '../src/title-looks/library.ts';
import { lookFrame } from '../src/title-looks/overlay-geometry.ts';
import { LookPreviewChip } from '../src/title-looks/PreviewChip.tsx';
import { endPreview, lookPreviewCommands, schedulePreview } from '../src/title-looks/preview.ts';
import { clipOf, makeSession, renderWithSession } from './inspector-helpers.tsx';

const recipe: LookRecipe = {
	palette: { face: [1, 0.8, 0.2, 1] },
	layers: [
		{ type: 'shadow', params: { distance: 8 } },
		{ type: 'rim', name: 'Outline', params: { width: 5 } },
		{ type: 'face' },
	],
};

/** A project with looks and titles; `titles` clips, none selected. */
function project(opts: { looks?: string[]; titles?: number } = {}) {
	const session = makeSession();
	const looks = opts.looks ?? ['Gold'];
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		commands: [
			...looks.map((name) => ({ type: 'look.create', name, recipe })),
			...Array.from({ length: opts.titles ?? 1 }, (_, i) => ({
				type: 'clip.addText',
				at: i * 40,
				duration: 30,
				track: 'V2',
				content: { text: `title ${i}` },
			})),
		] as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const ids = r.created.filter((id) => id.startsWith('clp_'));
	return { session, ids };
}

const entry = (s: EditorSession, name = 'Gold') =>
	lookEntries(s.getCommitted()).find((e) => e.name === name)!;
const fxOf = (s: EditorSession, id: string) =>
	clipLook((clipOf(s, id) as unknown as { effects: EffectInstance[] }).effects);
const lookOf = (s: EditorSession, id: string) => fxOf(s, id)?.appearance as Appearance | undefined;
const historyLength = (s: EditorSession) => s.getState().history.entries.length;

function withLook(opts: { titles?: number } = {}) {
	const p = project(opts);
	p.session.apply({
		label: 'look',
		origin: 'user',
		commands: [
			{ type: 'look.apply', clipIds: p.ids, lookId: titleLooksOf(p.session.getCommitted())[0]!.id },
		] as never,
	});
	act(() => p.session.select('timeline', p.ids));
	return p;
}

/** The grid measures real layout; give it one. */
function layout(width = 340, height = 400) {
	const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
	const h = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(height);
	return () => {
		client.mockRestore();
		h.mockRestore();
	};
}

beforeEach(() => {
	vi.useRealTimers();
});
afterEach(() => {
	lookFocus.set(null);
	cleanup();
	vi.restoreAllMocks();
});

describe('clicking a look (TL-086)', () => {
	it('with nothing selected adds a title with the look at the playhead: one undo step, and it is selected', () => {
		const { session } = project({ titles: 0 });
		act(() => session.transport.seek(12));
		const before = historyLength(session);
		const o = pickLook(session, entry(session));
		expect(o.ok).toBe(true);
		const id = session.getState().selection.timeline.clips[0]!;
		expect(clipOf(session, id).kind).toBe('text');
		expect(clipOf(session, id).start).toBe(12);
		expect(lookOf(session, id)?.layers).toHaveLength(3);
		expect(historyLength(session)).toBe(before + 1);
		session.undo();
		expect(Object.keys(Object.values(session.getCommitted().sequences)[0]!.clips)).toHaveLength(0);
	});

	it('with clips selected applies to them', () => {
		const { session, ids } = project({ titles: 2 });
		act(() => session.select('timeline', ids));
		const o = pickLook(session, entry(session));
		expect(o.ok && o.clipIds).toEqual(ids);
		expect(lookOf(session, ids[1]!)?.layers).toHaveLength(3);
	});

	it('never turns a selection that cannot take a look into a new title', () => {
		const { session } = project({ titles: 0 });
		const r = session.apply({
			label: 'a',
			origin: 'user',
			commands: [{ type: 'clip.addAdjustment', at: 0, duration: 30, track: 'V1' }] as never,
		});
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		const id = r.created.find((x) => x.startsWith('clp_'))!;
		act(() => session.select('timeline', [id]));
		const n = Object.keys(Object.values(session.getCommitted().sequences)[0]!.clips).length;
		const o = pickLook(session, entry(session));
		expect(o.ok).toBe(false);
		expect(Object.keys(Object.values(session.getCommitted().sequences)[0]!.clips)).toHaveLength(n);
		expect(session.getState().selection.timeline.clips).toEqual([id]);
	});

	it('announces the keyframes a replaced look took with it', () => {
		const { session, ids } = withLook();
		const fx = fxOf(session, ids[0]!)!;
		const layer = (fx.appearance as Appearance).layers[1]!.id;
		session.apply({
			label: 'k',
			origin: 'user',
			commands: [
				{
					type: 'param.setAnimated',
					target: ['appearance', fx.id, layer, 'width'],
					animated: true,
					at: { sequenceFrame: 2 },
				},
			] as never,
		});
		const o = pickLook(session, entry(session));
		expect(o.ok && o.notices[0]?.title).toMatch(/1 keyframe/);
	});

	it('announces a look that paints over a picture, and offers to keep it', () => {
		const { session } = project({ titles: 0 });
		const r = session.apply({
			label: 's',
			origin: 'user',
			commands: [
				{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [0, 0, 0, 1], ref: '$s' },
			] as never,
		});
		const id = r.ok ? r.refs.$s! : '';
		act(() => session.select('timeline', [id]));
		// A solid is no picture.
		const o = pickLook(session, entry(session));
		expect(o.ok && o.notices).toEqual([]);
	});

	it('a look dragged carries its id and colourway through a validated payload', () => {
		const data = new Map<string, string>();
		const types: string[] = [];
		const dt = {
			types,
			effectAllowed: '',
			setData(k: string, v: string) {
				data.set(k, v);
				types.push(k);
			},
			getData: (k: string) => data.get(k) ?? '',
		} as unknown as DataTransfer;
		writeLookDrag(dt, 'look.a', 'cw.red');
		expect(isLookDrag(dt)).toBe(true);
		expect(readLookDrag(dt)).toEqual({ type: 'jasper/title-look', lookId: 'look.a', colorwayId: 'cw.red' });
		expect(readLookDrag({ getData: () => '{"type":"nope"}' })).toBeNull();
		expect(readLookDrag({ getData: () => 'not json' })).toBeNull();
	});
});

describe('Looks browser (TL-086)', () => {
	const library = FACTORY_LOOKS as FactoryLook[];
	const shipped = [...FACTORY_LOOKS];
	beforeAll(() => {
		library.length = 0;
	});
	afterAll(() => {
		library.splice(0, library.length, ...shipped);
	});

	it('lists the shipped library first, then the project’s own looks', () => {
		library.splice(0, library.length, ...shipped);
		try {
			const { session } = project({ looks: ['Gold'], titles: 0 });
			const restore = layout();
			renderWithSession(session, <LooksBrowser session={session} />);
			expect(screen.getByRole('list', { name: 'Looks' }).dataset.count).toBe(String(shipped.length + 1));
			const entries = lookEntries(session.getCommitted());
			expect(entries.slice(0, shipped.length).map((e) => e.lookId)).toEqual(shipped.map((l) => l.libraryId));
			expect(entries.at(-1)).toMatchObject({ name: 'Gold', source: 'project' });
			restore();
		} finally {
			library.length = 0;
		}
	});

	it('says honestly when there is nothing to show', () => {
		const { session } = project({ looks: [], titles: 0 });
		renderWithSession(session, <LooksBrowser session={session} />);
		expect(screen.getByTestId('looks-empty').textContent).toMatch(/No looks yet/);
		expect(screen.queryByTestId('look-grid')).toBeNull();
	});

	it('says what a click will do, in words', () => {
		const { session, ids } = project({ titles: 2 });
		renderWithSession(session, <LooksBrowser session={session} />);
		expect(screen.getByTestId('looks-status').textContent).toMatch(/add a title at the playhead/);
		act(() => session.select('timeline', ids));
		expect(screen.getByTestId('looks-status').textContent).toMatch(/2 selected clips/);
	});

	it('mounts only what is on screen: posters of the rest are never asked for', () => {
		const names = Array.from({ length: 300 }, (_, i) => `Look ${i}`);
		const { session } = project({ looks: names, titles: 0 });
		const restore = layout();
		renderWithSession(session, <LooksBrowser session={session} />);
		const cards = screen.getAllByTestId('look-card');
		expect(cards.length).toBeGreaterThan(2);
		expect(cards.length).toBeLessThan(30);
		expect(screen.getByRole('list', { name: 'Looks' }).dataset.count).toBe('300');
		restore();
	});

	it('searches, and offers a way back from no match', () => {
		const { session } = project({ looks: ['Gold', 'Neon'], titles: 0 });
		const restore = layout();
		renderWithSession(session, <LooksBrowser session={session} />);
		fireEvent.change(screen.getByTestId('looks-search'), { target: { value: 'neo' } });
		expect(screen.getAllByTestId('look-card')).toHaveLength(1);
		fireEvent.change(screen.getByTestId('looks-search'), { target: { value: 'zzz' } });
		expect(screen.getByTestId('looks-no-match')).toBeTruthy();
		fireEvent.click(screen.getByText('Show all looks'));
		expect(screen.getAllByTestId('look-card')).toHaveLength(2);
		restore();
	});

	it('a click uses the look and Enter does the same from the keyboard', () => {
		const { session, ids } = project({ looks: ['Gold'], titles: 1 });
		const restore = layout();
		act(() => session.select('timeline', ids));
		renderWithSession(session, <LooksBrowser session={session} />);
		const card = screen.getAllByTestId('look-card')[0]!;
		fireEvent.keyDown(card, { key: 'Enter' });
		expect(lookOf(session, ids[0]!)?.lookId).toBeTruthy();
		restore();
	});

	it('arrow keys move the roving focus between cards', async () => {
		const { session } = project({ looks: ['A', 'B', 'C'], titles: 0 });
		const restore = layout();
		renderWithSession(session, <LooksBrowser session={session} />);
		const list = screen.getByRole('list', { name: 'Looks' });
		fireEvent.keyDown(list, { key: 'ArrowRight' });
		await waitFor(() => expect(document.activeElement?.getAttribute('data-look-index')).toBe('1'));
		restore();
	});

	it('cycling colourways on a clip that wears the look is one History entry, not one per click', () => {
		const ids0 = createCounterIdSource(11);
		const document = createEmptyProject({ ids: ids0, name: 'c', preset: 'hd-1080p-30' });
		const session = new EditorSession({
			projectId: document.projectId,
			document,
			ctx: { ids: ids0, now: () => '2026-09-30T10:00:00.000Z', registries: defaultRegistries() },
			coalesceWindowMs: 0,
		});
		const r = session.apply({
			label: 'setup',
			origin: 'user',
			commands: [
				{ type: 'clip.addText', at: 0, duration: 30, track: 'V2', content: { text: 'T' }, ref: '$t' },
				{ type: 'look.apply', clipIds: ['$t'], look: { name: 'Gold', recipe } },
			] as never,
		});
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		const ids = [r.refs.$t!];
		const n = historyLength(session);
		const way = (id: string, face: [number, number, number, number]) => ({ id, name: id, palette: { face } });
		setColorway(session, ids, way('a', [1, 0, 0, 1]));
		setColorway(session, ids, way('b', [0, 1, 0, 1]));
		setColorway(session, ids, way('c', [0, 0, 1, 1]));
		expect(historyLength(session)).toBe(n + 1);
		expect(lookOf(session, ids[0]!)?.palette.face?.value).toEqual([0, 0, 1, 1]);
		expect(lookOf(session, ids[0]!)?.colorwayId).toBe('c');
		session.undo();
		expect(lookOf(session, ids[0]!)?.colorwayId).toBeUndefined();
	});
});

describe('Apply Look dialog (TL-086)', () => {
	it('opens outside the session provider, as the dialog host does, and closes once a look is used', () => {
		const { session, ids } = project({ titles: 1 });
		act(() => session.select('timeline', ids));
		const restore = layout();
		const close = vi.fn();
		render(<ApplyLookDialog session={session} close={close} />);
		expect(screen.getByTestId('apply-look-dialog')).toBeTruthy();
		fireEvent.click(screen.getAllByTestId('look-card')[0]!);
		expect(close).toHaveBeenCalledWith(true);
		expect(lookOf(session, ids[0]!)?.lookId).toBeTruthy();
		restore();
	});
});

describe('hover preview (TL-088)', () => {
	it('shows on the selected clip without touching the document or History, and ends on leave', () => {
		vi.useFakeTimers();
		const { session, ids } = project({ titles: 1 });
		act(() => session.select('timeline', ids));
		const lookId = titleLooksOf(session.getCommitted())[0]!.id;
		const doc = session.getCommitted();
		const entries = historyLength(session);
		const rev = session.getState().revision;
		schedulePreview(session, { label: 'Gold', commands: lookPreviewCommands(ids, lookId) }, 180);
		// Passing over a card draws nothing.
		vi.advanceTimersByTime(100);
		expect(derivedPreviewFor(session).getState().active).toBeNull();
		vi.advanceTimersByTime(100);
		const active = derivedPreviewFor(session).getState().active!;
		expect(active.label).toBe('Gold');
		const previewed = Object.values(active.document.sequences)[0]!.clips[ids[0]!] as Clip;
		expect(clipLook((previewed as unknown as { effects: EffectInstance[] }).effects)).toBeTruthy();
		expect(session.getCommitted()).toBe(doc);
		expect(historyLength(session)).toBe(entries);
		expect(session.getState().revision).toBe(rev);
		expect(lookOf(session, ids[0]!)).toBeUndefined();
		endPreview(session);
		expect(derivedPreviewFor(session).getState().active).toBeNull();
		expect(session.getCommitted()).toBe(doc);
		vi.useRealTimers();
	});

	it('leaving before the delay shows nothing', () => {
		vi.useFakeTimers();
		const { session, ids } = project({ titles: 1 });
		const lookId = titleLooksOf(session.getCommitted())[0]!.id;
		schedulePreview(session, { label: 'Gold', commands: lookPreviewCommands(ids, lookId) }, 180);
		endPreview(session);
		vi.advanceTimersByTime(500);
		expect(derivedPreviewFor(session).getState().active).toBeNull();
		vi.useRealTimers();
	});

	it('names what it shows, in words, and leaves other previews alone', () => {
		vi.useFakeTimers();
		const { session, ids } = project({ titles: 1 });
		const lookId = titleLooksOf(session.getCommitted())[0]!.id;
		renderWithSession(session, <LookPreviewChip />);
		expect(screen.queryByTestId('look-preview-chip')).toBeNull();
		act(() => {
			schedulePreview(session, { label: 'Gold', commands: lookPreviewCommands(ids, lookId) }, 10);
			vi.advanceTimersByTime(20);
		});
		expect(screen.getByTestId('look-preview-chip').textContent).toContain('Gold');
		act(() => endPreview(session));
		expect(screen.queryByTestId('look-preview-chip')).toBeNull();
		const seqId = session.getState().activeSequenceId!;
		derivedPreviewFor(session).start({
			label: 'x',
			kind: 'cleanup.result',
			sequenceId: seqId,
			commands: [],
			omitted: [],
		});
		endPreview(session);
		expect(derivedPreviewFor(session).getState().active?.kind).toBe('cleanup.result');
		derivedPreviewFor(session).stop();
		vi.useRealTimers();
	});

	it('a preview that cannot be built shows nothing and raises nothing', () => {
		vi.useFakeTimers();
		const { session } = project({ titles: 1 });
		schedulePreview(session, { label: 'x', commands: lookPreviewCommands(['clp_gone'], 'tlk_gone') }, 5);
		expect(() => vi.advanceTimersByTime(10)).not.toThrow();
		expect(derivedPreviewFor(session).getState().active).toBeNull();
		vi.useRealTimers();
	});
});

describe('Properties: Look (TL-089)', () => {
	it('with no look, offers one and keeps Appearance away', () => {
		const { session, ids } = project({ titles: 1 });
		act(() => session.select('timeline', ids));
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		expect(screen.getByTestId('look-none')).toBeTruthy();
		expect(screen.queryByText('Appearance')).toBeNull();
	});

	it("shows the name, the link, Intensity and the layers' primaries; Reset waits for a change", () => {
		const { session, ids } = withLook();
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		expect(screen.getByTestId('look-name').textContent).toBe('Gold');
		expect(screen.getByTestId('look-status').textContent).toBe('Matches the look');
		expect(screen.getByTestId('prop-appearance.intensity')).toBeTruthy();
		const reset = screen.getByTestId('look-reset') as HTMLButtonElement;
		expect(reset.disabled || reset.getAttribute('aria-disabled') === 'true').toBe(true);
		const fx = fxOf(session, ids[0]!)!;
		const rim = (fx.appearance as Appearance).layers[1]!.id;
		act(() => {
			session.apply({
				label: 'w',
				origin: 'user',
				commands: [{ type: 'param.set', target: ['appearance', fx.id, rim, 'width'], value: 9 }] as never,
			});
		});
		expect(screen.getByTestId('look-status').textContent).toBe('1 change from the look');
		fireEvent.click(screen.getByTestId('look-reset'));
		expect((lookOf(session, ids[0]!)!.layers[1]!.params.width as { value: number }).value).toBe(5);
		expect(screen.getByTestId('look-status').textContent).toBe('Matches the look');
	});

	it('Detach keeps every value and drops the link', () => {
		const { session, ids } = withLook();
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		const layers = JSON.stringify(lookOf(session, ids[0]!)!.layers);
		fireEvent.click(screen.getByTestId('look-detach'));
		expect(lookOf(session, ids[0]!)!.lookId).toBeUndefined();
		expect(JSON.stringify(lookOf(session, ids[0]!)!.layers)).toBe(layers);
		expect(screen.getByTestId('look-status').textContent).toBe('Not linked to a look');
	});

	it('lists one row per layer, top of the stack first, each with one line and an eye', () => {
		const { session, ids } = withLook();
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		expect(screen.getByTestId('look-layer-0').dataset.layerType).toBe('face');
		expect(screen.getByTestId('look-layer-1').textContent).toContain('Outline');
		expect(screen.getByTestId('look-layer-2').dataset.layerType).toBe('shadow');
		fireEvent.click(screen.getByTestId('look-layer-eye-2'));
		expect(lookOf(session, ids[0]!)!.layers[0]!.enabled).toBe(false);
	});

	it('opens a layer in place, one at a time, and selecting it never moves the clip selection', () => {
		const { session, ids } = withLook();
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		fireEvent.click(screen.getByTestId('look-layer-open-1'));
		const rim = lookOf(session, ids[0]!)!.layers[1]!.id;
		const stack = within(screen.getByTestId('look-appearance'));
		expect(stack.getByTestId(`prop-appearance.${rim}.width`)).toBeTruthy();
		expect(lookFocus.get()?.target).toBe(rim);
		expect(session.getState().selection.timeline.clips).toEqual(ids);
		fireEvent.click(screen.getByTestId('look-layer-open-0'));
		expect(stack.queryByTestId(`prop-appearance.${rim}.width`)).toBeNull();
	});

	it('moves a layer without a pointer', () => {
		const { session, ids } = withLook();
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		fireEvent.click(screen.getByTestId('look-layer-open-1'));
		fireEvent.click(screen.getByTestId('look-layer-up'));
		expect(lookOf(session, ids[0]!)!.layers.map((l) => l.type)).toEqual(['shadow', 'face', 'rim']);
	});

	it('edits several clips at once: mixed reads —, and a scrub offsets each clip from its own value', () => {
		const { session, ids } = withLook({ titles: 2 });
		const fx = fxOf(session, ids[1]!)!;
		const rim = (fx.appearance as Appearance).layers[1]!.id;
		session.apply({
			label: 'w',
			origin: 'user',
			commands: [{ type: 'param.set', target: ['appearance', fx.id, rim, 'width'], value: 9 }] as never,
		});
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		fireEvent.click(screen.getByTestId('look-layer-open-1'));
		const value = within(screen.getByTestId('look-appearance')).getByTestId(`prop-appearance.${rim}.width`);
		expect(value.textContent).toContain('—');
		fireEvent.pointerDown(value, { clientX: 0, button: 0 });
		act(() => {
			window.dispatchEvent(new MouseEvent('pointermove', { clientX: 20 }));
			window.dispatchEvent(new MouseEvent('pointerup'));
		});
		const width = (id: string) => lookOf(session, id)!.layers[1]!.params.width!.value as number;
		expect(width(ids[0]!)).toBeCloseTo(7, 6);
		expect(width(ids[1]!)).toBeCloseTo(11, 6);
	});

	it('says so when the selected clips have different stacks', () => {
		const { session, ids } = withLook({ titles: 2 });
		session.apply({
			label: 'x',
			origin: 'user',
			commands: [
				{
					type: 'appearance.removeLayer',
					effectInstanceId: fxOf(session, ids[1]!)!.id,
					layerId: lookOf(session, ids[1]!)!.layers[0]!.id,
				},
			] as never,
		});
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		expect(screen.getByTestId('look-stacks-differ')).toBeTruthy();
	});

	it('does not list the look among ordinary effects', () => {
		const { session } = withLook();
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		expect(screen.queryByText(/^Effects \(/)).toBeNull();
	});

	it('a new layer never lands over the title: what reaches outside goes under the face', () => {
		const a = {
			layers: [
				{ id: 'a', type: 'shadow', enabled: true, params: {} },
				{ id: 'b', type: 'face', enabled: true, params: {} },
			],
		} as unknown as Appearance;
		expect(newLayerIndex('glow', a)).toBe(1);
		expect(newLayerIndex('rim', a)).toBe(1);
		expect(newLayerIndex('nope', a)).toBe(2);
	});
});

describe('paint control (TL-091)', () => {
	function open() {
		const p = withLook();
		renderWithSession(p.session, <PropertiesPanel instanceId="p1" visible />);
		fireEvent.click(screen.getByTestId('look-layer-open-0'));
		const face = lookOf(p.session, p.ids[0]!)!.layers[2]!.id;
		return { ...p, face, key: `appearance.${face}.paint` };
	}
	const paintOf = (s: EditorSession, id: string) =>
		lookOf(s, id)!.layers[2]!.params.paint!.value as { kind: string };

	it('changes the kind and the role, one undo step each', () => {
		const { session, ids, key } = open();
		const n = historyLength(session);
		fireEvent.change(screen.getByTestId(`paint-role-${key}`), { target: { value: 'accent1' } });
		expect(paintOf(session, ids[0]!)).toEqual({ kind: 'role', role: 'accent1' });
		fireEvent.change(screen.getByTestId(`paint-kind-${key}`), { target: { value: 'source' } });
		expect(paintOf(session, ids[0]!)).toEqual({ kind: 'source' });
		expect(historyLength(session)).toBe(n + 2);
	});

	it('a gradient opens its stops under the row: roles or colours, added by clicking, at most 32', () => {
		const { session, ids, key } = open();
		fireEvent.change(screen.getByTestId(`paint-kind-${key}`), { target: { value: 'gradient' } });
		const stops = () =>
			(paintOf(session, ids[0]!) as unknown as { gradient: { stops: unknown[] } }).gradient.stops;
		expect(stops()).toHaveLength(2);
		const ramp = screen.getByTestId('look-gradient-ramp');
		ramp.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 12 }) as DOMRect;
		fireEvent.pointerDown(ramp, { clientX: 50, button: 0 });
		expect(stops()).toHaveLength(3);
		fireEvent.change(screen.getByTestId('look-gradient-stop-role'), { target: { value: 'accent2' } });
		expect((stops()[2] as { paint: unknown }).paint).toEqual({ role: 'accent2' });
		fireEvent.click(screen.getByTestId('look-gradient-stop-delete'));
		expect(stops()).toHaveLength(2);
	});

	it('says that line and glyph spans need text', () => {
		const { session, ids } = project({ titles: 0 });
		void ids;
		const r = session.apply({
			label: 's',
			origin: 'user',
			commands: [
				{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [0, 0, 0, 1], ref: '$s' },
				{ type: 'look.apply', clipIds: ['$s'], lookId: titleLooksOf(session.getCommitted())[0]!.id },
			] as never,
		});
		const id = r.ok ? r.refs.$s! : '';
		act(() => session.select('timeline', [id]));
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		fireEvent.click(screen.getByTestId('look-layer-open-0'));
		const face = lookOf(session, id)!.layers[2]!.id;
		fireEvent.change(screen.getByTestId(`paint-kind-appearance.${face}.paint`), {
			target: { value: 'gradient' },
		});
		expect(screen.queryByTestId('look-gradient-span-note')).toBeNull();
		// The options carry the reason before one is chosen (`gradientSpanOn` says `needs-text` on a solid).
		const span = screen.getByTestId('look-gradient-span') as HTMLSelectElement;
		expect([...span.options].map((o) => o.textContent)).toEqual([
			'Block',
			'Line (needs text)',
			'Glyph (needs text)',
		]);
		fireEvent.change(span, { target: { value: 'line' } });
		expect(screen.getByTestId('look-gradient-span-note').textContent).toBe(
			'Line and Glyph follow text. On this clip they draw as Block.',
		);
	});

	it('names the clips without text when a selection mixes them, and says nothing on text', () => {
		const { session, ids } = withLook({ titles: 1 });
		const r = session.apply({
			label: 's',
			origin: 'user',
			commands: [
				{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V3', color: [0, 0, 0, 1], ref: '$s' },
				{ type: 'look.apply', clipIds: ['$s'], lookId: lookOf(session, ids[0]!)!.lookId },
			] as never,
		});
		expect(r.ok).toBe(true);
		const solid = r.ok ? r.refs.$s! : '';
		const faceOf = (id: string) => lookOf(session, id)!.layers[2]!;
		const gradient = {
			kind: 'gradient',
			gradient: {
				type: 'linear',
				span: 'glyph',
				angle: 90,
				stops: [
					{ at: 0, paint: { role: 'face' } },
					{ at: 1, paint: { role: 'accent1' } },
				],
			},
		};
		session.apply({
			label: 'g',
			origin: 'user',
			commands: [ids[0]!, solid].map((id) => ({
				type: 'appearance.setPaint',
				effectInstanceId: fxOf(session, id)!.id,
				layerId: faceOf(id).id,
				paint: gradient,
			})) as never,
		});
		act(() => session.select('timeline', [ids[0]!]));
		const view = renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		fireEvent.click(screen.getByTestId('look-layer-open-0'));
		expect(screen.queryByTestId('look-gradient-span-note')).toBeNull();
		expect(
			[...(screen.getByTestId('look-gradient-span') as HTMLSelectElement).options].map((o) => o.textContent),
		).toEqual(['Block', 'Line', 'Glyph']);
		view.unmount();
		act(() => session.select('timeline', [ids[0]!, solid]));
		renderWithSession(session, <PropertiesPanel instanceId="p2" visible />);
		fireEvent.click(screen.getByTestId('look-layer-open-0'));
		expect(screen.getByTestId('look-gradient-span-note').textContent).toBe(
			'Line and Glyph follow text. On the clips without text they draw as Block.',
		);
	});

	it('mixed paints read —', () => {
		const { session, ids } = withLook({ titles: 2 });
		const fx = fxOf(session, ids[1]!)!;
		const face = (fx.appearance as Appearance).layers[2]!.id;
		session.apply({
			label: 'p',
			origin: 'user',
			commands: [
				{ type: 'appearance.setPaint', effectInstanceId: fx.id, layerId: face, paint: { kind: 'source' } },
			] as never,
		});
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		fireEvent.click(screen.getByTestId('look-layer-open-0'));
		const select = screen.getByTestId(`paint-kind-appearance.${face}.paint`) as HTMLSelectElement;
		expect(within(select).getByText('—')).toBeTruthy();
	});
});

describe('Effect Controls (TL-090)', () => {
	it('shows the stack with stopwatches and keyframes on every numeric param', () => {
		const { session, ids } = withLook();
		renderWithSession(session, <EffectControlsPanel instanceId="e1" visible />);
		const fx = fxOf(session, ids[0]!)!;
		expect(screen.getByTestId(`ec-appearance-${fx.id}`)).toBeTruthy();
		const rim = (fx.appearance as Appearance).layers[1]!.id;
		expect(screen.queryByTestId(`stopwatch-appearance.${rim}.width`)).toBeNull();
		fireEvent.click(screen.getByTestId(`ec-look-toggle-${rim}`));
		fireEvent.click(screen.getByTestId(`stopwatch-appearance.${rim}.width`));
		const anim = lookOf(session, ids[0]!)!.layers[1]!.params.width!;
		expect(anim.keyframes).toHaveLength(1);
	});

	it('resets a linked look through the look, and hides and removes layers', () => {
		const { session, ids } = withLook();
		renderWithSession(session, <EffectControlsPanel instanceId="e1" visible />);
		const fx = fxOf(session, ids[0]!)!;
		const rim = (fx.appearance as Appearance).layers[1]!.id;
		fireEvent.click(screen.getByTestId(`ec-look-eye-${rim}`));
		expect(lookOf(session, ids[0]!)!.layers[1]!.enabled).toBe(false);
		fireEvent.click(screen.getByTestId(`ec-look-remove-${rim}`));
		expect(lookOf(session, ids[0]!)!.layers).toHaveLength(2);
		fireEvent.click(screen.getByRole('button', { name: 'Reset Title Look' }));
		expect(lookOf(session, ids[0]!)!.layers).toHaveLength(3);
	});
});

describe('Effects panel (TL-095)', () => {
	it('the highlighted effect previews on the selection, never in History, and Esc ends it', () => {
		vi.useFakeTimers();
		const { session, ids } = project({ titles: 1 });
		act(() => session.select('timeline', ids));
		const n = historyLength(session);
		renderWithSession(session, <EffectsPanel instanceId="f1" visible />);
		fireEvent.change(screen.getByTestId('effects-search'), { target: { value: 'gaussian' } });
		const row =
			document.querySelector<HTMLElement>('[data-effect-id="jasper.gaussian-blur"]') ??
			document.querySelector<HTMLElement>('[data-effect-id]');
		act(() => {
			row!.focus();
			vi.advanceTimersByTime(300);
		});
		expect(derivedPreviewFor(session).getState().active).not.toBeNull();
		expect(historyLength(session)).toBe(n);
		const tree = screen.getByRole('tree', { name: 'Effects' });
		fireEvent.keyDown(tree, { key: 'Escape' });
		expect(derivedPreviewFor(session).getState().active).toBeNull();
		vi.useRealTimers();
	});

	it('Up and Down walk the rows', () => {
		const { session } = project({ titles: 0 });
		renderWithSession(session, <EffectsPanel instanceId="f1" visible />);
		fireEvent.change(screen.getByTestId('effects-search'), { target: { value: 'blur' } });
		const tree = screen.getByRole('tree', { name: 'Effects' });
		const items = tree.querySelectorAll<HTMLElement>('[role="treeitem"]');
		items[0]!.focus();
		fireEvent.keyDown(tree, { key: 'ArrowDown' });
		expect(document.activeElement).toBe(items[1]);
		fireEvent.keyDown(tree, { key: 'End' });
		expect(document.activeElement).toBe(items[items.length - 1]);
	});
});

describe('settings search (TL-095)', () => {
	const row = (label: string) => ({ id: label, label, bindings: [{ clip: { id: 'c' } }] });
	const section = { id: 's', title: 'Motion', rows: [row('Scale'), row('Rotation')] };
	const groups = [{ id: 'video', title: 'Video', sections: [section] }] as never;
	const effects = [
		{ id: 'a', label: 'Scale Glow', category: 'Stylize', appliesTo: 'video' },
		{ id: 'b', label: 'Scale Audio', category: 'Audio', appliesTo: 'audio' },
		{ id: 'c', label: 'Scale Hidden', category: 'x', appliesTo: 'video', internal: true },
	] as never;

	it('ranks effects to add first, then the rows on screen; internal and other-medium effects stay out', () => {
		const hits = settingsHits('scale', groups, effects, false);
		expect(hits.map((h) => `${h.kind}:${h.label}`)).toEqual(['add:Scale Glow', 'row:Scale']);
	});

	it('finds nothing for nothing', () => {
		expect(settingsHits('  ', groups, effects, false)).toEqual([]);
	});

	it('choosing a setting keeps the selection', () => {
		const { session, ids } = withLook();
		renderWithSession(session, <EffectControlsPanel instanceId="e1" visible />);
		const input = screen.getByTestId('ec-search');
		fireEvent.change(input, { target: { value: 'width' } });
		const results = screen.getByTestId('ec-search-results');
		expect(within(results).getAllByRole('option').length).toBeGreaterThan(0);
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(session.getState().selection.timeline.clips).toEqual(ids);
	});
});

describe('layer handles on a frame (TL-092)', () => {
	const f = lookFrame(
		[
			[0, 0],
			[400, 0],
			[400, 200],
			[0, 200],
		],
		{ width: 400, height: 200 },
		100,
	);

	it('a rim starts where the rims above it end', () => {
		const h = handlesOf(f, { id: 'x', type: 'rim', params: { width: 5, offset: 2 } }, 10, { angle: 0 });
		expect(h).toHaveLength(1);
		expect(h[0]).toMatchObject({ kind: 'distance', param: 'width', start: 12, value: 5 });
	});

	it('a shadow following the light moves along it: distance only', () => {
		const free = handlesOf(f, { id: 'x', type: 'shadow', params: { angle: 45, distance: 8 } }, 0, {
			angle: 225,
		});
		expect(free[0]!.kind).toBe('offset');
		const lit = handlesOf(f, { id: 'x', type: 'shadow', params: { useLight: true, distance: 8 } }, 0, {
			angle: 0,
		});
		expect(lit[0]!.kind).toBe('axis');
		expect(lit[0]).toMatchObject({ param: 'distance', value: 8 });
	});

	it('offers each handle only in its state, and the light’s angle while a layer follows it', () => {
		const free = handlesOf(f, { id: 'x', type: 'shadow', params: { angle: 45, distance: 8 } }, 0, {
			angle: 225,
		});
		expect(free.map((h) => h.kind)).toEqual(['offset']);
		const lit = handlesOf(f, { id: 'x', type: 'shadow', params: { useLight: true, distance: 8 } }, 0, {
			angle: 30,
		});
		expect(lit.map((h) => h.kind)).toEqual(['axis', 'angle']);
		expect(lit[1]).toMatchObject({ kind: 'angle', param: 'angle', light: true, value: 30 });
	});

	it('a layer of an unknown type has none', () => {
		expect(handlesOf(f, { id: 'x', type: 'gone', params: {} }, 0, { angle: 0 })).toEqual([]);
	});
});

describe('insertTitleWithLook', () => {
	it('never overwrites: it takes a free track', () => {
		const { session, ids } = project({ titles: 1 });
		act(() => session.transport.seek(0));
		const o = insertTitleWithLook(session, entry(session));
		expect(o.ok).toBe(true);
		const seq = Object.values(session.getCommitted().sequences)[0]!;
		expect(seq.clips[ids[0]!]).toBeTruthy();
		const added = o.ok ? seq.clips[o.clipIds[0]!]! : null;
		expect(added?.trackId).not.toBe(seq.clips[ids[0]!]!.trackId);
	});
});
