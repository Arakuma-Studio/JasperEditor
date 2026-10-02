// MCP tools for composition clips (S08:MGA-001/002, §8 test 7). The schema summary is a unit test; with
// MG_E2E=1 the whole flow runs headless against a real engine on MCP_MG_TEST_PORT (default 48145):
// import_mg_bundle → list_compositions → add_composition → set_composition_props → render_frame (the edited
// title changes the frame) → prerender_composition, plus the actionable errors.
import { type ChildProcess, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MgCompositionInfo } from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPOSITION_GUIDE, propsSummary } from '../src/tools/compositions.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const FIXTURE_PROJECT = join(ROOT, 'fixtures', 'mg-project');
const PORT = Number(process.env.MCP_MG_TEST_PORT ?? 48145);
const E2E = process.env.MG_E2E === '1';

describe('composition tool helpers', () => {
	it('summarizes a props schema for agents (type, default, constraints, controls)', () => {
		const info = {
			id: 'Title',
			width: 1920,
			height: 1080,
			fps: 30,
			durationInFrames: 90,
			defaultProps: { title: 'Hi', accent: '#ff0000', delay: 6, tags: ['a'] },
			propsSchema: {
				type: 'object',
				properties: {
					title: { type: 'string', maxLength: 80, description: 'Headline' },
					accent: { type: 'string', pattern: '^#[0-9a-f]{6}$' },
					delay: { type: 'integer', minimum: 0 },
					tags: { type: 'array', items: { type: 'string' } },
				},
				required: ['title'],
			},
			schemaSource: 'bundle',
			ui: { accent: { control: 'color' } },
		} as MgCompositionInfo;
		expect(propsSummary(info)).toEqual({
			title: { type: 'string', maxLength: 80, description: 'Headline', default: 'Hi', required: true },
			accent: { type: 'string', pattern: '^#[0-9a-f]{6}$', default: '#ff0000', control: 'color' },
			delay: { type: 'integer', minimum: 0, default: 6 },
			tags: { type: 'array', items: 'string', default: ['a'] },
		});
		expect(COMPOSITION_GUIDE).toMatch(/import_mg_bundle/);
	});
});

function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env))
		if (v !== undefined && !k.startsWith('JASPER_')) out[k] = v;
	return { ...out, ...extra };
}

describe.runIf(E2E)('composition tools over stdio against a real engine (MG_E2E=1)', () => {
	let engine: ChildProcess | null = null;
	let appdir = '';
	let client: Client;
	const logs: string[] = [];
	const text = (r: CallToolResult) =>
		(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
	const call = async (name: string, args: Record<string, unknown> = {}) =>
		(await client.callTool({ name, arguments: args }, undefined, { timeout: 900_000 })) as CallToolResult;
	const ok = async <T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) => {
		const r = await call(name, args);
		if (r.isError) throw new Error(`${name}: ${text(r)}\n${logs.join('')}`);
		return { body: JSON.parse(text(r)) as T, r };
	};

	beforeAll(async () => {
		appdir = mkdtempSync(join(tmpdir(), 'jasper-mcp-mg-'));
		engine = spawn(
			process.execPath,
			['--import', 'tsx', join(ROOT, 'apps/engine/src/cli.ts'), '--port', String(PORT), '--appdir', appdir],
			{ cwd: ROOT, env: cleanEnv({ JASPER_DEV: '1' }), stdio: ['ignore', 'pipe', 'pipe'] },
		);
		const until = Date.now() + 120_000;
		while (Date.now() < until) {
			if (existsSync(join(appdir, 'engine', 'runtime.json'))) {
				const ok = await fetch(`http://127.0.0.1:${PORT}/health`).then(
					(r) => r.ok,
					() => false,
				);
				if (ok) break;
			}
			await new Promise((r) => setTimeout(r, 250));
		}
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: ['--import', 'tsx', join(ROOT, 'apps/mcp/src/cli.ts'), '--appdir', appdir],
			cwd: ROOT,
			env: cleanEnv(),
			stderr: 'pipe',
		});
		transport.stderr?.on('data', (d: Buffer) => logs.push(d.toString('utf8')));
		client = new Client({ name: 'vitest-mcp-mg', version: '1.0.0' });
		await client.connect(transport);
	}, 180_000);

	afterAll(async () => {
		await client?.close().catch(() => {});
		if (engine && engine.exitCode === null) {
			const exited = new Promise((r) => engine!.once('exit', r));
			engine.kill('SIGTERM');
			await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
		}
		if (appdir) rmSync(appdir, { recursive: true, force: true });
	}, 30_000);

	it('imports, places, edits and renders a composition; errors carry hints', async () => {
		const { body: p } = await ok<{ projectId: string }>('create_project', { name: 'MCP compositions' });
		const projectId = p.projectId;
		const { body: imp } = await ok<{
			mediaId: string;
			compositions: { id: string; schemaSource: string; props: Record<string, { type?: string }> }[];
		}>('import_mg_bundle', { projectId, path: FIXTURE_PROJECT });
		expect(imp.compositions.map((c) => [c.id, c.schemaSource]).sort()).toEqual([
			['Badge', 'inferred'],
			['LowerThird', 'bundle'],
			['Title', 'bundle'],
		]);
		expect(imp.compositions.find((c) => c.id === 'Title')!.props.delay!.type).toBe('integer');
		// Importing again reuses the asset.
		const { body: again } = await ok<{ mediaId: string }>('import_mg_bundle', {
			projectId,
			path: FIXTURE_PROJECT,
		});
		expect(again.mediaId).toBe(imp.mediaId);
		const { body: list } = await ok<{ bundles: { compositions: unknown[] }[] }>('list_compositions', {
			projectId,
		});
		expect(list.bundles[0]!.compositions).toHaveLength(3);

		const { body: added } = await ok<{
			appliedBy: string;
			clips: { id: string; start: number; end: number }[];
		}>('add_composition', {
			projectId,
			mediaId: imp.mediaId,
			compositionId: 'Title',
			at: 0,
			track: 'V1',
			props: { delay: 0 },
		});
		expect(added.appliedBy).toBe('headless');
		const clip = added.clips[0]!;
		expect([clip.start, clip.end]).toEqual([0, 90]);
		const frame = async () => {
			const r = await call('render_frame', { projectId, at: 45, width: 480 });
			expect(r.isError, text(r)).toBeFalsy();
			return (r.content.find((c) => c.type === 'image') as { data: string }).data;
		};
		const before = await frame();
		const bad = await call('set_composition_props', { projectId, clipId: clip.id, props: { title: 7 } });
		expect(bad.isError).toBe(true);
		expect(JSON.parse(text(bad)).error.code).toBe('E_INVALID_PARAM');
		const { body: set } = await ok<{ effectiveProps: Record<string, unknown> }>('set_composition_props', {
			projectId,
			clipId: clip.id,
			props: { title: 'Edited by an agent' },
		});
		expect(set.effectiveProps).toEqual({ title: 'Edited by an agent', accent: '#ff3366', delay: 0 });
		const after = await frame();
		expect(after).not.toBe(before);
		const { body: pre } = await ok<{ job: { state: string; kind: string; result?: { masterUrl?: string } } }>(
			'prerender_composition',
			{ projectId, clipId: clip.id, quality: 'master', wait: true },
		);
		expect(pre.job).toMatchObject({ kind: 'mg-prerender', state: 'succeeded' });
		expect(pre.job.result?.masterUrl).toMatch(/master\.mov$/);

		// Hybrid text layers (S08:MGA-003): list the texts of a LowerThird, edit a text and its style in one step.
		const { body: lt } = await ok<{ clips: { id: string }[]; revision: number }>('add_composition', {
			projectId,
			mediaId: imp.mediaId,
			compositionId: 'LowerThird',
			at: 0,
			track: 'V2',
		});
		const ltId = lt.clips[0]!.id;
		const { body: texts } = await ok<{
			texts: { path: string; label: string; value: string; style: Record<string, { prop: string }> }[];
		}>('list_composition_texts', { projectId, clipId: ltId });
		expect(texts.texts.map((t) => [t.path, t.label])).toEqual([
			['name.text', 'Name'],
			['role', 'Role'],
			['quote', 'Quote'],
		]);
		expect(Object.keys(texts.texts[0]!.style).sort()).toEqual([
			'align',
			'color',
			'fontFamily',
			'fontSize',
			'fontWeight',
		]);
		const noRole = await call('set_composition_text', {
			projectId,
			clipId: ltId,
			texts: [{ text: 'role', style: { align: 'center' } }],
		});
		expect(JSON.parse(text(noRole)).error.code).toBe('E_INVALID_PARAM');
		const tooLong = await call('set_composition_text', {
			projectId,
			clipId: ltId,
			texts: [{ text: 'Name', value: 'x'.repeat(61) }],
		});
		expect(JSON.parse(text(tooLong)).error.code).toBe('E_INVALID_PARAM');
		const ltBefore = await call('render_frame', { projectId, at: 60, width: 480 });
		const { body: edited } = await ok<{
			revision: number;
			texts: { path: string; value: string; warnings: { code: string }[] }[];
		}>('set_composition_text', {
			projectId,
			clipId: ltId,
			texts: [
				{ text: 'name.text', value: 'Grace Hopper, Rear Admiral', style: { color: '#ffcc00', fontSize: 72 } },
			],
		});
		expect(edited.texts[0]).toMatchObject({ path: 'name.text', value: 'Grace Hopper, Rear Admiral' });
		expect(edited.texts[0]!.warnings.map((w) => w.code)).toContain('MG_TEXT_LONG'); // designed for 24
		const ltAfter = await call('render_frame', { projectId, at: 60, width: 480 });
		const img = (r: CallToolResult) => (r.content.find((c) => c.type === 'image') as { data: string }).data;
		expect(img(ltAfter)).not.toBe(img(ltBefore));
		// Text and style landed in ONE transaction (one revision, one undo step in an open editor).
		expect(edited.revision).toBe(lt.revision + 1);
		const { body: now } = await ok<{
			texts: { value: string; overridden: boolean; style: Record<string, { value: unknown }> }[];
		}>('list_composition_texts', { projectId, clipId: ltId });
		expect(now.texts[0]).toMatchObject({ value: 'Grace Hopper, Rear Admiral', overridden: true });
		expect(now.texts[0]!.style.color!.value).toBe('#ffcc00');
		expect(now.texts[0]!.style.fontSize!.value).toBe(72);
		expect(now.texts[1]!.overridden).toBe(false);
		// Layout warnings measured by the engine (its headless browser renders the composition): a name too long
		// for its panel is cut off; the warning names it and the result says it was measured.
		const { body: long } = await ok<{
			layout: string;
			texts: { path: string; warnings: { code: string }[]; rect?: { width: number } }[];
		}>('set_composition_text', {
			projectId,
			clipId: ltId,
			texts: [{ text: 'name.text', value: 'Augusta Ada King, Countess of Lovelace' }],
		});
		expect(long.layout).toMatch(/^measured/);
		expect(long.texts[0]!.warnings.map((w) => w.code)).toEqual(['MG_TEXT_LONG', 'MG_TEXT_CLIPPED']);
		expect(long.texts[0]!.rect!.width).toBeGreaterThan(1100);
		const { body: listed2 } = await ok<{
			layout: string;
			texts: { path: string; warnings: { code: string }[] }[];
		}>('list_composition_texts', { projectId, clipId: ltId });
		expect(listed2.texts.find((t) => t.path === 'name.text')!.warnings.map((w) => w.code)).toContain(
			'MG_TEXT_CLIPPED',
		);
		const { body: quick } = await ok<{ layout: string }>('list_composition_texts', {
			projectId,
			clipId: ltId,
			measure: false,
		});
		expect(quick.layout).toMatch(/not measured/);

		// MG_REMOTION_VERSION carries the pin hint (S08:MGA-002).
		const old = mkdtempSync(join(tmpdir(), 'jasper-mcp-old-'));
		cpSync(join(FIXTURE_PROJECT, 'src'), join(old, 'src'), { recursive: true });
		writeFileSync(join(old, 'package.json'), JSON.stringify({ dependencies: { remotion: '4.0.300' } }));
		const ver = await call('import_mg_bundle', { projectId, path: old });
		expect(ver.isError).toBe(true);
		const err = JSON.parse(text(ver)).error;
		expect(err.code).toBe('MG_REMOTION_VERSION');
		expect(err.hint).toMatch(/pin it|pin every remotion/);
		rmSync(old, { recursive: true, force: true });
	}, 900_000);
});
