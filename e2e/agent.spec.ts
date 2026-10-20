import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clips,
	createProject,
	enableAgentBridge,
	importFiles,
	playheadFrame,
	ROOT,
	serverInfo,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const MCP_BUNDLE = join(ROOT, 'apps/mcp/dist/jasper-mcp.mjs');

let page: Page;
let projectId = '';
let mcp: Client;
const mcpLog: string[] = [];

type TxBody = {
	ok: boolean;
	appliedBy: 'session' | 'headless';
	appliedLive: boolean;
	revision: number;
	created: string[];
	refs?: Record<string, string>;
};

const text = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
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

test.beforeAll(async ({ browser }) => {
	expect(existsSync(MCP_BUNDLE), `${MCP_BUNDLE} is missing: run \`pnpm mcp:build\``).toBe(true);
	page = await browser.newPage();
	await enableAgentBridge(page);
	projectId = await createProject(page, 'E2E Agent');
	await importFiles(page, ['clip-b.mp4']);

	// The server finds the E2E engine the way it finds a user's: <appdir>/engine/runtime.json.
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
	mcp = new Client({ name: 'e2e-agent', version: '1.0.0' });
	await mcp.connect(transport);
});

test.afterAll(async () => {
	await mcp?.close().catch(() => {});
	if (page && !page.isClosed()) await page.screenshot({ path: 'test-results/e2e-agent-final.png' });
	await page?.close();
});

test('apply_commands with the editor open places a clip and a marker live, as one "Agent:" History entry', async () => {
	const testInfo = test.info();
	const before = (await appliedLabels(page)).length;
	const body = await tool<TxBody>('apply_commands', {
		projectId,
		label: 'Place clip-b and mark it',
		commands: [
			{
				type: 'clip.place',
				source: { mediaByName: 'clip-b.mp4' },
				at: 0,
				tracks: { video: 'V1', audio: 'A1' },
				matchSequence: 'keep',
			},
			{ type: 'marker.add', frame: 45, name: 'Agent marker', comment: 'added over MCP' },
		],
	});
	expect(body).toMatchObject({ ok: true, appliedBy: 'session', appliedLive: true });

	const placed = await clips(page, ['V1']);
	expect(placed).toHaveLength(1);
	expect(body.created).toContain(placed[0]!.id);
	await expect(
		page.locator(`[data-testid="timeline-track-area"] [data-clip-id="${placed[0]!.id}"]`),
	).toBeVisible();
	await expect(page.locator('[data-marker-lane] [data-mark="marker"]')).toHaveCount(1);
	const labels = await appliedLabels(page);
	expect(labels).toHaveLength(before + 1);
	expect(labels.at(-1)).toBe('Agent: Place clip-b and mark it');
	await testInfo.attach('live-project', {
		body: JSON.stringify({ placed, labels, transaction: body }, null, 2),
		contentType: 'application/json',
	});
	await testInfo.attach('editor', { body: await page.screenshot(), contentType: 'image/png' });
});

test('MCP edits render from the live editor and can be undone and redone', async () => {
	const testInfo = test.info();
	const added = await tool<TxBody & { clips: { id: string; track: string; start: number }[] }>('add_text', {
		projectId,
		text: 'Hello from MCP',
		at: { seconds: 1 },
		duration: { seconds: 2 },
		track: 'V2',
	});
	expect(added.appliedLive).toBe(true);
	expect(await clips(page, ['V2'])).toHaveLength(1);

	const frame = await call('render_frame', { projectId, at: { seconds: 2 }, width: 320 });
	expect(frame.isError, text(frame)).toBeFalsy();
	const image = frame.content.find((c) => c.type === 'image') as { data: string; mimeType: string };
	expect(image.mimeType).toBe('image/png');
	const png = Buffer.from(image.data, 'base64');
	expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
	expect(png.readUInt32BE(16)).toBe(320);
	await testInfo.attach('agent-frame', { body: png, contentType: 'image/png' });

	const history = (await appliedLabels(page)).length;
	const moved = await tool<{ frame: number; timecode: string }>('set_playhead', {
		projectId,
		at: '00:00:01:15',
	});
	expect(moved.frame).toBe(45);
	await expect.poll(() => playheadFrame(page)).toBe(45);
	expect((await tool<{ frame: number }>('get_playhead', { projectId })).frame).toBe(45);
	expect((await appliedLabels(page)).length).toBe(history);

	await tool('undo', { projectId });
	expect(await clips(page, ['V2'])).toHaveLength(0);
	expect(await clips(page, ['V1'])).toHaveLength(1);
	await tool('redo', { projectId });
	expect(await clips(page, ['V2'])).toHaveLength(1);
	await testInfo.attach('rendered-project', {
		body: JSON.stringify({ added, moved, clips: await clips(page) }, null, 2),
		contentType: 'application/json',
	});
});

test('with the editor closed the tools apply headlessly; open_project_in_editor brings the project back', async () => {
	const testInfo = test.info();
	await page.getByTestId('home-button').click();
	await expect(page.getByTestId('home')).toBeVisible();
	await expect
		.poll(async () => (await tool<{ editorOpen: boolean }>('get_project', { projectId })).editorOpen)
		.toBe(false);
	const marker = await tool<TxBody>('add_marker', { projectId, at: 90, name: 'Headless marker' });
	expect(marker.appliedBy).toBe('headless');
	const opened = await tool<{ editorOpen: boolean }>('open_project_in_editor', {
		projectId,
		waitSeconds: 30,
	});
	expect(opened.editorOpen).toBe(true);
	await expect(page.getByTestId('editor-shell')).toBeVisible();
	expect(page.url()).toContain(`/project/${projectId}`);
	await expect(
		page.locator('[data-marker-lane] [data-mark="marker"][title*="Headless marker"]').first(),
	).toBeVisible();
	await expect(page.locator('[data-marker-lane] [data-mark="marker"][title*="Agent marker"]')).toHaveCount(1);
	await testInfo.attach('reopened-project', {
		body: JSON.stringify(await tool('get_project', { projectId }), null, 2),
		contentType: 'application/json',
	});
	await testInfo.attach('reopened-editor', { body: await page.screenshot(), contentType: 'image/png' });
});
