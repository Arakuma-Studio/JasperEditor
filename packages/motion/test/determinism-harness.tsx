import { type TextAnimationSide, type TextAnimationSpec, toJsonSchema } from '@jasper/project';
import fc from 'fast-check';
import { expect } from 'vitest';
import { frameToMs, hash32, seekCanonical } from '../src/runtime/index.ts';
import type { TextAnimationBuildContext, TextAnimationImpl } from '../src/text/index.ts';

// Keep the expected identity transform and reveal independent of REST_UNIT_VALUES.
const rest = { opacity: 1, x: 0, y: 0, scale: 1, rotate: 0, blur: 0, letterSpacing: 0, reveal: 1 };

function visitOrders(frames: number[]): number[][] {
	return [
		frames,
		[...frames].reverse(),
		...fc.sample(fc.shuffledSubarray(frames, { minLength: frames.length }), { seed: 4242, numRuns: 4 }),
		[...frames, ...frames.slice().reverse()],
	];
}

function paramVariants(spec: TextAnimationSpec | undefined): Record<string, unknown>[] {
	if (!spec) return [{}];
	const out: Record<string, unknown>[] = [{ ...spec.defaults }];
	const props =
		(toJsonSchema(spec.paramsSchema) as { properties?: Record<string, { enum?: string[] }> }).properties ??
		{};
	for (const [key, p] of Object.entries(props))
		for (const v of p.enum ?? []) {
			if (v === spec.defaults[key]) continue;
			const variant = { ...spec.defaults, [key]: v };
			if (spec.paramsSchema.safeParse(variant).success) out.push(variant);
		}
	return out;
}

type TextCase = { label: string; ctx: TextAnimationBuildContext; fps: number };

/** [fps, window frames]: 30 fps and an odd rate whose frame times are not whole milliseconds. */
const RATES: readonly (readonly [number, number])[] = [
	[30, 18],
	[24, 13],
];

function textAnimationCases(impl: TextAnimationImpl, spec?: TextAnimationSpec): TextCase[] {
	const sides: readonly TextAnimationSide[] = spec?.phases ?? ['in', 'out'];
	const out: TextCase[] = [];
	const variants = paramVariants(spec);
	for (const side of sides)
		for (const [vi, params] of variants.entries())
			for (const units of vi === 0 ? [1, 5, 37] : [7])
				for (const [fps, frames] of vi === 0 && units === 5 ? RATES : RATES.slice(0, 1))
					out.push({
						label: `${impl.key} ${side} units=${units} fps=${fps} params=${JSON.stringify(params)}`,
						fps,
						ctx: {
							units,
							// six units per line (line units and line-aware presets)
							lineOf: Array.from({ length: units }, (_, i) => Math.floor(i / 6)),
							side,
							durationMs: frameToMs(frames, fps),
							params,
							seed: hash32('clp_DETERMINISM00000', 'text-anim', side),
							box: { width: 800, height: 240 },
						},
					});
	return out;
}

export function checkTextAnimation(impl: TextAnimationImpl, spec?: TextAnimationSpec): void {
	for (const { label, ctx, fps } of textAnimationCases(impl, spec)) {
		const frames = Array.from({ length: Math.ceil((ctx.durationMs * fps) / 1000) + 5 }, (_, i) => i - 2);
		const unitValues = (built: ReturnType<TextAnimationImpl['build']>) =>
			built.targets.map((target) =>
				Object.fromEntries(Object.keys(rest).map((key) => [key, target[key as keyof typeof rest]])),
			);
		const read = (built: ReturnType<TextAnimationImpl['build']>, frame: number) => {
			const ms = frameToMs(frame, fps);
			seekCanonical(built.timeline, ms);
			const units = unitValues(built);
			const shown = units.filter((unit) => unit.reveal! >= 1).length;
			return { units, caret: impl.caretVisible?.({ ...ctx, ms, fps, shown }) };
		};
		const fresh = new Map(frames.map((frame) => [frame, read(impl.build(ctx), frame)]));
		const failures: string[] = [];
		const independent = impl.build(ctx);
		const before = read(independent, 0).units;
		read(impl.build(ctx), frames[frames.length - 1]!);
		if (JSON.stringify(unitValues(independent)) !== JSON.stringify(before))
			failures.push('seeking another build changed the first build');
		for (const [frame, { units }] of fresh) {
			if (units.length !== ctx.units) failures.push(`frame ${frame}: missing units`);
			for (const unit of units) {
				if (!Object.values(unit).every(Number.isFinite)) failures.push(`frame ${frame}: nonfinite values`);
				if (frameToMs(frame, fps) >= ctx.durationMs)
					for (const [key, value] of Object.entries(rest))
						if (Math.abs(unit[key]! - value) >= 0.0000005) failures.push(`frame ${frame}: wrong rest ${key}`);
			}
		}
		for (const order of visitOrders(frames)) {
			const built = impl.build(ctx);
			for (const frame of order)
				if (JSON.stringify(read(built, frame)) !== JSON.stringify(fresh.get(frame)))
					failures.push(`frame ${frame}: output depends on visit order`);
		}
		expect(failures, label).toEqual([]);
	}
}
