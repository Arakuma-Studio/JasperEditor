// The Stroke Animation panel opens docked (a tab beside Effect Controls, else Properties, else Project) in every
// built-in layout, never floating.
import { describe, expect, it, vi } from 'vitest';
import strokeAnimation from '../src/panels/strokeAnimation/index.ts';
import type { PanelKind } from '../src/panels/types.ts';
import { DockController } from '../src/shell/dock/controller.ts';

function controllerWith(open: PanelKind[]) {
	const addPanel = vi.fn((opts: unknown) => opts);
	const c = new DockController({} as never, new Map([['strokeAnimation', strokeAnimation]]));
	c.api = {
		panels: open.map((kind) => ({ id: `${kind}-1`, params: { kind } })),
		addPanel,
		width: 1600,
		height: 900,
	} as never;
	return { c, addPanel };
}

describe('Stroke Animation panel docking', () => {
	it('opens as a tab beside the first open preferred neighbour', () => {
		const a = controllerWith(['program', 'project', 'effectControls']);
		a.c.open('strokeAnimation');
		expect(a.addPanel).toHaveBeenCalledWith(
			expect.objectContaining({ position: { referencePanel: 'effectControls-1', direction: 'within' } }),
		);
		const b = controllerWith(['program', 'project']);
		b.c.open('strokeAnimation');
		expect(b.addPanel).toHaveBeenCalledWith(
			expect.objectContaining({ position: { referencePanel: 'project-1', direction: 'within' } }),
		);
		expect(b.addPanel.mock.calls[0]![0]).not.toHaveProperty('floating');
	});

	it('floats only when none of its neighbours is open', () => {
		const { c, addPanel } = controllerWith(['program', 'timeline']);
		c.open('strokeAnimation');
		expect(addPanel.mock.calls[0]![0]).toHaveProperty('floating');
	});
});
