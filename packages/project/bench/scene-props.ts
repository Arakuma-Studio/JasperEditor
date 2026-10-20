// Run: pnpm exec tsx packages/project/bench/scene-props.ts
// Optional argument: a scene module path relative to the working directory (for a baseline revision).
// Reproduce before/after from the repository root without changing the working implementation:
// git show b56f7d4:packages/project/src/render/scene.ts > packages/project/src/render/scene.perf-baseline.ts
// pnpm exec tsx packages/project/bench/scene-props.ts packages/project/src/render/scene.perf-baseline.ts
// pnpm exec tsx packages/project/bench/scene-props.ts
// rm packages/project/src/render/scene.perf-baseline.ts
// The sibling location preserves the baseline module's relative imports. Both runs use current shared
// dependencies and the same fixtures; only the scene implementation differs.
// Measures warm scene resolution only: fixture construction and hashing are not timed.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { buildRenderSnapshot, resolveSceneAt as currentResolveSceneAt } from '../src/index.ts';
import { Harness } from '../test/helpers.ts';

const sceneModule = process.argv[2];
const resolveSceneAt: typeof currentResolveSceneAt = sceneModule
	? (await import(pathToFileURL(resolve(sceneModule)).href)).resolveSceneAt
	: currentResolveSceneAt;

const results = [];
for (const [layers, grades, animated] of [
	[8, 0, false],
	[8, 1, false],
	[32, 1, false],
	[128, 3, false],
	[32, 1, true],
] as const) {
	const h = new Harness();
	h.ok([
		{ type: 'clip.addSolid', at: 0, duration: 300, track: 'V1', color: [0.2, 0.5, 1, 1], ref: '$clip' },
		...Array.from({ length: grades }, () => ({
			type: 'effect.add' as const,
			target: { clipId: '$clip' },
			effectId: 'jasper.lumetri',
		})),
		...(animated
			? [
					{
						type: 'param.setAnimated' as const,
						target: ['clip', '$clip', 'opacity'],
						animated: true,
						at: { frames: 0 },
					},
					{ type: 'param.set' as const, target: ['clip', '$clip', 'opacity'], value: 0, at: { frames: 0 } },
					{
						type: 'param.set' as const,
						target: ['clip', '$clip', 'opacity'],
						value: 100,
						at: { frames: 299 },
					},
				]
			: []),
	]);
	const snapshot = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null });
	const template = snapshot.videoTracks[0]!;
	snapshot.videoTracks = Array.from({ length: layers }, (_, i) => ({
		...template,
		trackId: `V${i + 1}`,
		clips: [{ ...structuredClone(template.clips[0]!), clipId: `clip-${i}` }],
	}));
	const hash = createHash('sha256');
	for (const frame of [0, 150, 299, 12, 298, 0]) {
		const scene = resolveSceneAt(snapshot, frame);
		hash.update(JSON.stringify(scene));
	}
	let checksum = 0;
	const run = () => {
		for (let frame = 0; frame < 300; frame++) checksum += resolveSceneAt(snapshot, frame)[0]!.props.opacity;
	};
	const warmup = performance.now() + 300;
	while (performance.now() < warmup) run();
	const samples = [];
	const cpuSamples = [];
	for (let i = 0; i < 7; i++) {
		const start = performance.now();
		const cpuStart = process.cpuUsage();
		let batches = 0;
		do {
			run();
			batches++;
		} while (performance.now() - start < 150);
		samples.push((performance.now() - start) / (batches * 300));
		const cpu = process.cpuUsage(cpuStart);
		cpuSamples.push((cpu.user + cpu.system) / (1000 * batches * 300));
	}
	samples.sort((a, b) => a - b);
	cpuSamples.sort((a, b) => a - b);
	results.push({
		layers,
		grades,
		animated,
		medianCpuMsPerFrame: cpuSamples[3],
		medianMsPerFrame: samples[3],
		minMsPerFrame: samples[0],
		maxMsPerFrame: samples[6],
		sha256: hash.digest('hex'),
		checksum,
	});
}
console.log(
	JSON.stringify({ node: process.version, sceneModule: sceneModule ?? 'current', results }, null, 2),
);
