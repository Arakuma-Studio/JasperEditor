// The advertised schema is smaller than what the server accepts, never stricter and never a looser validator.
import type { EngineClient } from '@jasper/engine-client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { compactInputSchema, compactNode } from '../src/advertise.ts';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

const client: { current: Client | null } = { current: null };
afterEach(async () => {
	await client.current?.close();
	client.current = null;
});

async function connect() {
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => ({}) as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	const { server } = createJasperMcpServer({ link, agentName: 'test', toolsets: 'all' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	const c = new Client({ name: 'advertise', version: '1' });
	await Promise.all([server.connect(a), c.connect(b)]);
	client.current = c;
	return c;
}

const errorOf = (r: unknown) =>
	(JSON.parse(((r as CallToolResult).content[0] as { text: string }).text) as { error: { code: string } })
		.error;

describe('compactNode', () => {
	it('drops what a call does not need', () => {
		expect(
			compactInputSchema({
				$schema: 'https://json-schema.org/draft/2020-12/schema',
				type: 'object',
				additionalProperties: false,
				properties: {
					id: { type: 'string', minLength: 1, maxLength: 64, pattern: '^x' },
					n: { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
					capped: { type: 'integer', minimum: 1, maximum: 900 },
				},
			}),
		).toEqual({
			type: 'object',
			properties: {
				id: { type: 'string' },
				n: { type: 'integer' },
				capped: { type: 'integer', minimum: 1, maximum: 900 },
			},
		});
	});
	it('keeps a property that is named like a dropped keyword', () => {
		expect(compactNode({ properties: { pattern: { type: 'string' } } })).toEqual({
			properties: { pattern: { type: 'string' } },
		});
	});
	it('drops the null branch of an optional field', () => {
		expect(compactNode({ anyOf: [{ type: 'string' }, { type: 'null' }], description: 'd' })).toEqual({
			type: 'string',
			description: 'd',
		});
	});
	it('reads a time union as integer or string', () => {
		const time = {
			anyOf: [
				{
					anyOf: [
						{ type: 'integer' },
						{ type: 'object', properties: { frames: { type: 'integer' } } },
						{ type: 'object', properties: { seconds: { type: 'number' } } },
						{ type: 'string', pattern: 'tc' },
					],
				},
				{ type: 'string', pattern: 'friendly' },
			],
			description: 'When',
		};
		expect(compactNode(time)).toEqual({ type: ['integer', 'string'], description: 'When' });
	});
	it('advertises the plain form of an animatable value', () => {
		expect(
			compactNode({
				anyOf: [
					{ type: 'number' },
					{ type: 'object', properties: { value: { type: 'number' }, keyframes: { type: 'array' } } },
				],
			}),
		).toEqual({ type: 'number' });
	});
	it('turns a tagged union into its tag', () => {
		expect(
			compactNode({
				anyOf: [
					{ type: 'object', properties: { kind: { const: 'a' }, x: { type: 'number' } } },
					{ type: 'object', properties: { kind: { type: 'string', enum: ['b'] }, y: { type: 'number' } } },
				],
				description: 'One item',
			}),
		).toEqual({
			type: 'object',
			properties: { kind: { enum: ['a', 'b'] } },
			required: ['kind'],
			description: 'One item',
		});
	});
	it('leaves a union of different shapes alone, without duplicates', () => {
		expect(compactNode({ anyOf: [{ type: 'string' }, { type: 'string' }, { type: 'number' }] })).toEqual({
			anyOf: [{ type: 'string' }, { type: 'number' }],
		});
	});
	it('reads a tuple of one type as an array of it', () => {
		expect(
			compactNode({ type: 'array', items: [{ type: 'number' }, { type: 'number' }], additionalItems: false }),
		).toEqual({ type: 'array', items: { type: 'number' } });
	});
	it('drops an enum long enough to be a catalogue', () => {
		const values = Array.from({ length: 41 }, (_, i) => `v${i}`);
		expect(compactNode({ type: 'string', enum: values })).toEqual({ type: 'string' });
		expect(compactNode({ type: 'string', enum: values.slice(0, 40) })).toEqual({
			type: 'string',
			enum: values.slice(0, 40),
		});
	});
});

describe('compactInputSchema', () => {
	const field = (i: number) => ({ type: 'number', description: `Field ${i} ${'x'.repeat(40)}` });
	const big = {
		type: 'object',
		properties: {
			top: {
				type: 'object',
				description: 'Keeps this',
				properties: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`f${i}`, field(i)])),
			},
		},
	};

	it('leaves a schema under the cap alone', () => {
		const small = { type: 'object', properties: { a: { type: 'object', properties: { b: field(1) } } } };
		expect(compactInputSchema(small)).toEqual(small);
	});
	it('still over the cap, reads deep objects as plain objects', () => {
		const deep = {
			type: 'object',
			properties: {
				top: {
					type: 'object',
					properties: Object.fromEntries(
						Array.from({ length: 200 }, (_, i) => [
							`section${i}`,
							{
								type: 'object',
								properties: {
									inner: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
								},
							},
						]),
					),
				},
			},
		};
		const out = compactInputSchema(deep) as unknown as {
			properties: { top: { properties: Record<string, { properties: { inner: unknown } }> } };
		};
		expect(out.properties.top.properties.section7?.properties.inner).toEqual({ type: 'object' });
	});
	it('over the cap, keeps top-level descriptions and nested names and types', () => {
		const out = compactInputSchema(big) as typeof big;
		expect(out.properties.top.description).toBe('Keeps this');
		expect(out.properties.top.properties.f7).toEqual({ type: 'number' });
	});
});

describe('tools/list against validation', () => {
	const firstShapeItem = { type: 'rect', size: { value: [10, 10], keyframes: [] } };

	it('advertises shape items by their tag and keeps every property name', async () => {
		const c = await connect();
		const { tools } = await c.listTools();
		const add = tools.find((t) => t.name === 'add_shape_items')!;
		expect(JSON.stringify(add.inputSchema).length).toBeLessThan(10_000);
		for (const t of tools)
			expect(JSON.stringify(t.inputSchema), t.name).not.toContain('additionalProperties');
		const commands = tools.find((t) => t.name === 'apply_commands')!;
		expect(JSON.stringify(commands.inputSchema)).not.toContain('clip.place');
	});

	it('describe_tool with full returns the whole schema', async () => {
		const c = await connect();
		const r = (await c.callTool({
			name: 'describe_tool',
			arguments: { name: 'add_shape_items', full: true },
		})) as CallToolResult;
		const def = JSON.parse((r.content[0] as { text: string }).text) as { inputSchema: unknown };
		expect(JSON.stringify(def.inputSchema).length).toBeGreaterThan(50_000);
		expect(JSON.stringify(def.inputSchema)).toContain('additionalProperties');
	});

	it('still refuses unknown keys at any depth, and accepts what the advertised schema leaves out', async () => {
		const c = await connect();
		const topLevel = await c.callTool({ name: 'list_projects', arguments: { nope: 1 } });
		expect(errorOf(topLevel).code).toBe('E_UNKNOWN_ARGUMENT');
		const deep = await c.callTool({
			name: 'add_shape_items',
			arguments: { projectId: 'p', clipId: 'c', items: [{ ...firstShapeItem, nope: 1 }] },
		});
		expect(errorOf(deep).code).toBe('E_UNKNOWN_ARGUMENT');
		const keyframed = await c.callTool({
			name: 'add_shape_items',
			arguments: { projectId: 'p', clipId: 'c', items: [firstShapeItem] },
		});
		expect(['E_UNKNOWN_ARGUMENT', 'E_INVALID_ARGUMENT']).not.toContain(errorOf(keyframed).code);
	});
});
