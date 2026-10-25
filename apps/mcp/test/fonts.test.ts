// wp fonts: list_fonts / install_font / remove_font and add_text {font} against a fake engine.
import type { FontCatalog, FontLibraryResponse, LibraryFont } from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
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

const PIXEL: LibraryFont = {
	id: 'f0123456789abcdef01234567',
	format: 'ttf',
	family: 'Pixel 12x10',
	subfamily: 'Regular',
	fullName: 'Pixel 12x10 Regular',
	postscriptName: 'Pixel12x10',
	weight: 400,
	italic: false,
	sizeBytes: 27_000,
	sha256: 'a'.repeat(64),
	originalName: 'Pixel12x10.ttf',
	addedAt: '2026-10-25T00:00:00.000Z',
};

function fakeEngine() {
	const ids = createCounterIdSource(3);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Fonts', preset: 'hd-1080p-30' });
	let revision = 0;
	const apply = (tx: Record<string, unknown>) => {
		const r = applyTransaction(doc, { protocol: 'jasper.tx/1', ...tx, origin: 'user' } as never, {
			ids,
			now: () => '2026-10-25T00:00:00.000Z',
			revision,
			registries: defaultRegistries(),
		});
		if (r.result.ok) {
			doc = r.document;
			revision++;
		}
		return r.result;
	};
	apply({
		label: 'setup',
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
				content: { text: 'b', style: { fontId: '$m' } },
			},
		],
	});
	const library: FontLibraryResponse = {
		revision: 1,
		readOnly: false,
		fonts: [PIXEL],
		totalBytes: PIXEL.sizeBytes,
		limits: { maxFileBytes: 64 << 20, maxFonts: 1000, maxTotalBytes: 2 ** 31 },
		repairs: [],
	};
	const catalog = (): FontCatalog => ({
		fonts: [
			{
				family: 'Inter',
				source: 'bundled',
				weights: [400],
				styles: ['normal'],
				files: [{ weight: 400, style: 'normal', subset: 'latin', url: '/fonts/inter/a.woff2' }],
			},
			...library.fonts.map((f) => ({
				family: f.family,
				source: 'custom' as const,
				weights: [f.weight],
				styles: ['normal' as const],
				files: [
					{
						weight: f.weight,
						style: 'normal' as const,
						url: `/fonts/library/${f.id}.ttf`,
						postscriptName: f.postscriptName,
						fontId: f.id,
					},
				],
			})),
		],
	});
	const calls: string[] = [];
	const client = {
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		agentTx: async (req: { transaction: Record<string, unknown> }) => ({
			result: apply(req.transaction),
			appliedBy: 'headless',
		}),
		listFonts: async () => catalog(),
		fontLibrary: async () => structuredClone(library),
		installFontPath: async (path: string) => {
			calls.push(`install ${path}`);
			if (path.endsWith('clash.otf'))
				throw new EngineError('FONT_EXISTS', 'A different "Pixel 12x10 Regular" is installed', {
					status: 409,
				});
			const face = {
				...PIXEL,
				id: 'f00000000000000000000000b',
				family: 'Minion Pro',
				postscriptName: 'MinionPro-Regular',
				fullName: 'Minion Pro Regular',
			};
			library.fonts.push(face);
			return { revision: 2, installed: [face], existing: [] };
		},
		removeFont: async (id: string) => {
			calls.push(`remove ${id}`);
			throw new EngineError('APPROVAL_DENIED', 'Remove font needs the user', {
				status: 403,
				detail: { code: 'E_APPROVAL_DENIED' },
			});
		},
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as never,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, calls, doc: () => doc, projectId: () => doc.projectId };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect() {
	const engine = fakeEngine();
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'fonts-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'fonts-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
		const text = (r.content[0] as { text: string }).text;
		return { r, json: JSON.parse(text) };
	};
	return { engine, call };
}

describe('font MCP tools (wp fonts)', () => {
	it("list_fonts: bundled, installed and the project's missing fonts", async () => {
		const { engine, call } = await connect();
		const { json } = await call('list_fonts', { projectId: engine.projectId() });
		expect(json.bundled.map((f: { family: string }) => f.family)).toEqual(['Inter']);
		expect(json.installed[0]).toMatchObject({
			fontId: PIXEL.id,
			postscriptName: 'Pixel12x10',
			file: 'Pixel12x10.ttf',
		});
		const byFamily = Object.fromEntries(json.projectFonts.map((f: { family: string }) => [f.family, f]));
		expect(byFamily.Pixel12x10).toMatchObject({
			status: 'available',
			rendersWith: 'Pixel 12x10',
			source: 'installed',
			layers: 1,
		});
		expect(byFamily['Minion Pro']).toMatchObject({ status: 'missing', layers: 1 });
		const q = await call('list_fonts', { query: 'pixel' });
		expect(q.json.bundled).toEqual([]);
		expect(q.json.projectFonts).toBeUndefined();
	});

	it('install_font: absolute paths only; the missing font becomes available; clashes are explained', async () => {
		const { engine, call } = await connect();
		const rel = await call('install_font', { path: 'fonts/MinionPro-Regular.otf' });
		expect(rel.r.isError).toBe(true);
		const ok = await call('install_font', { path: '/home/u/fonts/MinionPro-Regular.otf' });
		expect(ok.json.installed[0]).toMatchObject({ family: 'Minion Pro', postscriptName: 'MinionPro-Regular' });
		expect(engine.calls).toEqual(['install /home/u/fonts/MinionPro-Regular.otf']);
		const after = await call('list_fonts', { projectId: engine.projectId() });
		expect(after.json.projectFonts.find((f: { family: string }) => f.family === 'Minion Pro').status).toBe(
			'available',
		);
		const clash = await call('install_font', { path: '/home/u/fonts/clash.otf' });
		expect(clash.r.isError).toBe(true);
		expect(clash.json.error.code).toBe('E_FONT_EXISTS');
	});

	it('remove_font goes through the engine approval and reports a denial', async () => {
		const { engine, call } = await connect();
		const r = await call('remove_font', { fontId: PIXEL.id });
		expect(r.r.isError).toBe(true);
		expect(r.json.error.code).toBe('E_APPROVAL_DENIED');
		expect(engine.calls).toEqual([`remove ${PIXEL.id}`]);
		expect((await call('remove_font', { fontId: 'nope' })).r.isError).toBe(true);
	});

	it('add_text {font} registers the family and sets it on the new text clip in one transaction', async () => {
		const { engine, call } = await connect();
		const r = await call('add_text', {
			projectId: engine.projectId(),
			text: 'Hi',
			at: 0,
			duration: 30,
			font: 'CircularStd-Medium',
		});
		expect(r.r.isError).toBeFalsy();
		const doc = engine.doc();
		const font = Object.values(doc.fonts).find((f) => f.family === 'CircularStd-Medium')!;
		const clip = Object.values(Object.values(doc.sequences)[0]!.clips).find(
			(c) => (c as unknown as { content?: { text: string } }).content?.text === 'Hi',
		) as unknown as { content: { style: { fontId: string } } };
		expect(clip.content.style.fontId).toBe(font.id);
	});
});
