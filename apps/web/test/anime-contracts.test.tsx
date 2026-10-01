// M2 animation contracts in the web app (ARCHITECTURE §20.6): the text-animation and shapes command modules,
// the Motion Templates "Text Animations" tab.
import { EngineClient } from '@jasper/engine-client';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { getCommand, registerAllCommands } from '../src/commands/index.ts';
import { shapeCommands } from '../src/commands/shapes.ts';
import { textAnimationCommands } from '../src/commands/text-animation.ts';
import { MotionTemplatesPanel } from '../src/panels/motionTemplates/MotionTemplatesPanel.tsx';
import { EngineProvider } from '../src/state/engine.tsx';

function offlineEngine() {
	const fetchImpl = (async () =>
		new Response(JSON.stringify({ code: 'NOT_IMPLEMENTED', message: 'later', retryable: false }), {
			status: 501,
			headers: { 'x-jasper-api': '1' },
		})) as unknown as typeof fetch;
	return new EngineClient({ fetch: fetchImpl });
}

afterEach(() => globalThis.localStorage?.removeItem('jasper.motionTemplates.tab'));

describe('command modules (ARCHITECTURE §20.6)', () => {
	it('registers the (empty) text-animation module and the shapes module (wp-m2-shapes, FIX-007)', () => {
		expect(textAnimationCommands).toEqual([]);
		registerAllCommands();
		for (const c of shapeCommands) expect(getCommand(c.id)).toBe(c);
		expect(getCommand('graphics.newRectangle')).toBeDefined();
	});
});

describe('Motion Templates ▸ Text Animations tab (S11:TXA-020)', () => {
	it('is the second tab and renders the text-animation gallery slot', async () => {
		render(
			<EngineProvider client={offlineEngine()} connectEvents={false}>
				<MotionTemplatesPanel instanceId="mgt-anim" visible />
			</EngineProvider>,
		);
		const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
		expect(tabs).toEqual(['Templates', 'Text Animations', 'Remotion']);
		fireEvent.mouseDown(screen.getByRole('tab', { name: 'Text Animations' }), { button: 0 });
		expect(await screen.findByTestId('text-animations-tab')).toBeTruthy();
		expect(screen.getByText('Text animation presets are not installed yet.')).toBeTruthy();
		expect(globalThis.localStorage?.getItem('jasper.motionTemplates.tab')).toBe('textAnimations');
	});
});
