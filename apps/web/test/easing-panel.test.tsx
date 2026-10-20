import { builtinEasePresets, type EasePreset, type Keyframe, type TransactionResult } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type EaseDispatch, EaseDispatchProvider } from '../src/panels/easing/dispatch.tsx';
import { EasingPanel } from '../src/panels/easing/EasingPanel.tsx';
import { easeLibrary } from '../src/panels/easing/library.ts';
import { addSolids, clipOf, makeSession } from './inspector-helpers.tsx';

// The real built-in catalogue (packages/project/src/ease/presets.ts).
const builtin = (id: string): EasePreset => builtinEasePresets().find((p) => p.id === id)!;
const gentle = builtin('basic.easy-ease');

function stub(reasons: Record<string, string | undefined> = {}) {
	const run = vi.fn(async (_id: string, _args?: unknown) => true);
	const toast = vi.fn();
	const d: EaseDispatch = { run, reason: (id) => reasons[id], toast, platform: 'win' };
	return { d, run, toast };
}

function show(
	opts: { reasons?: Record<string, string | undefined>; session?: ReturnType<typeof makeSession> } = {},
) {
	const s = stub(opts.reasons);
	const ui = (
		<EaseDispatchProvider value={s.d}>
			<EasingPanel instanceId="ease" visible />
		</EaseDispatchProvider>
	);
	render(opts.session ? <SessionProvider session={opts.session}>{ui}</SessionProvider> : ui);
	return s;
}

const text = () => screen.getByTestId('ease-cubic-text') as HTMLInputElement;
const editor = () => screen.getByTestId('ease-curve-editor');

beforeEach(() => {
	globalThis.localStorage?.clear();
	easeLibrary.reload();
});
afterEach(() => cleanup());

// The editor measures 240 × 180 (no layout in the test DOM); its view is y −0.25…1.25 with 14 px padding.
const px = (x: number, y: number, lo = -0.25, hi = 1.25) => ({
	clientX: 14 + x * 212,
	clientY: 14 + ((hi - y) / (hi - lo)) * 152,
});

function drag(el: Element, from: { clientX: number; clientY: number }, dx: number, dy: number, mods = {}) {
	act(() => {
		fireEvent.pointerDown(el, { ...from, button: 0, ...mods });
	});
	act(() => {
		fireEvent.pointerMove(window, {
			clientX: from.clientX + dx / 2,
			clientY: from.clientY + dy / 2,
			...mods,
		});
		fireEvent.pointerMove(window, { clientX: from.clientX + dx, clientY: from.clientY + dy, ...mods });
	});
	act(() => {
		fireEvent.pointerUp(window, { clientX: from.clientX + dx, clientY: from.clientY + dy });
	});
}

describe('Easing panel ▸ curve editor', () => {
	it('drags a handle; a symmetric curve stays symmetric, Alt breaks the link', () => {
		show();
		expect(text().value).toBe('cubic-bezier(0.333, 0.333, 0.667, 0.667)');
		// +0.1 in x (21.2 px), +0.15 in y (−15.2 px).
		drag(screen.getByTestId('ease-handle-h1'), px(1 / 3, 1 / 3), 21.2, -15.2);
		expect(text().value).toBe('cubic-bezier(0.433, 0.483, 0.567, 0.517)');
		drag(screen.getByTestId('ease-handle-h1'), px(0.433, 0.483), 21.2, 0, { altKey: true });
		expect(text().value).toBe('cubic-bezier(0.533, 0.483, 0.567, 0.517)');
	});

	it('Shift constrains the drag to one axis; Escape cancels it', () => {
		show();
		drag(screen.getByTestId('ease-handle-h2'), px(2 / 3, 2 / 3), 21.2, -3, { shiftKey: true, altKey: true });
		expect(text().value).toBe('cubic-bezier(0.333, 0.333, 0.767, 0.667)');
		const h = screen.getByTestId('ease-handle-h2');
		act(() => {
			fireEvent.pointerDown(h, { ...px(0.767, 0.667), button: 0 });
			fireEvent.pointerMove(window, { clientX: 10, clientY: 10 });
			fireEvent.keyDown(window, { key: 'Escape' });
		});
		expect(text().value).toBe('cubic-bezier(0.333, 0.333, 0.767, 0.667)');
	});

	it('Ctrl-click on the curve adds a point, on the point removes it; double-click resets', () => {
		show();
		act(() => {
			fireEvent.pointerDown(editor(), { ...px(0.5, 0.5), button: 0, ctrlKey: true });
		});
		expect(editor().dataset.curveKind).toBe('multi');
		expect(screen.getByTestId('ease-handle-point-1')).toBeTruthy();
		// Far from the curve nothing is added.
		act(() => {
			fireEvent.pointerDown(editor(), { ...px(0.8, 0.1), button: 0, ctrlKey: true });
		});
		expect(screen.queryByTestId('ease-handle-point-2')).toBeNull();
		act(() => {
			fireEvent.pointerDown(screen.getByTestId('ease-handle-point-1'), {
				...px(0.5, 0.5),
				button: 0,
				ctrlKey: true,
			});
		});
		expect(editor().dataset.curveKind).toBe('cubic');
		fireEvent.change(text(), { target: { value: 'ease' } });
		fireEvent.keyDown(text(), { key: 'Enter' });
		expect(text().value).toBe('cubic-bezier(0.25, 0.1, 0.25, 1)');
		fireEvent.doubleClick(editor());
		expect(text().value).toBe('cubic-bezier(0.333, 0.333, 0.667, 0.667)');
	});

	it('keyboard: arrows nudge the focused handle, + adds a point, Delete removes it, Ctrl+Z undoes', () => {
		show();
		const h1 = screen.getByTestId('ease-handle-h1');
		fireEvent.focus(h1);
		fireEvent.keyDown(h1, { key: 'ArrowUp', shiftKey: true });
		expect(text().value).toBe('cubic-bezier(0.333, 0.433, 0.667, 0.667)');
		fireEvent.keyDown(editor(), { key: '+' });
		expect(editor().dataset.curveKind).toBe('multi');
		fireEvent.keyDown(editor(), { key: 'Delete' });
		expect(editor().dataset.curveKind).toBe('cubic');
		fireEvent.keyDown(editor(), { code: 'KeyZ', key: 'z', ctrlKey: true });
		expect(editor().dataset.curveKind).toBe('multi');
		fireEvent.keyDown(editor(), { code: 'KeyZ', key: 'Z', ctrlKey: true, shiftKey: true });
		expect(editor().dataset.curveKind).toBe('cubic');
		fireEvent.click(screen.getByTestId('ease-undo'));
		expect(editor().dataset.curveKind).toBe('multi');
	});

	it('numeric fields and the cubic-bezier text refuse invalid input', () => {
		show();
		const x1 = screen.getByTestId('ease-field-x1') as HTMLInputElement;
		fireEvent.change(x1, { target: { value: '0.25' } });
		fireEvent.blur(x1);
		expect(text().value).toBe('cubic-bezier(0.25, 0.333, 0.667, 0.667)');
		fireEvent.change(x1, { target: { value: 'abc' } });
		fireEvent.blur(x1);
		expect(x1.getAttribute('aria-invalid')).toBe('true');
		expect(text().value).toBe('cubic-bezier(0.25, 0.333, 0.667, 0.667)');
		fireEvent.change(text(), { target: { value: 'cubic-bezier(2, 0, 0, 1)' } });
		fireEvent.keyDown(text(), { key: 'Enter' });
		expect(screen.getByTestId('ease-error').textContent).toMatch(/between 0 and 1/);
		expect(text().getAttribute('aria-invalid')).toBe('true');
		fireEvent.paste(text(), { clipboardData: { getData: () => 'cubic-bezier(0.1, 0.7, 0.1, 1)' } });
		expect(screen.queryByTestId('ease-error')).toBeNull();
		expect((screen.getByTestId('ease-field-y1') as HTMLInputElement).value).toBe('0.7');
	});

	it('Mirror makes the curve symmetric', () => {
		show();
		fireEvent.change(text(), { target: { value: 'cubic-bezier(0.3, 0.1, 0.9, 0.5)' } });
		fireEvent.keyDown(text(), { key: 'Enter' });
		fireEvent.click(screen.getByTestId('ease-mirror'));
		expect(text().value).toBe('cubic-bezier(0.3, 0.1, 0.7, 0.9)');
	});

	it('remembers the edited curve', () => {
		show();
		fireEvent.change(text(), { target: { value: 'cubic-bezier(0.3, 0.1, 0.9, 0.5)' } });
		fireEvent.keyDown(text(), { key: 'Enter' });
		expect(easeLibrary.get().settings.curve).toEqual({ kind: 'cubic', x1: 0.3, y1: 0.1, x2: 0.9, y2: 0.5 });
		cleanup();
		show();
		expect(text().value).toBe('cubic-bezier(0.3, 0.1, 0.9, 0.5)');
	});
});

describe('Easing panel ▸ applying and targeting', () => {
	it('Apply sends the curve; Shift / Alt / Ctrl pick in / out / middle and add up', () => {
		const { run } = show();
		fireEvent.click(screen.getByTestId('ease-apply'));
		const curve = { kind: 'cubic', x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 };
		expect(run).toHaveBeenLastCalledWith('ease.apply', { curve });
		fireEvent.click(screen.getByTestId('ease-apply'), { shiftKey: true });
		expect(run).toHaveBeenLastCalledWith('ease.apply', { curve, sections: ['in'] });
		fireEvent.click(screen.getByTestId('ease-apply'), { altKey: true, ctrlKey: true });
		expect(run).toHaveBeenLastCalledWith('ease.apply', { curve, sections: ['middle', 'out'] });
		// The explicit control is used without modifiers.
		fireEvent.click(screen.getByTestId('ease-section-out'));
		fireEvent.click(screen.getByTestId('ease-section-in'));
		expect(screen.getByTestId('ease-section-in').getAttribute('aria-pressed')).toBe('true');
		fireEvent.click(screen.getByTestId('ease-apply'));
		expect(run).toHaveBeenLastCalledWith('ease.apply', { curve, sections: ['in', 'out'] });
	});

	it('disabled actions show the command’s reason', () => {
		show({
			reasons: {
				'ease.apply': 'Select keyframes in Effect Controls',
				'ease.copy': 'Select keyframes in Effect Controls',
			},
		});
		const apply = screen.getByTestId('ease-apply');
		expect(apply.getAttribute('aria-disabled')).toBe('true');
		fireEvent.click(apply);
		expect(screen.getByTestId('ease-info').textContent).toBe('Select keyframes in Effect Controls');
	});

	it('the toolbar and its More menu run the easing commands', () => {
		const { run } = show({
			reasons: { 'ease.drivePath': 'This build has no keyframe.createPathController command yet' },
		});
		fireEvent.click(screen.getByTestId('ease-copy'));
		expect(run).toHaveBeenLastCalledWith('ease.copy');
		fireEvent.click(screen.getByTestId('ease-paste'), { altKey: true });
		expect(run).toHaveBeenLastCalledWith('ease.paste', { sections: ['out'] });
		fireEvent.click(screen.getByTestId('ease-more'));
		const menu = screen.getByTestId('ease-more-menu');
		fireEvent.click(within(menu).getByText('Mirror Keys at Playhead'));
		expect(run).toHaveBeenLastCalledWith('ease.mirrorAtPlayhead');
		fireEvent.click(screen.getByTestId('ease-more'));
		const drive = within(screen.getByTestId('ease-more-menu')).getByText(
			/Drive Along Path — This build has no/,
		);
		expect((drive.closest('button') as HTMLButtonElement).disabled).toBe(true);
	});

	it('shows the selection’s curve and what an apply will reach', () => {
		const session = makeSession();
		const [id] = addSolids(session, [0], 60);
		session.apply({
			label: 'keys',
			origin: 'user',
			commands: [
				{
					type: 'keyframe.add',
					target: ['clip', id, 'opacity'],
					at: { frames: 0 },
					value: 0,
					interpolation: 'bezier',
					easeOut: { influence: 0.25, slope: 0.4 },
				},
				{
					type: 'keyframe.add',
					target: ['clip', id, 'opacity'],
					at: { frames: 30 },
					value: 100,
					interpolation: 'bezier',
					easeIn: { influence: 0.5, slope: 0 },
				},
				{ type: 'keyframe.add', target: ['clip', id, 'transform', 'rotation'], at: { frames: 0 }, value: 0 },
				{
					type: 'keyframe.add',
					target: ['clip', id, 'transform', 'rotation'],
					at: { frames: 30 },
					value: 90,
				},
			] as never,
		});
		const keys = (k: 'opacity' | 'rotation') => {
			const c = clipOf(session, id!) as unknown as {
				opacity: { keyframes: Keyframe<unknown>[] };
				transform: { rotation: { keyframes: Keyframe<unknown>[] } };
			};
			return (k === 'opacity' ? c.opacity : c.transform.rotation).keyframes;
		};
		act(() => session.selectKeyframes({ clipOrTrackId: id!, keyframeIds: keys('opacity').map((k) => k.id) }));
		show({ session });
		expect(text().value).toBe('cubic-bezier(0.25, 0.1, 0.5, 1)');
		expect(screen.getByTestId('ease-info').textContent).toBe('Auto: 1 segment in 1 property');
		act(() =>
			session.selectKeyframes({
				clipOrTrackId: id!,
				keyframeIds: [...keys('opacity'), ...keys('rotation')].map((k) => k.id),
			}),
		);
		expect(screen.getByTestId('ease-property')).toBeTruthy();
		expect(screen.getByTestId('ease-info').textContent).toBe('Auto: 2 segments in 2 properties');
		fireEvent.keyDown(window, { key: 'Shift', shiftKey: true });
		expect(screen.getByTestId('ease-info').textContent).toBe('In: no segment to ease for this selection');
		fireEvent.keyUp(window, { key: 'Shift', shiftKey: false });
	});

	it('Auto-apply runs a drag as one live gesture', () => {
		const session = makeSession();
		const ok = { ok: true, results: [], warnings: [], created: [] } as unknown as TransactionResult;
		const g = { active: true, update: vi.fn(() => ok), commit: vi.fn(() => ok), cancel: vi.fn() };
		vi.spyOn(session, 'beginGesture').mockReturnValue(g as never);
		easeLibrary.settings({ autoApply: true });
		show({ session });
		drag(screen.getByTestId('ease-handle-h1'), px(1 / 3, 1 / 3), 21.2, 0, { altKey: true });
		expect(g.update).toHaveBeenCalled();
		const last = g.update.mock.calls.at(-1)! as unknown as [{ type: string; curve: unknown }[]];
		expect(last[0][0]!.type).toBe('keyframe.applyEase');
		expect(g.commit).toHaveBeenCalledTimes(1);
		expect(g.cancel).not.toHaveBeenCalled();
	});
});

describe('Easing panel ▸ keyframe velocity', () => {
	function keyed(values: [number, number]) {
		const session = makeSession();
		const [id] = addSolids(session, [0], 60);
		session.apply({
			label: 'keys',
			origin: 'user',
			commands: values.map((value, i) => ({
				type: 'keyframe.add',
				target: ['clip', id, 'opacity'],
				at: { frames: i * 30 },
				value,
				interpolation: 'bezier',
			})) as never,
		});
		const keys = (clipOf(session, id!) as unknown as { opacity: { keyframes: Keyframe<unknown>[] } }).opacity
			.keyframes;
		act(() => session.selectKeyframes({ clipOrTrackId: id!, keyframeIds: keys.map((k) => k.id) }));
		return { session, keys };
	}

	it('edits the speed and influence of a side, or both with Link', () => {
		const { session, keys } = keyed([0, 100]);
		const { run } = show({ session });
		expect(screen.getByTestId('ease-velocity-key')).toBeTruthy();
		// The first key: no segment before it.
		const inSpeed = screen.getByTestId('ease-velocity-in-speed') as HTMLInputElement;
		expect(inSpeed.disabled).toBe(true);
		expect(inSpeed.closest('label')!.title).toBe('No keyframe before it');
		const outSpeed = screen.getByTestId('ease-velocity-out-speed') as HTMLInputElement;
		fireEvent.change(outSpeed, { target: { value: '120' } });
		fireEvent.keyDown(outSpeed, { key: 'Enter' });
		expect(run).toHaveBeenLastCalledWith('ease.setVelocity', {
			keyframeId: keys[0]!.id,
			side: 'out',
			speed: 120,
		});
		fireEvent.click(screen.getByTestId('ease-velocity-link'));
		const infl = screen.getByTestId('ease-velocity-out-influence') as HTMLInputElement;
		fireEvent.change(infl, { target: { value: '250' } });
		fireEvent.blur(infl);
		expect(run).toHaveBeenLastCalledWith('ease.setVelocity', {
			keyframeId: keys[0]!.id,
			side: 'both',
			influence: 100,
		});
	});

	it('a flat segment has no speed to set', () => {
		const { session } = keyed([50, 50]);
		show({ session });
		const outSpeed = screen.getByTestId('ease-velocity-out-speed') as HTMLInputElement;
		expect(outSpeed.disabled).toBe(true);
		expect(outSpeed.closest('label')!.title).toMatch(/Both keys of this segment are equal/);
		expect((screen.getByTestId('ease-velocity-out-influence') as HTMLInputElement).disabled).toBe(false);
	});
});

describe('Easing panel ▸ preview', () => {
	it('plays the curve, or shows still frames with reduced motion', () => {
		show();
		expect(screen.getByTestId('ease-preview').dataset.animated).toBe('true');
		cleanup();
		const mm = vi.spyOn(window, 'matchMedia').mockImplementation(
			(q: string) =>
				({
					matches: q.includes('reduce'),
					media: q,
					addEventListener() {},
					removeEventListener() {},
				}) as unknown as MediaQueryList,
		);
		show();
		expect(screen.getByTestId('ease-preview').dataset.animated).toBe('false');
		expect(screen.getAllByTestId('ease-preview-still')).toHaveLength(5);
		mm.mockRestore();
	});
});

describe('Easing panel ▸ library', () => {
	it('built-in tiles apply and load; the matching tile is highlighted; hover shows its values', () => {
		const { run } = show();
		fireEvent.click(screen.getByTestId('ease-tab-builtin:basic'));
		fireEvent.pointerEnter(screen.getByTestId('ease-tile-basic.easy-ease-out'));
		expect(screen.getByTestId('ease-info').textContent).toBe(
			'Easy Ease Out · cubic-bezier(0.333, 0, 0.667, 0.667)',
		);
		fireEvent.click(screen.getByTestId('ease-pick-basic.easy-ease'), { shiftKey: true });
		expect(run).toHaveBeenLastCalledWith('ease.apply', {
			curve: gentle.curve,
			sections: ['in'],
			name: 'Easy Ease',
		});
		expect(text().value).toBe('cubic-bezier(0.333, 0, 0.667, 1)');
		expect(screen.getByTestId('ease-tile-basic.easy-ease').dataset.matched).toBe('true');
	});

	it('built-ins are read-only: Duplicate copies one into My Curves', () => {
		show();
		fireEvent.click(screen.getByTestId('ease-tab-builtin:basic'));
		fireEvent.contextMenu(screen.getByTestId('ease-tile-basic.easy-ease-out'));
		const menu = screen.getByTestId('ease-library-menu');
		expect(within(menu).queryByText('Rename…')).toBeNull();
		fireEvent.click(within(menu).getByText('Duplicate to My Curves'));
		expect(easeLibrary.get().presets.map((p) => p.name)).toEqual(['Easy Ease Out copy']);
	});

	it('save, rename, reorder from the keyboard, delete with undo', () => {
		show();
		for (const name of ['First', 'Second']) {
			fireEvent.click(screen.getByTestId('ease-save'));
			const input = screen.getByTestId('ease-save-name');
			fireEvent.change(input, { target: { value: name } });
			fireEvent.keyDown(input, { key: 'Enter' });
		}
		fireEvent.click(screen.getByTestId('ease-tab-user'));
		const [a, b] = easeLibrary.get().presets;
		expect([a!.name, b!.name]).toEqual(['First', 'Second']);
		fireEvent.keyDown(screen.getByTestId(`ease-pick-${a!.id}`), { key: 'ArrowRight', altKey: true });
		expect(easeLibrary.get().presets.map((p) => p.name)).toEqual(['Second', 'First']);
		fireEvent.contextMenu(screen.getByTestId(`ease-tile-${a!.id}`));
		fireEvent.click(within(screen.getByTestId('ease-library-menu')).getByText('Rename…'));
		const name = screen.getByTestId('ease-inline-name');
		fireEvent.change(name, { target: { value: 'Renamed' } });
		fireEvent.keyDown(name, { key: 'Enter' });
		expect(easeLibrary.get().presets.find((p) => p.id === a!.id)!.name).toBe('Renamed');
		fireEvent.contextMenu(screen.getByTestId(`ease-tile-${a!.id}`));
		fireEvent.click(within(screen.getByTestId('ease-library-menu')).getByText('Delete'));
		expect(easeLibrary.get().presets).toHaveLength(1);
		fireEvent.click(within(screen.getByTestId('ease-library-notice')).getByText('Undo'));
		expect(easeLibrary.get().presets).toHaveLength(2);
	});

	it('imports a file, listing what it skipped; an oversized file is refused', async () => {
		show();
		const input = screen.getByTestId('ease-import-file') as HTMLInputElement;
		const file = (body: string, size?: number) => {
			const f = new File([body], 'curves.json', { type: 'application/json' });
			if (size) Object.defineProperty(f, 'size', { value: size });
			return f;
		};
		const body = JSON.stringify({
			format: 'jasper-ease-presets',
			version: 1,
			presets: [
				{ id: 'x', name: 'Imported', group: 'user', curve: gentle.curve },
				{ id: 'y', name: 'Broken', group: 'user', curve: { kind: 'cubic', x1: 5, y1: 0, x2: 0, y2: 1 } },
			],
		});
		await act(async () => {
			fireEvent.change(input, { target: { files: [file(body)] } });
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(easeLibrary.get().presets.map((p) => p.name)).toEqual(['Imported']);
		expect(screen.getByTestId('ease-library-notice').textContent).toMatch(/Imported 1 curves; 1 skipped/);
		expect(screen.getByTestId('ease-library-errors').textContent).toMatch(/Preset 2: curve/);
		await act(async () => {
			fireEvent.change(input, { target: { files: [file('{}', 5_000_000)] } });
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(screen.getByTestId('ease-library-errors').textContent).toMatch(/larger than/);
	});

	it('new groups, tile size and columns are settings', () => {
		show();
		fireEvent.click(screen.getByTestId('ease-new-group'));
		const input = screen.getByTestId('ease-inline-name');
		fireEvent.change(input, { target: { value: 'Springs' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		const g = easeLibrary.get().groups.find((x) => x.name === 'Springs')!;
		expect(easeLibrary.get().settings.group).toBe(g.id);
		fireEvent.change(screen.getByTestId('ease-columns'), { target: { value: '3' } });
		expect(easeLibrary.get().settings.columns).toBe(3);
	});

	it('the view switch shows the editor, the library or both', () => {
		show();
		fireEvent.click(screen.getByTestId('ease-view-library'));
		expect(screen.queryByTestId('ease-curve-editor')).toBeNull();
		expect(screen.getByTestId('ease-library')).toBeTruthy();
		fireEvent.click(screen.getByTestId('ease-view-curve'));
		expect(screen.queryByTestId('ease-library')).toBeNull();
		expect(easeLibrary.get().settings.view).toBe('curve');
	});
});
