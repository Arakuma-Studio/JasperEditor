// wp fonts: documentFontUsage (Resolve Fonts, missing-font marks, MCP list_fonts).
import { describe, expect, it } from 'vitest';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	documentFontUsage,
} from '../src/index.ts';

describe('documentFontUsage', () => {
	it('counts text clips (style and styled runs), captions clips and caption tracks per font id', () => {
		const ids = createCounterIdSource(1);
		let doc = createEmptyProject({ ids, name: 'Fonts', preset: 'hd-1080p-30' });
		const seqId = Object.keys(doc.sequences)[0]!;
		const r = applyTransaction(
			doc,
			{
				label: 't',
				origin: 'user',
				sequenceId: seqId,
				commands: [
					{ type: 'font.add', family: 'Pixel12x10', ref: '$p' },
					{ type: 'font.add', family: 'Minion Pro', ref: '$m' },
					{
						type: 'clip.addText',
						at: 0,
						duration: 30,
						track: 'V1',
						content: { text: 'a', style: { fontId: '$p' } },
					},
					{
						type: 'clip.addText',
						at: 30,
						duration: 30,
						track: 'V1',
						content: {
							text: 'ab',
							style: { fontId: '$p' },
							runs: [{ from: 0, to: 1, style: { fontId: '$m' } }],
						},
					},
				] as never,
			},
			{ ids, now: () => '2026-10-25T00:00:00.000Z', revision: 0, registries: defaultRegistries() },
		);
		expect(r.result.ok).toBe(true);
		doc = r.document;
		const p = r.result.ok ? r.result.refs.$p! : '';
		const m = r.result.ok ? r.result.refs.$m! : '';
		const usage = documentFontUsage(doc);
		expect(usage.get(p)).toEqual({ clips: 2, tracks: 0 });
		expect(usage.get(m)).toEqual({ clips: 1, tracks: 0 });
	});

	it('skips malformed values instead of throwing', () => {
		const doc = createEmptyProject({ ids: createCounterIdSource(2), name: 'X', preset: 'hd-1080p-30' });
		const seq = Object.values(doc.sequences)[0]!;
		(seq.clips as Record<string, unknown>).bad = {
			kind: 'text',
			content: { style: { fontId: 7 }, runs: 'nope' },
		};
		expect(documentFontUsage(doc).size).toBe(0);
	});
});
