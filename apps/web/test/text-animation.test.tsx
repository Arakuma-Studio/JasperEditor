// Text animators in the web app (S11:TXA-020…024): drag payload and drop side, apply/remove actions (one undo
// step), the commands and menus, the clip context submenu, the Text Animations tab, the Properties / Effect
// Controls section, the mini-timeline In/Out bars and the timeline wedges.
import { EngineClient } from '@jasper/engine-client';
import type { Clip } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCommandContext, getCommand, registerAllCommands, runCommand } from '../src/commands/index.ts';
import { clipMenuExtensions, clipSections, type MenuItemSpec } from '../src/extensions/index.ts';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { MENUBAR } from '../src/shell/menus/model.ts';
import {
	applyTextAnimation,
	dropSide,
	isTextAnimationDrag,
	readTextAnimationDrag,
	removeTextAnimation,
	TEXT_ANIM_MIME,
	writeTextAnimationDrag,
} from '../src/text-animation/actions.ts';
import { LATEST_TEXT_ANIMATIONS } from '../src/text-animation/PresetPreview.tsx';
import { TextAnimationSection } from '../src/text-animation/TextAnimationSection.tsx';
import { filterPresets, TextAnimationsTab } from '../src/text-animation/TextAnimationsTab.tsx';
import { TextAnimationWedges } from '../src/text-animation/TextAnimationWedges.tsx';
import { clipOf, makeSession, renderWithSession } from './inspector-helpers.tsx';

type TextClip = Extract<Clip, { kind: 'text' }>;

const engine = new EngineClient({ fetch: (async () => new Response('{}')) as unknown as typeof fetch });

function addTexts(session: EditorSession, n = 1, duration = 60): string[] {
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		commands: Array.from({ length: n }, (_, i) => ({
			type: 'clip.addText',
			at: i * 100,
			duration,
			track: 'V1',
			content: { text: `Title ${i}` },
		})) as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return r.created.filter((id) => id.startsWith('clp_'));
}
const textOf = (s: EditorSession, id: string) => clipOf(s, id) as TextClip;
const labels = (s: EditorSession) => {
	const h = s.getState().history;
	return h.entries.slice(0, h.index + 1).map((e) => e.label);
};

/** A minimal DataTransfer (happy-dom has none for synthetic drag events). */
function dataTransfer(): DataTransfer {
	const data = new Map<string, string>();
	return {
		setData: (k: string, v: string) => void data.set(k, v),
		getData: (k: string) => data.get(k) ?? '',
		get types() {
			return [...data.keys()];
		},
		dropEffect: 'none',
		effectAllowed: 'all',
	} as unknown as DataTransfer;
}

beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => cleanup());

describe('actions (S11:TXA-020/024)', () => {
	it('drag payload round trip and drop side by position', () => {
		const dt = dataTransfer();
		expect(isTextAnimationDrag(dt)).toBe(false);
		writeTextAnimationDrag(dt, { preset: 'pop', version: 1 });
		expect(isTextAnimationDrag(dt)).toBe(true);
		expect(dt.types).toContain(TEXT_ANIM_MIME);
		expect(readTextAnimationDrag(dt)).toEqual({ preset: 'pop', version: 1 });
		expect(readTextAnimationDrag(null)).toBeNull();
		expect(dropSide({ start: 100, duration: 60 }, 129)).toBe('in');
		expect(dropSide({ start: 100, duration: 60 }, 130)).toBe('out');
	});
	it('applies to all text clips in one undo step and ignores other kinds', () => {
		const session = makeSession();
		const ids = addTexts(session, 2);
		const solid = session.apply({
			label: 'solid',
			origin: 'user',
			commands: [{ type: 'clip.addSolid', at: 300, duration: 30, track: 'V2', color: [1, 0, 0, 1] }] as never,
		});
		const solidId = solid.ok ? solid.created.find((x) => x.startsWith('clp_'))! : '';
		const r = applyTextAnimation(session, [...ids, solidId], { side: 'both', preset: 'slide-up' });
		expect(r?.ok).toBe(true);
		expect(labels(session).at(-1)).toBe('Apply Slide Up');
		for (const id of ids) {
			expect(textOf(session, id).textAnimation?.in?.preset).toBe('slide-up');
			expect(textOf(session, id).textAnimation?.out?.preset).toBe('slide-up');
		}
		expect(removeTextAnimation(session, ids, 'out')?.ok).toBe(true);
		expect(labels(session).at(-1)).toBe('Remove Out Animation');
		expect(textOf(session, ids[0]!).textAnimation).toEqual({
			in: expect.objectContaining({ preset: 'slide-up' }),
		});
		session.undo();
		expect(textOf(session, ids[0]!).textAnimation?.out?.preset).toBe('slide-up');
		expect(applyTextAnimation(session, [solidId], { side: 'in', preset: 'fade' })).toBeNull();
	});
});

describe('commands and menus (S11:TXA-024)', () => {
	it('text.applyAnimation / text.removeAnimation are agent-exposed and act on the selection by default', async () => {
		registerAllCommands();
		expect(getCommand('text.applyAnimation')?.agentExposed).toBe(true);
		expect(getCommand('text.removeAnimation')?.agentExposed).toBe(true);
		const session = makeSession();
		const [a, b] = addTexts(session, 2);
		const toasts: string[] = [];
		const ctx = createCommandContext({ engine, session, toast: (t) => toasts.push(t.message) });
		act(() => session.select('timeline', [a!]));
		expect((await runCommand('text.applyAnimation', ctx, { side: 'in', preset: 'pop' })).ran).toBe(true);
		expect(textOf(session, a!).textAnimation?.in?.preset).toBe('pop');
		expect(textOf(session, b!).textAnimation).toBeUndefined();
		const explicit = await runCommand('text.applyAnimation', ctx, {
			clipIds: [b!],
			side: 'out',
			preset: 'drop',
			durationFrames: 9,
			params: { distance: 30 },
		});
		expect(explicit.ran).toBe(true);
		expect(textOf(session, b!).textAnimation?.out).toMatchObject({
			durationFrames: 9,
			params: { distance: 30 },
		});
		expect((await runCommand('text.applyAnimation', ctx, { side: 'in', preset: 'zoom' })).ran).toBe(false);
		expect((await runCommand('text.removeAnimation', ctx, { side: 'both' })).ran).toBe(true);
		expect(textOf(session, a!).textAnimation).toBeUndefined();
		// compression is reported
		await runCommand('text.applyAnimation', ctx, {
			clipIds: [a!],
			side: 'both',
			preset: 'fade',
			durationFrames: 50,
		});
		expect(toasts.at(-1)).toMatch(/shortened to fit/);
	});
	it('Graphics ▸ Text Animation has Apply In…, Apply Out… and Remove', () => {
		const graphics = MENUBAR.find((m) => m.id === 'graphics')!;
		const sub = graphics.items.find((i) => i.type === 'submenu' && i.label === 'Text Animation');
		expect(
			sub?.type === 'submenu' && sub.items.map((i) => (i.type === 'command' ? [i.label, i.args] : null)),
		).toEqual([
			['Apply In…', { side: 'in' }],
			['Apply Out…', { side: 'out' }],
			['Remove', { side: 'both' }],
		]);
	});
	it('the clip context menu offers Apply In / Apply Out / Remove for text clips only', () => {
		registerAllCommands();
		const session = makeSession();
		const [id] = addTexts(session, 1);
		const ext = clipMenuExtensions.get('text-animation')!;
		const clip = textOf(session, id!);
		const items = ext.items({ session, clip, selection: [id!] });
		const sub = items[0] as Extract<MenuItemSpec, { kind: 'submenu' }>;
		expect(sub.label).toBe('Text Animation');
		const applyIn = sub.items[0] as Extract<MenuItemSpec, { kind: 'submenu' }>;
		expect(applyIn.items.map((i) => (i.kind === 'item' ? i.label : ''))).toContain('Typewriter');
		const typewriter = applyIn.items.find((i) => i.kind === 'item' && i.label === 'Typewriter')!;
		if (typewriter.kind === 'item') typewriter.run();
		expect(textOf(session, id!).textAnimation?.in?.preset).toBe('typewriter');
		const fresh = ext.items({ session, clip: textOf(session, id!), selection: [id!] })[0] as Extract<
			MenuItemSpec,
			{ kind: 'submenu' }
		>;
		const removeAll = fresh.items.find((i) => i.kind === 'item' && i.label === 'Remove All')!;
		expect(removeAll.kind === 'item' && removeAll.disabled).toBe(false);
		expect(ext.items({ session, clip: { ...clip, kind: 'solid' } as never, selection: [] })).toEqual([]);
		expect(clipSections.get('text-animation')?.appliesTo([clip])).toBe(true);
	});
});

describe('Text Animations tab (S11:TXA-020)', () => {
	it('lists every preset with posters, filters by chip and search, applies on double-click / card menu', () => {
		const session = makeSession();
		const [id] = addTexts(session, 1);
		act(() => session.select('timeline', [id!]));
		renderWithSession(session, <TextAnimationsTab />);
		const cards = () => screen.getAllByRole('listitem');
		expect(cards()).toHaveLength(12);
		expect(cards()[0]!.querySelector('[data-preview-thumb="poster"]')).not.toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
		expect(cards().map((c) => c.dataset.textAnimation)).toEqual(['mask-reveal@1']);
		fireEvent.click(screen.getByRole('button', { name: 'All' }));
		fireEvent.change(screen.getByRole('searchbox', { name: 'Search text animations' }), {
			target: { value: 'slide' },
		});
		expect(cards()).toHaveLength(4);
		fireEvent.doubleClick(cards()[0]!);
		expect(textOf(session, id!).textAnimation?.in?.preset).toBe('slide-up');
		expect(screen.getByTestId('text-animations-status').textContent).toMatch(/Slide Up applied as In/);
		// the Out chip makes double-click apply as Out
		fireEvent.click(screen.getByRole('button', { name: 'Out' }));
		fireEvent.keyDown(cards()[1]!, { key: 'Enter' });
		expect(textOf(session, id!).textAnimation?.out?.preset).toBe('slide-down');
		// dragging a card carries the preset
		const dt = dataTransfer();
		fireEvent.dragStart(cards()[2]!, { dataTransfer: dt });
		expect(readTextAnimationDrag(dt)).toEqual({ preset: 'slide-left', version: 1 });
	});
	it('filterPresets matches label, category, description and id', () => {
		expect(
			filterPresets(LATEST_TEXT_ANIMATIONS, { query: 'caret', category: null, side: 'in' }).map((s) => s.id),
		).toEqual(['typewriter']);
		expect(
			filterPresets(LATEST_TEXT_ANIMATIONS, { query: '', category: 'Pop', side: 'out' }).map((s) => s.id),
		).toEqual(['pop']);
	});
});

describe('Properties ▸ Text Animation (S11:TXA-021)', () => {
	it('picks presets, edits duration and params for all selected text clips', () => {
		const session = makeSession();
		const ids = addTexts(session, 2);
		act(() => session.select('timeline', ids));
		renderWithSession(session, <TextAnimationSection session={session} clipIds={ids} host="properties" />);
		expect(screen.getByTestId('text-anim-picker-in').textContent).toBe('None');
		act(() => fireEvent.click(screen.getByTestId('text-anim-picker-in')));
		const popover = screen.getByTestId('text-anim-popover-in');
		const options = within(popover).getAllByRole('option');
		expect(options[0]!.textContent).toBe('None');
		act(() => fireEvent.click(within(popover).getByRole('option', { name: /Blur/ })));
		for (const id of ids) expect(textOf(session, id).textAnimation?.in?.preset).toBe('blur');
		expect(labels(session).at(-1)).toBe('Apply Blur In');
		expect(screen.getByTestId('text-anim-picker-in').textContent).toBe('Blur');
		expect(screen.getByTestId('text-anim-duration-in').title).toMatch(/00:00:00:20 \(0\.67 s\)/);
		// a param row per param of the preset (unit, stagger, order, ease, blur)
		expect(
			screen.getByTestId('text-anim-side-in').querySelectorAll('[data-testid^="prop-"]').length,
		).toBeGreaterThanOrEqual(5);
		// different presets on the selection: mixed, no param rows
		act(() => void applyTextAnimation(session, [ids[1]!], { side: 'in', preset: 'pop' }));
		expect(screen.getByTestId('text-anim-picker-in').textContent).toBe('–');
		expect(screen.getByText(/Mixed presets/)).toBeTruthy();
		// reset re-applies the preset (defaults) to every selected clip
		act(() => fireEvent.click(screen.getByTestId('text-anim-picker-in')));
		act(() =>
			fireEvent.click(
				within(screen.getByTestId('text-anim-popover-in')).getByRole('option', { name: /^None/ }),
			),
		);
		for (const id of ids) expect(textOf(session, id).textAnimation).toBeUndefined();
	});
});

describe('Effect Controls (S11:TXA-022)', () => {
	it('shows the Text Animation section after Opacity and In/Out bars whose edge drag is one undo step', () => {
		const session = makeSession();
		const [id] = addTexts(session, 1, 60);
		applyTextAnimation(session, [id!], { side: 'both', preset: 'fade', durationFrames: 10 });
		act(() => {
			session.select('timeline', [id!]);
			session.transport.seek(5);
		});
		renderWithSession(session, <EffectControlsPanel instanceId="ec1" visible />);
		const sections = [...document.querySelectorAll('[data-ec-section]')].map(
			(e) => (e as HTMLElement).dataset.ecSection!.split(':')[1],
		);
		expect(sections.slice(0, 4)).toEqual(['motion', 'opacity', 'textAnimation', 'crop']);
		expect(screen.getByTestId('ec-text-animation')).toBeTruthy();
		expect(screen.getByTestId('ec-text-anim-bar-in')).toBeTruthy();
		expect(screen.getByTestId('ec-text-anim-bar-out')).toBeTruthy();
		const ruler = screen.getByTestId('ec-ruler');
		ruler.getBoundingClientRect = () => ({
			left: 0,
			width: 128,
			top: 0,
			height: 34,
			right: 128,
			bottom: 34,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		});
		const before = labels(session).length;
		// range = 60 frames ± 4 → 68 frames over 128 px: +32 px ≈ +17 frames
		act(() => {
			fireEvent.pointerDown(screen.getByTestId('ec-text-anim-edge-in'), { clientX: 10, button: 0 });
			fireEvent.pointerMove(window, { clientX: 26 });
			fireEvent.pointerMove(window, { clientX: 42 });
			fireEvent.pointerUp(window, { clientX: 42 });
		});
		expect(textOf(session, id!).textAnimation?.in?.durationFrames).toBe(27);
		expect(labels(session)).toHaveLength(before + 1);
		expect(labels(session).at(-1)).toBe('In Animation Duration');
		// the playhead did not move (the ruler seek is not triggered by the edge)
		expect(session.transport.getState().frame).toBe(5);
	});
});

describe('timeline wedges (S11:TXA-023)', () => {
	it('draws head/tail wedges of the windows as rendered', () => {
		const session = makeSession();
		const [id] = addTexts(session, 1, 30);
		applyTextAnimation(session, [id!], { side: 'both', preset: 'fade', durationFrames: 20 });
		const { container } = render(
			<TextAnimationWedges clip={textOf(session, id!)} pxPerFrame={2} height={40} />,
		);
		const svg = container.querySelector('svg')!;
		// 20 + 20 > 30: compressed to 15 + 15
		expect(svg.dataset.textAnimWedges).toBe('15/15');
		expect(svg.querySelectorAll('path')).toHaveLength(2);
		expect(
			render(
				<TextAnimationWedges clip={textOf(session, addTexts(session, 1)[0]!)} pxPerFrame={2} height={40} />,
			).container.innerHTML,
		).toBe('');
	});
});
