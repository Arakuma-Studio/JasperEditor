import { expect, type Page, test } from '@playwright/test';
import {
	clipBox,
	createProject,
	enableAgentBridge,
	expectTransaction,
	focusTimeline,
	query,
	timelineArea,
	transact,
} from './support.ts';

test.describe.configure({ mode: 'serial' });

let page: Page;
let seqId = '';
let clipId = '';

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await enableAgentBridge(page);
	await createProject(page, 'E2E Expressions');
	seqId = (await query<{ sequenceId: string }>(page, 'sequence.summary')).sequenceId;
});

test.afterAll(async () => {
	await page?.close();
});

const rotation = async () =>
	(
		await query<{ transform: { rotation: { expression?: { text: string; enabled: boolean } } } }>(
			page,
			'doc.get',
			{
				path: ['sequences', seqId, 'clips', clipId],
				fields: ['transform'],
			},
		)
	).transform.rotation.expression;

const evaluatedRotation = async (frame: number) => {
	const scene = await query<{ video: { clipId: string; transform: { rotation: number } }[] }>(
		page,
		'sequence.at',
		{ frame },
	);
	return scene.video.find((layer) => layer.clipId === clipId)?.transform.rotation;
};

test('typing an expression changes evaluated rotation at the requested frames', async () => {
	const r = await transact(page, [
		{ type: 'clip.addSolid', at: 0, duration: 150, track: 'V1', color: [0.9, 0.3, 0.1, 1] },
	]);
	expectTransaction(r);
	clipId = r.created.find((id) => id.startsWith('clp_'))!;
	await transact(page, [{ type: 'param.set', target: ['clip', clipId, 'transform', 'scale'], value: 30 }]);
	const b = await clipBox(page, clipId);
	const area = (await timelineArea(page).boundingBox())!;
	await page.mouse.click(
		(Math.max(b.x, area.x + 4) + Math.min(b.x + b.width, area.x + area.width - 4)) / 2,
		b.y + b.height / 2,
	);
	await page.getByTestId('tab-effectControls').click();
	const ec = page.getByTestId('ec-content');

	await ec.getByTestId('stopwatch-transform.rotation').click({ modifiers: ['Alt'] });
	await expect.poll(rotation).toEqual({ text: 'transform.rotation', enabled: true });
	const pathId = `clip-${clipId}-transform-rotation`;
	const field = ec.getByTestId(`expr-row-${pathId}`).locator('[contenteditable="true"]');
	await expect(field).toBeVisible();
	await field.click();
	await page.keyboard.press('Control+KeyA');
	await page.keyboard.type('time * 90');
	await page.keyboard.press('Control+Enter');
	await expect.poll(rotation).toEqual({ text: 'time * 90', enabled: true });

	// The default sequence is 30000/1001 fps: frames 30 and 15 are 1.001 and 0.5005 seconds.
	await query(page, 'playhead.set', { frame: 30 });
	await expect.poll(() => evaluatedRotation(30)).toBe(90.09);
	await query(page, 'playhead.set', { frame: 15 });
	await expect.poll(() => evaluatedRotation(15)).toBe(45.045);

	await page.screenshot({ path: 'test-results/e2e/expressions-effect-controls.png' });
});

test('errors show under the field; a preset from the language menu replaces the text; undo', async () => {
	const ec = page.getByTestId('ec-content');
	const pathId = `clip-${clipId}-transform-rotation`;
	const field = ec.getByTestId(`expr-row-${pathId}`).locator('[contenteditable="true"]');
	await field.click();
	await page.keyboard.press('Control+KeyA');
	await page.keyboard.type('nope(');
	// The editor closes the bracket: nope() is a call of an undefined function (a runtime error).
	await page.keyboard.press('Control+Enter');
	await expect(ec.getByTestId(`expr-error-${pathId}`)).toBeVisible();
	await expect.poll(() => evaluatedRotation(15)).toBe(0);

	await ec.getByTestId(`expr-menu-${pathId}`).click();
	const menu = page.getByTestId('expr-language-menu');
	await menu.getByText('Presets', { exact: true }).hover();
	await page.getByText('Time', { exact: true }).hover();
	await page.getByText('Rotate over time', { exact: true }).click();
	await expect.poll(() => evaluatedRotation(15)).toBe(45.045);
	await expect(ec.getByTestId(`expr-error-${pathId}`)).toHaveCount(0);

	await focusTimeline(page);
	await page.keyboard.press('Control+KeyZ');
	await expect.poll(async () => (await rotation())?.text).toBe('nope()');
});

test('browser (editor page) and Node evaluate expressions bit-identically', async () => {
	// Expressions that exercise libm (sin, exp, pow, log, atan2), noise, wiggle, random and gaussRandom; their results
	// are read at full precision from the page (effect params of `sequence.at`) and recomputed in Node. (Layer
	// bounds are not compared: they go through the host's Math.cos/sin in layerMatrix, which differ in the last ulp
	// between Chrome's V8 and Node's.)
	const r = await transact(page, [
		{ type: 'clip.addSolid', at: 200, duration: 60, track: 'V2', color: [0.1, 0.6, 0.9, 1], ref: '$c' },
		{ type: 'effect.add', target: { clipId: '$c' }, effectId: 'jasper.gaussian-blur', ref: '$b' },
		{ type: 'effect.add', target: { clipId: '$c' }, effectId: 'jasper.brightness-contrast', ref: '$bc' },
		{
			type: 'expression.set',
			target: ['effect', '$bc', 'brightness'],
			text: '(wiggle(3, 40, 3, 0.7) + noise([time * 2.1, 0.5]) * 30 + random(-5, 5)) % 100',
		},
		{
			type: 'expression.set',
			target: ['effect', '$bc', 'contrast'],
			text: '(gaussRandom(-50, 50) + Math.atan2(time, 1.3) * 10) % 100',
		},
		{
			type: 'expression.set',
			target: ['effect', '$b', 'radius'],
			text: 'Math.abs(Math.sin(time * 7.3) * Math.exp(time / 3) + Math.log(time + 2) * Math.pow(1.7, time)) * 37 % 500',
		},
		{
			type: 'expression.set',
			target: ['clip', '$c', 'transform', 'position'],
			text: 'wiggle(3, 200, 3, 0.7) + [noise(time * 2.1) * 300, random(-50, 50)]',
		},
		{
			type: 'expression.set',
			target: ['clip', '$c', 'transform', 'rotation'],
			text: 'gaussRandom(0, 360) + Math.atan2(time, 1.3) * 57',
		},
	]);
	expectTransaction(r);
	const c = r.refs.$c!;
	const { loadExpressionEngine } = await import('../packages/expressions/src/index.ts');
	const project = await import('../packages/project/src/index.ts');
	await loadExpressionEngine();
	const doc = await query<import('../packages/project/src/index.ts').ProjectDocument>(page, 'doc.get', {});
	type Layer = {
		clipId: string;
		transform: { position: number[]; rotation: number };
		effects: { params: Record<string, unknown> }[];
	};
	const round3 = (x: number) => Math.round(x * 1000) / 1000;
	const radii = new Set<unknown>();
	const evaluations: unknown[] = [];
	for (const frame of [200, 211, 229, 247, 259]) {
		const inPage = (await query<{ video: Layer[] }>(page, 'sequence.at', { frame })).video.find(
			(l) => l.clipId === c,
		)!;
		const snap = project.buildRenderSnapshot(doc, seqId, {
			range: { start: frame, end: frame + 1 },
			resolveMedia: () => null,
			resolveFont: () => null,
		});
		const inNode = project.resolveSceneAt(snap, frame).find((l) => l.clip.clipId === c)!;
		expect(inPage.effects.map((e) => e.params)).toEqual(inNode.props.effects.map((e) => e.params));
		expect(inPage.transform.position).toEqual(inNode.props.transform!.position.map(round3));
		expect(inPage.transform.rotation).toBe(round3(inNode.props.transform!.rotation));
		radii.add(inPage.effects[0]!.params.radius);
		evaluations.push({ frame, inPage, inNode: inNode.props });
	}
	expect(radii.size).toBe(5);
	await test
		.info()
		.attach('expression-evaluations', { body: JSON.stringify(evaluations), contentType: 'application/json' });
});

test.afterEach(async () => {
	await test.info().attach('expression-document', {
		body: JSON.stringify(await query(page, 'doc.get')),
		contentType: 'application/json',
	});
});
