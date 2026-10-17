// Sound-pack MCP tools end to end (spec 12 §2.10, P6-R1; wp-note "Phase 6 → WP6.1 sound packs"): a real engine whose
// pack catalogue (JASPER_SOUND_CATALOG) names a generated archive by a file:// URL, driven by jasper-mcp over stdio:
// list_sound_packs (licence and sizes first), install_sound_pack (waits for the install and the index job), the pack's
// sounds found by search_sounds {packId}, remove_sound_pack behind the approval card (denied, then approved). No network.
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { editorWindow } from './editor-window.ts';
import { cleanEnv, waitFor } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = Number(process.env.MCP_SOUND_PACKS_TEST_PORT ?? 49563);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const textOf = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';

/** A 16-bit mono WAV: 20 ms of silence, then a decaying burst (a "hit"); `seed` varies the noise. */
function hitWav(seed: number, seconds = 0.4): Buffer {
	const sr = 48_000;
	const n = Math.round(seconds * sr);
	const buf = Buffer.alloc(44 + n * 2);
	buf.write('RIFF', 0);
	buf.writeUInt32LE(36 + n * 2, 4);
	buf.write('WAVEfmt ', 8);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(1, 22);
	buf.writeUInt32LE(sr, 24);
	buf.writeUInt32LE(sr * 2, 28);
	buf.writeUInt16LE(2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write('data', 36);
	buf.writeUInt32LE(n * 2, 40);
	let s = seed;
	for (let i = 0; i < n; i++) {
		const t = i / sr - 0.02;
		s = (s * 1103515245 + 12345) >>> 0;
		const v =
			t < 0
				? 0
				: Math.exp(-t * 20) * (0.5 * Math.sin(2 * Math.PI * 250 * t) + 0.3 * ((s / 0xffffffff) * 2 - 1));
		buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32000), 44 + i * 2);
	}
	return buf;
}

/** A stored (uncompressed) ZIP of the files (the engine's reader checks sizes; the catalogue's sha256 checks bytes). */
function storedZip(files: { name: string; data: Buffer }[]): Buffer {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const f of files) {
		const name = Buffer.from(f.name);
		const loc = Buffer.alloc(30);
		loc.writeUInt32LE(0x04034b50, 0);
		loc.writeUInt16LE(20, 4);
		loc.writeUInt32LE(f.data.length, 18);
		loc.writeUInt32LE(f.data.length, 22);
		loc.writeUInt16LE(name.length, 26);
		parts.push(loc, name, f.data);
		const cen = Buffer.alloc(46);
		cen.writeUInt32LE(0x02014b50, 0);
		cen.writeUInt16LE(20, 4);
		cen.writeUInt16LE(20, 6);
		cen.writeUInt32LE(f.data.length, 20);
		cen.writeUInt32LE(f.data.length, 24);
		cen.writeUInt16LE(name.length, 28);
		cen.writeUInt32LE(offset, 42);
		central.push(cen, name);
		offset += 30 + name.length + f.data.length;
	}
	const cd = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(cd.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, cd, end]);
}

let engine: ChildProcess | null = null;
let work = '';
let client: Client;
const token = randomBytes(16).toString('hex');
const editorKey = randomBytes(16).toString('hex');
const logs: string[] = [];
const engineLog: string[] = [];

async function call(name: string, args: Record<string, unknown> = {}) {
	return (await client.callTool({ name, arguments: args }, undefined, {
		timeout: 600_000,
	})) as CallToolResult;
}
async function ok<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) {
	const r = await call(name, args);
	if (r.isError) throw new Error(`${name} failed: ${textOf(r)}\n${logs.join('')}`);
	return JSON.parse(textOf(r)) as T;
}

beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), 'jasper-mcp-packs-'));
	const appdir = join(work, 'appdir');
	mkdirSync(appdir);
	mkdirSync(join(work, 'kit'));
	writeFileSync(join(work, 'kit', 'manifest.json'), JSON.stringify({ version: 1, packs: [], sounds: [] }));
	const files = [
		{ path: 'Audio/impact_000.wav', data: hitWav(3), title: 'Pack impact one' },
		{ path: 'Audio/impact_001.wav', data: hitWav(4, 0.3), title: 'Pack impact two' },
	];
	const zip = storedZip(files.map((f) => ({ name: f.path, data: f.data })));
	writeFileSync(join(work, 'pack.zip'), zip);
	const catalog = {
		version: 1,
		packs: [
			{
				id: 'test-impacts',
				title: 'Test Impacts',
				author: 'Test Author',
				description: 'Two generated hits.',
				license: 'CC0-1.0',
				licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
				licenseEvidence: [
					{ url: 'https://example.invalid/impacts', statement: 'License: CC0', checkedAt: '2026-10-17' },
				],
				attribution: null,
				pageUrl: 'https://example.invalid/impacts',
				download: {
					type: 'zip',
					url: pathToFileURL(join(work, 'pack.zip')).href,
					sha256: sha(zip),
					sizeBytes: zip.length,
				},
				files: files.map((f) => ({
					path: f.path,
					sha256: sha(f.data),
					sizeBytes: f.data.length,
					title: f.title,
					types: ['hit'],
					tags: ['test'],
				})),
			},
		],
	};
	writeFileSync(join(work, 'catalog.json'), JSON.stringify(catalog));
	engine = spawn(
		process.execPath,
		['--import', 'tsx', join(ROOT, 'apps/engine/src/cli.ts'), '--port', String(PORT), '--appdir', appdir],
		{
			cwd: ROOT,
			env: cleanEnv({
				JASPER_LOCAL_TOKEN: token,
				JASPER_EDITOR_KEY: editorKey,
				JASPER_SOUND_STARTER_DIR: join(work, 'kit'),
				JASPER_SOUND_SYNTH_VARIANTS: '0',
				JASPER_SOUND_AUTO_INDEX: '0',
				JASPER_SOUND_CATALOG: join(work, 'catalog.json'),
			}),
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
	engine.stdout?.on('data', (d: Buffer) => engineLog.push(d.toString()));
	engine.stderr?.on('data', (d: Buffer) => engineLog.push(d.toString()));
	await waitFor(
		async () => (await fetch(`http://127.0.0.1:${PORT}/health`)).ok,
		120_000,
		`the engine on ${PORT}: ${engineLog.join('')}`,
	);
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ['--import', 'tsx', join(ROOT, 'apps/mcp/src/cli.ts'), '--appdir', appdir],
		cwd: ROOT,
		env: cleanEnv(),
		stderr: 'pipe',
	});
	transport.stderr?.on('data', (d: Buffer) => logs.push(d.toString('utf8')));
	client = new Client({ name: 'vitest-mcp-packs', version: '1.0.0' });
	await client.connect(transport);
}, 240_000);

afterAll(async () => {
	await client?.close().catch(() => {});
	if (engine && engine.exitCode === null) {
		const exited = new Promise((r) => engine!.once('exit', r));
		engine.kill('SIGTERM');
		await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
	}
	if (work) rmSync(work, { recursive: true, force: true });
}, 30_000);

type PackView = {
	packId: string;
	license: string;
	credit: string | null;
	downloadMB: number;
	installMB: number;
	sounds: number;
	state: string;
	indexedSounds: number;
	licenseEvidence: { url: string }[];
};

describe('sound pack MCP tools', { timeout: 900_000 }, () => {
	it('annotations: list is read-only, install reaches the network, remove is destructive and idempotent', async () => {
		const tools = (await client.listTools()).tools;
		const ann = (n: string) => tools.find((t) => t.name === n)?.annotations;
		expect(ann('list_sound_packs')).toMatchObject({ readOnlyHint: true, openWorldHint: false });
		expect(ann('install_sound_pack')).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
			openWorldHint: true,
		});
		expect(ann('remove_sound_pack')).toMatchObject({ destructiveHint: true, idempotentHint: true });
		expect(tools.find((t) => t.name === 'install_sound_pack')!.description).toMatch(
			/tell the user the pack's name, download size and licence/,
		);
	});

	it('lists, installs (waiting for the index), searches by pack and removes behind the approval card', async () => {
		const list = await ok<{ packs: PackView[] }>('list_sound_packs');
		expect(list.packs).toEqual([
			expect.objectContaining({
				packId: 'test-impacts',
				license: 'CC0-1.0',
				credit: null,
				sounds: 2,
				state: 'available',
			}),
		]);
		expect(list.packs[0]!.licenseEvidence[0]!.url).toBe('https://example.invalid/impacts');

		const unknown = await call('install_sound_pack', { packId: 'nope' });
		expect(unknown.isError).toBe(true);
		expect(textOf(unknown)).toContain('test-impacts');

		const inst = await ok<{
			ok: boolean;
			state: string;
			pack: { license: string };
			installed: { sounds: number };
			index: { state: string };
		}>('install_sound_pack', { packId: 'test-impacts' });
		expect(inst).toMatchObject({
			ok: true,
			state: 'succeeded',
			pack: { license: 'CC0-1.0' },
			installed: { sounds: 2 },
			index: { state: 'succeeded' },
		});

		const found = await ok<{
			total: number;
			results: { title: string; source: { type: string; packId?: string } }[];
		}>('search_sounds', { packId: 'test-impacts', license: 'any' });
		expect(found.total).toBe(2);
		expect(found.results[0]!.source).toEqual({ type: 'pack', packId: 'test-impacts' });
		expect((await ok<{ packs: PackView[] }>('list_sound_packs')).packs[0]).toMatchObject({
			state: 'installed',
			indexedSounds: 2,
		});

		// Removing needs the user: no window → E_APPROVAL_DENIED and nothing changes.
		const refused = await call('remove_sound_pack', { packId: 'test-impacts' });
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain('APPROVAL_DENIED');
		const projectId = (await ok<{ projectId: string }>('create_project', { name: 'Packs' })).projectId;
		const win = await editorWindow({ port: PORT, token, editorKey, projectId });
		try {
			const denied = call('remove_sound_pack', { packId: 'test-impacts' });
			const c1 = await win.card(1);
			expect(c1.label).toBe('Remove a sound pack');
			expect(c1.summary).toContain('Test Impacts');
			win.answer(c1, 'denied');
			expect((await denied).isError).toBe(true);
			expect((await ok<{ packs: PackView[] }>('list_sound_packs')).packs[0]!.state).toBe('installed');

			const approved = ok<{ removed: boolean; removedSounds: number }>('remove_sound_pack', {
				packId: 'test-impacts',
			});
			win.answer(await win.card(2), 'approved');
			expect(await approved).toMatchObject({ removed: true, removedSounds: 2 });
			// idempotent: nothing installed, nothing asked
			expect(await ok('remove_sound_pack', { packId: 'test-impacts' })).toMatchObject({ removed: false });
			expect(win.cards).toHaveLength(2);
		} finally {
			win.close();
		}
		expect((await ok<{ packs: PackView[] }>('list_sound_packs')).packs[0]!.state).toBe('available');
	});
});
