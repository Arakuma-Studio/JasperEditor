import { EngineClient } from '@jasper/engine-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
	createCommandContext,
	getCommand,
	isCommandChecked,
	isCommandEnabled,
	listCommands,
	registerCommands,
	resetCommandRegistry,
	runCommand,
} from '../src/commands/index.ts';
import { getPanelDefinition, PANEL_DEFINITIONS } from '../src/panels/registry.ts';
import { PANEL_KINDS } from '../src/panels/types.ts';
import { PanelServices } from '../src/state/panel-services.ts';

const engine = new EngineClient({ fetch: (async () => new Response('{}')) as unknown as typeof fetch });

describe('UI command registry (ARCHITECTURE §7.3)', () => {
	afterEach(() => resetCommandRegistry());

	it('registers, evaluates and runs commands with capability gating and args validation', async () => {
		const run = vi.fn();
		let checked = false;
		const off = registerCommands([
			{
				id: 'test.hello',
				label: 'Hello',
				scope: 'global',
				run,
				checked: () => checked,
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
		expect(getCommand('test.hello')?.label).toBe('Hello');
		expect(listCommands({ scope: 'timeline' }).map((c) => c.id)).toEqual(['test.boom']);
		expect(await runCommand('test.hello', ctx, { n: 1 })).toEqual({ ran: true });
		expect(run).toHaveBeenCalledWith(ctx, { n: 1 });
		expect((await runCommand('test.hello', ctx, { n: 'x' })).reason).toBe('invalid-args');
		expect(isCommandEnabled(getCommand('test.native')!, ctx)).toBe(false);
		expect((await runCommand('test.native', ctx)).reason).toBe('disabled');
		expect(
			isCommandEnabled(
				getCommand('test.native')!,
				createCommandContext({ engine, capabilities: ['nativeFfmpeg'] }),
			),
		).toBe(true);
		checked = true;
		expect(isCommandChecked(getCommand('test.hello')!, ctx)).toBe(true);
		expect((await runCommand('test.boom', ctx)).reason).toBe('error');
		expect(toast).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
		expect((await runCommand('nope', ctx)).reason).toBe('unknown');
		off();
		expect(getCommand('test.hello')).toBeUndefined();
	});
});

describe('panel registry (ARCHITECTURE §7.2)', () => {
	it('lists every PanelKind exactly once with a component', () => {
		expect(PANEL_DEFINITIONS.map((d) => d.kind).sort()).toEqual([...PANEL_KINDS].sort());
		for (const kind of PANEL_KINDS) {
			const d = getPanelDefinition(kind);
			// Plain components or code-split React.lazy components (panels/lazy.ts, WP-3I).
			expect(['function', 'object']).toContain(typeof d.component);
			expect(d.component).toBeTruthy();
			expect(d.agentDescription.length).toBeGreaterThan(10);
			expect(d.title({})).toBeTruthy();
		}
		expect(getPanelDefinition('program').keepAlive).toBe(true);
		expect(getPanelDefinition('timeline').keepAlive).toBe(true);
		expect(getPanelDefinition('tools').fixedAxis).toBe('width');
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
		s.get('programPlayer')?.play();
		expect(b.play).toHaveBeenCalled();
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
