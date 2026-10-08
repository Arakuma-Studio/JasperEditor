// Editor-side performance counters (workstream `previews`, docs/performance.md): what the MCP `perf_stats` tool and
// scripts/performance.mjs read from an open editor window through the agent relay (UI action `perf`) — the Program
// monitor's playback (frames shown / dropped, fps, stalls recovered, buffering), the render bar and the UI frame rate.
import { previewSettingsOf } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import type { PlaybackDriver } from '../panels/program/playback-driver.ts';
import { renderBarSpans, segmentsOf } from '../panels/timeline/model/renderbar.ts';
import { previewStatusStore } from './store.ts';

let program: { session: EditorSession; driver: PlaybackDriver } | null = null;

/** The Program monitor registers its session and driver while mounted. */
export function registerProgramPerf(session: EditorSession, driver: PlaybackDriver): () => void {
	const entry = { session, driver };
	program = entry;
	return () => {
		if (program === entry) program = null;
	};
}

/** Animation frames per second over `ms` (the UI thread's responsiveness while measuring). */
function uiFps(ms: number): Promise<number | null> {
	if (typeof requestAnimationFrame === 'undefined') return Promise.resolve(null);
	return new Promise((resolve) => {
		let frames = 0;
		const t0 = performance.now();
		const tick = () => {
			frames++;
			const dt = performance.now() - t0;
			if (dt >= ms) resolve(Math.round((frames / dt) * 10000) / 10);
			else requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
}

export async function editorPerfStats(args: { sampleMs?: number } = {}): Promise<Record<string, unknown>> {
	const p = program;
	const fps = await uiFps(Math.min(5000, Math.max(100, args.sampleMs ?? 500)));
	const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } })
		.memory;
	let renderBar: Record<string, unknown> | null = null;
	if (p) {
		const doc = p.session.getCommitted();
		const seqId = p.session.getState().activeSequenceId;
		const seq = seqId ? doc.sequences[seqId] : undefined;
		if (seq && seqId) {
			const segs = segmentsOf(doc, seqId);
			const status = previewStatusStore.get(previewSettingsOf(seq));
			const spans = renderBarSpans(segs, status?.video ?? null);
			const count = (state: string) =>
				segs.filter((s) =>
					state === 'green'
						? status?.video.has(s.hash)
						: !status?.video.has(s.hash) &&
							(state === 'none'
								? s.need === 'none'
								: state === 'red'
									? s.need === 'render'
									: s.need === 'realtime'),
				).length;
			renderBar = {
				sequenceId: seqId,
				segments: segs.length,
				green: count('green'),
				yellow: count('yellow'),
				red: count('red'),
				none: count('none'),
				spans: spans.length,
			};
		}
	}
	return {
		at: new Date().toISOString(),
		playback: p ? { ...p.driver.stats, frame: p.session.transport.getState().frame } : null,
		uiFps: fps,
		...(mem
			? {
					heapMB: Math.round(mem.usedJSHeapSize / 1048576),
					heapTotalMB: Math.round(mem.totalJSHeapSize / 1048576),
				}
			: {}),
		renderBar,
	};
}
