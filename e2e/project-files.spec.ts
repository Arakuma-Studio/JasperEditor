// Crash recovery, saved versions and Save As in the built app (process workstream, ARCHITECTURE D-39,
// docs/project-files.md). A real browser crash is simulated where it matters: the journal is left behind by a
// session that held the lease and vanished without saving (its lease released, as when it expires).
import { expect, type Page, test } from '@playwright/test';
import { createProject, enableAgentBridge, transact } from './support.ts';

const markerCount = async (page: Page, projectId: string) => {
	const r = await page.request.get(`/api/projects/${projectId}`);
	const env = (await r.json()) as {
		envelope: { document: { sequences: Record<string, { markers: unknown[] }> } };
	};
	return Object.values(env.envelope.document.sequences)[0]!.markers.length;
};

async function fileMenu(page: Page, item: RegExp) {
	await page.getByText('File', { exact: true }).first().click();
	await page.getByRole('menuitem', { name: item }).click();
}

test('unsaved changes of a dead session are offered on open and recovered as one undoable step', async ({
	page,
}) => {
	// Made over HTTP, so no editor holds it yet.
	const created = await page.request.post('/api/projects', {
		data: { name: 'Recovery E2E', preset: 'hd-1080p-30' },
	});
	const { projectId } = (await created.json()) as { projectId: string };
	// A session that edited, journalled and died before autosave (it held the lease, then lost it).
	const got = (await (await page.request.get(`/api/projects/${projectId}`)).json()) as {
		envelope: { document: Record<string, unknown> & { sequences: Record<string, { markers: unknown[] }> } };
	};
	const doc = structuredClone(got.envelope.document);
	const seq = Object.values(doc.sequences)[0]!;
	seq.markers = [1, 2, 3].map((i) => ({
		id: `mrk_E2E00000000000${i}`,
		name: `Lost ${i}`,
		comment: '',
		color: 'green',
		type: 'comment',
		author: 'user',
		frame: i * 10,
		duration: 0,
	}));
	// The editor that created the project releases its lease on its way to Home: wait until it is free.
	let lease: { leaseId?: string } = {};
	await expect
		.poll(async () => {
			const r = await page.request.post(`/api/projects/${projectId}/lease`, {
				data: { sessionId: 'ses_dead' },
			});
			lease = await r.json();
			return r.status();
		})
		.toBe(200);
	const put = await page.request.put(`/api/projects/${projectId}/recovery/ses_dead`, {
		data: {
			leaseId: lease.leaseId,
			baseRevision: 0,
			revision: 7,
			changes: ['Add Marker', 'Add Marker', 'Add Marker'],
			envelope: { ...got.envelope, document: doc },
		},
	});
	expect(put.status(), await put.text()).toBe(200);
	await page.request.delete(`/api/projects/${projectId}/lease/${lease.leaseId}`);

	await page.goto(`/project/${projectId}`);
	const dialog = page.getByTestId('recovery-dialog');
	await expect(dialog).toBeVisible();
	await expect(page.getByTestId('recovery-changes')).toHaveText(
		'3 unsaved changes: Add Marker, Add Marker, Add Marker',
	);
	await dialog.getByRole('button', { name: 'Recover' }).click();
	await expect(dialog).toBeHidden();
	await expect.poll(() => markerCount(page, projectId)).toBe(3);
	const left = await (await page.request.get(`/api/projects/${projectId}/recovery`)).json();
	expect(left.candidates).toEqual([]);

	// Undo takes the recovery back (and autosave writes that too).
	await page.getByText('Edit', { exact: true }).first().click();
	await page.getByRole('menuitem', { name: /^Undo Recover Unsaved Changes/ }).click();
	await expect.poll(() => markerCount(page, projectId)).toBe(0);
});

test('reload keeps the project editable; versions restore in place; Save As opens the new project', async ({
	page,
}) => {
	await enableAgentBridge(page);
	const projectId = await createProject(page, 'Versions E2E');
	expect((await transact(page, [{ type: 'marker.add', frame: 5, name: 'A' }])).ok).toBe(true);
	await expect.poll(() => markerCount(page, projectId)).toBe(1);

	// pagehide releases the lease: a reload is not read-only (docs/M1-STATUS.md corrected).
	await page.reload();
	await expect(page.getByTestId('editor-shell')).toBeVisible();
	await expect(page.getByTestId('banner-read-only')).toHaveCount(0);

	// Revert is disabled while everything is saved.
	await page.getByText('File', { exact: true }).first().click();
	await expect(page.getByRole('menuitem', { name: /^Revert/ })).toHaveAttribute('aria-disabled', 'true');
	await page.keyboard.press('Escape');

	await fileMenu(page, /Project Versions/);
	const versions = page.getByTestId('versions-dialog');
	await expect(versions).toBeVisible();
	await versions.locator('[data-testid$="-restore"]').first().click();
	await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Restore' }).click();
	await expect(versions).toBeHidden();
	await expect.poll(() => markerCount(page, projectId)).toBe(0);
	const kinds = (await (await page.request.get(`/api/projects/${projectId}/versions`)).json()).versions.map(
		(v: { kind: string }) => v.kind,
	);
	expect(kinds).toContain('before-restore');

	await fileMenu(page, /^Save As/);
	await page.getByTestId('save-as-name').fill('Versions E2E v2');
	await page.getByTestId('save-as-dialog').getByRole('button', { name: 'Save' }).click();
	await expect.poll(() => page.url()).not.toContain(projectId);
	await expect(page.getByTestId('editor-shell')).toBeVisible();
	const names = (await (await page.request.get('/api/projects')).json()).projects.map(
		(p: { name: string }) => p.name,
	);
	expect(names).toContain('Versions E2E v2');
});
