import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import {
	createProject,
	enableAgentBridge,
	importFiles,
	query,
	ROOT,
	serverInfo,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

const SHOTS = join(ROOT, 'test-results', 'gaps');
mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });

let page: Page;

type Violation = {
	id: string;
	impact?: string | null;
	help: string;
	nodes: {
		target: unknown[];
		html: string;
		any?: { relatedNodes?: { html: string }[] }[];
		all?: { relatedNodes?: { html: string }[] }[];
		none?: { relatedNodes?: { html: string }[] }[];
	}[];
};

async function audit(where: string): Promise<string[]> {
	const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
	return (r.violations as Violation[])
		.filter((v) => v.impact === 'serious' || v.impact === 'critical')
		.map(
			(v) =>
				`${where}: ${v.id} (${v.impact}) ${v.help} — ${v.nodes.length} nodes, e.g. ${v.nodes
					.slice(0, 3)
					.map(
						(n) =>
							`${JSON.stringify(n.target)} ${n.html.slice(0, 120)}${[
								...(n.any ?? []),
								...(n.all ?? []),
								...(n.none ?? []),
							]
								.flatMap((c) => c.relatedNodes ?? [])
								.slice(0, 2)
								.map((r) => ` ⟶ ${r.html.slice(0, 160)}`)
								.join('')}`,
					)
					.join(' | ')}`,
		);
}

let projectId = '';
/** Live-UI automation of this window through the engine (the path agents use, POST /api/agent/ui). */
async function ui<T = unknown>(action: string, args: Record<string, unknown> = {}): Promise<T> {
	const { port } = serverInfo();
	const r = await page.request.post(`http://127.0.0.1:${port}/api/agent/ui`, {
		data: { projectId, action, args },
	});
	const body = await r.json();
	expect(r.ok(), `${action} ${JSON.stringify(args)}: ${JSON.stringify(body)}`).toBe(true);
	return body.result as T;
}
const runCommand = (id: string, args?: unknown) => ui('command', { id, ...(args ? { args } : {}) });

test.beforeAll(async ({ browser }) => {
	const context = await browser.newContext();
	page = await context.newPage();
	await enableAgentBridge(page);
	projectId = await createProject(page, 'E2E gaps');
	await importFiles(page, ['clip-a.mp4']);
	const media = (await query<{ media: { mediaId: string; originalName: string }[] }>(page, 'media.list'))
		.media;
	const a = media.find((m) => m.originalName === 'clip-a.mp4')!.mediaId;
	const r = await transact(page, [
		{ type: 'clip.place', source: { mediaId: a }, at: 0, tracks: { video: 'V1', audio: 'A1' } },
		{ type: 'clip.addText', ref: '$t', at: 10, duration: 60, track: 'V2', content: { text: 'Audit' } },
		{ type: 'marker.add', frame: 20, name: 'Audit marker' },
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
});

test.afterAll(async () => {
	await page?.close();
});

const workspaces = ['editing', 'color', 'audio', 'effects', 'motion', 'captions'];
for (const theme of ['default', 'high-contrast']) {
	for (const ws of workspaces) {
		test(`accessibility: [${theme}] ${ws} has no serious or critical axe violations`, async () => {
			const testInfo = test.info();
			if (theme === 'high-contrast' && ws === 'editing') {
				// View ▸ High Contrast applies live (no reload, so the session keeps its lease).
				await runCommand('view.contrast.high');
				await expect(page.locator('html')).toHaveAttribute('data-pr-contrast', 'high');
			}
			await page.keyboard.press('Escape');
			await runCommand('workspace.switch', { id: ws });
			await page.waitForTimeout(800);
			const violations = await audit(`[${theme}] ${ws}`);
			await testInfo.attach(`axe-${theme}-${ws}`, {
				body: JSON.stringify(violations, null, 2),
				contentType: 'application/json',
			});
			await shot(page, `a11y-${theme}-${ws}`);
			await testInfo.attach(`workspace-${theme}-${ws}`, {
				path: join(SHOTS, `a11y-${theme}-${ws}.png`),
				contentType: 'image/png',
			});
			expect(violations, violations.join('\n')).toEqual([]);
		});
	}
}
