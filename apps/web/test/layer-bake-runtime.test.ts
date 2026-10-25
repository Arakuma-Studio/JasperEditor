import type { EngineJob, TypedEvent } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { mgRegistry } from '@jasper/mg-templates';
import {
	buildRenderSnapshot,
	type Command,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	LUMETRI_EFFECT_ID,
	type RenderVisualClip,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayerBakeRuntime } from '../src/layer-bake/runtime.ts';

function makeSession() {
	const ids = createCounterIdSource(5);
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
		vi.useFakeTimers();
		vi.stubGlobal('fetch', async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }));
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('asks for the graded preview of graded DOM layers only, after they stop changing', async () => {
		const { session, graded } = makeSession();
		const engine = fakeEngine();
		const rt = new LayerBakeRuntime(session, engine.link);
		try {
			await vi.advanceTimersByTimeAsync(1999);
			expect(engine.calls).toHaveLength(0);
			await vi.advanceTimersByTimeAsync(1);
			expect(engine.calls).toHaveLength(1);
			const { name, body } = engine.calls[0]!;
			expect(name).toBe('layerBakePreview');
			expect(body).toMatchObject({ clipId: graded, sequenceId: session.store.getState().activeSequenceId });
			expect((body.envelope as { document: unknown }).document).toBeTruthy();
			expect(rt.previewFor(clipOf(session, graded))).toBeNull();
			engine.finish('job_0000000000000001', 'k'.repeat(40));
			await vi.advanceTimersByTimeAsync(0);
			expect(rt.previewFor(clipOf(session, graded))).toEqual({
				url: `/mg/layers/${'k'.repeat(40)}/preview.webm`,
				rect: { x: 10, y: 20, w: 300, h: 100 },
			});
			const move = session.apply({
				label: 'move',
				origin: 'user',
				commands: [{ type: 'clip.move', clipIds: [graded], deltaFrames: 30 } as Command],
			});
			expect(move.ok).toBe(true);
			await vi.advanceTimersByTimeAsync(200);
			expect(rt.previewFor(clipOf(session, graded))).not.toBeNull();
			expect(engine.calls).toHaveLength(1);
			const edit = session.apply({
				label: 'edit',
				origin: 'user',
				commands: [
					{ type: 'clip.update', clipIds: [graded], patch: { content: { text: 'Edited' } } } as Command,
				],
			});
			expect(edit.ok).toBe(true);
			expect(rt.previewFor(clipOf(session, graded))).toBeNull();
			await vi.advanceTimersByTimeAsync(2150);
			expect(engine.calls).toHaveLength(2);
		} finally {
			rt.dispose();
		}
	}, 10_000);

	it('a layer edited just before its request fires is not stored under its old identity', async () => {
		const { session, graded } = makeSession();
		const engine = fakeEngine();
		const rt = new LayerBakeRuntime(session, engine.link);
		try {
			await vi.advanceTimersByTimeAsync(10);
			// The request is due 2 s after the scan; the text changes 50 ms before that (the rescan follows 150 ms
			// after the change, i.e. after the request fired).
			await vi.advanceTimersByTimeAsync(1940);
			const edit = session.apply({
				label: 'edit',
				origin: 'user',
				commands: [
					{ type: 'clip.update', clipIds: [graded], patch: { content: { text: 'Late edit' } } } as Command,
				],
			});
			expect(edit.ok).toBe(true);
			await vi.advanceTimersByTimeAsync(100);
			expect(engine.calls).toHaveLength(0);
			await vi.advanceTimersByTimeAsync(2500);
			expect(engine.calls).toHaveLength(1);
			const sent = engine.calls[0]!.body.envelope as { document: unknown; revision: number };
			expect(JSON.stringify(sent.document)).toContain('Late edit');
			expect(sent.revision).toBe(session.revision);
			engine.finish('job_0000000000000001', 'e'.repeat(40));
			await vi.advanceTimersByTimeAsync(10);
			expect(rt.previewFor(clipOf(session, graded))?.url).toBe(`/mg/layers/${'e'.repeat(40)}/preview.webm`);
		} finally {
			rt.dispose();
		}
	});
});
