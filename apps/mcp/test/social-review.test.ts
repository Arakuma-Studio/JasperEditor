// Store reviews through the agent API (design §11, §7.10): the real social-comment@1 catalogue entry (as the engine
// serves it), its store presets in list_motion_templates, add_motion_graphic with a store preset ref filling rating,
// date, title and the reviewer from the seed, given values kept, a bad date refused, and import_motion_graphics_csv
// with store-review columns.
import type { MgTemplatesResponse } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { mgRegistry, parseReviewDate } from '@jasper/mg-templates';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';
import { TEMPLATES_GUIDE } from '../src/tools/templates.ts';

const registries = defaultRegistries(mgRegistry);
const SOCIAL = mgRegistry.catalogJson().find((t) => t.id === 'social-comment')!;

function fakeEngine() {
	const ids = createCounterIdSource(3);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Reviews', preset: 'hd-1080p-30' });
	let revision = 1;
	const client: Record<string, unknown> = {
		mgTemplates: async (): Promise<MgTemplatesResponse> => ({
			templates: [SOCIAL],
			renderer: { status: 'unavailable', reason: 'not built' },
		}),
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		agentTx: async (req: { transaction: { dryRun?: boolean; commands: unknown[] } }) => {
			const r = applyTransaction(doc, { ...req.transaction, origin: 'user' } as never, {
				ids,
				now: () => '2026-10-25T00:00:00.000Z',
				revision,
				registries,
			});
			if (r.result.ok && !req.transaction.dryRun) {
				doc = r.document;
				revision++;
			}
			return { result: r.result, appliedBy: 'headless' };
		},
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, doc: () => doc };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect(engine: ReturnType<typeof fakeEngine>) {
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'review-test' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	const client = new Client({ name: 'review-test', version: '1' });
	await client.connect(b);
	open.push(client);
	return async (name: string, args: Record<string, unknown>) =>
		(await client.callTool({
			name,
			arguments: name === 'list_motion_templates' ? args : { projectId: engine.doc().projectId, ...args },
		})) as CallToolResult;
}
const textOf = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';

describe('store reviews through the MCP tools (real social-comment@1)', () => {
	it('lists the three store presets with the review params described', async () => {
		const call = await connect(fakeEngine());
		const r = await call('list_motion_templates', {});
		expect(r.isError, textOf(r)).toBeFalsy();
		const text = textOf(r);
		for (const ref of [
			'social-comment:play-store-review',
			'social-comment:app-store-review',
			'social-comment:app-store-review-ios',
		])
			expect(text).toContain(ref);
		for (const p of ['rating', 'date', 'title', 'edited', 'truncate']) expect(text).toContain(p);
		expect(TEMPLATES_GUIDE).toContain('social-comment:app-store-review');
	});

	it('add_motion_graphic with a store preset fills the review from the seed and keeps given values', async () => {
		const engine = fakeEngine();
		const call = await connect(engine);
		const r = await call('add_motion_graphic', {
			seed: 9,
			items: [
				{ template: 'social-comment:play-store-review', at: '0s' },
				{
					template: 'social-comment:app-store-review',
					at: '5s',
					params: { rating: 5, title: 'Great so far', date: '2026-09-24', text: 'I like it 😍' },
				},
				{ template: 'social-comment:app-store-review-ios', at: '10s', params: { edited: true } },
			],
		});
		expect(r.isError, textOf(r)).toBeFalsy();
		const body = JSON.parse(textOf(r)) as {
			items: { params: Record<string, unknown>; filled: string[]; preset?: string }[];
		};
		const [play, web, ios] = body.items;
		expect(play!.preset).toBe('play-store-review');
		expect(play!.params.variant).toBe('play-store-review');
		expect(play!.filled).toEqual(expect.arrayContaining(['rating', 'date']));
		expect([1, 2, 3, 4, 5]).toContain(play!.params.rating);
		expect(parseReviewDate(play!.params.date)).not.toBeNull();
		expect(web!.params).toMatchObject({
			variant: 'app-store-review',
			rating: 5,
			title: 'Great so far',
			date: '2026-09-24',
			text: 'I like it 😍',
		});
		expect(ios!.params).toMatchObject({ variant: 'app-store-review-ios', edited: true, truncate: false });
		expect(typeof ios!.params.title).toBe('string');
		// the same call and seed give the same reviews
		const again = await call('add_motion_graphic', {
			seed: 9,
			dryRun: true,
			items: [{ template: 'social-comment:play-store-review', at: '20s' }],
		});
		const p2 = (JSON.parse(textOf(again)) as { items: { params: Record<string, unknown> }[] }).items[0]!
			.params;
		expect({ rating: p2.rating, date: p2.date, displayName: p2.displayName }).toEqual({
			rating: play!.params.rating,
			date: play!.params.date,
			displayName: play!.params.displayName,
		});
	});

	it('refuses an impossible date or rating as an error result, nothing added', async () => {
		const engine = fakeEngine();
		const call = await connect(engine);
		for (const params of [{ date: '2025-02-30' }, { rating: 6 }, { date: '09/24/2025' }]) {
			const r = await call('add_motion_graphic', {
				template: 'social-comment:app-store-review',
				at: 0,
				params,
			});
			expect(r.isError, JSON.stringify(params)).toBe(true);
		}
		expect(Object.keys(Object.values(engine.doc().sequences)[0]!.clips)).toHaveLength(0);
	});

	it('import_motion_graphics_csv reads Stars / Review title / Date / Edited columns', async () => {
		const engine = fakeEngine();
		const call = await connect(engine);
		const r = await call('import_motion_graphics_csv', {
			template: 'social-comment:app-store-review-ios',
			csv: 'User,Stars,Review title,Date,Edited,Review\nLuna Park,5,Love it,2026-10-20,no,Works great\nJake,1,Crashes,2026/1/4,yes,Every time I open it',
			seed: 3,
		});
		expect(r.isError, textOf(r)).toBeFalsy();
		const clips = Object.values(Object.values(engine.doc().sequences)[0]!.clips) as unknown as {
			params: Record<string, unknown>;
		}[];
		expect(clips.map((c) => [c.params.displayName, c.params.rating, c.params.title, c.params.date])).toEqual([
			['Luna Park', 5, 'Love it', '2026-10-20'],
			['Jake', 1, 'Crashes', '2026-01-04'],
		]);
		expect(clips[1]!.params.edited).toBe(true);
	});
});
