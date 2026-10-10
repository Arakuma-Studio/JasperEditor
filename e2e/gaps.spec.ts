// Workstream gaps (docs/wp-notes/gaps.md) in the built app: the accessibility audit (axe-core, WCAG 2.1 A/AA: no
// serious or critical violation in the main workspaces, in the default and the high-contrast theme), the Spanish UI,
// the Warp Stabilizer's background analysis and banner, Essential Graphics (new graphic, layers, align, roll) and
// Auto Reframe Sequence. Screenshots go to test-results/gaps/ for a look.
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

test.describe.configure({ mode: 'default' });

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

/** Reloads the window: the reloaded tab reclaims its own lease at once (polish), so it opens editable. */
async function reloadEditable() {
	await page.reload();
	await expect(page.getByTestId('editor-shell')).toBeVisible();
	await expect(page.getByTestId('banner-read-only')).toHaveCount(0);
}

test.beforeAll(async ({ browser }) => {
	const context = await browser.newContext();
	page = await context.newPage();
	await enableAgentBridge(page);
	projectId = await createProject(page, 'E2E gaps');
	await importFiles(page, ['clip-a.mp4', 'shaky.mp4', 'reframe.mp4']);
});

test.afterAll(async () => {
	await page?.close();
});

test('accessibility: no serious or critical axe violation in the main workspaces', async () => {
	const media = (await query<{ media: { mediaId: string; originalName: string }[] }>(page, 'media.list'))
		.media;
	const a = media.find((m) => m.originalName === 'clip-a.mp4')!.mediaId;
	const r = await transact(page, [
		{ type: 'clip.place', source: { mediaId: a }, at: 0, tracks: { video: 'V1', audio: 'A1' } },
		{ type: 'clip.addText', ref: '$t', at: 10, duration: 60, track: 'V2', content: { text: 'Audit' } },
		{ type: 'marker.add', frame: 20, name: 'Audit marker' },
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	const found: string[] = [];
	const workspaces = ['editing', 'color', 'audio', 'effects', 'motion', 'captions'];
	for (const theme of ['default', 'high-contrast']) {
		if (theme === 'high-contrast') {
			// View ▸ High Contrast applies live (no reload, so the session keeps its lease).
			await runCommand('view.contrast.high');
			await expect(page.locator('html')).toHaveAttribute('data-pr-contrast', 'high');
		}
		for (const ws of workspaces) {
			await page.keyboard.press('Escape');
			await runCommand('workspace.switch', { id: ws });
			await page.waitForTimeout(800);
			found.push(...(await audit(`[${theme}] ${ws}`)));
			await shot(page, `a11y-${theme}-${ws}`);
		}
	}
	expect(found, found.join('\n')).toEqual([]);
});

test('Warp Stabilizer: background analysis stored with the effect, banner while analysing', async () => {
	const media = (await query<{ media: { mediaId: string; originalName: string }[] }>(page, 'media.list'))
		.media;
	const shaky = media.find((m) => m.originalName === 'shaky.mp4')!.mediaId;
	const r = await transact(page, [
		{
			type: 'clip.place',
			source: { mediaId: shaky },
			at: 300,
			tracks: { video: 'V1', audio: 'A1' },
			ref: '$s',
		},
	]);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	const clips = (
		await query<{ clips: { id: string; start: number; kind: string }[] }>(page, 'sequence.clipsInRange', {
			from: 300,
			to: 301,
		})
	).clips;
	const clipId = clips.find((c) => c.kind === 'video')!.id;
	expect(
		(await transact(page, [{ type: 'effect.add', target: { clipId }, effectId: 'jasper.warp-stabilizer' }]))
			.ok,
	).toBe(true);
	await query(page, 'playhead.set', { frame: 340 });
	await expect(page.getByTestId('warp-banner')).toBeVisible({ timeout: 20_000 });
	await shot(page, 'warp-banner');
	// The analysis arrives in the document (one effect instance carries it).
	await expect
		.poll(
			async () => {
				const doc = await query<{
					document?: {
						sequences: Record<
							string,
							{
								clips: Record<
									string,
									{ effects?: { effectId: string; warpAnalysis?: { frames: number[] } }[] }
								>;
							}
						>;
					};
					sequences?: Record<
						string,
						{
							clips: Record<
								string,
								{ effects?: { effectId: string; warpAnalysis?: { frames: number[] } }[] }
							>;
						}
					>;
				}>(page, 'doc.get').catch(() => null);
				const seqs = doc?.document?.sequences ?? doc?.sequences ?? {};
				const clip = Object.values(seqs)
					.map((q) => q.clips[clipId])
					.find(Boolean);
				const fx = clip?.effects?.find((e) => e.effectId === 'jasper.warp-stabilizer');
				return fx?.warpAnalysis?.frames?.length ?? 0;
			},
			{ timeout: 180_000 },
		)
		.toBeGreaterThan(14 * 30);
	await expect(page.getByTestId('warp-banner')).toBeHidden({ timeout: 20_000 });
	await shot(page, 'warp-stabilized');
});

test('Essential Graphics: a new graphic, a second layer, align and roll', async () => {
	await runCommand('panel.focus.essentialGraphics');
	const panel = page.getByTestId('essential-graphics-panel');
	await expect(panel).toBeVisible();
	await panel.getByRole('tab', { name: 'Edit' }).click();
	await page.getByTestId('eg-new-text').click();
	await expect(page.getByTestId('eg-edit')).toBeVisible({ timeout: 15_000 });
	await page.getByTestId('eg-add-rectangle').click();
	const layers = page.locator('[data-testid^="eg-layer-"]');
	await expect(layers).toHaveCount(2);
	await layers.first().click();
	await page.getByTestId('eg-align-left').click();
	await shot(page, 'essential-graphics');
	const doc = await query<{
		document?: { sequences: Record<string, { graphic?: unknown }> };
		sequences?: Record<string, { graphic?: unknown }>;
	}>(page, 'doc.get');
	const seqs = Object.values(doc.document?.sequences ?? doc.sequences ?? {});
	expect(seqs.filter((q) => q.graphic).length).toBeGreaterThanOrEqual(1);
});

test('Auto Reframe Sequence makes a 9:16 copy that follows the subject', async () => {
	const media = (await query<{ media: { mediaId: string; originalName: string }[] }>(page, 'media.list'))
		.media;
	const rf = media.find((m) => m.originalName === 'reframe.mp4')!.mediaId;
	// After everything the earlier specs placed, on V1 (where the analysis looks first).
	const sum = await query<{ sequenceId: string; duration: { frames: number } }>(page, 'sequence.summary');
	const placed = await page.evaluate(
		(tx) =>
			(window as unknown as { jasper: { transact(tx: unknown): Promise<{ ok: boolean }> } }).jasper.transact(
				tx,
			),
		{
			protocol: 'jasper.tx/1',
			label: 'E2E setup',
			sequenceId: sum.sequenceId,
			commands: [
				{
					type: 'clip.place',
					source: { mediaId: rf },
					at: sum.duration.frames + 30,
					tracks: { video: 'V1', audio: 'A1' },
				},
			],
		},
	);
	expect(placed.ok, JSON.stringify(placed)).toBe(true);
	await runCommand('sequence.autoReframe');
	const dialog = page.getByTestId('auto-reframe-dialog');
	await expect(dialog).toBeVisible();
	await shot(page, 'auto-reframe-dialog');
	await dialog.getByRole('button', { name: 'Create' }).click();
	await expect(dialog).toBeHidden({ timeout: 240_000 });
	const s = await query<{ settings: { width: number; height: number } }>(page, 'sequence.summary');
	expect(s.settings.height).toBeGreaterThan(s.settings.width);
	await shot(page, 'auto-reframe-result');
});

test('Spanish UI after a restart', async () => {
	await page.evaluate(() => {
		const raw = localStorage.getItem('jasper:gaps-prefs');
		const p = raw ? JSON.parse(raw) : {};
		localStorage.setItem(
			'jasper:gaps-prefs',
			JSON.stringify({ ...p, appearance: { ...(p.appearance ?? {}), language: 'es' } }),
		);
	});
	await reloadEditable();
	await expect(page.locator('html')).toHaveAttribute('lang', 'es');
	await expect(
		page.getByRole('menuitem', { name: 'Archivo' }).or(page.getByText('Archivo').first()),
	).toBeVisible();
	await runCommand('panel.focus.effects');
	await page.waitForTimeout(500);
	await shot(page, 'spanish');
	// Back to English for the following specs.
	await page.evaluate(() => {
		const p = JSON.parse(localStorage.getItem('jasper:gaps-prefs') ?? '{}');
		localStorage.setItem(
			'jasper:gaps-prefs',
			JSON.stringify({ ...p, appearance: { ...(p.appearance ?? {}), language: 'en' } }),
		);
	});
});
