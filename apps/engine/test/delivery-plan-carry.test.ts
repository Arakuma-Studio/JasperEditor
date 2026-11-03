// Spec 19 §12, AGENTS §4: every delivery job (Export Frame/PNG sequence/Export Title, PSD, gamut check) carries the export
// planner's warnings into its result and is refused by its blockers before anything renders. The renderer is faked: what is
// checked is what the jobs do with the plan, not the pictures (delivery.e2e.test.ts renders them).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AlphaDeliveryRequest, GamutCheckRequest, PsdRequest } from '@jasper/api';
import { buildRenderSnapshot, type RenderSnapshot } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { type DeliveryDeps, runAlphaDelivery } from '../src/export/delivery/alpha.ts';
import { runGamutCheck } from '../src/export/delivery/gamut.ts';
import { runPsdExport } from '../src/export/delivery/psd-job.ts';
import { encodePngAsync } from '../src/export/synthetic.ts';
import { type JobContext, JobError } from '../src/jobs/types.ts';
import { DocBuilder } from './helpers.ts';

function scene(): { d: DocBuilder; doc: RenderSnapshot } {
	const d = new DocBuilder('hd-720p-30');
	d.tx([{ type: 'clip.addSolid', at: 0, duration: 10, track: 'V1', color: [1, 0, 0, 1] }]);
	return { d, doc: buildRenderSnapshot(d.doc, d.seqId, { resolveMedia: () => null, resolveFont: () => null }) };
}

function context(): JobContext {
	const dir = mkdtempSync(join(tmpdir(), 'jasper-delivery-carry-'));
	return {
		job: { id: 'job_carry000001' } as JobContext['job'],
		input: {},
		signal: new AbortController().signal,
		slots: 1,
		progress: () => {},
		trackChild: () => {},
		addPartial: () => {},
		scratchDir: async () => dir,
		log: () => {},
	};
}

/** A centred opaque square: something painted, away from every edge. */
async function png(w: number, h: number): Promise<Uint8Array> {
	const rgba = new Uint8Array(w * h * 4);
	for (let y = Math.floor(h / 4); y < Math.ceil((3 * h) / 4); y++)
		for (let x = Math.floor(w / 4); x < Math.ceil((3 * w) / 4); x++)
			rgba.set([200, 40, 40, 255], (y * w + x) * 4);
	return encodePngAsync(rgba, w, h);
}

const PLANNED = [{ code: 'FONT_FALLBACK', message: 'A font is drawn with a fallback face' }];

function deps(doc: RenderSnapshot, frames?: DeliveryDeps['frames']): DeliveryDeps {
	const outDir = mkdtempSync(join(tmpdir(), 'jasper-delivery-out-'));
	const size = (props: unknown) => {
		const s = (props as { doc: RenderSnapshot }).doc.settings;
		return [s.width, s.height] as const;
	};
	return {
		frames: frames ?? (async () => ({ doc, displayLut: null, warnings: PLANNED })),
		remotion: {
			renderStill: async (o: { inputProps: unknown; output: string }) => {
				writeFileSync(o.output, await png(...size(o.inputProps)));
			},
			renderStillSheet: async (o: { inputProps: unknown; outputDir: string }) => {
				writeFileSync(join(o.outputDir, '0.png'), await png(...size(o.inputProps)));
			},
			openSharedBrowser: async () => ({ close: async () => {} }),
		} as unknown as DeliveryDeps['remotion'],
		ff: { run: async () => ({}) } as unknown as DeliveryDeps['ff'],
		outDir: async () => outDir,
		copyOut: async (src) => src,
		concurrency: () => 1,
	};
}

describe('delivery jobs carry the plan (AGENTS §4)', () => {
	it('Export Frame returns the planner’s warnings with its own', async () => {
		const { d, doc } = scene();
		const req = {
			envelope: d.envelope(),
			sequenceId: d.seqId,
			range: { start: 0, end: 1 },
		} as AlphaDeliveryRequest;
		const r = await runAlphaDelivery(context(), req, deps(doc));
		expect(r.warnings).toEqual(expect.arrayContaining(PLANNED));
	});

	it('the PSD returns them', async () => {
		const { d, doc } = scene();
		const req = { envelope: d.envelope(), sequenceId: d.seqId, frame: 0 } as PsdRequest;
		const r = await runPsdExport(context(), req, deps(doc));
		expect(r.warnings).toEqual(expect.arrayContaining(PLANNED));
	});

	it('the gamut check returns them', async () => {
		const { d, doc } = scene();
		const req = { envelope: d.envelope(), sequenceId: d.seqId, frame: 0 } as GamutCheckRequest;
		const r = await runGamutCheck(context(), req, deps(doc));
		expect(r.warnings).toEqual(PLANNED);
	});

	it('a blocked plan refuses every delivery with its code and blockers, before anything renders', async () => {
		const { d, doc } = scene();
		const blockers = [{ path: 'hybrid', reason: 'look picture "pano.png" of clip "Title"', itemId: 'clip_1' }];
		let rendered = 0;
		const base = deps(doc, async () => {
			throw new JobError('LOOK_MEDIA_OFFLINE', 'A look’s picture is offline', false, { blockers });
		});
		const counting: DeliveryDeps = {
			...base,
			remotion: new Proxy(base.remotion, {
				get: (t, k) => {
					rendered++;
					return Reflect.get(t, k);
				},
			}),
		};
		const env = { envelope: d.envelope(), sequenceId: d.seqId };
		for (const run of [
			() =>
				runAlphaDelivery(
					context(),
					{ ...env, range: { start: 0, end: 1 } } as AlphaDeliveryRequest,
					counting,
				),
			() => runPsdExport(context(), { ...env, frame: 0 } as PsdRequest, counting),
			() => runGamutCheck(context(), { ...env, frame: 0 } as GamutCheckRequest, counting),
		]) {
			const e = await run().catch((x: unknown) => x);
			expect(e).toBeInstanceOf(JobError);
			expect((e as JobError).code).toBe('LOOK_MEDIA_OFFLINE');
			expect((e as JobError).detail).toEqual({ blockers });
		}
		expect(rendered).toBe(0);
	});
});
