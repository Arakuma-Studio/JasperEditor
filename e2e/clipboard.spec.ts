// Clipboard end to end (wp-clipboard, S01 §20, S03:XF-050/FX-012/EC-023): copy/paste on the timeline with the
// keyboard (an animated text, a keyframed shape and an anime template keep every M2 field under new ids; the
// copies are selected and the playhead moves to their end), Paste Insert ripples, Paste Attributes… through the
// dialog, undo/redo, the Program monitor's right-click menu, keyframes in Effect Controls, a sequence in the
// Project panel, and a cross-project paste in a second tab through the system clipboard (media resolved by
// fingerprint). Setup edits go through the in-page agent API; every clipboard action goes through the real UI.
import { expect, type Page, test } from '@playwright/test';
import {
	appliedLabels,
	clipBox,
	clips,
	createProject,
	enableAgentBridge,
	focusTimeline,
	importFiles,
	playheadFrame,
	query,
	sequenceSummary,
	watchPage,
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
let watcher: { errors: string[] };
let seqId = '';
const ids = { text: '', shape: '', template: '', video: '' };

async function transact(p: Page, label: string, commands: unknown[]): Promise<Record<string, string>> {
	const r = await p.evaluate(
		([l, c]) =>
			(
				window as unknown as {
					jasper: {
						transact(tx: unknown): Promise<{ ok: boolean; refs?: Record<string, string>; errors?: unknown }>;
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
	watcher = watchPage(page);
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
	await expect(menu.getByRole('menuitem')).toHaveText([
		/Cut/,
		/Copy/,
		/Paste/,
		/Paste Attributes…/,
		/Duplicate/,
		/Delete/,
		/Enable/,
		/Scale to Frame Size/,
		/Set to Frame Size/,
	]);
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
	const otherWatch = watchPage(other);
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
	expect(otherWatch.errors.filter((e) => e.startsWith('pageerror'))).toEqual([]);
	await other.close();
});

test('no page errors', () => {
	expect(watcher.errors.filter((e) => e.startsWith('pageerror'))).toEqual([]);
});
