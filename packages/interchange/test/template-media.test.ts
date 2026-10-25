// Template media params (avatars, docs/wp-notes/social-comments.md "Template media params") through the
// JasperEditor metadata of an OTIO export: the medium travels with the motion graphic and is remapped on import;
// a medium the document does not carry clears the param (reported) instead of leaving a dangling reference.
import { type Clip, checkInvariants } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { videoAsset } from '../../project/test/helpers.ts';
import { avatarRegistries } from '../../project/test/template-media-fixture.ts';
import { exportTimeline, importTimeline } from '../src/index.ts';
import { Harness } from './support/rich.ts';

type Mg = Extract<Clip, { kind: 'motion-graphic' }>;
const NOW = '2026-10-25T00:00:00.000Z';

function project() {
	const h = new Harness({ ctx: { registries: avatarRegistries() } });
	const reg = h.ok([{ type: 'media.register', asset: videoAsset({ kind: 'image' }) }]);
	const mediaId = (reg.results[0] as { mediaId: string }).mediaId;
	h.ok([
		{
			type: 'clip.addMotionGraphic',
			at: 0,
			duration: 60,
			track: 'V1',
			template: { id: 'avatar-card', version: 1 },
			params: { avatar: { mediaId } },
		},
	]);
	return { h, mediaId };
}

function importInto(bytes: Uint8Array) {
	const imp = importTimeline(bytes, { format: 'otio', now: NOW, rate: { num: 30, den: 1 } });
	const target = new Harness({ seed: 4242, ctx: { registries: avatarRegistries() } });
	const r = target.ok([{ type: 'project.importTimeline', fragment: imp }]);
	const seqId = (r.results[0] as { topSequenceIds: string[] }).topSequenceIds[0]!;
	const mg = Object.values(target.doc.sequences[seqId]!.clips).find((c) => c.kind === 'motion-graphic') as Mg;
	expect(checkInvariants(target.doc, { mgTemplates: avatarRegistries().mgTemplates })).toEqual([]);
	return { imp, target, mg };
}

describe('template media params in .jasper interchange metadata (OTIO)', () => {
	it('carries the avatar medium and remaps the param on import', () => {
		const { h, mediaId } = project();
		const out = exportTimeline(h.doc, h.seqId, 'otio');
		const { target, mg } = importInto(out.files[0]!.bytes);
		const id = (mg.params.avatar as { mediaId: string }).mediaId;
		expect(target.doc.media[id]?.fingerprint).toBe(h.doc.media[mediaId]!.fingerprint);
	});

	it('clears an avatar whose medium the document does not carry, with a warning', () => {
		const { h, mediaId } = project();
		const out = exportTimeline(h.doc, h.seqId, 'otio');
		const json = JSON.parse(new TextDecoder().decode(out.files[0]!.bytes));
		// Drop the medium from the carried JasperEditor entities (a hand-edited or truncated file).
		const strip = (v: unknown): void => {
			if (!v || typeof v !== 'object') return;
			const o = v as Record<string, unknown>;
			if (Array.isArray(o.media))
				o.media = (o.media as { id?: string }[]).filter((m) => m?.id !== mediaId) as never;
			for (const x of Object.values(o)) strip(x);
		};
		strip(json);
		const { imp, mg } = importInto(new TextEncoder().encode(JSON.stringify(json)));
		expect(mg.params.avatar).toBeNull();
		expect(imp.warnings.some((w) => /does not carry \(params\.avatar\); cleared/.test(w.message))).toBe(true);
	});
});
