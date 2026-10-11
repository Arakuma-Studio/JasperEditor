import {
	COMMAND_CATALOG,
	type CommandInput,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
} from '@jasper/project';
import { describe, expect, it, vi } from 'vitest';
import { EditorSession } from '../src/index.ts';

describe('transaction command inputs', () => {
	it.each(['apply', 'submit', 'gesture'] as const)(
		'%s normalizes omitted command defaults before handling',
		async (entry) => {
			const ids = createCounterIdSource(1);
			const document = createEmptyProject({ ids, name: 'Defaults', preset: 'hd-1080p-30' });
			const session = new EditorSession({
				projectId: document.projectId,
				document,
				ctx: { ids, now: () => '2026-10-11T00:00:00.000Z', registries: defaultRegistries() },
			});
			const commands: CommandInput[] = [
				{
					type: 'sequence.autoReframe',
					sequenceId: Object.keys(document.sequences)[0]!,
					width: 1080,
					height: 1920,
					subjects: [],
				},
			];
			const handler = vi.spyOn(COMMAND_CATALOG['sequence.autoReframe'], 'handler');
			try {
				const transaction = { label: 'Reframe', origin: 'user' as const, commands };
				if (entry === 'gesture') {
					const gesture = session.beginGesture('Reframe');
					expect(gesture.update(commands).ok).toBe(true);
					expect(gesture.commit()?.ok).toBe(true);
				} else if (entry === 'submit') {
					const gesture = session.beginGesture('Queue');
					const pending = session.submit(transaction);
					expect(session.getCommitted()).toBe(document);
					gesture.cancel();
					expect((await pending).ok).toBe(true);
				} else {
					expect(session.apply(transaction).ok).toBe(true);
				}
				expect(handler).toHaveBeenCalled();
				for (const call of handler.mock.calls) expect(call[1]).toMatchObject({ tracking: 'default' });
				expect(commands[0]).not.toHaveProperty('tracking');
				expect(Object.values(session.getCommitted().sequences)).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ settings: expect.objectContaining({ width: 1080, height: 1920 }) }),
					]),
				);
			} finally {
				handler.mockRestore();
				await session.close();
			}
		},
	);
});
