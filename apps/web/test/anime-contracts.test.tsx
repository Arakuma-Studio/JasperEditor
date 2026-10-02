// The Motion Templates "Text Animations" tab (S11:TXA-020).
import { EngineClient } from '@jasper/engine-client';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('Motion Templates ▸ Text Animations tab (S11:TXA-020)', () => {
	it('is the second tab and renders the text-animation gallery slot', async () => {
		render(
			<EngineProvider client={offlineEngine()} connectEvents={false}>
				<MotionTemplatesPanel instanceId="mgt-anim" visible />
			</EngineProvider>,
		);
		fireEvent.mouseDown(screen.getByRole('tab', { name: 'Text Animations' }), { button: 0 });
		expect(await screen.findByRole('searchbox', { name: 'Search text animations' })).toBeTruthy();
	});
});
