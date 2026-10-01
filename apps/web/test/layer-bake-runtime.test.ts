// Graded previews of DOM layers in the editor (S11:LBK-010, FIX-002): the runtime requests
// `POST /api/layer-bake/preview` for text/shape/anime layers with colour effects once they stop changing, maps the
// finished job's preview to the layer (also after moving it in time) and drops it when the layer changes.
import type { EngineJob, TypedEvent } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { mgRegistry } from '@jasper/mg-templates';
import {
	buildRenderSnapshot,
	type Command,
	createEmptyProject,
	createSeededIdSource,
	defaultRegistries,
	LUMETRI_EFFECT_ID,
	type RenderVisualClip,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayerBakeRuntime, layerIdentity } from '../src/layer-bake/runtime.ts';

function makeSession() {
	const ids = createSeededIdSource(5);
	const document = createEmptyProject({ ids, name: 'Bake test', preset: 'hd-1080p-30' });
	const session = new EditorSession({
		projectId: document.projectId,
		document,
		ctx: { ids, now: () => '2026-10-01T10:00:00.000Z', registries: defaultRegistries(mgRegistry) },
		coalesceWindowMs: 0,
	});
	const r = session.apply({
		label: 'setup',
		origin: 'system',
		commands: [
			{ type: 'clip.addText', at: 0, duration: 60, track: 'V1', content: { text: 'Graded' }, ref: '$g' },
			{ type: 'clip.addText', at: 0, duration: 60, track: 'V2', content: { text: 'Plain' }, ref: '$p' },
			{
				type: 'effect.add',
				target: { clipId: '$g' },
				effectId: LUMETRI_EFFECT_ID,
				params: { saturation: 0 },
			},
		] as Command[],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return { session, graded: r.refs.$g!, plain: r.refs.$p! };
}

function fakeEngine() {
	const calls: { name: string; body: Record<string, unknown> }[] = [];
	const listeners = new Set<(e: TypedEvent | null) => void>();
	let n = 0;
	const client = {
		call: async (name: string, args: { body: Record<string, unknown> }) => {
			calls.push({ name, body: args.body });
			n++;
			return { id: `job_${String(n).padStart(16, '0')}`, kind: 'layer-bake', state: 'queued' } as EngineJob;
		},
	} as unknown as EngineClient;
	return {
		calls,
		link: {
			client,
			subscribe: (l: (e: TypedEvent | null) => void) => {
				listeners.add(l);
				return () => listeners.delete(l);
			},
		},
		finish(jobId: string, key: string) {
			const job = {
				id: jobId,
				kind: 'layer-bake',
				state: 'succeeded',
				finishedAt: 'now',
				result: {
					key,
					sourceKey: 'src',
					previewUrl: `/mg/layers/${key}/preview.webm`,
					startFrame: 0,
					durationFrames: 60,
					rect: { x: 10, y: 20, w: 300, h: 100 },
					width: 300,
					height: 100,
				},
			} as unknown as EngineJob;
			for (const l of listeners) l({ type: 'job.finished', payload: job } as TypedEvent);
		},
	};
}

function clipOf(session: EditorSession, id: string): RenderVisualClip {
	const s = session.store.getState();
	const snap = buildRenderSnapshot(s.document, s.activeSequenceId!, {
		resolveMedia: () => null,
		resolveFont: () => null,
	});
	return snap.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === id)!;
}

describe('LayerBakeRuntime (S11:LBK-010)', () => {
	beforeEach(() => {
		vi.stubGlobal('fetch', async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }));
	});
	afterEach(() => vi.unstubAllGlobals());

	it('asks for the graded preview of graded DOM layers only, after they stop changing', async () => {
		const { session, graded } = makeSession();
		const engine = fakeEngine();
		const rt = new LayerBakeRuntime(session, engine.link, 40);
		try {
			await vi.waitFor(() => expect(engine.calls).toHaveLength(1), { timeout: 3000 });
			const { name, body } = engine.calls[0]!;
			expect(name).toBe('layerBakePreview');
			expect(body).toMatchObject({ clipId: graded, sequenceId: session.store.getState().activeSequenceId });
			expect((body.envelope as { document: unknown }).document).toBeTruthy();
			expect(rt.previewFor(clipOf(session, graded))).toBeNull();
			engine.finish('job_0000000000000001', 'k'.repeat(40));
			await vi.waitFor(() => expect(rt.previewFor(clipOf(session, graded))).not.toBeNull());
			expect(rt.previewFor(clipOf(session, graded))).toEqual({
				url: `/mg/layers/${'k'.repeat(40)}/preview.webm`,
				rect: { x: 10, y: 20, w: 300, h: 100 },
			});
			// Moving the clip in time keeps its preview (no new request).
			session.apply({
				label: 'move',
				origin: 'user',
				commands: [{ type: 'clip.move', clipIds: [graded], deltaFrames: 30 } as Command],
			});
			await new Promise((r) => setTimeout(r, 300));
			expect(rt.previewFor(clipOf(session, graded))).not.toBeNull();
			expect(engine.calls).toHaveLength(1);
			// Editing the text drops it and asks again.
			session.apply({
				label: 'edit',
				origin: 'user',
				commands: [
					{ type: 'clip.update', clipIds: [graded], patch: { content: { text: 'Edited' } } } as Command,
				],
			});
			expect(rt.previewFor(clipOf(session, graded))).toBeNull();
			await vi.waitFor(() => expect(engine.calls).toHaveLength(2), { timeout: 3000 });
		} finally {
			rt.dispose();
		}
	});

	it('the identity ignores the position in time and the clip id, not the grade or the content', () => {
		const { session, graded } = makeSession();
		const seq = { width: 1920, height: 1080, fps: { num: 30, den: 1 } };
		const c = clipOf(session, graded);
		const id = layerIdentity(c, seq, {});
		expect(layerIdentity({ ...c, start: c.start + 100, clipId: 'clp_other' }, seq, {})).toBe(id);
		expect(layerIdentity({ ...c, effects: [] }, seq, {})).not.toBe(id);
		expect(layerIdentity({ ...c, intrinsicBox: { width: 1, height: 1 } }, seq, {})).not.toBe(id);
		expect(layerIdentity(c, { ...seq, width: 1280 }, {})).not.toBe(id);
	});
});
