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

test('only a trusted user can approve a destructive agent request; denial preserves the track', async () => {
	const testInfo = test.info();
	const a3 = (await sequenceSummary(page)).tracks!.find((t) => t.label === 'A3')!;
	const remove = () =>
		call('apply_commands', {
			projectId,
			label: 'Remove A3',
			commands: [{ type: 'track.remove', trackIds: [a3.id] }],
		});
	const pending = remove();
	const card = page.getByTestId('agent-approval-card');
	await expect(card).toBeVisible({ timeout: 20_000 });
	const click = await call('ui_click', { projectId, id: 'agent-approval-approve' });
	expect(click.isError, text(click)).toBeFalsy();
	await expect(card).toBeVisible();
	expect((await sequenceSummary(page)).tracks!.some((t) => t.id === a3.id)).toBe(true);
	await testInfo.attach('untrusted-approval-blocked', {
		body: await card.screenshot(),
		contentType: 'image/png',
	});
	await card.getByRole('button', { name: 'Deny' }).click();
	const denied = await pending;
	expect(denied.isError).toBe(true);
	expect(JSON.parse(text(denied))).toMatchObject({ error: { code: 'E_APPROVAL_DENIED' } });
	expect((await sequenceSummary(page)).tracks!.some((t) => t.id === a3.id)).toBe(true);

	const approved = remove();
	await expect(card).toBeVisible({ timeout: 20_000 });
	await card.getByRole('button', { name: 'Approve' }).click();
	const ok = await approved;
	expect(ok.isError, text(ok)).toBeFalsy();
	expect((await sequenceSummary(page)).tracks!.some((t) => t.id === a3.id)).toBe(false);
	await testInfo.attach('approval-results', {
		body: JSON.stringify({ denied, approved: ok, tracks: (await sequenceSummary(page)).tracks }, null, 2),
		contentType: 'application/json',
	});
});
