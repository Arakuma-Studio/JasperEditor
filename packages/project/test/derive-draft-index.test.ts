// Immer keeps the clips-record proxy across commands in a transaction; its identity cannot key a clip-index cache.
import { describe, expect, it } from 'vitest';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
} from '../src/index.ts';

describe('the clip index inside one transaction', () => {
	it('sees clips added after an earlier command read it', () => {
		const ids = createCounterIdSource(1);
		const base = createEmptyProject({ ids, name: 'T', preset: 'hd-720p-30' });
		const seq = Object.values(base.sequences)[0]!;
		const commands = [1, 2].flatMap((n) => [
			{ type: 'clip.addSolid', at: 0, duration: 30, track: `V${n}`, color: [1, 0, 0, 1] },
			{ type: 'clip.addSolid', at: 30, duration: 30, track: `V${n}`, color: [0, 0, 1, 1] },
			{ type: 'transition.add', trackId: `V${n}`, at: 30, effectId: 'jasper.cross-dissolve', duration: 10 },
		]);
		const { document, result } = applyTransaction(
			base,
			{ label: 't', origin: 'user', sequenceId: seq.id, commands: commands as never },
			{ ids, now: () => 't', revision: 0, registries: defaultRegistries() },
		);
		expect(result.ok ? 'ok' : result.errors).toBe('ok');
		expect(Object.keys(Object.values(document.sequences)[0]!.transitions)).toHaveLength(2);
	});
});
