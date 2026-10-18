// Cue Seam interaction (spec 12 §2.7): select (Shift adds), drag to move (snapping, anchors detach), Alt-drag
// duplicates, Delete removes, keyboard (Left/Right/Enter/Delete/context-menu key), the cue menu (Role, Visual Tag,
// Align, Stop Before Next, Convert to Marker), undo/redo of each edit; the Suggest Cues… dialog with live counts and
// one undo step.
import type { Sequence, SoundCue } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerAllCommands } from '../src/commands/index.ts';
import { computeLayout } from '../src/panels/timeline/model/layout.ts';
import type { ContextMenuItem } from '../src/panels/timeline/state/ui-store.ts';
import { createTimelineUiStore } from '../src/panels/timeline/state/ui-store.ts';
import { CueSeam } from '../src/sound/cues/CueSeam.tsx';
import { cuesOf, SEAM_PX } from '../src/sound/cues/model.ts';
import { SuggestCuesDialog } from '../src/sound/cues/SuggestCuesDialog.tsx';
import { audioAsset } from './proposal-helpers.ts';
import { makeSession, solid } from './timeline-helpers.ts';

// The cue menu's Stop Before Next asks the engine (its cached beats) through `useEngineOrNull`; none unless a test sets one.
const engineMock = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../src/state/engine.tsx', async (orig) => ({
	...(await orig<typeof import('../src/state/engine.tsx')>()),
	useEngineOrNull: () => (engineMock.client ? { client: engineMock.client } : null),
}));

beforeAll(() => registerAllCommands());
afterEach(() => cleanup());

const V = { scrollFrame: 0, pxPerFrame: 10, width: 1000 };

function setup(
	cues: Record<string, unknown>[],
	opts: { snapping?: boolean; pxPerFrame?: number; before?: Record<string, unknown>[] } = {},
) {
	const { session, seqId } = makeSession();
	const add = session.apply({
		label: 'setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [...(opts.before ?? []), { type: 'soundCue.add', cues }] as never[],
	});
	const viewport = { ...V, pxPerFrame: opts.pxPerFrame ?? V.pxPerFrame };
	if (!add.ok) throw new Error(JSON.stringify(add.errors));
	const ui = createTimelineUiStore();
	const run = vi.fn();
	const menus: ContextMenuItem[][] = [];
	const toasts: string[] = [];
	const seq = () => session.getCommitted().sequences[seqId] as Sequence;
	const layout = () =>
		computeLayout({
			height: 400,
			dividerRatio: 0.5,
			videoTracks: seq().videoTracks,
			audioTracks: seq().audioTracks,
			heights: {},
			scrollYVideo: 0,
			scrollYAudio: 0,
			dividerPx: SEAM_PX,
		});
	const view = (
		<SessionProvider session={session}>
			<Seam />
		</SessionProvider>
	);
	function Seam() {
		return (
			<CueSeam
				session={session}
				seq={(session.getState().transient ?? session.getState().document).sequences[seqId] as Sequence}
				layout={layout()}
				viewport={viewport}
				media={{}}
				ui={ui}
				instanceId="t1"
				snapping={opts.snapping ?? false}
				run={run}
				openMenu={(_x, _y, items) => menus.push(items)}
				toast={(_k, m) => toasts.push(m)}
				reveal={() => {}}
			/>
		);
	}
	const r = render(view);
	const rerender = () => r.rerender(view);
	session.store.subscribe(() => rerender());
	const cueList = () => cuesOf(seq());
	const lane = () => screen.getByTestId('cue-seam');
	const history = () => session.getState().history.entries.map((e) => e.label);
	const ids = () => add.ok && ((add.results.at(-1) as { cueIds: string[] }).cueIds as string[]);
	return { session, seqId, ui, run, menus, toasts, seq, cueList, lane, history, ids: ids as () => string[] };
}

const pointer = (el: Element, type: string, x: number, extra: Record<string, unknown> = {}) =>
	fireEvent[type as 'pointerDown'](el, { clientX: x, clientY: 9, button: 0, pointerId: 1, ...extra });

const three = [
	{ frame: 30, kind: 'land', weight: 'hero', source: 'derived', reason: "Logo lands on V2 'Logo'" },
	{ frame: 60, kind: 'cut', weight: 'support', source: 'derived', reason: 'Cut on V1' },
	{ frame: 90, kind: 'appear', weight: 'ambient', source: 'agent' },
];

describe('Cue Seam', () => {
	it('draws one labelled glyph per cue with its state', () => {
		const t = setup(three);
		const glyphs = within(t.lane()).getAllByRole('button');
		expect(glyphs).toHaveLength(3);
		expect(glyphs[0]!.getAttribute('aria-label')).toBe(
			"Hero Land cue at 00:00:01:00, unfilled, Logo lands on V2 'Logo'",
		);
		expect(glyphs[0]!.style.left).toBe(`${300 - 9}px`);
		expect(glyphs[2]!.getAttribute('data-cue-state')).toBe('unfilled agent');
		expect(t.lane().getAttribute('aria-label')).toBe('Cue Seam: 3 cues');
	});

	it('click selects, Shift-click adds, a click on the lane deselects', () => {
		const t = setup(three);
		const [a, b] = t.ids();
		pointer(t.lane(), 'pointerDown', 301);
		pointer(t.lane(), 'pointerUp', 301);
		expect(t.session.getState().selection.cues).toEqual([a]);
		pointer(t.lane(), 'pointerDown', 600, { shiftKey: true });
		pointer(t.lane(), 'pointerUp', 600, { shiftKey: true });
		expect(t.session.getState().selection.cues).toEqual([a, b]);
		expect(within(t.lane()).getAllByRole('button')[1]!.getAttribute('aria-pressed')).toBe('true');
		pointer(t.lane(), 'pointerDown', 450);
		expect(t.session.getState().selection.cues).toEqual([]);
	});

	it('drag moves the cue (one undo step) and detaches it from its anchor when dropped elsewhere', () => {
		const t = setup(
			[
				{
					frame: 30,
					kind: 'cut',
					weight: 'support',
					source: 'derived',
					anchor: { type: 'marker', markerId: '$m' },
				},
			],
			{ before: [{ type: 'marker.add', frame: 30, name: 'Hit', ref: '$m' }] },
		);
		const [a] = t.ids();
		expect(t.cueList()[0]!.anchor).toMatchObject({ type: 'marker' });
		pointer(t.lane(), 'pointerDown', 300);
		pointer(t.lane(), 'pointerMove', 330);
		pointer(t.lane(), 'pointerMove', 352);
		pointer(t.lane(), 'pointerUp', 352);
		const c = t.cueList()[0]!;
		expect(c.id).toBe(a);
		expect(c.frame).toBe(35);
		expect(c.anchor).toBeNull();
		expect(t.history().at(-1)).toBe('Move Cue');
		act(() => t.session.undo());
		expect(t.cueList()[0]!.frame).toBe(30);
		expect(t.cueList()[0]!.anchor).toMatchObject({ type: 'marker' });
		act(() => t.session.redo());
		expect(t.cueList()[0]!.frame).toBe(35);
	});

	it('drag snaps to other cues and to the playhead', () => {
		const t = setup(
			[
				{ frame: 30, kind: 'cut', weight: 'support', source: 'derived' },
				{ frame: 50, kind: 'land', weight: 'hero', source: 'derived' },
			],
			{ snapping: true, pxPerFrame: 2 },
		);
		// 8 px threshold at 2 px per frame = 4 frames: +17 frames (47) snaps to the cue at 50
		pointer(t.lane(), 'pointerDown', 60);
		pointer(t.lane(), 'pointerMove', 94);
		expect(t.ui.getState().snapFrame).toBe(50);
		pointer(t.lane(), 'pointerUp', 94);
		expect(t.cueList().map((c) => c.frame)).toEqual([50, 50]);
		expect(t.ui.getState().snapFrame).toBeNull();
		// the playhead wins over a cue at the same distance
		act(() => t.session.transport.seek(54));
		const second = t.cueList()[1]!;
		t.session.select('cues', [second.id], 'replace');
		pointer(t.lane(), 'pointerDown', 100);
		pointer(t.lane(), 'pointerMove', 104);
		pointer(t.lane(), 'pointerMove', 105);
		expect(t.ui.getState().snapFrame).toBe(54);
		pointer(t.lane(), 'pointerUp', 105);
		expect(
			t
				.cueList()
				.map((c) => c.frame)
				.sort(),
		).toEqual([50, 54]);
	});

	it('Alt-drag duplicates (the original stays); undo removes the copy', () => {
		const t = setup(three);
		pointer(t.lane(), 'pointerDown', 300, { altKey: true });
		pointer(t.lane(), 'pointerMove', 400, { altKey: true });
		pointer(t.lane(), 'pointerUp', 400, { altKey: true });
		const frames = t.cueList().map((c) => c.frame);
		expect(frames).toEqual([30, 40, 60, 90]);
		const copy = t.cueList()[1]!;
		expect(copy).toMatchObject({ kind: 'land', weight: 'hero', source: 'user', anchor: null });
		expect(t.session.getState().selection.cues).toEqual([copy.id]);
		expect(t.history().at(-1)).toBe('Duplicate Cue');
		act(() => t.session.undo());
		expect(t.cueList()).toHaveLength(3);
	});

	it('keyboard: arrows move between cues, Enter fills, Delete removes, the menu key opens the menu', () => {
		const t = setup(three);
		const [a, b, c] = t.ids();
		const lane = t.lane();
		act(() => lane.focus());
		fireEvent.keyDown(lane, { key: 'ArrowRight' });
		expect(t.session.getState().selection.cues).toEqual([a]);
		expect(lane.getAttribute('aria-activedescendant')).toBe(`cue-t1-${a}`);
		fireEvent.keyDown(lane, { key: 'ArrowRight' });
		fireEvent.keyDown(lane, { key: 'ArrowRight', shiftKey: true });
		expect(t.session.getState().selection.cues).toEqual([b, c]);
		fireEvent.keyDown(lane, { key: 'Enter' });
		expect(t.run).toHaveBeenCalledWith('soundLibrary.fillCue', { cueId: c });
		fireEvent.keyDown(lane, { key: 'ContextMenu' });
		expect(t.menus).toHaveLength(1);
		fireEvent.keyDown(lane, { key: 'Delete' });
		expect(t.cueList().map((x) => x.id)).toEqual([a]);
		expect(t.history().at(-1)).toBe('Delete Cues (2)');
		act(() => t.session.undo());
		expect(t.cueList()).toHaveLength(3);
		fireEvent.keyDown(lane, { key: 'Home' });
		expect(t.session.getState().selection.cues).toEqual([a]);
		fireEvent.keyDown(lane, { key: 'Escape' });
		expect(t.session.getState().selection.cues).toEqual([]);
	});

	it('double-click asks the Sound Library to fill the cue', () => {
		const t = setup(three);
		fireEvent.doubleClick(t.lane(), { clientX: 600 });
		expect(t.run).toHaveBeenCalledWith('soundLibrary.fillCue', { cueId: t.ids()[1] });
	});

	it('the cue menu: Role, Visual Tag, Align, Stop Before Next, Convert to Marker, Delete', () => {
		const t = setup(three);
		const [a] = t.ids();
		fireEvent.contextMenu(t.lane(), { clientX: 300 });
		const items = t.menus.at(-1)!;
		const sub = (label: string) =>
			(items.find((i) => i.kind === 'submenu' && i.label === label) as { items: ContextMenuItem[] }).items;
		const item = (list: ContextMenuItem[], label: string) =>
			list.find((i) => i.kind === 'item' && i.label === label) as { run(): void; checked?: boolean };
		expect(item(sub('Role'), 'Hero').checked).toBe(true);
		act(() => item(sub('Role'), 'Ambient').run());
		expect(t.cueList()[0]!.weight).toBe('ambient');
		act(() => item(sub('Visual Tag'), 'Emphasis').run());
		expect(t.cueList()[0]!.kind).toBe('emphasis');
		act(() => item(sub('Align'), 'End').run());
		expect(t.cueList()[0]!.align).toBe('end');
		act(() => item(items, 'Stop Before Next').run());
		expect(t.cueList()[0]!.stopBefore).toEqual({ seconds: 0.25, depthDb: -24 });
		expect(t.history().slice(-4)).toEqual(['Cue Role', 'Cue Visual Tag', 'Cue Align', 'Stop Before Next']);
		act(() => t.session.undo());
		expect(t.cueList()[0]!.stopBefore).toBeUndefined();
		act(() => item(items, 'Convert to Marker').run());
		expect(t.cueList().map((c) => c.id)).not.toContain(a);
		expect(t.seq().markers.map((m) => [m.frame, m.name])).toEqual([[30, 'sfx: land']]);
		act(() => t.session.undo());
		expect(t.seq().markers).toHaveLength(0);
		expect(t.cueList()).toHaveLength(3);
	});

	it('Stop Before Next over music with analysed beats ends on the bar line, as the plan does', async () => {
		// final carry-over cleanup, item 5: the menu stored the plain 0.25 s; only the plan read the beats
		const beats = Array.from({ length: 30 }, (_, k) => 0.6 + k * 0.5);
		const downbeats = beats.filter((_, k) => k % 4 === 0);
		const audioBeats = vi.fn(async () => ({ beats, downbeats }));
		engineMock.client = { audioBeats };
		try {
			const t = setup([{ frame: 90, kind: 'land', weight: 'hero', source: 'user' }], {
				before: [
					{ type: 'media.register', asset: audioAsset(20), ref: '$music' },
					{ type: 'clip.place', source: { mediaId: '$music' }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
					{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
				],
			});
			fireEvent.contextMenu(t.lane(), { clientX: 900 });
			const items = t.menus.at(-1)!;
			const stop = items.find((i) => i.kind === 'item' && i.label === 'Stop Before Next') as { run(): void };
			act(() => stop.run());
			await vi.waitFor(() => expect(t.cueList()[0]!.stopBefore).toBeDefined());
			// the hit at 3 s: the downbeat at 2.6 s
			expect(t.cueList()[0]!.stopBefore!.seconds).toBeCloseTo(0.4, 9);
			expect(t.cueList()[0]!.stopBefore!.depthDb).toBe(-24);
			expect(t.history().at(-1)).toBe('Stop Before Next');
			expect(t.toasts).toContain('The music stops on the bar line before the cue');
			expect(audioBeats).toHaveBeenCalledWith(expect.objectContaining({ cachedOnly: true }));
		} finally {
			engineMock.client = null;
		}
	});

	it('refusals reach the user (a read-only project never edits)', () => {
		const t = setup(three);
		act(() => t.session.store.setState({ readOnly: true }));
		pointer(t.lane(), 'pointerDown', 300);
		pointer(t.lane(), 'pointerMove', 400);
		pointer(t.lane(), 'pointerUp', 400);
		expect(t.cueList()[0]!.frame).toBe(30);
	});
});

describe('Suggest Cues… dialog', () => {
	it('shows found / kept counts per source and adds the cues in one transaction', async () => {
		const { session, seqId } = makeSession();
		const r = session.apply({
			label: 'fixture',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				solid(0, 60, 'V1'),
				solid(60, 60, 'V1'),
				solid(120, 60, 'V1'),
				{ type: 'marker.add', frame: 150, name: 'sfx: boom' },
			] as never[],
		});
		expect(r.ok).toBe(true);
		const close = vi.fn();
		const toasts: unknown[] = [];
		render(
			<SessionProvider session={session}>
				<SuggestCuesDialog session={session} sequenceId={seqId} close={close} toast={(x) => toasts.push(x)} />
			</SessionProvider>,
		);
		const count = (s: string) => document.querySelector(`[data-cue-source-count="${s}"]`)!.textContent;
		expect(count('edits')).toBe('2 found · 2 kept');
		expect(count('markers')).toBe('1 found · 1 kept');
		expect(screen.getByTestId('suggest-cues-summary').textContent).toContain('3 cues');
		// unticking a source updates the kept count and the summary live
		fireEvent.click(screen.getByRole('checkbox', { name: 'Markers named “sfx: …”' }));
		expect(count('markers')).toBe('1 found · 0 kept');
		expect(screen.getByTestId('suggest-cues-summary').textContent).toContain('2 cues');
		fireEvent.click(screen.getByRole('checkbox', { name: 'Markers named “sfx: …”' }));
		const before = session.getState().history.entries.length;
		fireEvent.click(screen.getByRole('button', { name: 'Suggest 3 Cues' }));
		const seq = session.getCommitted().sequences[seqId] as Sequence;
		const cues = cuesOf(seq);
		expect(cues.map((c) => [c.frame, c.kind, c.source])).toEqual([
			[60, 'cut', 'derived'],
			[120, 'cut', 'derived'],
			[150, 'manual', 'marker'],
		]);
		for (const c of cues as SoundCue[]) {
			expect(c.reason).toBeTruthy();
			expect(c.anchor).toBeTruthy();
		}
		expect(session.getState().history.entries.length).toBe(before + 1);
		expect(session.getState().history.entries.at(-1)!.label).toBe('Suggest Cues (3)');
		expect(session.getState().selection.cues).toHaveLength(3);
		expect(close).toHaveBeenCalled();
		// undo removes all three at once
		act(() => session.undo());
		expect(cuesOf(session.getCommitted().sequences[seqId] as Sequence)).toHaveLength(0);
	});
});
