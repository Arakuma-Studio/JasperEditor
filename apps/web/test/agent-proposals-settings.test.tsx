// Spec 18 AF-PROP-004: Project Settings ▸ Agent Proposals lists the rough-cut feature from the feature table, off by
// default (the other workflow features on); turning it on is the user's undoable project setting.
import { agentProposalsAllowed } from '@jasper/project';
import { closeAllDialogs, DialogHost, openDialog } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
	PROJECT_SETTINGS_DIALOG,
	registerProjectSettingsDialog,
} from '../src/gaps/ProjectSettingsDialog.tsx';
import { makeSession } from './timeline-helpers.ts';

afterEach(() => {
	closeAllDialogs();
	cleanup();
});

// the engine's scratch info and capabilities never arrive (not what this test is about)
const engine = {
	call: () => new Promise(() => {}),
	capabilities: () => new Promise(() => {}),
};

describe('Project Settings ▸ Agent Proposals', () => {
	it('lists rough cuts, off by default; turning them on is one undoable setting', async () => {
		registerProjectSettingsDialog();
		const { session } = makeSession();
		render(<DialogHost />);
		let done: Promise<unknown> = Promise.resolve();
		act(() => {
			done = openDialog(PROJECT_SETTINGS_DIALOG, { session, engine });
		});
		const rough = (await screen.findByLabelText('Allow agents to apply rough cut proposals')) as HTMLElement;
		const auto = screen.getByLabelText('Allow agents to apply editing automation proposals') as HTMLElement;
		const checked = (el: HTMLElement) =>
			el.getAttribute('aria-checked') === 'true' || (el as HTMLInputElement).checked === true;
		expect(checked(rough)).toBe(false);
		expect(checked(auto)).toBe(true);
		expect(screen.getByTestId('project-settings-dialog').textContent).toContain(
			'Rough cuts (an agent’s own cut of your footage) are off by default',
		);
		act(() => {
			fireEvent.click(rough);
		});
		expect(checked(rough)).toBe(true);
		act(() => {
			fireEvent.click(screen.getByRole('button', { name: 'OK' }));
		});
		await act(async () => {
			await done;
		});
		expect(agentProposalsAllowed(session.getCommitted(), 'rough-cut')).toBe(true);
		act(() => void session.undo());
		expect(agentProposalsAllowed(session.getCommitted(), 'rough-cut')).toBe(false);
	});
});
