import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
	const click = await call('ui_click', { projectId, id: 'agent-approval-approve' });
	expect(click.isError, text(click)).toBeFalsy();
	await page.waitForTimeout(500);
	await expect(card).toBeVisible();
	expect((await sequenceSummary(page)).tracks!.some((t) => t.id === a3.id)).toBe(true);
	await card.getByRole('button', { name: 'Approve' }).click();
	const ok = await pending;
	expect(ok.isError, text(ok)).toBeFalsy();
	expect((await sequenceSummary(page)).tracks!.some((t) => t.id === a3.id)).toBe(false);
});

test('an agent cannot clear the undo history through ui_command', async () => {
	const before = await page.evaluate(() => window.jasper!.query('history.list', {}));
	const r = await call('ui_command', { projectId, id: 'history.clear', args: { confirmed: true } });
	const body = text(r);
	expect(r.isError || /"ran":\s*false/.test(body), body).toBeTruthy();
	const after = await page.evaluate(() => window.jasper!.query('history.list', {}));
	expect(JSON.stringify(after)).toBe(JSON.stringify(before));
	expect(JSON.stringify(after)).toContain('Remove A3');
});

type Preset = { id: string; name: string };
const userPresets = async (): Promise<Preset[]> => {
	const r = await call('list_effect_presets', { builtIn: false });
	expect(r.isError, text(r)).toBeFalsy();
	return (JSON.parse(text(r)) as { presets: Preset[] }).presets;
};

/** A client that holds what an agent can get: the engine token from the runtime file, nothing else. */
async function tokenHolderSocket(): Promise<{
	welcome: { editor?: boolean };
	send(event: string, payload: unknown): void;
	received: { event?: string }[];
	close(): void;
}> {
	const { port, appdir } = serverInfo();
	const runtime = JSON.parse(readFileSync(join(appdir, 'engine', 'runtime.json'), 'utf8')) as {
		token: string;
	};
	const WS = createRequire(join(ROOT, 'apps/engine/package.json'))('ws') as new (
		url: string,
		opts: { headers: Record<string, string> },
	) => {
		on(event: string, cb: (data: unknown) => void): void;
		send(data: string): void;
		close(): void;
	};
	const ws = new WS(`ws://127.0.0.1:${port}/agent`, {
		headers: { authorization: `Bearer ${runtime.token}` },
	});
	const received: { type?: string; event?: string; editor?: boolean }[] = [];
	ws.on('message', (d) => received.push(JSON.parse(String(d))));
	await new Promise<void>((resolve, reject) => {
		ws.on('open', () => resolve());
		ws.on('error', (e) => reject(e as Error));
	});
	ws.send(JSON.stringify({ type: 'hello', projectId, sessionId: 'ses_e2e_rogue', leaseId: null }));
	await expect.poll(() => received.some((m) => m.type === 'welcome')).toBe(true);
	return {
		welcome: received.find((m) => m.type === 'welcome')!,
		send: (event, payload) => ws.send(JSON.stringify({ type: 'event', event, payload })),
		received,
		close: () => ws.close(),
	};
}

test('AGT-3 / AGT-2: an agent deleting a preset asks the user, and only the editor window can answer', async () => {
	const builtin = JSON.parse(text(await call('get_effect_preset', { presetId: 'builtin.fade-in' }))) as {
		preset?: Record<string, unknown>;
	} & Record<string, unknown>;
	const saved = await call('save_effect_preset', {
		name: 'E2E hardening',
		preset: builtin.preset ?? builtin,
	});
	expect(saved.isError, text(saved)).toBeFalsy();
	const preset = (await userPresets()).find((p) => p.name === 'E2E hardening')!;
	expect(preset, 'the preset was saved').toBeTruthy();

	const pending = call('delete_effect_preset', { presetId: preset.id });
	const card = page.getByTestId('agent-approval-card');
	await expect(card).toBeVisible({ timeout: 20_000 });
	await expect(card).toContainText('Delete effect preset');
	await expect(page.getByTestId('agent-approval-summary')).toContainText(
		'e2e-review wants to delete the preset "E2E hardening" from your preset library',
	);
	const approvalId = (await card.getAttribute('data-approval-id'))!;
	await card.screenshot({ path: 'test-results/e2e-hardening-approval-card.png' });

	// The engine token is available to local clients; it must not authorize answering approvals.
	const rogue = await tokenHolderSocket();
	expect(rogue.welcome.editor).toBe(false);
	rogue.send('agent.approval.resolve', { approvalId, decision: 'approved' });
	rogue.send('agent.approval.resolve', { approvalId, decision: 'approved', answerKey: 'guess' });
	rogue.send('agent.approval.resolve', { approvalId, decision: 'denied', answerKey: approvalId });
	const click = await call('ui_click', { projectId, id: 'agent-approval-approve' });
	expect(click.isError, text(click)).toBeFalsy();
	await page.waitForTimeout(700);
	await expect(card).toBeVisible();
	// The token-holding connection was never shown the card (so it has no answer key to present).
	expect(rogue.received.some((m) => m.event === 'agent.approval.requested')).toBe(false);
	expect((await userPresets()).some((p) => p.id === preset.id)).toBe(true);
	rogue.close();

	await card.getByRole('button', { name: 'Deny' }).click();
	const denied = await pending;
	expect(denied.isError).toBeTruthy();
	expect(text(denied)).toContain('E_APPROVAL_DENIED');
	expect((await userPresets()).some((p) => p.id === preset.id)).toBe(true);

	const again = call('delete_effect_preset', { presetId: preset.id });
	await expect(card).toBeVisible({ timeout: 20_000 });
	await card.getByRole('button', { name: 'Approve' }).click();
	const done = await again;
	expect(done.isError, text(done)).toBeFalsy();
	expect((await userPresets()).some((p) => p.id === preset.id)).toBe(false);
});

test('DEV-1: the engine refuses requests without its token; the page is the editor through HttpOnly cookies', async () => {
	const { port } = serverInfo();
	// Node's own fetch: no cookie, no token.
	expect((await fetch(`http://127.0.0.1:${port}/api/projects`)).status).toBe(401);
	expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
	expect(await page.evaluate(() => fetch('/api/projects').then((r) => r.status))).toBe(200);
	expect(await page.evaluate(() => document.cookie)).not.toMatch(/jasper_(session|editor)/);
	const cookies = await page.context().cookies();
	for (const name of [`jasper_session_${port}`, `jasper_editor_${port}`]) {
		const c = cookies.find((x) => x.name === name);
		expect(c, name).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
	}
});
