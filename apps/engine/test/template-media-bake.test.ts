// Template media params (avatars, docs/wp-notes/social-comments.md "Template media params") in the engine: the
// layer-bake key covers the referenced medium's content, the bake document and the Remotion export props carry a
// signed URL for it, and the planner warns when it is offline. Uses the test-only `avatar-test@1` template.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectDocument, RenderVisualClip } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type PlannedExport, templatePictureProblem } from '../src/export/planner.ts';
import { createImportsExtension } from '../src/imports/extension.ts';
import type { VariantService } from '../src/imports/variants.ts';
import type { BakeEnvironment } from '../src/layer-bake/key.ts';
import type { LayerBakeService } from '../src/layer-bake/service.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, makeApp, register, type TestApp } from './helpers.ts';

vi.mock('@jasper/mg-templates', async (importOriginal) => {
	const m = await importOriginal<typeof import('@jasper/mg-templates')>();
	const { AVATAR_TEST_TEMPLATE } = await import(
		'../../../packages/mg-templates/test/fixtures/avatar-test-template.ts'
	);
	return { ...m, mgRegistry: m.createMgRegistry([...m.MG_CATALOG, AVATAR_TEST_TEMPLATE]) };
});

/** 4×4 PNGs of two colours (two different files: a relink to the other changes the medium's content). */
const RED =
	'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGP4z8DwHxkzkC4AADxAH+HggXe0AAAAAElFTkSuQmCC';
const BLUE =
	'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEUlEQVR4nGNgYPj/HxWTLAAAHGAf4baQ7OcAAAAASUVORK5CYII=';

const ENV: BakeEnvironment = {
	bundleId: 'b1',
	animejs: '4.5.0',
	remotion: '4.0.499',
	browser: '/usr/bin/chrome|1|1',
	gl: 'swangle',
};

const settings = (seqId: string) => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container: 'mp4',
	engine: 'auto',
	video: {
		codec: 'h264',
		width: 1280,
		height: 720,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 20 },
		encoderSpeed: 'fast',
	},
});

/** An `avatar-test@1` clip showing `mediaId` (injected: DocBuilder's registries hold no templates). */
function addAvatarClip(d: DocBuilder, mediaId: string | null): string {
	const seq = d.doc.sequences[d.seqId]!;
	const id = 'clp_AVATAR0000000001';
	const clip = {
		id,
		trackId: d.track('V1'),
		start: 0,
		duration: 30,
		sourceIn: 0,
		speed: { rate: 1, reverse: false, maintainPitch: false },
		name: 'Avatar',
		label: 'purple',
		enabled: true,
		linkId: null,
		groupId: null,
		markers: [],
		kind: 'motion-graphic',
		template: { id: 'avatar-test', version: 1, renderer: 'anime' },
		params: { name: 'Ada', avatar: mediaId ? { mediaId } : null },
		canvas: 'sequence',
		transform: {
			position: { value: [640, 360], keyframes: [] },
			anchor: { value: [640, 360], keyframes: [] },
			scale: { value: 100, keyframes: [] },
			scaleWidth: { value: 100, keyframes: [] },
			uniformScale: true,
			rotation: { value: 0, keyframes: [] },
			flipH: false,
			flipV: false,
		},
		opacity: { value: 100, keyframes: [] },
		blendMode: 'normal',
		effects: [],
	};
	d.doc = {
		...d.doc,
		sequences: { ...d.doc.sequences, [d.seqId]: { ...seq, clips: { ...seq.clips, [id]: clip as never } } },
	};
	d.revision++;
	return id;
}

describe('template media params in layer bakes and exports', () => {
	let app: TestApp;
	let svc: LayerBakeService;
	let red: Awaited<ReturnType<typeof register>>;
	let blue: Awaited<ReturnType<typeof register>>;
	beforeAll(async () => {
		app = await makeApp();
		svc = app.jasper.services.layerBake as LayerBakeService;
		const dir = mkdtempSync(join(tmpdir(), 'jasper-avatar-'));
		writeFileSync(join(dir, 'red.png'), Buffer.from(RED, 'base64'));
		writeFileSync(join(dir, 'blue.png'), Buffer.from(BLUE, 'base64'));
		red = await register(app, join(dir, 'red.png'));
		blue = await register(app, join(dir, 'blue.png'));
	});
	afterAll(closeApps);

	const plan = (d: DocBuilder): Promise<PlannedExport> =>
		coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId) as never,
		});
	const clipOf = (p: PlannedExport, id: string): RenderVisualClip =>
		p.snapshot.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === id)!;

	it('signs the avatar URL for the bake page and keys the bake on the medium’s content', async () => {
		const d = new DocBuilder('hd-720p-30');
		const mediaId = d.addMedia(red);
		const clipId = addAvatarClip(d, mediaId);
		const p1 = await plan(d);
		expect(p1.plan.blockers).toEqual([]);
		const b1 = await svc.planBake(p1, clipOf(p1, clipId), { env: ENV });
		// The bake document holds a signed engine URL for the avatar (the render page loads it cross-origin).
		const url = b1.doc.media[mediaId]?.url ?? '';
		expect(url).toMatch(new RegExp(`/media/${encodeURIComponent(red.mediaKey)}\\?.+`));
		expect(url).not.toBe(`/media/${red.mediaKey}`);
		expect(b1.material.media.map((m) => m.mediaId)).toEqual([mediaId]);
		expect(b1.material.media[0]!.fingerprint).toBe(red.fingerprint);
		// Same inputs → same key.
		expect((await svc.planBake(await plan(d), clipOf(p1, clipId), { env: ENV })).key).toBe(b1.key);
		// Relink the medium to other content (same media id): a new key.
		const relinked = new DocBuilder('hd-720p-30');
		relinked.doc = structuredClone(d.doc) as ProjectDocument;
		relinked.revision = d.revision;
		const asset = relinked.doc.media[mediaId]!;
		asset.fingerprint = blue.fingerprint;
		asset.sizeBytes = blue.sizeBytes;
		asset.locators = structuredClone(blue.locators) as typeof asset.locators;
		const p2 = await plan(relinked);
		const b2 = await svc.planBake(p2, clipOf(p2, clipId), { env: ENV });
		expect(b2.material.media[0]!.fingerprint).toBe(blue.fingerprint);
		expect(b2.key).not.toBe(b1.key);
		// No avatar: no media in the key, and another key again.
		const none = new DocBuilder('hd-720p-30');
		addAvatarClip(none, null);
		const p3 = await plan(none);
		const b3 = await svc.planBake(p3, clipOf(p3, clipId), { env: ENV });
		expect(b3.material.media).toEqual([]);
		expect(b3.key).not.toBe(b1.key);
	});

	it('the export snapshot resolves the avatar; an offline avatar is reported', async () => {
		const d = new DocBuilder('hd-720p-30');
		const mediaId = d.addMedia(red);
		addAvatarClip(d, mediaId);
		const p = await plan(d);
		expect(p.snapshot.media[mediaId]).not.toBeNull();
		expect(p.plan.warnings.map((w) => w.code)).not.toContain('OFFLINE_TEMPLATE_MEDIA');
		const offline = new DocBuilder('hd-720p-30');
		offline.doc = structuredClone(d.doc) as ProjectDocument;
		offline.revision = d.revision;
		offline.doc.media[mediaId]!.locators = [
			{ type: 'engine-store', engineId: 'local', key: 'mk_gone0000000' },
		];
		const q = await plan(offline);
		expect(q.plan.warnings.find((w) => w.code === 'OFFLINE_TEMPLATE_MEDIA')?.itemIds).toEqual([
			'clp_AVATAR0000000001',
		]);
	});

	it('a template picture the browser cannot decode gets its display picture (bake and Remotion), never the placeholder', async () => {
		const d = new DocBuilder('hd-720p-30');
		const mediaId = d.addMedia(red);
		const clipId = addAvatarClip(d, mediaId);
		// a still the browser cannot decode (HEIF, EXR…): the probe says so
		d.doc = structuredClone(d.doc) as ProjectDocument;
		const stream = d.doc.media[mediaId]!.probe.streams.find((x) => x.type === 'video')!;
		(stream as { browserDecodable?: boolean }).browserDecodable = false;
		const ensured: string[] = [];
		const variants = {
			ensureAndWait: async (r: { mediaKey: string }, kind: string) => {
				ensured.push(`${r.mediaKey}:${kind}`);
				return '/tmp/display.png';
			},
			url: (r: { mediaKey: string }, kind: string) => `/media/${r.mediaKey}/variant/${kind}`,
		} as unknown as VariantService;
		const ext = createImportsExtension({ variants, registry: coreServices(app).registry });
		for (const purpose of ['native', 'remotion'] as const) {
			const p = await plan(d);
			const ctx = {
				signal: new AbortController().signal,
				stage: () => undefined,
				scratchDir: async () => tmpdir(),
				log: () => undefined,
				jobId: 'job_test',
				purpose,
			};
			const art = (await ext.prepare!(p, ctx)) as Map<string, { proxyUrl?: string }>;
			expect(art.get(mediaId)?.proxyUrl, purpose).toBe(`/media/${red.mediaKey}/variant/display`);
			if (purpose === 'native') {
				// the layer bake's document draws the display picture
				const b = await svc.planBake(p, clipOf(p, clipId), { env: ENV });
				expect(b.doc.media[mediaId]?.browserDecodable).toBe(false);
				expect(b.doc.media[mediaId]?.proxyUrl).toMatch(
					new RegExp(`/media/${red.mediaKey}/variant/display\\?.+`),
				);
			}
		}
		expect(ensured).toEqual([`${red.mediaKey}:display`, `${red.mediaKey}:display`]);
	});

	it('media no picture can show (a video, a PDF page) block the export by name instead of drawing the placeholder', async () => {
		const d = new DocBuilder('hd-720p-30');
		const mediaId = d.addMedia(red);
		addAvatarClip(d, mediaId);
		d.doc = structuredClone(d.doc) as ProjectDocument;
		(d.doc.media[mediaId] as { kind: string }).kind = 'video';
		await expect(plan(d)).rejects.toMatchObject({
			code: 'TEMPLATE_MEDIA_UNDRAWABLE',
			message: expect.stringContaining(`${mediaId} (a video medium)`),
		});
	});

	it('templatePictureProblem: stills (and SVG) are pictures; videos, Lottie and PDF pages are not', () => {
		expect(templatePictureProblem({ kind: 'image' })).toBeNull();
		expect(templatePictureProblem({ kind: 'image', vector: { format: 'svg' } })).toBeNull();
		expect(templatePictureProblem({ kind: 'image', vector: { format: 'pdf' } })).toBe('a pdf page');
		expect(templatePictureProblem({ kind: 'image', lottie: {} })).toBe('a Lottie animation');
		expect(templatePictureProblem({ kind: 'video' })).toBe('a video medium');
	});
});
