// mcp-cli §4 audit (EffectCraft's ui_agent_audit, for the web shell): every interactive element of every panel,
// in every workspace, has a stable automation id (a unique data-testid, an entity id such as
// timeline.clip.<id>, or a unique "<scope>/<role>[<accessible name>]"). Opens each workspace, focuses and
// maximizes each of its panels, and asks the live window for its elements through POST /api/agent/ui, the
// same path agents use. Fails with the list of elements that only have a positional "#n" id or no name.
import { expect, type Page, test } from '@playwright/test';
import { createProject, enableAgentBridge, importFiles, query, serverInfo, transact } from './support.ts';

test.describe.configure({ mode: 'serial' });

let page: Page;
let projectId = '';

type El = {
	id: string;
	stable: boolean;
	role: string;
	name: string;
	panel: string | null;
	tag: string;
	kind: string;
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
	await importFiles(page, ['clip-a.mp4', 'clip-b.mp4']);
	const media = (await query<{ media: { mediaId: string; originalName: string }[] }>(page, 'media.list'))
		.media;
	const a = media.find((m) => m.originalName === 'clip-a.mp4')!.mediaId;
	const b = media.find((m) => m.originalName === 'clip-b.mp4')!.mediaId;
	// Content for selection-driven panels: two clips with a transition, a title with an effect and keyframes,
	// a marker; the title is selected so Effect Controls, Properties and Lumetri show their controls.
	const r = await transact(page, [
		{ type: 'clip.place', source: { mediaId: a }, at: 0, tracks: { video: 'V1', audio: 'A1' } },
		{ type: 'clip.place', source: { mediaId: b }, at: 60, tracks: { video: 'V1', audio: 'A1' } },
		{ type: 'clip.addText', ref: '$t', at: 10, duration: 60, track: 'V2', content: { text: 'Audit' } },
		{ type: 'effect.add', target: { clipId: '$t' }, effectId: 'jasper.gaussian-blur', params: { radius: 4 } },
		{ type: 'keyframe.add', target: ['clip', '$t', 'opacity'], at: { sequenceFrame: 10 }, value: 0 },
		{ type: 'keyframe.add', target: ['clip', '$t', 'opacity'], at: { sequenceFrame: 40 }, value: 100 },
		{ type: 'marker.add', frame: 20, name: 'Audit marker' },
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
});

test.afterAll(async () => {
	await page?.close();
});

/** Elements without a stable id in what is on screen now (optionally one panel). */
const checked = new Map<string, number>();
async function gaps(where: string, panel?: string): Promise<string[]> {
	const r = await ui<{ elements: El[] }>('elements', { ...(panel ? { panel } : {}), limit: 2000 });
	const kind = panel ? (r.elements[0]?.panel ?? panel) : 'chrome';
	checked.set(kind, Math.max(checked.get(kind) ?? 0, r.elements.length));
	return r.elements
		.filter((e) => !e.stable)
		.filter((e) => (panel ? true : e.panel === null))
		.map(
			(e) =>
				`${where}: ${e.id} (${e.tag}, role ${e.role}${e.name ? `, "${e.name}"` : ''}${e.className ? `, class "${e.className}"` : ''})`,
		);
}

test('every interactive element of every panel in every workspace has a stable automation id', async () => {
	const state = await ui<{ workspace: { id: string; available: string[] } }>('state');
	const found = new Set<string>();
	const seenPanels = new Set<string>();
	// Select the title (Effect Controls, Properties and Lumetri then show their controls).
	const select = async () => {
		const clips = await query<{ clips: { id: string; kind: string }[] }>(page, 'sequence.clipsInRange', {
			from: 0,
			to: 200,
		});
		const text = clips.clips.find((c) => c.kind === 'text');
		if (text) await ui('click', { timeline: { clipId: text.id } });
	};
	for (const ws of state.workspace.available) {
		await ui('command', { id: 'workspace.switch', args: { id: ws } });
		await page.waitForTimeout(400);
		await select().catch(() => undefined);
		for (const g of await gaps(`[${ws}] chrome`)) found.add(g);
		const panels = (await ui<{ panels: { kind: string; instanceId: string }[] }>('state')).panels;
		for (const p of panels) {
			seenPanels.add(p.kind);
			await ui('command', { id: `panel.focus.${p.kind}` });
			await ui('command', { id: 'panel.maximize' }).catch(() => undefined);
			await page.waitForTimeout(250);
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
		await page.waitForTimeout(300);
		for (const g of await gaps(`[window menu] ${kind}`, kind)) found.add(g);
	}
	// The menu bar menus and the timeline clip context menu.
	const chrome = await ui<{ elements: El[] }>('elements', { limit: 2000 });
	const menus = chrome.elements.filter((e) => e.panel === null && e.id.startsWith('menubar/'));
	expect(
		menus.length,
		JSON.stringify(chrome.elements.filter((e) => e.panel === null).map((e) => e.id)),
	).toBeGreaterThan(5);
	for (const m of menus) {
		await ui('click', { id: m.id });
		for (const g of await gaps(`[menu ${m.id}]`)) found.add(g);
		await ui('key', { key: 'Escape' });
	}
	const clips = await query<{ clips: { id: string }[] }>(page, 'sequence.clipsInRange', { from: 0, to: 200 });
	await ui('click', { timeline: { clipId: clips.clips[0]!.id }, button: 'right' });
	for (const g of await gaps('[clip context menu]')) found.add(g);
	await ui('key', { key: 'Escape' });
	expect([...found], `${found.size} interactive elements without a stable automation id`).toEqual([]);
	// The audit looked at real content: the selected title's controls, the clips, the header and menus.
	const total = [...checked.values()].reduce((a, b) => a + b, 0);
	expect(total, JSON.stringify(Object.fromEntries(checked))).toBeGreaterThan(400);
	expect(checked.get('effectControls') ?? 0, JSON.stringify(Object.fromEntries(checked))).toBeGreaterThan(15);
	expect(checked.get('timeline') ?? 0).toBeGreaterThan(30);
});
