// Run: pnpm exec tsx apps/web/bench/timeline-pointer.ts [baseline-controller-module]
// The optional module path is relative to the working directory. Alternate both implementations
// in one process to compare at the same host load; fixture setup and warm-up are outside timings.
import { strictEqual } from 'node:assert';
import { cpus, loadavg, release } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { TimelineController } from '../src/panels/timeline/state/controller.ts';
import { createTimelineUiStore } from '../src/panels/timeline/state/ui-store.ts';
import { setupTimeline, solid } from '../test/timeline-helpers.ts';

const implementations = [{ label: 'current', Controller: TimelineController }];
if (process.argv[2]) {
	const baseline = await import(pathToFileURL(resolve(process.argv[2])).href);
	implementations.unshift({ label: 'baseline', Controller: baseline.TimelineController });
}
console.log(
	JSON.stringify({
		node: process.version,
		platform: `${process.platform} ${release()}`,
		cpu: cpus()[0]?.model,
		cores: cpus().length,
		load: loadavg(),
	}),
);
for (const count of [1000, 5000]) {
	const t = setupTimeline({ pxPerFrame: 2 });
	t.apply(Array.from({ length: count }, (_, i) => solid(i * 40, 30, 'V1')));
	t.session.setToggles({ activeTool: 'razor', snapping: true });
	t.session.transport.seek(12);
	const y = t.rowY('V1');
	const states = implementations.map(({ label, Controller }) => {
		const ui = createTimelineUiStore();
		const controller = new Controller({
			session: t.session,
			sequenceId: () => t.seqId,
			ui,
			geometry: t.geometry,
		});
		return { label, controller, ui, samples: [] as number[], checksum: 0 };
	});
	for (const scenario of ['razor-hover', 'snapped-scrub'] as const) {
		for (const state of states) {
			state.samples = [];
			state.checksum = 0;
		}
		const run = (state: (typeof states)[number], i: number) => {
			// Vary the pointer across clip interiors and snap thresholds, never beyond the viewport.
			const frame = ((i * 7) % 12) * 40 + 8 + (i % 16);
			if (scenario === 'razor-hover') {
				state.controller.hover(t.pt(t.x(frame), y));
				state.checksum += state.ui.getState().razor?.frame ?? 0;
			} else state.checksum += state.controller.scrubTo(t.x(frame), true);
		};
		for (const state of states) for (let i = 0; i < 100; i++) run(state, i);
		const iterations = 300;
		for (let batch = 0; batch < 9; batch++) {
			for (const state of batch % 2 ? states : [...states].reverse()) {
				const start = performance.now();
				for (let i = 0; i < iterations; i++) run(state, i);
				state.samples.push(((performance.now() - start) * 1000) / iterations);
			}
		}
		for (const state of states) {
			strictEqual(state.checksum, states[0]!.checksum, `${scenario} output differs`);
			state.samples.sort((a, b) => a - b);
			console.log(
				`${count} clips / ${scenario} / ${state.label}: median ${state.samples[4]!.toFixed(3)} us/op (9 x ${iterations}); checksum ${state.checksum}`,
			);
		}
	}
}
console.log(JSON.stringify({ loadAfter: loadavg() }));
