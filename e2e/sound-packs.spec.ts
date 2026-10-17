// Sound packs in the built app (spec 12 P6-R1; wp-note "Phase 6 → WP6.1 sound packs"): a generated pack in the e2e
// catalogue (file:// URL; e2e/serve.mjs points JASPER_SOUND_CATALOG into the throwaway appdir) is installed from
// Preferences ▸ Sound Library ▸ Packs after its licence is shown, its sounds appear in the Library under Sources ›
// Packs › <pack>, one is inserted, the pack is removed, and the project still exports the sound (the media is the
// project's managed copy). Screenshots go to test-results/e2e-sound-packs. No network.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { createProject, enableAgentBridge, exportViaUi, query, ROOT, serverInfo } from './support.ts';

test.describe.configure({ mode: 'serial' });
const outDir = join(ROOT, 'test-results', 'e2e-sound-packs');
let page: Page;

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** 16-bit mono WAV: 30 ms of silence, then a decaying `freq` tone burst. */
function burst(freq: number, seconds = 0.5): Buffer {
	const sr = 48_000;
	const n = Math.round(seconds * sr);
	const b = Buffer.alloc(44 + n * 2);
	b.write('RIFF', 0);
	b.writeUInt32LE(36 + n * 2, 4);
	b.write('WAVEfmt ', 8);
	b.writeUInt32LE(16, 16);
	b.writeUInt16LE(1, 20);
	b.writeUInt16LE(1, 22);
	b.writeUInt32LE(sr, 24);
	b.writeUInt32LE(sr * 2, 28);
	b.writeUInt16LE(2, 32);
	b.writeUInt16LE(16, 34);
	b.write('data', 36);
	b.writeUInt32LE(n * 2, 40);
	for (let i = 0; i < n; i++) {
		const t = i / sr - 0.03;
		const v = t < 0 ? 0 : Math.exp(-t * 12) * Math.sin(2 * Math.PI * freq * t) * 0.8;
		b.writeInt16LE(Math.round(v * 32000), 44 + i * 2);
	}
	return b;
}

/** A stored ZIP (the engine checks sizes and the catalogue's sha256s). */
function storedZip(files: { name: string; data: Buffer }[]): Buffer {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const f of files) {
		const name = Buffer.from(f.name);
		const loc = Buffer.alloc(30);
		loc.writeUInt32LE(0x04034b50, 0);
		loc.writeUInt16LE(20, 4);
		loc.writeUInt32LE(f.data.length, 18);
		loc.writeUInt32LE(f.data.length, 22);
		loc.writeUInt16LE(name.length, 26);
		parts.push(loc, name, f.data);
		const cen = Buffer.alloc(46);
		cen.writeUInt32LE(0x02014b50, 0);
		cen.writeUInt16LE(20, 4);
		cen.writeUInt16LE(20, 6);
		cen.writeUInt32LE(f.data.length, 20);
		cen.writeUInt32LE(f.data.length, 24);
		cen.writeUInt16LE(name.length, 28);
		cen.writeUInt32LE(offset, 42);
		central.push(cen, name);
		offset += 30 + name.length + f.data.length;
	}
	const cd = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(cd.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, cd, end]);
}

/** Writes the generated pack and the e2e catalogue that names it. */
function writePack(): void {
	const { appdir } = serverInfo();
	const dir = join(appdir, 'e2e-pack-source');
	mkdirSync(dir, { recursive: true });
	const files = [
		{ path: 'Audio/e2e_bell_000.wav', data: burst(660), title: 'E2E pack bell' },
		{ path: 'Audio/e2e_gong_000.wav', data: burst(220), title: 'E2E pack gong' },
	];
	const zip = storedZip(files.map((f) => ({ name: f.path, data: f.data })));
	writeFileSync(join(dir, 'e2e-pack.zip'), zip);
	const catalog = {
		version: 1,
		packs: [
			{
				id: 'e2e-test-pack',
				title: 'E2E Test Pack',
				author: 'JasperEditor tests',
				description: 'Two generated tone bursts.',
				license: 'CC0-1.0',
				licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
				licenseEvidence: [
					{ url: 'https://example.invalid/e2e-pack', statement: 'License: CC0', checkedAt: '2026-10-17' },
				],
				attribution: null,
				pageUrl: 'https://example.invalid/e2e-pack',
				download: {
					type: 'zip',
					url: pathToFileURL(join(dir, 'e2e-pack.zip')).href,
					sha256: sha(zip),
					sizeBytes: zip.length,
				},
				files: files.map((f) => ({
					path: f.path,
					sha256: sha(f.data),
					sizeBytes: f.data.length,
					title: f.title,
					types: ['chime'],
					tags: ['e2e'],
				})),
			},
		],
	};
	writeFileSync(join(appdir, 'e2e-sound-catalog.json'), JSON.stringify(catalog));
}

async function openPacks(p: Page) {
	await p.getByTestId('title-bar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
	await p.getByRole('menuitem', { name: /^Preferences$/ }).hover();
	await p.getByRole('menuitem', { name: /^Preferences…/ }).click();
	const prefs = p.getByTestId('preferences-dialog');
	await expect(prefs).toBeVisible();
	await prefs.getByTestId('prefs-page-sound-library').click();
	const packs = prefs.getByTestId('sound-prefs-packs');
	await packs.scrollIntoViewIfNeeded();
	return { prefs, packs };
}

/** The first channel of an audio file as 48 kHz float samples (ffmpeg). */
function decodeMono(file: string): Float32Array {
	const raw = execFileSync(
		process.env.JASPER_FFMPEG ?? 'ffmpeg',
		['-v', 'error', '-i', file, '-map', '0:a:0', '-af', 'pan=mono|c0=c0', '-ar', '48000', '-f', 'f32le', '-'],
		{ maxBuffer: 256 * 1024 * 1024 },
	);
	return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
}

test.beforeAll(async ({ browser }) => {
	mkdirSync(outDir, { recursive: true });
	writePack();
	page = await browser.newPage();
	await enableAgentBridge(page);
});
test.afterAll(async () => {
	await page?.close();
});

test('install a pack after its licence, use a sound, remove the pack: the project still exports it', async ({
	request,
}) => {
	test.setTimeout(900_000);
	await createProject(page, 'E2E Sound Packs');

	// install (the licence comes first)
	let { prefs, packs } = await openPacks(page);
	const row = packs.locator('[data-sound-pack="e2e-test-pack"]');
	await expect(row).toContainText('E2E Test Pack');
	await expect(row).toContainText('Not installed');
	await expect(row.locator('[data-license-badge="CC0"]')).toBeVisible();
	await row.getByRole('button', { name: 'Install E2E Test Pack' }).click();
	const confirm = page.getByTestId('confirm-dialog');
	await expect(confirm).toContainText('Licence: CC0-1.0');
	await expect(confirm).toContainText('2 sounds');
	await page.screenshot({ path: join(outDir, 'licence-before-download.png') });
	await confirm.getByRole('button', { name: 'Accept Licence and Download' }).click();
	await expect(row.getByTestId('sound-pack-state-e2e-test-pack')).toHaveText('Installed', {
		timeout: 120_000,
	});
	await expect(row).toContainText('2 in the library', { timeout: 360_000 });
	await prefs.screenshot({ path: join(outDir, 'installed.png') });
	await page.keyboard.press('Escape');
	await expect(prefs).toBeHidden();

	// the Library lists the pack under Sources and inserts one of its sounds
	await page.keyboard.press('Alt+Shift+Digit7');
	await page.locator('.dv-tab', { hasText: 'Sound Library' }).first().click();
	const panel = page.locator('[data-panel-kind="soundLibrary"][data-instance-id]');
	await expect(panel).toBeVisible({ timeout: 60_000 });
	const collection = panel.getByRole('combobox', { name: 'Collection' });
	await collection.click();
	await page.getByRole('option', { name: 'Sources › Packs › E2E Test Pack' }).click();
	const list = panel.getByRole('listbox', { name: 'Sounds' });
	await expect(list.getByRole('option')).toHaveCount(2, { timeout: 60_000 });
	await panel.screenshot({ path: join(outDir, 'library-pack-collection.png') });
	await query(page, 'playhead.set', { frame: 30 });
	await expect.poll(async () => (await query<{ frame: number }>(page, 'playhead.get', {})).frame).toBe(30);
	await list.getByRole('option', { name: /^E2E pack bell/ }).click();
	await page.keyboard.press('Enter');
	type Media = { library?: { source?: { type: string; packId?: string } } };
	await expect
		.poll(
			async () =>
				Object.keys(await query<Record<string, Media>>(page, 'doc.get', { path: ['media'] })).length,
			{
				timeout: 60_000,
			},
		)
		.toBe(1);
	const media = Object.values(await query<Record<string, Media>>(page, 'doc.get', { path: ['media'] }))[0]!;
	expect(media.library?.source).toMatchObject({ type: 'pack', packId: 'e2e-test-pack' });

	// remove the pack (asks first)
	({ prefs, packs } = await openPacks(page));
	await packs.getByRole('button', { name: 'Remove E2E Test Pack' }).click();
	await expect(page.getByTestId('confirm-dialog')).toContainText('keep their own copies');
	await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Remove' }).click();
	await expect(packs.getByTestId('sound-pack-state-e2e-test-pack')).toHaveText('Not installed', {
		timeout: 60_000,
	});
	await page.keyboard.press('Escape');
	await expect(prefs).toBeHidden();
	const gone = await request.get('/api/sounds?packId=e2e-test-pack&license=any');
	expect((await gone.json()).total).toBe(0);

	// the project still has the sound: an export plays it after frame 30
	const { file } = await exportViaUi(page, request, {
		engine: 'native',
		fileName: 'sound-packs-after-removal.mp4',
		expectPath: /native/i,
		outDir,
		jobTimeoutMs: 600_000,
	});
	const mix = decodeMono(file);
	let peak = 0;
	for (let i = 0; i < mix.length; i++) peak = Math.max(peak, Math.abs(mix[i]!));
	expect(peak).toBeGreaterThan(0.05);
});
