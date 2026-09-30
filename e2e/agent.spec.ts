// Agent API scenario (ARCHITECTURE §11, §15 item 10): HTTP transactions against the engine while the editor
// is open apply live through the session (one "Agent: …" History entry, the timeline and ruler update),
// destructive transactions wait for approval in the Agent panel, and with the editor closed the same call
// applies headlessly and shows up when the project is reopened.
import { expect, type Page, test } from '@playwright/test';
import {
	clips,
	createProject,
	enableAgentBridge,
	importFiles,
	sequenceSummary,
	watchPage,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

let page: Page;
let watcher: { errors: string[] };
let projectId = '';

type TxResponse = {
	result: { ok: boolean; revision: number; errors?: { code: string; message: string }[] };
	appliedBy: 'session' | 'headless';
};

const agentOrigin = { agent: 'e2e-agent', runId: 'e2e_run' };

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	watcher = watchPage(page);
	await enableAgentBridge(page);
	projectId = await createProject(page, 'E2E Agent');
	await importFiles(page, ['clip-b.mp4']);
});

test.afterAll(async () => {
	await page?.close();
});

test('POST /api/agent/tx with the editor open places a clip and a marker live', async ({ request }) => {
	// The relay id is the document's projectId, which the engine store uses too.
	const res = await request.post('/api/agent/tx', {
		data: {
			projectId,
			transaction: {
				protocol: 'jasper.tx/1',
				label: 'Place clip-b and mark it',
				origin: agentOrigin,
				commands: [
					{
						type: 'clip.place',
						source: { mediaByName: 'clip-b.mp4' },
						at: 0,
						tracks: { video: 'V1', audio: 'A1' },
						matchSequence: 'keep',
					},
					{ type: 'marker.add', frame: 45, name: 'Agent marker', comment: 'added over HTTP' },
				],
			},
		},
	});
	expect(res.status()).toBe(200);
	const body = (await res.json()) as TxResponse;
	expect(body.result.ok, JSON.stringify(body.result.errors ?? [])).toBe(true);
	expect(body.appliedBy).toBe('session');

	// The UI reflects it: a clip body in the timeline, a marker in the ruler, "Agent: …" in History.
	const placed = await clips(page, ['V1']);
	expect(placed).toHaveLength(1);
	await expect(
		page.locator(`[data-testid="timeline-track-area"] [data-clip-id="${placed[0]!.id}"]`),
	).toBeVisible();
	await expect(page.locator('[data-marker-lane] [data-mark="marker"]')).toHaveCount(1);
	await expect(page.locator('[data-marker-lane] [data-mark="marker"]').first()).toHaveAttribute(
		'title',
		/Agent marker/,
	);
	await page.getByTestId('tab-history').click();
	await expect(page.getByTestId('history-list')).toContainText('Agent:');
});

test('a destructive transaction (track.remove) waits for approval in the Agent panel; Deny rejects it', async ({
	request,
}) => {
	const summary = await sequenceSummary(page);
	const a3 = summary.tracks!.find((t) => t.label === 'A3')!;
	const pending = request.post('/api/agent/tx', {
		data: {
			projectId,
			transaction: {
				protocol: 'jasper.tx/1',
				label: 'Remove A3',
				origin: agentOrigin,
				commands: [{ type: 'track.remove', trackIds: [a3.id] }],
			},
		},
		timeout: 90_000,
	});
	// The Agent panel tab (docked next to Properties) shows the pending request.
	await page.getByTestId('tab-agent').click();
	const card = page.getByTestId('agent-approval-card');
	await expect(card).toBeVisible({ timeout: 20_000 });
	await expect(card).toContainText(/Remove A3|track\.remove/);
	await card.getByRole('button', { name: 'Deny' }).click();
	const body = (await (await pending).json()) as TxResponse;
	expect(body.result.ok).toBe(false);
	expect(body.result.errors?.[0]?.code).toBe('E_APPROVAL_DENIED');
	expect((await sequenceSummary(page)).tracks!.some((t) => t.id === a3.id)).toBe(true);
});

test('with the editor closed the transaction applies headlessly and appears on reopen', async ({
	request,
}) => {
	// Leave the editor (releases the lease and disconnects the relay).
	await page.getByTestId('home-button').click();
	await expect(page.getByTestId('home')).toBeVisible();
	await expect
		.poll(async () => {
			const res = await request.post('/api/agent/tx', {
				data: {
					projectId,
					transaction: {
						protocol: 'jasper.tx/1',
						label: 'Headless marker',
						origin: agentOrigin,
						commands: [{ type: 'marker.add', frame: 90, name: 'Headless marker' }],
					},
				},
			});
			const body = (await res.json()) as TxResponse;
			return body.result.ok ? body.appliedBy : `rejected: ${body.result.errors?.[0]?.code}`;
		})
		.toBe('headless');

	await page.getByTestId('project-card').filter({ hasText: 'E2E Agent' }).first().click();
	await expect(page.getByTestId('editor-shell')).toBeVisible();
	await expect(page.locator('[data-marker-lane] [data-mark="marker"]')).toHaveCount(2);
	await expect(page.locator('[data-marker-lane] [data-mark="marker"][title*="Headless marker"]')).toHaveCount(
		1,
	);
	expect(watcher.errors.filter((e) => e.startsWith('pageerror'))).toEqual([]);
});
