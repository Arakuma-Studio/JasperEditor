// Mutated proposal requests (structure, values, truncations, arbitrary JSON) against a real project and proposal:
// a typed answer, never a 5xx, and every 200 parses with its response schema (spec 12 §2.5; AGENTS.md §0.2).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	ProposalAcceptResponseSchema,
	ProposalCreateResponseSchema,
	ProposalDecisionResponseSchema,
	ProposalResponseSchema,
} from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import { createCounterIdSource, createEmptyProject, makeEnvelope } from '@jasper/project';
import { describeFuzz, jsonTarget } from '@jasper/testkit/fuzz';
import { afterAll } from 'vitest';
import type { z } from 'zod';
import { closeApps, JSON_H, makeApp } from './helpers.ts';

afterAll(closeApps);

const app = await makeApp();
const doc = createEmptyProject({ ids: createCounterIdSource(5), name: 'Fuzz', preset: 'hd-1080p-30' });
const seqId = Object.keys(doc.sequences)[0]!;
const file = appdirPaths(app.appdir).projectFile(doc.projectId);
mkdirSync(join(file, '..'), { recursive: true });
writeFileSync(file, JSON.stringify(makeEnvelope(doc, { revision: 1, savedAt: '2026-10-01T00:00:00.000Z', platform: 'test' })));
const base = `/api/projects/${doc.projectId}/proposals`;

const draft = {
	feature: 'sound-design',
	title: 'Fuzz',
	sequenceId: seqId,
	items: [
		{ id: 'a', label: 'A', commands: [{ type: 'marker.add', frame: 3, name: 'm' }], group: 'hero', meta: { why: 1 } },
		{ id: 't', label: 'T', commands: [{ type: 'track.add', kind: 'audio', ref: '$t' }] },
		{
			id: 'u',
			label: 'U',
			requires: ['t'],
			commands: [{ type: 'track.update', trackId: '$t', patch: { mute: true } }],
			alternatives: [{ label: 'solo', commands: [{ type: 'track.update', trackId: '$t', patch: { solo: true } }] }],
		},
	],
};

async function call(method: 'GET' | 'POST', url: string, body?: unknown) {
	const r = await app.inject({
		method,
		url,
		headers: JSON_H,
		...(method === 'POST' ? { payload: JSON.stringify(body ?? null) } : {}),
	});
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(r.body);
	} catch {
		// not JSON
	}
	if (r.statusCode >= 500) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body.slice(0, 300)}`);
	return { status: r.statusCode, body: parsed };
}

const first = await call('POST', base, draft);
if (first.status !== 200) throw new Error(JSON.stringify(first.body));
const proposalId = ProposalCreateResponseSchema.parse(first.body).proposal.id;
const one = `${base}/${proposalId}`;

const checked = (schema: z.ZodType) => (r: { status: number; body: unknown }) => {
	if (r.status === 200) schema.parse(r.body);
};

describeFuzz(
	'proposal routes',
	[
		jsonTarget(
			'create',
			[draft, { ...draft, report: { x: [1, 2] } }, { ...draft, items: [draft.items[0]] }],
			async (body) => checked(ProposalCreateResponseSchema)(await call('POST', base, body)),
			undefined,
			{ iterations: 40, properties: 10, slowMs: 20_000 },
		),
		jsonTarget(
			'accept',
			[{ itemIds: ['a'] }, { itemIds: 'all', partial: true }, { itemIds: ['u'], expectedRevision: 1 }],
			async (body) => checked(ProposalAcceptResponseSchema)(await call('POST', `${one}/accept`, body)),
			undefined,
			{ iterations: 30, properties: 8, slowMs: 20_000 },
		),
		jsonTarget(
			'decisions',
			[
				{ path: 'reject', body: { itemIds: ['a'] } },
				{ path: 'note', body: { itemId: 'a', note: 'x' } },
				{ path: 'select', body: { itemId: 'u', alternative: 1 } },
				{ path: 'reopen', body: { itemIds: 'all' } },
			],
			async (input) => {
				const { path, body } = (input && typeof input === 'object' ? input : {}) as { path?: unknown; body?: unknown };
				const p = ['reject', 'note', 'select', 'reopen'].includes(String(path)) ? String(path) : 'reject';
				checked(ProposalDecisionResponseSchema)(await call('POST', `${one}/${p}`, body));
				checked(ProposalResponseSchema)(await call('GET', `${one}?revalidate=1`));
			},
			undefined,
			{ iterations: 30, properties: 8, slowMs: 20_000 },
		),
	],
	600_000,
);
