// Spec 19 TL-103: several Program stills as ONE job: one progress, one cancel, one result, cells served by index, the
// picture behind a clip through `hide`, a failing cell naming itself.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { STILL_SHEET_LIMITS, type StillSheetResult } from '@jasper/api';
import { decodePng } from '@jasper/testkit/png';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, H, JSON_H, makeApp, type TestApp } from './helpers.ts';

const W = 160;
const HH = 90;
let app: TestApp;

beforeAll(async () => {
	app = await makeApp();
}, 180_000);
afterAll(closeApps);

/** Red on V1, a green square on V2 for frames 0..30. */
function doc(): { d: DocBuilder; top: string } {
	const d = new DocBuilder();
	d.tx([{ type: 'sequence.updateSettings', settings: { width: W, height: HH } }]);
	d.tx([{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [1, 0, 0, 1] }]);
	d.tx([{ type: 'track.add', kind: 'video', count: 1 }]);
	const r = d.tx([{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V2', color: [0, 1, 0, 1], ref: '$g' }]);
	return { d, top: r.refs.$g! };
}

const submit = (payload: unknown) =>
	app.inject({ method: 'POST', url: '/api/stills/sheet', headers: JSON_H, payload: payload as object });

async function cell(url: string) {
	const png = await app.inject({ method: 'GET', url, headers: H });
	expect(png.statusCode, png.body).toBe(200);
	return decodePng(png.rawPayload);
}

const centre = (img: { width: number; height: number; data: Uint8Array }) => {
	const at = (Math.floor(img.height / 2) * img.width + Math.floor(img.width / 2)) * 4;
	return [...img.data.subarray(at, at + 3)];
};

describe('still-sheet job (TL-103)', () => {
	it('renders every cell of one job, in order, from several documents, with hidden clips', async () => {
		const { d, top } = doc();
		const blue = new DocBuilder();
		blue.tx([{ type: 'sequence.updateSettings', settings: { width: W, height: HH } }]);
		blue.tx([{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [0, 0, 1, 1] }]);
		const r = await submit({
			documents: [d.envelope(), blue.envelope()],
			cells: [
				{ document: 0, sequenceId: d.seqId, frame: 5, tag: 'with' },
				{ document: 0, sequenceId: d.seqId, frame: 5, tag: 'behind', hide: [top] },
				{ document: 0, sequenceId: d.seqId, frame: 45 },
				{ document: 1, sequenceId: blue.seqId, frame: 5, tag: 'other' },
			],
			width: 80,
			meta: { columns: 2 },
		});
		expect(r.statusCode, r.body).toBe(202);
		const job = r.json();
		expect(job.kind).toBe('still-sheet');
		const done = await coreServices(app).queue.wait(job.id);
		expect(done.error).toBeUndefined();
		const result = done.result as StillSheetResult;
		expect(result.meta).toEqual({ columns: 2 });
		expect(result.cells.map((c) => [c.index, c.frame, c.document, c.tag])).toEqual([
			[0, 5, 0, 'with'],
			[1, 5, 0, 'behind'],
			[2, 45, 0, undefined],
			[3, 5, 1, 'other'],
		]);
		const images = await Promise.all(result.cells.map((c) => cell(c.url)));
		expect(images.every((i) => i.width === 80)).toBe(true);
		const near = (got: number[], want: number[]) =>
			expect(Math.max(...got.map((v, i) => Math.abs(v - want[i]!)))).toBeLessThan(12);
		near(centre(images[0]!), [0, 255, 0]);
		near(centre(images[1]!), [255, 0, 0]);
		near(centre(images[2]!), [255, 0, 0]);
		near(centre(images[3]!), [0, 0, 255]);
		expect(result.cells.every((c) => typeof c.renderPath === 'string')).toBe(true);
	});

	it('refuses what is over its limits and cells naming a missing document', async () => {
		const { d } = doc();
		const one = { document: 0, sequenceId: d.seqId, frame: 0 };
		const tooMany = await submit({
			documents: [d.envelope()],
			cells: Array.from({ length: STILL_SHEET_LIMITS.maxCells + 1 }, () => one),
		});
		expect(tooMany.statusCode).toBe(400);
		const bad = await submit({ documents: [d.envelope()], cells: [{ ...one, document: 1 }] });
		expect(bad.statusCode).toBe(400);
		expect(bad.body).toContain('names document 1 of 1');
		const big = await submit({
			documents: [d.envelope()],
			cells: [one],
			meta: { x: 'y'.repeat(STILL_SHEET_LIMITS.maxMetaBytes) },
		});
		expect(big.statusCode).toBe(400);
		expect((await submit({ documents: [], cells: [one] })).statusCode).toBe(400);
	});

	it('a failing cell fails the job, names the cell, and leaves no partial output', async () => {
		const { d } = doc();
		const r = await submit({
			documents: [d.envelope()],
			cells: [
				{ document: 0, sequenceId: d.seqId, frame: 1 },
				{ document: 0, sequenceId: 'seq_missing', frame: 1 },
			],
		});
		expect(r.statusCode).toBe(202);
		const done = await coreServices(app).queue.wait(r.json().id);
		expect(done.state).toBe('failed');
		expect(done.error?.message).toMatch(/cell 2 of 2/);
		expect(existsSync(join(app.jasper.config.paths.rendersDir, r.json().id))).toBe(false);
		expect((await app.inject({ method: 'GET', url: `/renders/${r.json().id}/cells/0`, headers: H })).statusCode).toBe(
			404,
		);
	});

	it('cancelling the job stops the rest and deletes what it wrote', async () => {
		const { d } = doc();
		const r = await submit({
			documents: [d.envelope()],
			cells: Array.from({ length: STILL_SHEET_LIMITS.maxCells }, (_, i) => ({
				document: 0,
				sequenceId: d.seqId,
				frame: i,
			})),
		});
		const id = r.json().id;
		const queue = coreServices(app).queue;
		queue.cancel(id);
		const done = await queue.wait(id);
		expect(done.state).toBe('cancelled');
		expect(existsSync(join(app.jasper.config.paths.rendersDir, id))).toBe(false);
		expect((await app.inject({ method: 'GET', url: `/renders/${id}/cells/0`, headers: H })).statusCode).toBe(404);
	});

	it('does not serve an index that is not a number', async () => {
		const { d } = doc();
		const r = await submit({ documents: [d.envelope()], cells: [{ document: 0, sequenceId: d.seqId, frame: 0 }] });
		await coreServices(app).queue.wait(r.json().id);
		for (const bad of ['..%2Foutput', '1e3', '-1', '9999'])
			expect(
				(await app.inject({ method: 'GET', url: `/renders/${r.json().id}/cells/${bad}`, headers: H })).statusCode,
				bad,
			).toBe(404);
	});
});
