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
import { PanelServices } from '../src/state/panel-services.ts';

const engine = new EngineClient({ fetch: (async () => new Response('{}')) as unknown as typeof fetch });

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
});

describe('panel services (S05:SH-005)', () => {
	it('publishes services per instance and handles "not mounted"', () => {
		const s = new PanelServices();
		expect(s.get('programPlayer')).toBeNull();
		const a = { seekTo: vi.fn(), play: vi.fn(), pause: vi.fn(), getContainer: () => null };
		const b = { ...a, play: vi.fn() };
		const offA = s.register('programPlayer', 'program-1', a);
		const offB = s.register('programPlayer', 'program-2', b);
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
