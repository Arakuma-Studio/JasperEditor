// AGENTS §0: a dialog that fails to render shows the failure inside a dialog that closes, instead of unmounting the
// window with it. DialogHost renders above every other boundary of the app (GlobalHosts).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeAllDialogs, Dialog, DialogHost, type HostedDialogProps, openDialog, registerDialog } from '../src/index.ts';

afterEach(() => {
	act(() => closeAllDialogs());
	cleanup();
	vi.restoreAllMocks();
});

function Boom(): never {
	throw new Error('the plan has no layers');
}

function Fine(props: HostedDialogProps) {
	return (
		<Dialog open onOpenChange={(o) => !o && props.close()} title="Fine">
			<p data-testid="fine-body">ok</p>
		</Dialog>
	);
}

describe('DialogHost error boundary (AGENTS §0)', () => {
	it('shows a dialog that throws as a visible error, keeps the rest of the window, and closes', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const off = registerDialog('test.boom', () => (
			<Dialog open onOpenChange={() => {}} title="Boom">
				<Boom />
			</Dialog>
		));
		render(
			<>
				<p data-testid="editor">editor</p>
				<DialogHost />
			</>,
		);
		let result: Promise<unknown> | null = null;
		act(() => {
			result = openDialog('test.boom', {});
		});
		const crashed = await screen.findByTestId('dialog-crashed');
		expect(crashed.textContent).toContain('the plan has no layers');
		expect(screen.getByTestId('editor')).toBeTruthy();
		fireEvent.click(crashed.querySelector('[data-dialog-primary]')!);
		await expect(result).resolves.toBeUndefined();
		expect(screen.queryByTestId('dialog-crashed')).toBeNull();
		off();
	});

	it('a dialog opened after a failed one renders normally', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const offBoom = registerDialog('test.boom', () => <Boom />);
		const offFine = registerDialog('test.fine', Fine);
		render(<DialogHost />);
		act(() => {
			void openDialog('test.boom', {});
		});
		await screen.findByTestId('dialog-crashed');
		act(() => {
			void openDialog('test.fine', {});
		});
		expect((await screen.findByTestId('fine-body')).textContent).toBe('ok');
		expect(screen.queryByTestId('dialog-crashed')).toBeNull();
		offBoom();
		offFine();
	});
});
