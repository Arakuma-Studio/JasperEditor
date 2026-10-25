// Automation IDs must survive reordering: data-testid, entity IDs, or unique scope/role/name paths.
// Positional "#n" IDs cannot identify controls reliably (EffectCraft's ui_agent_audit contract).
import { expect, type Page, test } from '@playwright/test';
import {
	createProject,
	enableAgentBridge,
	expectTransaction,
	importFiles,
	query,
	serverInfo,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

let page: Page;
let projectId = '';
let textId = '';

type El = {
	id: string;
	stable: boolean;
	role: string;
	name: string;
	panel: string | null;
	tag: string;
	className?: string;
};

async function ui<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
	const { port } = serverInfo();
	const r = await page.request.post(`http://127.0.0.1:${port}/api/agent/ui`, {
		data: { projectId, action, args },
	});
	const body = await r.json();
	expect(r.ok(), `${action} ${JSON.stringify(args)}: ${JSON.stringify(body)}`).toBe(true);
	return body.result as T;
}

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
	projectId = await createProject(page, 'E2E UI audit');
	await importFiles(page, ['clip-a.mp4']);
	const media = (await query<{ media: { mediaId: string; originalName: string }[] }>(page, 'media.list'))
		.media;
	const a = media.find((m) => m.originalName === 'clip-a.mp4')!.mediaId;
	// Content for selection-driven panels: footage, a title with an effect and keyframes, and a marker.
	// Select the title so Effect Controls, Properties and Lumetri show their controls.
	const r = await transact(page, [
		{ type: 'clip.place', source: { mediaId: a }, at: 0, tracks: { video: 'V1', audio: 'A1' } },
		{ type: 'clip.addText', ref: '$t', at: 10, duration: 60, track: 'V2', content: { text: 'Audit' } },
		{ type: 'effect.add', target: { clipId: '$t' }, effectId: 'jasper.gaussian-blur', params: { radius: 4 } },
		{ type: 'keyframe.add', target: ['clip', '$t', 'opacity'], at: { sequenceFrame: 10 }, value: 0 },
		{ type: 'keyframe.add', target: ['clip', '$t', 'opacity'], at: { sequenceFrame: 40 }, value: 100 },
		{ type: 'marker.add', frame: 20, name: 'Audit marker' },
	]);
	expectTransaction(r);
	textId = r.refs.$t!;
});

test.afterAll(async () => {
	await page?.close();
});

const observed: { where: string; elements: El[] }[] = [];
async function gaps(where: string, panel?: string): Promise<string[]> {
	const r = await ui<{ elements: El[] }>('elements', { ...(panel ? { panel } : {}), limit: 2000 });
	observed.push({ where, elements: r.elements });
	return r.elements
		.filter((e) => !e.stable)
		.filter((e) => (panel ? true : e.panel === null))
		.map(
			(e) =>
				`${where}: ${e.id} (${e.tag}, role ${e.role}${e.name ? `, "${e.name}"` : ''}${e.className ? `, class "${e.className}"` : ''})`,
		);
}

test('every panel and every workspace chrome has stable automation ids', async () => {
	const state = await ui<{ workspace: { id: string; available: string[] } }>('state');
	const found = new Set<string>();
	const seenPanels = new Set<string>();
	for (const ws of state.workspace.available) {
		await ui('command', { id: 'workspace.switch', args: { id: ws } });
		await expect(page.getByTestId('panel-loading').filter({ visible: true })).toHaveCount(0);
		await ui('click', { timeline: { clipId: textId } }).catch(() => undefined);
		for (const g of await gaps(`[${ws}] chrome`)) found.add(g);
		const panels = (await ui<{ panels: { kind: string; instanceId: string }[] }>('state')).panels;
		for (const p of panels) {
			// Maximize and audit each panel once; workspace-specific chrome is checked above.
			if (seenPanels.has(p.kind)) continue;
			seenPanels.add(p.kind);
			await ui('command', { id: `panel.focus.${p.kind}` });
			await ui('command', { id: 'panel.maximize' }).catch(() => undefined);
			await expect(page.getByTestId('panel-loading').filter({ visible: true })).toHaveCount(0);
			for (const g of await gaps(`[${ws}] ${p.kind}`, p.instanceId)) found.add(g);
			await ui('command', { id: 'panel.maximize' }).catch(() => undefined);
		}
	}
	// Panels no workspace shows by default are opened from the Window menu.
	await ui('command', { id: 'workspace.switch', args: { id: 'editing' } });
	const kinds = (await ui<{ commands: { id: string }[] }>('commands', { filter: 'panel.focus.' })).commands
		.map((c) => c.id.slice('panel.focus.'.length))
		.filter((k) => !seenPanels.has(k));
	for (const kind of kinds) {
		await ui('command', { id: `panel.focus.${kind}` });
		await expect(page.getByTestId('panel-loading').filter({ visible: true })).toHaveCount(0);
		for (const g of await gaps(`[window menu] ${kind}`, kind)) found.add(g);
	}
	const chrome = await ui<{ elements: El[] }>('elements', { limit: 2000 });
	const menus = chrome.elements.filter((e) => e.panel === null && e.id.startsWith('menubar/'));
	// A real editor menu must be discoverable; an empty response cannot satisfy the audit.
	expect(menus.find((m) => m.role === 'menuitem' && m.name === 'File')).toMatchObject({ stable: true });
	for (const m of menus) {
		await ui('click', { id: m.id });
		for (const g of await gaps(`[menu ${m.id}]`)) found.add(g);
		await ui('key', { key: 'Escape' });
	}
	const clips = await query<{ clips: { id: string }[] }>(page, 'sequence.clipsInRange', { from: 0, to: 200 });
	await ui('click', { timeline: { clipId: clips.clips[0]!.id }, button: 'right' });
	for (const g of await gaps('[clip context menu]')) found.add(g);
	await ui('key', { key: 'Escape' });
	await test.info().attach('automation-addresses', {
		body: JSON.stringify(observed, null, 2),
		contentType: 'application/json',
	});
	expect([...found], `${found.size} interactive elements without a stable automation id`).toEqual([]);
});
