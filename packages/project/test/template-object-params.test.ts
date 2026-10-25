// Template params whose value is an object or a union of shapes (the social-comment avatar `{mediaId} | {generated} |
// null`, design §7.3): their property spec is a JSON value checked whole by the template schema. Before, such a param
// mapped to a `string` spec and `param.set` refused every object, so no UI or agent could change it (regression).
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	type Clip,
	createStaticMgRegistry,
	defaultRegistries,
	type MgTemplateInfo,
	paramsPropertySpecs,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const avatar = z.union([
	z.strictObject({ mediaId: z.string().min(1) }),
	z.strictObject({ generated: z.number().int().min(0) }),
	z.null(),
]);
const schema = z.strictObject({
	name: z.string().default('Ada'),
	avatar: avatar.default(null),
	box: z.strictObject({ w: z.number(), h: z.number() }).default({ w: 1, h: 1 }),
});
const card: MgTemplateInfo = {
	id: 'object-card',
	version: 1,
	name: 'Object card',
	category: 'Test',
	paramsSchema: schema,
	defaults: schema.parse({}) as Record<string, unknown>,
	introFrames: 10,
	outroFrames: 10,
	canvasDefault: 'sequence',
	renderer: 'anime',
};

function setup() {
	const h = new Harness({ ctx: { registries: defaultRegistries(createStaticMgRegistry([card])) } });
	const r = h.ok([
		{
			type: 'clip.addMotionGraphic',
			at: 0,
			duration: 90,
			track: 'V1',
			template: { id: 'object-card', version: 1 },
			ref: '$c',
		},
	]);
	const id = r.refs.$c!;
	return { h, id, params: () => (h.seq.clips[id] as Extract<Clip, { kind: 'motion-graphic' }>).params };
}

describe('object and union template params', () => {
	it('map to JSON property specs', () => {
		const specs = paramsPropertySpecs(card);
		expect(specs.find((s) => s.key === 'params.avatar')?.kind).toBe('json');
		expect(specs.find((s) => s.key === 'params.box')?.kind).toBe('json');
		expect(specs.find((s) => s.key === 'params.name')?.kind).toBe('string');
	});

	it('can be set to every member of the union and refuse values the schema rejects', () => {
		const { h, id, params } = setup();
		const set = (value: unknown) =>
			h.tx([{ type: 'param.set', target: ['clip', id, 'params', 'avatar'], value }]);
		expect(set({ generated: 7 }).ok).toBe(true);
		expect(params().avatar).toEqual({ generated: 7 });
		expect(set(null).ok).toBe(true);
		expect(params().avatar).toBeNull();
		for (const bad of [{ generated: -1 }, { generated: 1, extra: true }, 'text', 3, { mediaId: '' }]) {
			const r = set(bad);
			expect(r.ok, JSON.stringify(bad)).toBe(false);
			if (!r.ok) expect(r.errors[0]!.code).toBe('E_INVALID_PARAM');
		}
		expect(params().avatar).toBeNull();
		expect(
			h.tx([{ type: 'param.set', target: ['clip', id, 'params', 'box'], value: { w: 2, h: 3 } }]).ok,
		).toBe(true);
		expect(params().box).toEqual({ w: 2, h: 3 });
	});
});
