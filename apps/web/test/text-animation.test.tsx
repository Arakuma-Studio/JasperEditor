// Text animators in the web app (S11:TXA-020…024): drop side, apply/remove actions (one undo
// step), commands, the Text Animations tab, Properties / Effect Controls, and In/Out bar gestures.
import { EngineClient } from '@jasper/engine-client';
import { type Clip, resolveTextAnimationWindows } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCommandContext, getCommand, registerAllCommands, runCommand } from '../src/commands/index.ts';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import {
	applyTextAnimation,
	dropSide,
	readTextAnimationDrag,
	removeTextAnimation,
} from '../src/text-animation/actions.ts';
import { TextAnimationSection } from '../src/text-animation/TextAnimationSection.tsx';
import { TextAnimationsTab } from '../src/text-animation/TextAnimationsTab.tsx';
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
	it('chooses In or Out from the drop position', () => {
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
		// with nothing selected, agents still remove by clipIds; without them the user is told to select
		act(() => session.select('timeline', []));
		expect((await runCommand('text.removeAnimation', ctx, { clipIds: [a!], side: 'out' })).ran).toBe(true);
		expect(textOf(session, a!).textAnimation?.out).toBeUndefined();
		expect(textOf(session, a!).textAnimation?.in?.preset).toBe('fade');
		expect((await runCommand('text.removeAnimation', ctx, { side: 'both' })).ran).toBe(true);
		expect(toasts.at(-1)).toBe('Select a text clip first');
		expect(textOf(session, a!).textAnimation?.in?.preset).toBe('fade');
	});
});

describe('Text Animations tab (S11:TXA-020)', () => {
	it('filters presets and applies the selected animation by double-click or Enter', () => {
		const session = makeSession();
		const [id] = addTexts(session, 1);
		act(() => session.select('timeline', [id!]));
		renderWithSession(session, <TextAnimationsTab />);
		const cards = () => screen.getAllByRole('listitem');
		fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
		expect(cards()).toHaveLength(1);
		fireEvent.click(screen.getByRole('button', { name: 'All' }));
		fireEvent.change(screen.getByRole('searchbox', { name: 'Search text animations' }), {
			target: { value: 'slide' },
		});
		expect(cards()).toHaveLength(4);
		fireEvent.doubleClick(cards()[0]!);
		expect(textOf(session, id!).textAnimation?.in?.preset).toBe('slide-up');
		// the Out chip makes double-click apply as Out
		fireEvent.click(screen.getByRole('button', { name: 'Out' }));
		fireEvent.keyDown(cards()[1]!, { key: 'Enter' });
		expect(textOf(session, id!).textAnimation?.out?.preset).toBe('slide-down');
		// dragging a card carries the preset
		const dt = dataTransfer();
		fireEvent.dragStart(cards()[2]!, { dataTransfer: dt });
		expect(readTextAnimationDrag(dt)).toEqual({ preset: 'slide-left', version: 1 });
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
		expect(sections).toContain('textAnimation');
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
	it('a compressed bar edge follows the pointer (the drag inverts the compression)', () => {
		const session = makeSession();
		const [id] = addTexts(session, 1, 60);
		applyTextAnimation(session, [id!], { side: 'both', preset: 'fade', durationFrames: 40 });
		// 40 + 40 do not fit 60 frames: drawn as 30 + 29
		expect(resolveTextAnimationWindows(textOf(session, id!)).in?.frames).toBe(30);
		act(() => session.select('timeline', [id!]));
		renderWithSession(session, <EffectControlsPanel instanceId="ec1" visible />);
		screen.getByTestId('ec-ruler').getBoundingClientRect = () =>
			({ left: 0, width: 128, top: 0, height: 34, right: 128, bottom: 34, x: 0, y: 0 }) as DOMRect;
		// +32 px ≈ +17 frames: the In edge is drawn at 30 + 17 = 47 frames (the stored value grows to 149)
		act(() => {
			fireEvent.pointerDown(screen.getByTestId('ec-text-anim-edge-in'), { clientX: 10, button: 0 });
			fireEvent.pointerMove(window, { clientX: 42 });
			fireEvent.pointerUp(window, { clientX: 42 });
		});
		const clip = textOf(session, id!);
		expect(clip.textAnimation?.in?.durationFrames).toBe(149);
		expect(resolveTextAnimationWindows(clip).in?.frames).toBe(47);
		// the Out edge: −16 px ≈ +8 frames on the window of 12 left after In
		act(() => {
			fireEvent.pointerDown(screen.getByTestId('ec-text-anim-edge-out'), { clientX: 100, button: 0 });
			fireEvent.pointerMove(window, { clientX: 84 });
			fireEvent.pointerUp(window, { clientX: 84 });
		});
		const after = resolveTextAnimationWindows(textOf(session, id!));
		expect(after.out?.frames).toBe(12 + 8);
	});
});
