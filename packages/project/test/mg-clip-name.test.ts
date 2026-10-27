// Content names of motion-graphic clips (`MgTemplateInfo.clipName`, `mgClipName`; docs/wp-notes/social-comments.md
// "Clip names", App QA N5): a new clip is named from its params ("X post · Luna Park") instead of the template name
// ("Social comment" on every card), by clip.addMotionGraphic and Add another; a param change renames a clip that
// still has its automatic name, never one the user renamed.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	type Clip,
	checkInvariants,
	createStaticMgRegistry,
	defaultRegistries,
	type MgTemplateInfo,
	mgClipName,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const schema = z.strictObject({
	kind: z.enum(['a', 'b']),
	who: z.string().max(200),
	likes: z.number().int(),
});
const card: MgTemplateInfo = {
	id: 'card',
	version: 1,
	name: 'Card',
	category: 'Social',
	renderer: 'anime',
	paramsSchema: schema,
	defaults: { kind: 'a', who: 'ana', likes: 0 },
	introFrames: 5,
	outroFrames: 5,
	canvasDefault: 'sequence',
	defaultDurationSeconds: 2,
	ui: { addAnother: { reroll: ['who', 'likes'] } },
	fill(partial, seed) {
		return {
			ok: true,
			params: { ...partial, who: partial.who ?? `who${seed}`, likes: partial.likes ?? seed },
			filled: ['who', 'likes'].filter((k) => partial[k] === undefined),
		};
	},
	clipName: (p) => {
		if (p.who === 'boom') throw new Error('boom');
		return `Kind ${String(p.kind).toUpperCase()} · ${p.who}`;
	},
};
const plain: MgTemplateInfo = { ...card, id: 'plain', clipName: undefined };
const registries = defaultRegistries(createStaticMgRegistry([card, plain]));
type MgClip = Extract<Clip, { kind: 'motion-graphic' }>;

function add(h: Harness, extra: Record<string, unknown> = {}, id = 'card'): MgClip {
	const r = h.ok([
		{
			type: 'clip.addMotionGraphic',
			at: 0,
			duration: 60,
			track: 'V1',
			template: { id, version: 1 },
			params: { kind: 'b', who: 'luna' },
			ref: '$c',
			...extra,
		},
	]);
	return h.seq.clips[r.refs.$c!] as MgClip;
}

describe('mgClipName', () => {
	it('names from the hook, cleaned and capped; falls back to the template name', () => {
		expect(mgClipName(card, { kind: 'a', who: 'luna' })).toBe('Kind A · luna');
		expect(mgClipName(card, { kind: 'a', who: '  two\n lines\u0000 ' })).toBe('Kind A · two lines');
		expect(mgClipName(card, { kind: 'a', who: 'x'.repeat(300) }).length).toBeLessThanOrEqual(80);
		expect(mgClipName(card, { kind: 'a', who: 'boom' })).toBe('Card'); // a throwing hook
		expect(mgClipName({ ...card, clipName: () => '   ' }, {})).toBe('Card');
		expect(mgClipName({ ...card, clipName: () => 42 as never }, {})).toBe('Card');
		expect(mgClipName(plain, { kind: 'a', who: 'luna' })).toBe('Card');
	});
});

describe('clip names of motion graphics', () => {
	it('clip.addMotionGraphic names the clip from its params (given or filled); an explicit name wins', () => {
		const h = new Harness({ ctx: { registries } });
		expect(add(h).name).toBe('Kind B · luna');
		expect(add(h, { params: { kind: 'a' }, fill: { seed: 7 }, track: 'V2' }).name).toBe('Kind A · who7');
		expect(add(h, { name: 'Mine', track: 'V3' }).name).toBe('Mine');
		expect(add(h, { track: 'V4' }, 'plain').name).toBe('Card');
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('Add another names the copy after its new identity, keeps a name the user gave', () => {
		const h = new Harness({ ctx: { registries } });
		const src = add(h);
		const r = h.ok([{ type: 'clip.duplicateMotionGraphic', clipId: src.id, seed: 3 }]);
		const copy = h.seq.clips[(r.results[0] as { clipId: string }).clipId]!;
		expect(copy.name).toBe('Kind B · who3');
		h.ok([{ type: 'clip.update', clipId: src.id, patch: { name: 'Hero comment' } }]);
		const r2 = h.ok([{ type: 'clip.duplicateMotionGraphic', clipId: src.id, seed: 4 }]);
		expect(h.seq.clips[(r2.results[0] as { clipId: string }).clipId]!.name).toBe('Hero comment');
	});

	it('a param change renames a clip that has its automatic name (also the legacy template name), not a renamed one', () => {
		const h = new Harness({ ctx: { registries } });
		const c = add(h);
		h.ok([{ type: 'clip.update', clipId: c.id, patch: { params: { who: 'mo' } } }]);
		expect(h.seq.clips[c.id]!.name).toBe('Kind B · mo');
		// a clip saved before content names ("Card") follows too
		h.ok([{ type: 'clip.update', clipId: c.id, patch: { name: 'Card' } }]);
		h.ok([{ type: 'clip.update', clipId: c.id, patch: { params: { kind: 'a' } } }]);
		expect(h.seq.clips[c.id]!.name).toBe('Kind A · mo');
		// renamed: kept
		h.ok([{ type: 'clip.update', clipId: c.id, patch: { name: 'Pinned' } }]);
		h.ok([{ type: 'clip.update', clipId: c.id, patch: { params: { who: 'zed' } } }]);
		expect(h.seq.clips[c.id]!.name).toBe('Pinned');
		// a name and params in one patch: the name wins
		const d = add(h, { track: 'V2' });
		h.ok([{ type: 'clip.update', clipId: d.id, patch: { name: 'Both', params: { who: 'q' } } }]);
		expect(h.seq.clips[d.id]!.name).toBe('Both');
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});
