// Security review AGT-1 in the real app (docs/security-review.md): an agent on the MCP tools cannot approve its own
// destructive request with the live-UI tools, cannot make the same edit through the UI, and cannot clear the undo
// history; the user's own click still approves.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { expect, type Page, test } from '@playwright/test';
import { createProject, enableAgentBridge, ROOT, sequenceSummary, serverInfo } from './support.ts';

test.describe.configure({ mode: 'serial' });

const MCP_BUNDLE = join(ROOT, 'apps/mcp/dist/jasper-mcp.mjs');
let page: Page;
let projectId = '';
let mcp: Client;

const text = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
const call = async (name: string, args: Record<string, unknown> = {}) =>
	(await mcp.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as CallToolResult;

test.beforeAll(async ({ browser }) => {
	expect(existsSync(MCP_BUNDLE), `${MCP_BUNDLE} is missing: run \`pnpm mcp:build\``).toBe(true);
	page = await browser.newPage();
	await enableAgentBridge(page);
	projectId = await createProject(page, 'E2E Security Review');
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env))
		if (v !== undefined && !k.startsWith('JASPER_')) env[k] = v;
	mcp = new Client({ name: 'e2e-review', version: '1.0.0' });
	await mcp.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [MCP_BUNDLE, '--appdir', serverInfo().appdir],
			env,
			stderr: 'pipe',
		}),
	);
});

test.afterAll(async () => {
	await mcp?.close().catch(() => {});
	await page?.close();
});

test('an agent cannot approve its own request through the UI tools; the user can', async () => {
	const a3 = (await sequenceSummary(page)).tracks!.find((t) => t.label === 'A3')!;
	const pending = call('apply_commands', {
		projectId,
		label: 'Remove A3',
		commands: [{ type: 'track.remove', trackIds: [a3.id] }],
	});
	const card = page.getByTestId('agent-approval-card');
	await expect(card).toBeVisible({ timeout: 20_000 });
	// The agent clicks Approve with the live-UI tool: the click arrives (the tool succeeds), nothing is approved.
	const click = await call('ui_click', { projectId, id: 'agent-approval-approve' });
	expect(click.isError, text(click)).toBeFalsy();
	await page.waitForTimeout(500);
	await expect(card).toBeVisible();
	expect((await sequenceSummary(page)).tracks!.some((t) => t.id === a3.id)).toBe(true);
	// The user's own click approves.
	await card.getByRole('button', { name: 'Approve' }).click();
	const ok = await pending;
	expect(ok.isError, text(ok)).toBeFalsy();
	expect((await sequenceSummary(page)).tracks!.some((t) => t.id === a3.id)).toBe(false);
});

test('an agent cannot clear the undo history through ui_command', async () => {
	const before = await page.evaluate(() =>
		(window as unknown as { jasper: { query(n: string, a: unknown): Promise<unknown> } }).jasper.query(
			'history.list',
			{},
		),
	);
	const r = await call('ui_command', { projectId, id: 'history.clear', args: { confirmed: true } });
	const body = text(r);
	expect(r.isError || /"ran":\s*false/.test(body), body).toBeTruthy();
	const after = await page.evaluate(() =>
		(window as unknown as { jasper: { query(n: string, a: unknown): Promise<unknown> } }).jasper.query(
			'history.list',
			{},
		),
	);
	expect(JSON.stringify(after)).toBe(JSON.stringify(before));
	expect(JSON.stringify(after)).toContain('Remove A3');
});
