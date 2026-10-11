import { EngineClient } from '@jasper/engine-client';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
	createCommandContext,
	getCommand,
	isCommandEnabled,
	registerCommands,
	runCommand,
} from '../src/commands/index.ts';
import { monitorViewCommands, registerFullscreenTarget } from '../src/commands/monitor-view.ts';
import { onBeforeCommand } from '../src/commands/registry.ts';
import { PanelServices } from '../src/state/panel-services.ts';

const engine = new EngineClient({ fetch: async () => new Response('{}') });

describe('UI command registry (ARCHITECTURE §7.3)', () => {
	it('registers, evaluates and runs commands with capability gating and args validation', async () => {
		const run = vi.fn();
		const off = registerCommands([
			{
				id: 'test.hello',
				label: 'Hello',
				scope: 'global',
				run,
				argsSchema: z.object({ n: z.number() }),
			},
			{ id: 'test.native', label: 'Native', scope: 'global', capability: 'nativeFfmpeg', run },
			{
				id: 'test.boom',
				label: 'Boom',
				scope: 'timeline',
				run: () => {
					throw new Error('bad');
				},
			},
		]);
		const toast = vi.fn();
		const ctx = createCommandContext({ engine, toast });
		expect(await runCommand('test.hello', ctx, { n: 1 })).toEqual({ ran: true });
		expect(run).toHaveBeenCalledWith(ctx, { n: 1 });
		run.mockClear();
		expect((await runCommand('test.hello', ctx, { n: 'x' })).reason).toBe('invalid-args');
		expect(run).not.toHaveBeenCalled();
		expect(isCommandEnabled(getCommand('test.native')!, ctx)).toBe(false);
		expect((await runCommand('test.native', ctx)).reason).toBe('disabled');
		expect(run).not.toHaveBeenCalled();
		expect(
			isCommandEnabled(
				getCommand('test.native')!,
				createCommandContext({ engine, capabilities: ['nativeFfmpeg'] }),
			),
		).toBe(true);
		expect((await runCommand('test.boom', ctx)).reason).toBe('error');
		expect(toast).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
		expect((await runCommand('nope', ctx)).reason).toBe('unknown');
		off();
	});
	it('reports a refused fullscreen request through the command error boundary', async () => {
		const error = new Error('Fullscreen denied by the browser');
		const element = document.createElement('div');
		Object.defineProperty(element, 'requestFullscreen', { value: vi.fn().mockRejectedValue(error) });
		const unregister = registerCommands(monitorViewCommands);
		const removeTarget = registerFullscreenTarget('program', () => element);
		const toast = vi.fn();
		try {
			await expect(
				runCommand('monitor.fullScreenVideo', createCommandContext({ engine, toast })),
			).resolves.toEqual({ ran: false, reason: 'error', error });
			expect(toast).toHaveBeenCalledWith({
				kind: 'error',
				message: 'Toggle Full Screen failed',
				detail: error.message,
			});
		} finally {
			removeTarget();
			unregister();
		}
	});

	it('reports a failing pre-command hook without running the command', async () => {
		const run = vi.fn();
		const toast = vi.fn();
		const error = new Error('Cannot commit the active gesture');
		const unregister = registerCommands([{ id: 'test.hook', label: 'Hook', scope: 'global', run }]);
		const removeHook = onBeforeCommand(() => {
			throw error;
		});
		try {
			await expect(runCommand('test.hook', createCommandContext({ engine, toast }))).resolves.toEqual({
				ran: false,
				reason: 'error',
				error,
			});
			expect(run).not.toHaveBeenCalled();
			expect(toast).toHaveBeenCalledWith({ kind: 'error', message: 'Hook failed', detail: error.message });
		} finally {
			removeHook();
			unregister();
		}
	});

	it('reports a throwing argument transform without running the command', async () => {
		const error = new Error('Invalid transformed input');
		const run = vi.fn();
		const toast = vi.fn();
		const unregister = registerCommands([
			{
				id: 'test.transform',
				label: 'Transform',
				scope: 'global',
				run,
				argsSchema: z.string().transform(() => {
					throw error;
				}),
			},
		]);
		try {
			await expect(
				runCommand('test.transform', createCommandContext({ engine, toast }), 'input'),
			).resolves.toEqual({ ran: false, reason: 'error', error });
			expect(run).not.toHaveBeenCalled();
			expect(toast).toHaveBeenCalledWith({
				kind: 'error',
				message: 'Transform failed',
				detail: error.message,
			});
		} finally {
			unregister();
		}
	});
});

describe('panel services (S05:SH-005)', () => {
	it('publishes services per instance and handles "not mounted"', () => {
		const s = new PanelServices();
		expect(s.get('programPlayer')).toBeNull();
		const a = { seekTo: vi.fn(), play: vi.fn(), pause: vi.fn(), getContainer: () => null };
		const b = { ...a, play: vi.fn() };
		const offA = s.register('programPlayer', 'program-1', a);
		const offB = s.register('programPlayer', 'program-2', b);
		expect(s.get('programPlayer')).toBe(b);
		expect(s.get('programPlayer', 'program-1')).toBe(a);
		offB();
		expect(s.get('programPlayer')).toBe(a);
		const offReplacement = s.register('programPlayer', 'program-1', b);
		offA();
		expect(s.get('programPlayer')).toBe(b);
		offReplacement();
		expect(s.get('programPlayer')).toBeNull();
	});
});
