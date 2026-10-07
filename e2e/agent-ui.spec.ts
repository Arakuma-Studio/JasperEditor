// mcp-cli §4: an MCP client operates the live editor window through the built jasper-mcp: ui_state,
// ui_elements, ui_locate / ui_hit (timeline time ↔ x, track ↔ y; Program sequence px ↔ window), ui_drag of a
// clip, ui_key, ui_set on a scrubby number, ui_click on a button, ui_commands / ui_command, ui_screenshot.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, type Page, test } from '@playwright/test';
import {
	clips,
	createProject,
	enableAgentBridge,
	importFiles,
	query,
	ROOT,
	serverInfo,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'default' });

const MCP_BUNDLE = join(ROOT, 'apps/mcp/dist/jasper-mcp.mjs');
let page: Page;
let projectId = '';
let mcp: Client;
const mcpLog: string[] = [];

const text = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';

async function call(name: string, args: Record<string, unknown> = {}) {
	return (await mcp.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as CallToolResult;
}
async function tool<T = Record<string, unknown>>(
	name: string,
	args: Record<string, unknown> = {},
): Promise<T> {
	const r = await call(name, args);
	expect(r.isError, `${name}: ${text(r)}\n${mcpLog.join('')}`).toBeFalsy();
	return JSON.parse(text(r)) as T;
}

type El = {
	id: string;
	role: string;
	name: string;
	bounds: { x: number; y: number; width: number; height: number };
	value?: unknown;
	panel: string | null;
	stable: boolean;
};

test.beforeAll(async ({ browser }) => {
	expect(existsSync(MCP_BUNDLE), `${MCP_BUNDLE} is missing: run \`pnpm mcp:build\``).toBe(true);
	page = await browser.newPage();
	await enableAgentBridge(page);
	projectId = await createProject(page, 'E2E Agent UI');
	await importFiles(page, ['clip-a.mp4']);
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env))
		if (v !== undefined && !k.startsWith('JASPER_')) env[k] = v;
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [MCP_BUNDLE, '--appdir', serverInfo().appdir],
		env,
		stderr: 'pipe',
	});
	transport.stderr?.on('data', (d: Buffer) => mcpLog.push(d.toString('utf8')));
	mcp = new Client({ name: 'e2e-agent-ui', version: '1.0.0' });
	await mcp.connect(transport);
	const media = (await query<{ media: { mediaId: string }[] }>(page, 'media.list')).media;
	const r = await transact(page, [
		{
			type: 'clip.place',
			source: { mediaId: media[0]!.mediaId },
			at: 0,
			tracks: { video: 'V1', audio: 'A1' },
		},
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
});

test.afterAll(async () => {
	await mcp?.close().catch(() => {});
	await page?.close();
});

test('ui_state and ui_elements describe the window with stable ids', async () => {
	const s = await tool<{
		projectId: string;
		runtime: string;
		workspace: { id: string };
		panels: { kind: string; visible: boolean }[];
	}>('ui_state', { projectId });
	expect(s.projectId).toBe(projectId);
	expect(s.runtime).toBe('web');
	expect(s.panels.some((p) => p.kind === 'timeline' && p.visible)).toBe(true);
	const els = await tool<{ elements: El[] }>('ui_elements', { projectId, panel: 'timeline' });
	const clip = (await clips(page)).find((c) => c.track === 'V1')!;
	const target = els.elements.find((e) => e.id === `timeline.clip.${clip.id}`);
	expect(
		target,
		JSON.stringify(els.elements.map((e) => e.id).filter((i) => !i.includes('track-headers'))),
	).toBeTruthy();
	expect(els.elements.every((e) => e.panel === 'timeline')).toBe(true);
	// Unknown keys are rejected with the accepted ones listed.
	const bad = await call('ui_elements', { projectId, pannel: 'timeline' });
	expect(bad.isError).toBe(true);
	expect(JSON.parse(text(bad)).error.hint).toContain('"pannel" → "panel"');
});

test('timeline mapping, then a clip dragged by an agent moves by the frames asked', async () => {
	const clip = (await clips(page)).find((c) => c.track === 'V1')!;
	const at = await tool<{ timeline: { x: number; y: number; view: { pxPerFrame: number } } }>('ui_locate', {
		projectId,
		timeline: { frame: 10, track: 'V1' },
	});
	const hit = await tool<{ timeline: { frame: number; track: string; clipId: string } }>('ui_hit', {
		projectId,
		x: at.timeline.x,
		y: at.timeline.y,
	});
	expect(hit.timeline).toMatchObject({ frame: 10, track: 'V1', clipId: clip.id });
	// Make room: zoom so 30 frames are visible distinctly, then drag the clip body 30 frames right.
	const from = await tool<{ timeline: { x: number; y: number } }>('ui_locate', {
		projectId,
		timeline: { clipId: clip.id },
	});
	const dx = 30 * at.timeline.view.pxPerFrame;
	await tool('ui_drag', {
		projectId,
		from: { x: from.timeline.x, y: from.timeline.y },
		to: { x: from.timeline.x + dx, y: from.timeline.y },
		steps: 10,
	});
	await expect.poll(async () => (await clips(page)).find((c) => c.id === clip.id)?.start).toBe(30);
	await tool('ui_key', { projectId, key: 'Cmd+Z' });
	await expect.poll(async () => (await clips(page)).find((c) => c.id === clip.id)?.start).toBe(0);
});

test('Program monitor mapping: sequence pixels ↔ window points', async () => {
	const loc = await tool<{
		program: { window: { x: number; y: number }; view: { sequence: { width: number } } };
	}>('ui_locate', { projectId, program: { x: 960, y: 540 } });
	const back = await tool<{ panel: string; program: { x: number; y: number; inside: boolean } }>('ui_hit', {
		projectId,
		x: loc.program.window.x,
		y: loc.program.window.y,
	});
	expect(back.panel).toBe('program');
	expect(back.program.inside).toBe(true);
	expect(Math.abs(back.program.x - 960)).toBeLessThan(2);
	expect(Math.abs(back.program.y - 540)).toBeLessThan(2);
});

test('ui_set types into a scrubby number and the document follows', async () => {
	const clip = (await clips(page)).find((c) => c.track === 'V1')!;
	await tool('ui_click', { projectId, timeline: { clipId: clip.id } });
	await tool('ui_command', { projectId, id: 'panel.focus.effectControls' });
	const els = await tool<{ elements: El[] }>('ui_elements', {
		projectId,
		panel: 'effectControls',
		query: 'opacity',
	});
	const field = els.elements.find((e) => e.role === 'spinbutton');
	expect(field, JSON.stringify(els.elements.map((e) => [e.id, e.role]))).toBeTruthy();
	const set = await tool<{ value: unknown }>('ui_set', { projectId, id: field!.id, value: 40 });
	expect(set.value).toBe(40);
	const props = await tool<{ properties: { key: string; value: number; evaluated: number }[] }>(
		'get_clip_properties',
		{
			projectId,
			clipId: clip.id,
			keys: ['opacity'],
		},
	);
	expect(props.properties[0]).toMatchObject({ value: 40, evaluated: 40 });
});

test('UI commands list enabled/why and run; workspaces switch', async () => {
	const list = await tool<{ commands: { id: string; enabled: boolean; why?: string; shortcut?: string }[] }>(
		'ui_commands',
		{ projectId, filter: 'workspace' },
	);
	expect(list.commands.find((c) => c.id === 'workspace.switch')?.enabled).toBe(true);
	const disabled = (
		await tool<{ commands: { enabled: boolean; why?: string }[] }>('ui_commands', { projectId })
	).commands.filter((c) => !c.enabled);
	expect(disabled.length).toBeGreaterThan(0);
	expect(disabled.every((c) => typeof c.why === 'string' && c.why.length > 0)).toBe(true);
	await tool('ui_command', { projectId, id: 'workspace.switch', args: { id: 'color' } });
	await expect
		.poll(async () => (await tool<{ workspace: { id: string } }>('ui_state', { projectId })).workspace.id)
		.toBe('color');
	const bad = await call('ui_command', { projectId, id: 'workspace.nope' });
	expect(bad.isError).toBe(true);
	expect(text(bad)).toContain('Unknown UI command');
	await tool('ui_command', { projectId, id: 'workspace.switch', args: { id: 'editing' } });
});

test('ui_screenshot returns the window and a cropped panel', async () => {
	const win = await call('ui_screenshot', { projectId, maxWidth: 800 });
	expect(win.isError, text(win)).toBeFalsy();
	const img = win.content.find((c) => c.type === 'image') as { data: string } | undefined;
	expect(img).toBeTruthy();
	const png = Buffer.from(img!.data, 'base64');
	expect(png.subarray(1, 4).toString()).toBe('PNG');
	mkdirSync(join(ROOT, 'test-results', 'agent-ui'), { recursive: true });
	writeFileSync(join(ROOT, 'test-results', 'agent-ui', 'window.png'), png);
	const meta = JSON.parse(text(win)) as { width: number; height: number };
	expect(meta.width).toBeLessThanOrEqual(800);
	const panel = await call('ui_screenshot', { projectId, panel: 'timeline' });
	expect(panel.isError, text(panel)).toBeFalsy();
	const pm = JSON.parse(text(panel)) as { bounds: { width: number }; width: number };
	const pimg = panel.content.find((c) => c.type === 'image') as { data: string };
	writeFileSync(join(ROOT, 'test-results', 'agent-ui', 'timeline.png'), Buffer.from(pimg.data, 'base64'));
	expect(pm.bounds.width).toBeLessThan(page.viewportSize()!.width);
});
