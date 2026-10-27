import type { EngineClient } from '@jasper/engine-client';
import { BUILTIN_EFFECT_PRESETS, type EffectPreset } from '@jasper/project';
import { closeAllDialogs, DialogHost } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { writePresetDragPayload } from '../src/panels/effects/drag.ts';
import { EffectsPanel } from '../src/panels/effects/EffectsPanel.tsx';
import { connectPresetLibrary, presetLibrary } from '../src/panels/effects/presets/store.ts';
import { addSolids, clipOf, makeSession, renderWithSession } from './inspector-helpers.tsx';

const F = 705_600_000 / 30;
type Anim = { value: number; keyframes: { time: number; value: number }[] };
const opacity = (s: ReturnType<typeof makeSession>, id: string) =>
	(clipOf(s, id) as unknown as { opacity: Anim }).opacity;
const effects = (s: ReturnType<typeof makeSession>, id: string) =>
	(clipOf(s, id) as unknown as { effects: { effectId: string; params: Record<string, Anim> }[] }).effects;
const presetRows = () =>
	[...document.querySelectorAll<HTMLElement>('[data-preset-id]')].map((r) => r.dataset.presetId);

/** An in-memory engine library behind the EngineClient `call()` boundary. */
function fakeEngine(initial: { folders?: { id: string; name: string }[]; presets?: EffectPreset[] } = {}) {
	const lib = { revision: 0, folders: initial.folders ?? [], presets: initial.presets ?? [] };
	const calls: { name: string; opts: Record<string, unknown> }[] = [];
	let n = 0;
	const client = {
		call: async (
			name: string,
			opts: { body?: Record<string, unknown>; params?: Record<string, string> } = {},
		) => {
			calls.push({ name, opts });
			if (name === 'effectPresetsList') return structuredClone(lib);
			if (name === 'effectPresetCreate') {
				const p = { ...(opts.body!.preset as EffectPreset), id: `fxp_${String(++n).padStart(16, '0')}` };
				lib.presets.push(p);
				lib.revision++;
				return p;
			}
			if (name === 'effectPresetDelete') {
				lib.presets = lib.presets.filter((p) => p.id !== opts.params!.presetId);
				lib.revision++;
				return { ok: true, removedPresets: [opts.params!.presetId], removedFolders: [] };
			}
			throw new Error(`unexpected ${name}`);
		},
	} as unknown as EngineClient;
	return { calls, client };
}

async function connect(engine: ReturnType<typeof fakeEngine>) {
	await act(async () => {
		connectPresetLibrary(engine.client);
	});
	await waitFor(() => expect(presetLibrary().getState().status).toBe('ready'));
}

beforeEach(() => {
	globalThis.localStorage?.clear();
	connectPresetLibrary(null);
});
afterEach(() => {
	closeAllDialogs();
	cleanup();
});

describe('Effects ▸ Presets bin (EFX-001, FX-030)', () => {
	it('lists built-ins, searches, filters by badges and applies by double-click as one undo step', () => {
		const session = makeSession();
		const ids = addSolids(session, [0, 0], 90);
		act(() => session.select('timeline', ids));
		renderWithSession(session, <EffectsPanel instanceId="e1" visible />);
		act(() => {
			fireEvent.change(screen.getByTestId('effects-search'), { target: { value: 'fade' } });
		});
		expect(presetRows()).toEqual(expect.arrayContaining(['builtin.fade-in', 'builtin.fade-out']));
		expect(presetRows()).not.toContain('builtin.blur-in');
		const entries = session.getState().history.entries.length;
		act(() => {
			fireEvent.doubleClick(document.querySelector('[data-preset-id="builtin.fade-in"]')!);
		});
		for (const id of ids)
			expect(opacity(session, id).keyframes.map((k) => [k.time / F, k.value])).toEqual([
				[0, 0],
				[30, 100],
			]);
		expect(session.getState().history.entries.length).toBe(entries + 1);
		act(() => {
			fireEvent.change(screen.getByTestId('effects-search'), { target: { value: 'blur' } });
		});
		expect(presetRows()).toEqual(expect.arrayContaining(['builtin.blur-in', 'builtin.blur-out']));
		expect(presetRows()).not.toContain('builtin.fade-in');
		act(() => {
			fireEvent.change(screen.getByTestId('effects-search'), { target: { value: 'zzz-nothing' } });
		});
		expect(screen.queryByTestId('effects-bin-presets')).toBeNull();
		expect(presetRows()).toEqual([]);
	});

	it('shows user bins from the engine library and deletes a preset after confirmation', async () => {
		const mine = {
			...structuredClone(BUILTIN_EFFECT_PRESETS.find((p) => p.id === 'builtin.fade-out')!),
			id: 'fxp_USER',
			name: 'My Fade',
			builtIn: undefined,
			category: undefined,
			folderId: 'fxb_1',
		} as EffectPreset;
		const engine = fakeEngine({ folders: [{ id: 'fxb_1', name: 'Mine' }], presets: [mine] });
		await connect(engine);
		const session = makeSession();
		renderWithSession(session, <EffectsPanel instanceId="e1" visible />);
		render(<DialogHost />);
		const bin = screen.getByTestId('preset-bin-fxb_1');
		expect(bin.textContent).toContain('Mine');
		expect(within(bin).getByText('My Fade')).toBeTruthy();
		act(() => {
			fireEvent.contextMenu(bin.querySelector('[data-preset-id="fxp_USER"]')!);
		});
		act(() => {
			fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }));
		});
		const dialog = await screen.findByTestId('confirm-dialog');
		await act(async () => {
			fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Preset' }));
		});
		await waitFor(() => expect(engine.calls.some((c) => c.name === 'effectPresetDelete')).toBe(true));
		await waitFor(() => expect(presetRows()).not.toContain('fxp_USER'));
	});
});

describe('Effect presets in Effect Controls (EC-004, FX-030)', () => {
	it('a dragged preset is an effect ref; dropping it on Effect Controls applies it', () => {
		const store = new Map<string, string>();
		const dt = {
			types: [] as string[],
			setData: (t: string, v: string) => {
				store.set(t, v);
				dt.types.push(t);
			},
			getData: (t: string) => store.get(t) ?? '',
			effectAllowed: 'none',
			dropEffect: 'none',
		};
		writePresetDragPayload(dt as unknown as DataTransfer, 'builtin.blur-in');
		const session = makeSession();
		const [id] = addSolids(session, [0], 90);
		act(() => session.select('timeline', [id!]));
		renderWithSession(session, <EffectControlsPanel instanceId="ec1" visible />);
		act(() => {
			fireEvent.dragOver(screen.getByTestId('ec-drop-end'), { dataTransfer: dt });
			fireEvent.drop(screen.getByTestId('ec-drop-end'), { dataTransfer: dt });
		});
		const blur = effects(session, id!).find((e) => e.effectId === 'jasper.gaussian-blur')!;
		expect(blur.params.radius!.keyframes.map((k) => [k.time / F, k.value])).toEqual([
			[0, 60],
			[30, 0],
		]);
	});

	it('Save Preset… on selected headers opens the dialog and stores the sections in the library', async () => {
		const engine = fakeEngine();
		await connect(engine);
		const session = makeSession();
		const [id] = addSolids(session, [0], 60);
		act(() => {
			session.apply({
				label: 'keys',
				origin: 'user',
				commands: [
					{ type: 'keyframe.add', target: ['clip', id, 'opacity'], at: { frames: 40 }, value: 100 },
					{ type: 'keyframe.add', target: ['clip', id, 'opacity'], at: { frames: 59 }, value: 0 },
				] as never,
			});
			session.select('timeline', [id!]);
		});
		renderWithSession(session, <EffectControlsPanel instanceId="ec1" visible />);
		render(<DialogHost />);
		const header = (suffix: string) =>
			document.querySelector<HTMLElement>(`[data-ec-header="${id}:${suffix}"] > div`)!;
		act(() => {
			fireEvent.click(header('motion'));
			fireEvent.click(header('opacity'), { ctrlKey: true });
		});
		act(() => {
			fireEvent.contextMenu(header('opacity'));
		});
		const menu = screen.getByTestId('ec-header-menu');
		act(() => {
			fireEvent.click(within(menu).getByRole('menuitem', { name: /Save Preset/ }));
		});
		const dialog = await screen.findByTestId('save-preset-dialog');
		fireEvent.change(within(dialog).getByTestId('save-preset-name'), { target: { value: 'Fade Down' } });
		fireEvent.click(within(dialog).getByTestId('save-preset-type-anchor-out').querySelector('input')!);
		fireEvent.change(within(dialog).getByTestId('save-preset-description'), {
			target: { value: 'ends dark' },
		});
		await act(async () => {
			fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
		});
		await waitFor(() => expect(engine.calls.some((c) => c.name === 'effectPresetCreate')).toBe(true));
		const saved = (
			engine.calls.find((c) => c.name === 'effectPresetCreate')!.opts.body as { preset: EffectPreset }
		).preset;
		expect(saved).toMatchObject({ name: 'Fade Down', type: 'anchor-out', description: 'ends dark' });
		expect(Object.keys(saved.intrinsic ?? {}).sort()).toEqual(['blendMode', 'motion', 'opacity']);
		expect(saved.intrinsic?.opacity?.keyframes?.map((k) => k.time / F)).toEqual([40, 59]);
		expect(saved.effects).toBeUndefined();
	});
});
