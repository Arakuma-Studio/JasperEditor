// Clipboard end to end (wp-clipboard, S01 §20, S03:XF-050/FX-012/EC-023): copy/paste on the timeline with the
// keyboard (an animated text, a keyframed shape and an anime template keep every M2 field under new ids; the
// copies are selected and the playhead moves to their end), Paste Insert ripples, Paste Attributes… through the
// dialog, undo/redo, the Program monitor's right-click menu, keyframes in Effect Controls, a sequence in the
// Project panel, and a cross-project paste in a second tab through the system clipboard (media resolved by
// fingerprint). Setup edits go through the in-page agent API; every clipboard action goes through the real UI.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipBox,
	clips,
	createProject,
	enableAgentBridge,
	FIXTURES,
	focusTimeline,
	importFiles,
	playheadFrame,
	programPixels,
	query,
	sequenceSummary,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

type Anim<T> = { value: T; keyframes: { id: string; time: number; value: T }[] };
type DocClip = {
	id: string;
	kind: string;
	trackId: string;
	start: number;
	duration: number;
	name: string;
	linkId: string | null;
	mediaId?: string;
	opacity?: Anim<number>;
	transform?: { rotation: Anim<number>; scale: Anim<number> };
	textAnimation?: unknown;
	shape?: { size: Anim<[number, number]>; fill: Anim<number[]> | null };
	template?: { id: string; version: number; renderer?: string };
	params?: Record<string, unknown>;
	paramKeyframes?: Record<string, { id: string; time: number; value: unknown }[]>;
	effects?: { id: string; effectId: string }[];
};

let page: Page;
let seqId = '';
const ids = { text: '', shape: '', template: '', video: '' };

async function transact(p: Page, label: string, commands: unknown[]): Promise<Record<string, string>> {
	const r = await p.evaluate(
		([l, c]) =>
			(
				window as unknown as {
					jasper: {
						transact(tx: unknown): Promise<{ ok: boolean; refs?: Record<string, string> }>;
					};
				}
			).jasper.transact({ label: l, commands: c }),
		[label, commands] as const,
	);
	expect(r.ok, JSON.stringify(r)).toBe(true);
	return r.refs ?? {};
}

async function docClips(p: Page = page, seq = seqId): Promise<Record<string, DocClip>> {
	const s = await query<{ clips: Record<string, DocClip> }>(p, 'doc.get', { path: ['sequences', seq] });
	return s.clips;
}

async function selection(p: Page = page): Promise<string[]> {
	const r = await query<{ selection: { timeline?: { clips?: string[] } } }>(p, 'selection.get');
	return r.selection.timeline?.clips ?? [];
}

/** Clicks a clip body (Shift = toggle into the selection). */
async function clickClip(id: string, shift = false): Promise<void> {
	const b = await clipBox(page, id);
	if (shift) await page.keyboard.down('Shift');
	await page.mouse.click(b.x + Math.min(20, b.width / 2), b.y + b.height / 2);
	if (shift) await page.keyboard.up('Shift');
}

const strip = <T extends DocClip>(c: T) => {
	const { id: _i, trackId: _t, start: _s, linkId: _l, ...rest } = c;
	return rest;
};
/** Every id-like string inside a value. */
const idsIn = (v: unknown): string[] => JSON.stringify(v).match(/"(?:kf|fx|mrk|tkr)_[0-9A-Z]{16}"/g) ?? [];

test.beforeAll(async ({ browser }) => {
	// Clipboard permissions let Edit-menu pastes read the system clipboard too (keyboard pastes never need them).
	const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
	page = await context.newPage();
	await enableAgentBridge(page);
	await createProject(page, 'E2E Clipboard A');
	seqId = (await sequenceSummary(page)).sequenceId;
	const refs = await transact(page, 'Setup', [
		{
			type: 'clip.addText',
			at: 0,
			duration: 60,
			track: 'V2',
			content: { text: 'Copy me' },
			textAnimation: { in: { preset: 'slide-up' }, out: { preset: 'fade' } },
			ref: '$t',
		},
		{
			type: 'clip.addShape',
			at: 10,
			duration: 50,
			track: 'V3',
			shape: { type: 'rect', size: [300, 120], fill: [1, 0.5, 0, 1], cornerRadius: 12 },
			ref: '$s',
		},
		{ type: 'keyframe.add', target: ['clip', '$s', 'shape', 'size'], at: { frames: 0 }, value: [300, 120] },
		{ type: 'keyframe.add', target: ['clip', '$s', 'shape', 'size'], at: { frames: 30 }, value: [600, 120] },
		{
			type: 'clip.addMotionGraphic',
			at: 0,
			duration: 90,
			track: 'V1',
			template: { id: 'title-reveal', version: 1 },
			params: { title: 'Clipboard' },
			ref: '$m',
		},
		{ type: 'keyframe.add', target: ['clip', '$m', 'params', 'titleSize'], at: { frames: 0 }, value: 80 },
		{ type: 'keyframe.add', target: ['clip', '$m', 'params', 'titleSize'], at: { frames: 40 }, value: 140 },
		{ type: 'param.set', target: ['clip', '$t', 'opacity'], value: 60 },
	]);
	ids.text = refs.$t!;
	ids.shape = refs.$s!;
	ids.template = refs.$m!;
	// Zoom the timeline out so every clip of the spec stays on screen.
	await focusTimeline(page);
	await page.keyboard.press('Minus');
	await page.keyboard.press('Minus');
});

test.afterAll(async () => {
	await page?.context().close();
});

test('Ctrl+C / Ctrl+V on the timeline: new ids, every M2 field kept, copies selected, playhead at their end', async () => {
	await clickClip(ids.text);
	await clickClip(ids.shape, true);
	await clickClip(ids.template, true);
	expect((await selection()).sort()).toEqual([ids.text, ids.shape, ids.template].sort());
	await page.keyboard.press('Control+KeyC');
	await query(page, 'playhead.set', { frame: 90 });
	expect(await playheadFrame(page)).toBe(90);
	const before = await docClips();
	await page.keyboard.press('Control+KeyV');
	await expect.poll(async () => Object.keys(await docClips()).length).toBe(6);
	const after = await docClips();
	const pasted = Object.values(after).filter((c) => !before[c.id]);
	const byKind = Object.fromEntries(pasted.map((c) => [c.kind, c]));
	expect(byKind.text!.start).toBe(90);
	expect(byKind.shape!.start).toBe(100);
	expect(byKind['motion-graphic']!.start).toBe(90);
	// Same tracks (V1 lowest targeted by default), same content, new nested ids.
	for (const [kind, src] of [
		['text', before[ids.text]!],
		['shape', before[ids.shape]!],
		['motion-graphic', before[ids.template]!],
	] as const) {
		const copy = byKind[kind]!;
		expect(copy.trackId).toBe(src.trackId);
		// Same content (key order aside) once nested ids are masked.
		const masked = (c: DocClip) =>
			JSON.parse(JSON.stringify(strip(c)).replace(/"(kf|fx|mrk|tkr)_[0-9A-Z]{16}"/g, '"id"'));
		expect(masked(copy)).toEqual(masked(src));
		for (const id of idsIn(copy)) expect(idsIn(src)).not.toContain(id);
	}
	expect(byKind.text!.textAnimation).toEqual(before[ids.text]!.textAnimation);
	expect(byKind['motion-graphic']!.template).toEqual({ id: 'title-reveal', version: 1, renderer: 'anime' });
	expect(byKind['motion-graphic']!.paramKeyframes!.titleSize!.map((k) => k.value)).toEqual([80, 140]);
	expect(byKind.shape!.shape!.size.keyframes.map((k) => k.value)).toEqual([
		[300, 120],
		[600, 120],
	]);
	expect((await selection()).sort()).toEqual(pasted.map((c) => c.id).sort());
	expect(await playheadFrame(page)).toBe(180);
	expect((await appliedLabels(page)).at(-1)).toBe('Paste');
});

test('Undo removes the paste; Redo restores it with the copies selected', async () => {
	const pastedSel = await selection();
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => Object.keys(await docClips()).length).toBe(3);
	await page.keyboard.press('Control+Shift+KeyZ');
	await expect.poll(async () => Object.keys(await docClips()).length).toBe(6);
	expect((await selection()).sort()).toEqual([...pastedSel].sort());
});

test('Paste Insert (Ctrl+Shift+V) ripples later clips on the destination and sync-locked tracks', async () => {
	await clickClip(ids.text);
	await page.keyboard.press('Control+KeyC');
	const before = await docClips();
	const laterShape = Object.values(before).find((c) => c.kind === 'shape' && c.start === 100)!;
	await query(page, 'playhead.set', { frame: 90 });
	await page.keyboard.press('Control+Shift+KeyV');
	await expect.poll(async () => Object.keys(await docClips()).length).toBe(7);
	const after = await docClips();
	expect(after[laterShape.id]!.start).toBe(160); // shifted by the 60-frame text
	expect((await appliedLabels(page)).at(-1)).toBe('Paste Insert');
});

test('Paste Attributes… (Ctrl+Alt+V): the dialog lists the copied attributes; only the checked ones paste', async () => {
	const all = await docClips();
	const target = Object.values(all).find(
		(c) => c.kind === 'text' && c.id !== ids.text && c.trackId === all[ids.text]!.trackId,
	)!;
	await transact(page, 'Reset target', [
		{ type: 'param.set', target: ['clip', target.id, 'opacity'], value: 100 },
	]);
	await clickClip(ids.text);
	await page.keyboard.press('Control+KeyC');
	await clickClip(target.id);
	await page.keyboard.press('Control+Alt+KeyV');
	const dialog = page.getByTestId('paste-attributes-dialog');
	await expect(dialog).toBeVisible();
	for (const label of [
		'Motion',
		'Opacity',
		'In Animation',
		'Out Animation',
		'Text Style',
		'Scale Attribute Times',
	])
		await expect(dialog.getByText(label, { exact: true })).toBeVisible();
	await dialog.locator('[data-attr="motion"] button').click();
	await dialog.getByRole('button', { name: 'Paste' }).click();
	await expect(dialog).toBeHidden();
	await expect.poll(async () => (await docClips())[target.id]!.opacity!.value).toBe(60);
	expect((await appliedLabels(page)).at(-1)).toBe('Paste Attributes');
});

test('Program monitor right-click on a layer: Copy, then Paste from the menu (XF-050)', async () => {
	await query(page, 'playhead.set', { frame: 20 });
	const wrapper = (await page.getByTestId('program-player-wrapper').boundingBox())!;
	await page.mouse.click(wrapper.x + wrapper.width / 2, wrapper.y + wrapper.height / 2, { button: 'right' });
	const menu = page.getByTestId('program-context-menu');
	await expect(menu).toBeVisible();
	// Anchor ▸ and Arrange ▸ are hover submenus (their items are hidden until then).
	await expect(menu.getByRole('menuitem')).toHaveText([
		/Cut/,
		/Copy/,
		/Paste/,
		/Paste Attributes…/,
		/Duplicate/,
		/Delete/,
		/Enable/,
		/Reset Motion/,
		/Reset Crop/,
		/Fit to Frame/,
		/Fill Frame/,
		/Set to Native \(100%\)/,
		/Reveal in Timeline/,
		/Reveal in Project/,
	]);
	await expect(menu.getByText('Anchor', { exact: true })).toBeVisible();
	await expect(menu.getByText('Arrange', { exact: true })).toBeVisible();
	const picked = (await selection())[0]!;
	await menu.getByRole('menuitem', { name: /^Copy/ }).click();
	await query(page, 'playhead.set', { frame: 100_000 }); // stops at the sequence end
	const end = await playheadFrame(page);
	const n = Object.keys(await docClips()).length;
	await page.mouse.click(wrapper.x + 5, wrapper.y + 5, { button: 'right' });
	await page
		.getByTestId('program-context-menu')
		.getByRole('menuitem', { name: /^Paste/ })
		.first()
		.click();
	await expect.poll(async () => Object.keys(await docClips()).length).toBe(n + 1);
	const copy = Object.values(await docClips()).find((c) => c.start === end)!;
	expect(copy.kind).toBe((await docClips())[picked]!.kind);
});

test('Effect Controls: copied keyframes paste at the playhead keeping their spacing (EC-023)', async () => {
	await clickClip(ids.shape);
	await page.getByTestId('tab-effectControls').click();
	const keys = page.locator('[data-testid="effect-controls-panel"] [data-kf-id]');
	await expect(keys.first()).toBeVisible();
	const shapeKeys = (await docClips())[ids.shape]!.shape!.size.keyframes.map((k) => k.id);
	await page.locator(`[data-kf-id="${shapeKeys[0]}"]`).first().click();
	await page
		.locator(`[data-kf-id="${shapeKeys[1]}"]`)
		.first()
		.click({ modifiers: ['Shift'] });
	await page.keyboard.press('Control+KeyC');
	await query(page, 'playhead.set', { frame: 25 });
	await page.keyboard.press('Control+KeyV');
	await expect.poll(async () => (await docClips())[ids.shape]!.shape!.size.keyframes.length).toBe(4);
	expect((await appliedLabels(page)).at(-1)).toBe('Paste Keyframes');
});

test('Project panel: a copied sequence pastes as a deep copy with new ids (CLB-007)', async () => {
	await page.getByTestId('tab-project').click();
	const row = page.getByTestId('project-row').filter({ hasText: 'Sequence' }).first();
	await row.click({ button: 'right' });
	await page.getByTestId('project-menu-copy').click();
	await row.click({ button: 'right' });
	await page.getByTestId('project-menu-paste').click();
	await expect
		.poll(
			async () =>
				Object.keys(await query<Record<string, unknown>>(page, 'doc.get', { path: ['sequences'] })).length,
		)
		.toBe(2);
	expect((await appliedLabels(page)).at(-1)).toBe('Paste');
});

test('cross-project paste in another tab through the system clipboard (media resolved by fingerprint)', async () => {
	await importFiles(page, ['clip-a.mp4']);
	const media = await query<{ media: { mediaId: string; originalName: string }[] }>(page, 'media.list');
	const mediaId = media.media.find((m) => m.originalName === 'clip-a.mp4')!.mediaId;
	const tail = (await query<{ duration: { frames: number } }>(page, 'sequence.summary')).duration.frames;
	const refs = await transact(page, 'Place', [
		{
			type: 'clip.place',
			source: { mediaId },
			at: tail,
			tracks: { video: 'V1', audio: 'A1' },
			sourceRange: { in: { seconds: 0 }, out: { seconds: 2 } },
			matchSequence: 'keep',
			sequenceId: seqId,
			ref: '$v',
		},
	]);
	ids.video = refs.$v!;
	const fingerprint = (
		await query<Record<string, { fingerprint: string }>>(page, 'doc.get', { path: ['media'] })
	)[mediaId]!.fingerprint;
	await query(page, 'playhead.set', { frame: tail });
	await clickClip(ids.video);
	await page.keyboard.press('Control+KeyC');

	const other = await page.context().newPage();
	await enableAgentBridge(other);
	await createProject(other, 'E2E Clipboard B');
	const otherSeq = (await sequenceSummary(other)).sequenceId;
	await other.getByTestId('timeline-track-area').click({ position: { x: 300, y: 20 } });
	await other.keyboard.press('Control+KeyV');
	await expect.poll(async () => (await clips(other)).length).toBe(2);
	const rows = await clips(other);
	expect(rows.map((r) => r.kind).sort()).toEqual(['audio', 'video']);
	const pasted = Object.values(await docClips(other, otherSeq)).find((c) => c.kind === 'video')!;
	const otherMedia = await query<Record<string, { fingerprint: string }>>(other, 'doc.get', {
		path: ['media'],
	});
	expect(otherMedia[pasted.mediaId!]!.fingerprint).toBe(fingerprint);
	expect(pasted.mediaId).not.toBe(mediaId);
	await other.screenshot({ path: 'test-results/e2e-cross-project-clipboard.png' });
	await other.close();
});

// ---------------------------------------------------------------- wp-clipboard-2

type Item = { id: string; kind: string; name: string; mediaId?: string };

async function items(p: Page = page): Promise<Record<string, Item>> {
	return query<Record<string, Item>>(p, 'doc.get', { path: ['items'] });
}

/** Opens the Program monitor menu on the layer under a point of the player (fractions of its box). */
async function programMenuAt(fx: number, fy: number) {
	const w = (await page.getByTestId('program-player-wrapper').boundingBox())!;
	await page.mouse.click(w.x + w.width * fx, w.y + w.height * fy, { button: 'right' });
	const menu = page.getByTestId('program-context-menu');
	await expect(menu).toBeVisible();
	return menu;
}

test('Program monitor layer menu: Fit to Frame, Anchor ▸, Arrange ▸, Reveal in Timeline / Project (XF-050)', async () => {
	const video = (await docClips())[ids.video]!;
	const audioId = Object.values(await docClips()).find(
		(c) => c.linkId === video.linkId && c.kind === 'audio',
	)!.id;
	const audioTrack = (await docClips())[audioId]!.trackId;
	await transact(page, 'Shrink', [
		{ type: 'param.set', target: ['clip', ids.video, 'transform', 'scale'], value: 40 },
		{ type: 'param.set', target: ['clip', ids.video, 'transform', 'position'], value: [700, 400] },
	]);
	await query(page, 'playhead.set', { frame: video.start + 10 });
	// Fit to Frame: the layer is scaled to fit and centred (XF-051).
	let menu = await programMenuAt(0.4, 0.4);
	await menu.getByRole('menuitem', { name: /^Fit to Frame/ }).click();
	await expect.poll(async () => (await docClips())[ids.video]!.transform!.scale.value).not.toBe(40);
	type T = { position: Anim<[number, number]>; anchor: Anim<[number, number]> };
	const tr = async () => (await docClips())[ids.video]!.transform as unknown as T;
	expect((await tr()).position.value).toEqual([960, 540]);
	expect((await appliedLabels(page)).at(-1)).toBe('Fit to Frame');
	// Anchor ▸ Top Left: the anchor moves to the layer's corner, the image stays where it is.
	const before = await programPixels(page);
	menu = await programMenuAt(0.3, 0.3);
	await menu.getByText('Anchor', { exact: true }).hover();
	await menu.getByRole('menuitem', { name: 'Top Left' }).click();
	await expect.poll(async () => (await tr()).anchor.value).toEqual([0, 0]);
	expect((await appliedLabels(page)).at(-1)).toBe('Anchor to Top Left');
	const after = await programPixels(page);
	expect(Math.abs(after.mean - before.mean)).toBeLessThan(2);
	// Arrange ▸ Bring Forward: above the text on V2 (V3 is free), the linked audio keeps its track.
	await transact(page, 'Text above', [
		{
			type: 'clip.addText',
			at: video.start,
			duration: video.duration,
			track: 'V2',
			content: { text: 'Above' },
			sequenceId: seqId,
		},
	]);
	const v3 = (await sequenceSummary(page)).tracks!.find((t) => t.label === 'V3')!.id;
	menu = await programMenuAt(0.15, 0.15);
	await menu.getByText('Arrange', { exact: true }).hover();
	await menu.getByRole('menuitem', { name: /^Bring Forward/ }).click();
	await expect.poll(async () => (await docClips())[ids.video]!.trackId).toBe(v3);
	expect((await docClips())[audioId]!.trackId).toBe(audioTrack);
	expect((await appliedLabels(page)).at(-1)).toBe('Bring Forward');
	// Reveal in Project selects the clip's item in the Project panel.
	menu = await programMenuAt(0.15, 0.15);
	await menu.getByRole('menuitem', { name: /^Reveal in Project/ }).click();
	const item = Object.values(await items()).find((i) => i.kind === 'media' && i.mediaId === video.mediaId)!;
	await expect
		.poll(
			async () =>
				(await query<{ selection: { project: { items: string[] } } }>(page, 'selection.get')).selection
					.project.items,
		)
		.toEqual([item.id]);
	await expect(
		page.locator(`[data-testid="project-panel"] [data-item-id="${item.id}"]`).first(),
	).toBeVisible();
	// Reveal in Timeline brings the Timeline forward with the clip in view.
	menu = await programMenuAt(0.15, 0.15);
	await menu.getByRole('menuitem', { name: /^Reveal in Timeline/ }).click();
	await expect(
		page.locator(`[data-testid="timeline-track-area"] [data-clip-id="${ids.video}"]`).first(),
	).toBeVisible();
	expect(await selection()).toContain(ids.video);
});

test('external text: Ctrl+V on the Timeline adds a 5 s centred text clip at the playhead, one undo step (CLB-010)', async () => {
	await page.bringToFront();
	await page.evaluate(() => navigator.clipboard.writeText('Hello from another app'));
	await query(page, 'playhead.set', { frame: 100_000 });
	const at = await playheadFrame(page);
	await focusTimeline(page);
	const n = Object.keys(await docClips()).length;
	await page.keyboard.press('Control+KeyV');
	await expect.poll(async () => Object.keys(await docClips()).length).toBe(n + 1);
	const text = Object.values(await docClips()).find((c) => c.kind === 'text' && c.start === at)!;
	expect(text.duration).toBe(150);
	expect((text as unknown as { content: { text: string } }).content.text).toBe('Hello from another app');
	expect((text.transform as unknown as { position: Anim<number[]> }).position.value).toEqual([960, 540]);
	expect(text.trackId).toBe((await sequenceSummary(page)).tracks!.find((t) => t.label === 'V1')!.id);
	expect(await selection()).toEqual([text.id]);
	expect((await appliedLabels(page)).at(-1)).toBe('Paste Text');
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => Object.keys(await docClips()).length).toBe(n);
	await page.keyboard.press('Control+Shift+KeyZ');
	await expect.poll(async () => Object.keys(await docClips()).length).toBe(n + 1);
});

test('external image data: Edit ▸ Paste imports "Pasted image <time>" and places it at the playhead (CLB-010)', async () => {
	await page.evaluate(async () => {
		const c = document.createElement('canvas');
		c.width = 64;
		c.height = 48;
		const g = c.getContext('2d')!;
		g.fillStyle = '#3080ff';
		g.fillRect(0, 0, 64, 48);
		const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
		await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
	});
	await query(page, 'playhead.set', { frame: 100_000 });
	const at = await playheadFrame(page);
	await focusTimeline(page);
	const n = Object.keys(await docClips()).length;
	await page.getByTestId('title-bar').getByRole('menubar').getByRole('menuitem', { name: 'Edit' }).click();
	await page
		.getByRole('menuitem', { name: /^Paste(\s|$)/ })
		.first()
		.click();
	await expect.poll(async () => Object.keys(await docClips()).length, { timeout: 60_000 }).toBe(n + 1);
	const pasted = Object.values(await items()).find((i) =>
		/^Pasted image \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d$/.test(i.name),
	);
	expect(pasted, JSON.stringify(Object.values(await items()).map((i) => i.name))).toBeTruthy();
	const clip = Object.values(await docClips()).find((c) => c.start === at && c.mediaId === pasted!.mediaId)!;
	expect(clip.kind).toBe('still');
	expect((await appliedLabels(page)).at(-1)).toBe('Import 1 file');
});

test('an OS file in a paste event is imported under its name and placed (CLB-010, LIFE-010)', async () => {
	const bytes = readFileSync(join(FIXTURES, 'still.png')).toString('base64');
	await query(page, 'playhead.set', { frame: 100_000 });
	const at = await playheadFrame(page);
	await focusTimeline(page);
	await page.evaluate((b64) => {
		const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
		const dt = new DataTransfer();
		dt.items.add(new File([bin], 'still.png', { type: 'image/png' }));
		document.body.dispatchEvent(
			new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
		);
	}, bytes);
	await expect
		.poll(async () => Object.values(await items()).filter((i) => i.name === 'still.png').length, {
			timeout: 60_000,
		})
		.toBe(1);
	const item = Object.values(await items()).find((i) => i.name === 'still.png')!;
	await expect
		.poll(async () =>
			Object.values(await docClips()).some((c) => c.start === at && c.mediaId === item.mediaId),
		)
		.toBe(true);
	expect((await appliedLabels(page)).at(-1)).toBe('Import 1 file');
});

test('text fields keep their own paste (CLB-010 never hijacks inputs)', async () => {
	await page.evaluate(() => navigator.clipboard.writeText('needle'));
	await page.getByTestId('tab-project').click();
	const search = page.getByTestId('project-search');
	await search.click();
	const labels = (await appliedLabels(page)).length;
	await page.keyboard.press('Control+KeyV');
	await expect(search).toHaveValue('needle');
	await page.waitForTimeout(300);
	expect((await appliedLabels(page)).length).toBe(labels);
	await search.fill('');
});
