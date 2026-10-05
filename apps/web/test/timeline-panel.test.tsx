import { SessionProvider } from '@jasper/session/react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerAllCommands } from '../src/commands/index.ts';
import { ToolsPanel } from '../src/panels/tools/ToolsPanel.tsx';
import { makeSession } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());
afterEach(() => cleanup());

describe('Tools panel (S05:TOOL-001…005)', () => {
	it('clicking a button selects the tool; right-click opens the group flyout', async () => {
		const { session } = makeSession();
		render(
			<SessionProvider session={session}>
				<ToolsPanel instanceId="tools-2" visible />
			</SessionProvider>,
		);
		const razor = document.querySelector('[data-tool="razor"]') as HTMLElement;
		fireEvent.click(razor);
		expect(session.getState().toggles.activeTool).toBe('razor');
		const ripple = document.querySelector('[data-tool="ripple"]') as HTMLElement;
		fireEvent.contextMenu(ripple);
		expect(screen.getByTestId('tools-flyout')).toBeTruthy();
		fireEvent.click(document.querySelector('[data-tool-option="rolling"]') as HTMLElement);
		expect(session.getState().toggles.activeTool).toBe('rolling');
		expect(document.querySelector('[data-tool="rolling"]')).toBeTruthy();
	});
});
