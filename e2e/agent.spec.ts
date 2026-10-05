// External agent scenario (ARCHITECTURE §11, §15 item 10): an MCP client drives the editor through the
// built `jasper-mcp` stdio server (apps/mcp/dist/jasper-mcp.mjs), exactly as Claude Code, Codex CLI or Cursor
// would. With the editor open its edits apply live through the session (one "Agent: …" History entry, the
// timeline and ruler update); destructive transactions wait for Approve / Deny on the shell's approval
// card; `open_project_in_editor` navigates the window; with the editor closed the same tools apply
// headlessly and the result shows up when the project is reopened. There is no Agent panel.
import { existsSync, writeFileSync } from 'node:fs';
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
	sequenceSummary,
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
type ToolFailure = { error: { code: string; message: string; hint?: string } };

const text = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
	return (await mcp.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as CallToolResult;
}
/** Calls a tool that must succeed and returns its JSON body. */
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

test('the MCP server finds the running engine and sees the open editor', async () => {
	const status = await tool<{ engine: { url: string; foundBy: string }; agentName: string }>('engine_status');
	expect(status.engine).toMatchObject({
		url: `http://127.0.0.1:${serverInfo().port}`,
		foundBy: 'runtime-file',
	});
	expect(status.agentName).toBe('e2e-agent');
	const project = await tool<{ projectId: string; editorOpen: boolean; media: { name: string }[] }>(
		'get_project',
		{ projectId },
	);
	// Live: the summary comes from the open editor, including the media imported through the UI.
	expect(project.editorOpen).toBe(true);
	expect(project.media.map((m) => m.name)).toContain('clip-b.mp4');
});

test('apply_commands with the editor open places a clip and a marker live, as one "Agent:" History entry', async () => {
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

	// The UI reflects it: a clip body in the timeline, a marker in the ruler, "Agent: …" in History.
	const placed = await clips(page, ['V1']);
	expect(placed).toHaveLength(1);
	expect(body.created).toContain(placed[0]!.id);
	await expect(
		page.locator(`[data-testid="timeline-track-area"] [data-clip-id="${placed[0]!.id}"]`),
	).toBeVisible();
	await expect(page.locator('[data-marker-lane] [data-mark="marker"]')).toHaveCount(1);
	await expect(page.locator('[data-marker-lane] [data-mark="marker"]').first()).toHaveAttribute(
		'title',
		/Agent marker/,
	);
	const labels = await appliedLabels(page);
	expect(labels).toHaveLength(before + 1);
	expect(labels.at(-1)).toBe('Agent: Place clip-b and mark it');
	await page.getByTestId('tab-history').click();
	await expect(page.getByTestId('history-list')).toContainText('Agent: Place clip-b and mark it');
	// The shell tells the user what the agent did (there is no Agent panel to look at).
	await expect(page.locator('[data-testid="toast"][data-kind="agent"]')).toContainText(
		'Agent: Place clip-b and mark it',
	);
	await page.screenshot({ path: 'test-results/e2e-agent-live.png' });
});

test('helper tools, get_timeline, set_playhead and undo work against the live editor', async () => {
	const added = await tool<TxBody & { clips: { id: string; track: string; start: number }[] }>('add_text', {
		projectId,
		text: 'Hello from MCP',
		at: { seconds: 1 },
		duration: { seconds: 2 },
		track: 'V2',
	});
	expect(added.appliedLive).toBe(true);
	expect(await clips(page, ['V2'])).toHaveLength(1);

	const table = text(await call('get_timeline', { projectId }));
	expect(table).toContain('clip-b.mp4');
	expect(table).toContain('Hello from MCP');
	expect(table).toContain('Agent marker');

	// The agent can look at the result: the Program output of the live (unsaved) document as a PNG.
	const frame = await call('render_frame', { projectId, at: { seconds: 2 }, width: 320 });
	expect(frame.isError, text(frame)).toBeFalsy();
	const image = frame.content.find((c) => c.type === 'image') as { data: string; mimeType: string };
	expect(image.mimeType).toBe('image/png');
	const png = Buffer.from(image.data, 'base64');
	expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
	expect(png.readUInt32BE(16)).toBe(320);
	writeFileSync('test-results/e2e-agent-frame.png', png);

	// A view change, not an edit: the playhead moves in the window, History does not grow.
	const history = (await appliedLabels(page)).length;
	const moved = await tool<{ frame: number; timecode: string }>('set_playhead', {
		projectId,
		at: '00:00:01:15',
	});
	expect(moved.frame).toBe(45);
	await expect.poll(() => playheadFrame(page)).toBe(45);
	expect((await tool<{ frame: number }>('get_playhead', { projectId })).frame).toBe(45);
	expect((await appliedLabels(page)).length).toBe(history);

	// Undo removes the agent's own last entry (the text clip), and only that.
	await tool('undo', { projectId });
	expect(await clips(page, ['V2'])).toHaveLength(0);
	expect(await clips(page, ['V1'])).toHaveLength(1);
	await tool('redo', { projectId });
	expect(await clips(page, ['V2'])).toHaveLength(1);
});

test('a destructive transaction waits for the approval card; Deny rejects it, Approve applies it', async () => {
	const a3 = (await sequenceSummary(page)).tracks!.find((t) => t.label === 'A3')!;
	const remove = () =>
		call('apply_commands', {
			projectId,
			label: 'Remove A3',
			commands: [{ type: 'track.remove', trackIds: [a3.id] }],
		});

	const denied = remove();
	// The request shows up at the top of the editor window, whatever panel is in front.
	const card = page.getByTestId('agent-approval-card');
	await expect(card).toBeVisible({ timeout: 20_000 });
	await expect(card).toContainText('Agent request: Remove A3');
	await card.getByRole('button', { name: 'Deny' }).click();
	const r = await denied;
	expect(r.isError).toBe(true);
	const failure = JSON.parse(text(r)) as ToolFailure;
	expect(failure.error.code).toBe('E_APPROVAL_DENIED');
	await expect(card).toHaveCount(0);
	expect((await sequenceSummary(page)).tracks!.some((t) => t.id === a3.id)).toBe(true);

	const approved = remove();
	await expect(card).toBeVisible({ timeout: 20_000 });
	await card.getByRole('button', { name: 'Approve' }).click();
	const ok = await approved;
	expect(ok.isError, text(ok)).toBeFalsy();
	expect(JSON.parse(text(ok))).toMatchObject({ ok: true, appliedLive: true });
	await expect(card).toHaveCount(0);
	expect((await sequenceSummary(page)).tracks!.some((t) => t.id === a3.id)).toBe(false);
	expect((await appliedLabels(page)).at(-1)).toBe('Agent: Remove A3');
});

test('Help ▸ Connect an AI Agent… shows configuration with the real path of jasper-mcp', async () => {
	await page.getByTestId('title-bar').getByRole('menuitem', { name: 'Help', exact: true }).click();
	await page.getByRole('menuitem', { name: /Connect an AI Agent/ }).click();
	const dialog = page.getByTestId('connect-agent-dialog');
	await expect(dialog).toBeVisible();
	// The engine reports where its sibling bundle lives; the snippets are ready to paste.
	await expect(page.getByTestId('agent-snippet-claude-cli')).toContainText(
		`claude mcp add jasper -- node ${MCP_BUNDLE}`,
	);
	await expect(page.getByTestId('agent-snippet-codex-toml')).toContainText('[mcp_servers.jasper]');
	await expect(page.getByTestId('agent-snippet-codex-toml')).toContainText(MCP_BUNDLE);
	await expect(page.getByTestId('agent-snippet-cursor-json')).toContainText('"mcpServers"');
	// This engine has no token, so its Streamable HTTP endpoint is offered too.
	await expect(page.getByTestId('agent-snippet-claude-http')).toContainText(
		`http://127.0.0.1:${serverInfo().port}/mcp`,
	);
	await expect(page.getByTestId('connect-agent-missing')).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
});

test('with the editor closed the tools apply headlessly; open_project_in_editor brings the project back', async () => {
	// Leave the editor (releases the lease and disconnects the relay).
	await page.getByTestId('home-button').click();
	await expect(page.getByTestId('home')).toBeVisible();
	await expect
		.poll(async () => {
			const r = await call('add_marker', { projectId, at: 90, name: 'Headless marker' });
			if (r.isError) return `rejected: ${(JSON.parse(text(r)) as ToolFailure).error.code}`;
			const body = JSON.parse(text(r)) as TxBody;
			// A marker added while the editor was still closing would be live: undo is not needed, just retry.
			return body.appliedBy;
		})
		.toBe('headless');
	// Destructive changes need someone to approve them: without an editor they are refused.
	const refused = await call('apply_commands', {
		projectId,
		label: 'Remove V3',
		commands: [{ type: 'track.remove', trackIds: ['V3'] }],
	});
	expect(refused.isError).toBe(true);
	expect((JSON.parse(text(refused)) as ToolFailure).error.code).toBe('E_APPROVAL_DENIED');

	// The window is on Home; the agent asks it to open the project.
	const opened = await tool<{ editorOpen: boolean; editorWindowsNotified: number }>(
		'open_project_in_editor',
		{
			projectId,
			waitSeconds: 30,
		},
	);
	expect(opened.editorWindowsNotified).toBeGreaterThanOrEqual(1);
	expect(opened.editorOpen).toBe(true);
	await expect(page.getByTestId('editor-shell')).toBeVisible();
	expect(page.url()).toContain(`/project/${projectId}`);
	await expect(
		page.locator('[data-marker-lane] [data-mark="marker"][title*="Headless marker"]').first(),
	).toBeVisible();
	await expect(page.locator('[data-marker-lane] [data-mark="marker"][title*="Agent marker"]')).toHaveCount(1);
});
