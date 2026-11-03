// Spec 19 TL-063, TL-064, TL-097: generator presets as chips at the top of a generator's inspector (a look layer in
// Properties and Effect Controls, a standalone generator effect in Effect Controls), Graphics ▸ New Layer ▸ Generator
// and the palette's generator rows.
import { type Appearance, type EffectInstance, TITLE_GENERATORS } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { titleLookCommands } from '../src/commands/title-looks.ts';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { PropertiesPanel } from '../src/panels/properties/PropertiesPanel.tsx';
import { MENUBAR } from '../src/shell/menus/model.ts';
import {
	generatorOf,
	holdsPreset,
	presetCommands,
	presetValues,
} from '../src/title-looks/GeneratorPresets.tsx';
import '../src/title-looks/register.ts';
import { layerRows } from '../src/title-looks/rows.ts';
import { lookedClip, sharedStack } from '../src/title-looks/selection.ts';
import { clipOf, makeSession, renderWithSession } from './inspector-helpers.tsx';

afterEach(cleanup);

const fire = TITLE_GENERATORS.find((g) => g.id === 'fire')!;
const blaze = fire.presets!.find((p) => p.id === 'blaze')!;
const overEdges = fire.presets!.find((p) => p.id === 'overEdges')!;
const historyLength = (s: EditorSession) => s.getState().history.entries.length;
const seqOf = (s: EditorSession) => Object.values(s.getCommitted().sequences)[0]!;

/** A title with a look holding a fire layer, selected. */
function titleWithFire() {
	const session = makeSession();
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		commands: [
			{ type: 'clip.addText', at: 0, duration: 30, track: 'V2', content: { text: 'hot' }, ref: '$t' },
			{
				type: 'look.apply',
				clipIds: ['$t'],
				look: { name: 'Hot', recipe: { palette: { face: [1, 1, 1, 1] }, layers: [{ type: 'face' }] } },
			},
		] as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const id = r.refs.$t!;
	const fx = lookedClip(clipOf(session, id))!.fx;
	const add = session.apply({
		label: 'fire',
		origin: 'user',
		commands: [
			{ type: 'appearance.addLayer', effectInstanceId: fx.id, layerType: 'generator:fire' },
		] as never,
	});
	if (!add.ok) throw new Error(JSON.stringify(add.errors));
	act(() => session.select('timeline', [id]));
	return { session, id, fxId: fx.id };
}

const fireLayer = (session: EditorSession, id: string) =>
	(lookedClip(clipOf(session, id))!.appearance as Appearance).layers.find(
		(l) => l.type === 'generator:fire',
	)!;

describe('preset values (TL-063)', () => {
	it('are the preset over the defaults, own params only', () => {
		const v = presetValues(fire, blaze);
		expect(v.height).toBe(130);
		expect(v.turbulence).toBe(70);
		expect(v.overEdge).toBe(false);
		expect(Object.keys(v)).not.toContain('paint');
		expect(Object.keys(v)).not.toContain('opacity');
		expect(generatorOf('generator:fire')).toBe(fire);
		expect(generatorOf('jasper.generator.fire')).toBe(fire);
		expect(generatorOf('jasper.glow')).toBeUndefined();
	});

	it('write only what differs, and the chip that matches reads as held', () => {
		const { session, id } = titleWithFire();
		const doc = session.getCommitted();
		const seq = seqOf(session);
		const shared = sharedStack([lookedClip(clipOf(session, id))!])!;
		const s = shared.find((x) => x.type === 'generator:fire')!;
		const rows = layerRows(doc, seq, s, 0);
		expect(holdsPreset(fire, fire.presets![0]!, rows)).toBe(true);
		expect(holdsPreset(fire, blaze, rows)).toBe(false);
		const cmds = presetCommands(fire, overEdges, rows, 0);
		// Over the Edges changes two params from the defaults.
		expect(cmds).toHaveLength(2);
		expect(presetCommands(fire, fire.presets![0]!, rows, 0)).toEqual([]);
	});
});

describe('chips in Properties ▸ Appearance', () => {
	it('set the opened generator layer to a preset in one undo step, and press that chip', () => {
		const { session, id } = titleWithFire();
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		const row = screen
			.getAllByRole('listitem')
			.find((e) => e.getAttribute('data-layer-type') === 'generator:fire')!;
		const index = row.getAttribute('data-testid')!.replace('look-layer-', '');
		fireEvent.click(screen.getByTestId(`look-layer-open-${index}`));
		const chips = screen.getByTestId(`look-generator-presets-${index}`);
		expect(chips.querySelectorAll('button')).toHaveLength(fire.presets!.length);
		const n = historyLength(session);
		fireEvent.click(chips.querySelector('[data-preset="blaze"]')!);
		expect(historyLength(session)).toBe(n + 1);
		const params = fireLayer(session, id).params;
		expect(params.height!.value).toBe(130);
		expect(params.spread!.value).toBe(30);
		expect(chips.querySelector('[data-preset="blaze"]')!.getAttribute('aria-pressed')).toBe('true');
		expect(chips.querySelector('[data-preset="behind"]')!.getAttribute('aria-pressed')).toBe('false');
		// Undo is one step back to the defaults.
		act(() => void session.undo());
		expect(fireLayer(session, id).params.height!.value).toBe(75);
	});

	it('key an animated param at the playhead instead of replacing its animation', () => {
		const { session, id, fxId } = titleWithFire();
		const layer = fireLayer(session, id);
		session.apply({
			label: 'animate',
			origin: 'user',
			commands: [
				{
					type: 'param.setAnimated',
					target: ['appearance', fxId, layer.id, 'height'],
					animated: true,
					at: { sequenceFrame: 0 },
				},
			] as never,
		});
		session.transport.seek(10);
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		const row = screen
			.getAllByRole('listitem')
			.find((e) => e.getAttribute('data-layer-type') === 'generator:fire')!;
		const index = row.getAttribute('data-testid')!.replace('look-layer-', '');
		fireEvent.click(screen.getByTestId(`look-layer-open-${index}`));
		fireEvent.click(
			screen.getByTestId(`look-generator-presets-${index}`).querySelector('[data-preset="blaze"]')!,
		);
		const height = fireLayer(session, id).params.height!;
		expect(height.keyframes).toHaveLength(2);
		expect(height.keyframes.map((k) => k.value)).toEqual([75, 130]);
	});
});

describe('chips in Effect Controls', () => {
	it('show on a look’s generator layer', () => {
		const { session, id } = titleWithFire();
		renderWithSession(session, <EffectControlsPanel instanceId="e1" visible />);
		const layer = fireLayer(session, id);
		fireEvent.click(screen.getByTestId(`ec-look-toggle-${layer.id}`));
		const chips = screen.getByTestId(`ec-look-generator-presets-${layer.id}`);
		fireEvent.click(chips.querySelector('[data-preset="overEdges"]')!);
		expect(fireLayer(session, id).params.overEdge!.value).toBe(true);
		expect(fireLayer(session, id).params.height!.value).toBe(55);
	});

	it('show at the top of a standalone generator effect, one undo step per chip', () => {
		const session = makeSession();
		const r = session.apply({
			label: 'g',
			origin: 'user',
			commands: [
				{ type: 'clip.addGenerator', effectId: 'generator:fire', at: 0, duration: 30, ref: '$g' },
			] as never,
		});
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		const id = r.refs.$g!;
		act(() => session.select('timeline', [id]));
		renderWithSession(session, <EffectControlsPanel instanceId="e1" visible />);
		const fx = (clipOf(session, id) as unknown as { effects: EffectInstance[] }).effects[0]!;
		const chips = screen.getByTestId(`generator-presets-${fx.id}`);
		const n = historyLength(session);
		fireEvent.click(chips.querySelector('[data-preset="blaze"]')!);
		expect(historyLength(session)).toBe(n + 1);
		const after = (clipOf(session, id) as unknown as { effects: EffectInstance[] }).effects[0]!;
		expect(after.params.height!.value).toBe(130);
		expect(chips.querySelector('[data-preset="blaze"]')!.getAttribute('aria-pressed')).toBe('true');
	});
});

/** A title of `sizePx` whose look holds a Sunburst reaching `extent` % of the unit, selected. */
function titleWithSunburst(sizePx: number, extent: number) {
	const session = makeSession();
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		commands: [
			{
				type: 'clip.addText',
				at: 0,
				duration: 30,
				track: 'V2',
				content: { text: 'big', style: { sizePx } },
				ref: '$t',
			},
			{
				type: 'look.apply',
				clipIds: ['$t'],
				look: { name: 'Rays', recipe: { layers: [{ type: 'face' }] } },
			},
		] as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const id = r.refs.$t!;
	const fx = lookedClip(clipOf(session, id))!.fx;
	session.apply({
		label: 'rays',
		origin: 'user',
		commands: [
			{ type: 'appearance.addLayer', effectInstanceId: fx.id, layerType: 'generator:sunburst' },
		] as never,
	});
	const layer = lookedClip(clipOf(session, id))!.appearance.layers.find(
		(l) => l.type === 'generator:sunburst',
	)!;
	const set = session.apply({
		label: 'extent',
		origin: 'user',
		commands: [
			{ type: 'param.set', target: ['appearance', fx.id, layer.id, 'extent'], value: extent },
		] as never,
	});
	if (!set.ok) throw new Error(JSON.stringify(set.errors));
	act(() => session.select('timeline', [id]));
	return { session, layerId: layer.id };
}

describe('reach past the canvas limit (spec 19, AGENTS §4)', () => {
	const openSunburst = () => {
		const row = screen
			.getAllByRole('listitem')
			.find((e) => e.getAttribute('data-layer-type') === 'generator:sunburst')!;
		fireEvent.click(
			screen.getByTestId(`look-layer-open-${row.getAttribute('data-testid')!.replace('look-layer-', '')}`),
		);
	};

	it('the generator’s inspector says where its drawing stops when the reach passes the canvas limit', () => {
		const { session, layerId } = titleWithSunburst(300, 800);
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		openSunburst();
		expect(screen.getByTestId('generator-reach-cut').textContent).toMatch(/2404 px.*2048 px/);
		cleanup();
		renderWithSession(session, <EffectControlsPanel instanceId="e1" visible />);
		fireEvent.click(screen.getByTestId(`ec-look-toggle-${layerId}`));
		expect(screen.getByTestId('generator-reach-cut').textContent).toMatch(/2048 px/);
	});

	it('says nothing when it fits', () => {
		const { session } = titleWithSunburst(120, 800);
		renderWithSession(session, <PropertiesPanel instanceId="p1" visible />);
		openSunburst();
		expect(screen.queryByTestId('generator-reach-cut')).toBeNull();
	});
});

describe('Graphics ▸ New Layer ▸ Generator (TL-064, TL-097)', () => {
	const flat = (
		items: readonly { type: string; label?: string; items?: unknown; command?: string; args?: unknown }[],
	) => items;
	it('lists every generator under New Layer', () => {
		const graphics = MENUBAR.find((m) => m.id === 'graphics')!;
		const newLayer = flat(graphics.items as never).find(
			(i) =>
				i.type === 'submenu' && flat(i.items as never).some((x) => x.command === 'graphics.newTextLayer'),
		)!;
		const gen = flat(newLayer.items as never).find(
			(i) =>
				i.type === 'submenu' && flat(i.items as never).some((x) => x.command === 'graphics.addGenerator'),
		)!;
		expect([newLayer.label, gen.label]).toEqual(['New Layer', 'Generator']);
		const entries = flat(gen.items as never);
		expect(entries.map((e) => (e.args as { generatorId: string }).generatorId)).toEqual(
			TITLE_GENERATORS.map((g) => g.id),
		);
		expect(entries.every((e) => e.command === 'graphics.addGenerator')).toBe(true);
	});

	it('adds a standalone generator below the selected title for its length, with a preset, and selects it', async () => {
		const session = makeSession();
		const r = session.apply({
			label: 's',
			origin: 'user',
			commands: [
				{ type: 'clip.addText', at: 12, duration: 40, track: 'V2', content: { text: 'x' }, ref: '$t' },
			] as never,
		});
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		const title = r.refs.$t!;
		act(() => session.select('timeline', [title]));
		const toast = vi.fn();
		const n = historyLength(session);
		await titleLookCommands
			.find((c) => c.id === 'graphics.addGenerator')!
			.run({ session, ui: { toast } } as never, { generatorId: 'fire', preset: 'blaze' });
		expect(toast).not.toHaveBeenCalled();
		expect(historyLength(session)).toBe(n + 1);
		const seq = seqOf(session);
		const added = Object.values(seq.clips).find((c) => c.id !== title)!;
		expect([added.start, added.duration]).toEqual([12, 40]);
		const order = seq.videoTracks.map((t) => t.id);
		expect(order.indexOf(added.trackId)).toBeLessThan(order.indexOf(seq.clips[title]!.trackId));
		const fx = (added as unknown as { effects: EffectInstance[] }).effects[0]!;
		expect(fx.effectId).toBe('jasper.generator.fire');
		expect(fx.params.height!.value).toBe(130);
		expect(session.getState().selection.timeline.clips).toEqual([added.id]);
	});
});
