// spatial-points: spatial (motion path) interpolation of point keys through the interchange formats
// (docs/wp-notes/spatial-points.md). FCPXML's `curve` (linear | smooth) is a key's spatial interpolation, with no
// handle data; FCP 7 XML carries the key values only; OTIO keeps the JasperEditor keys whole. Every loss is reported.
import type { Animatable, Keyframe, Spatial, Transform, Vec2 } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { exportFcp7, importFcp7 } from '../src/fcp7.ts';
import { exportFcpxml, importFcpxml } from '../src/fcpxml.ts';
import { exportOtio, importOtio } from '../src/otio.ts';
import { Report } from '../src/report.ts';
import { clip, media, project, sequence } from './support/ir.ts';

const R = { num: 25, den: 1 };
const F = 705_600_000 / 25;
const LIN = { influence: 1 / 3, slope: 1 };

function pkey(frame: number, value: Vec2, spatial?: Spatial): Keyframe<Vec2> {
	return {
		id: `kf${frame}`,
		time: frame * F,
		value,
		interpolation: 'linear',
		easeIn: { ...LIN },
		easeOut: { ...LIN },
		...(spatial ? { spatial } : {}),
	};
}
const auto: Spatial = { mode: 'auto-bezier', inTangent: [0, 0], outTangent: [0, 0], auto: 'proportional' };
const bez: Spatial = { mode: 'bezier', inTangent: [-0.1, 0], outTangent: [0.1, 0.05] };
const lin: Spatial = { mode: 'linear', inTangent: [0, 0], outTangent: [0, 0] };

function withPaths() {
	const p = project();
	const m = media(p, '/media/a.mov', true, false, R, 400);
	const sid = sequence(p, 'Seq', R);
	const c = clip(p, sid, 'video', 0, m, 0, 200, 0);
	const a = (v: Vec2): Animatable<Vec2> => ({ value: v, keyframes: [] });
	c.transform = {
		position: {
			value: [100, 100],
			keyframes: [pkey(0, [100, 100], auto), pkey(50, [800, 300], auto), pkey(100, [1500, 100], lin)],
		},
		anchor: a([960, 540]),
		scale: { value: 100, keyframes: [] },
		scaleWidth: { value: 100, keyframes: [] },
		uniformScale: true,
		rotation: { value: 0, keyframes: [] },
		flipH: false,
		flipV: false,
	} as Transform;
	c.effects.push({
		id: 'fx1',
		effectId: 'jasper.transform',
		effectVersion: 1,
		enabled: true,
		params: {
			position: {
				value: [0.2, 0.5],
				keyframes: [pkey(0, [0.2, 0.5], bez), pkey(50, [0.5, 0.2], auto), pkey(100, [0.8, 0.5], lin)],
			},
		},
	});
	return { p, sid };
}

describe('spatial-points interchange', () => {
	it('FCPXML: a point key’s curve is its spatial interpolation, for Motion and effect points, and reads back', () => {
		const { p, sid } = withPaths();
		const report = new Report();
		const text = exportFcpxml(p, sid, {}, report);
		// Motion Position: auto, auto, linear → smooth, smooth, linear (the temporal interp stays linear).
		const position = text.slice(text.indexOf('<param name="position"'));
		expect(
			[...position.matchAll(/<keyframe [^>]*interp="(\w+)" curve="(\w+)"/g)].slice(0, 3).map((m) => m[2]),
		).toEqual(['smooth', 'smooth', 'linear']);
		// The effect point is written with its keyframes (it used to be its static value only).
		const fxParam = text.slice(text.indexOf('<param name="position" key="position"'));
		expect(fxParam).toContain('<keyframeAnimation>');
		expect(
			[...fxParam.matchAll(/<keyframe [^>]*value="([^"]+)"[^>]*curve="(\w+)"/g)]
				.slice(0, 3)
				.map((m) => [m[1], m[2]]),
		).toEqual([
			['0.2 0.5', 'smooth'],
			['0.5 0.2', 'smooth'],
			['0.8 0.5', 'linear'],
		]);
		// Handles are lost (warning for the Bezier key), smooth curves are approximated (info).
		const msgs = JSON.stringify(report.entries);
		expect(msgs).toContain('motion-path handles of Transform Position');
		expect(msgs).toContain('curved motion path of position');
		const back = importFcpxml(text, {}, new Report());
		const c = back.sequences[back.top[0]!]!.video[0]!.clips[0]!;
		expect(c.transform!.position.keyframes.map((k) => k.spatial?.mode ?? 'linear')).toEqual([
			'auto-bezier',
			'auto-bezier',
			'linear',
		]);
		const fx = c.effects.find((e) => e.effectId === 'jasper.transform')!;
		const kfs = fx.params.position!.keyframes as Keyframe<Vec2>[];
		expect(kfs.map((k) => k.value)).toEqual([
			[0.2, 0.5],
			[0.5, 0.2],
			[0.8, 0.5],
		]);
		// No handle data in FCPXML: the Bezier key comes back as the smooth (Auto Bezier) path.
		expect(kfs.map((k) => k.spatial?.mode ?? 'linear')).toEqual(['auto-bezier', 'auto-bezier', 'linear']);
	});

	it('FCP 7 XML writes point key values only and reports the curved paths', () => {
		const { p, sid } = withPaths();
		const report = new Report();
		const text = exportFcp7(p, sid, {}, report);
		const msgs = JSON.stringify(report.entries);
		expect(msgs).toContain('curved motion path of Center is not carried by FCP 7 XML');
		expect(msgs).toContain('curved motion path of Position is not carried by FCP 7 XML');
		const back = importFcp7(text, {}, new Report());
		const fx = back.sequences[back.top[0]!]!.video[0]!.clips[0]!.effects.find(
			(e) => e.effectId === 'jasper.transform',
		)!;
		expect(fx.params.position!.keyframes.map((k) => k.value)).toEqual([
			[0.2, 0.5],
			[0.5, 0.2],
			[0.8, 0.5],
		]);
	});

	it('OTIO keeps every key’s spatial data exactly', () => {
		const { p, sid } = withPaths();
		const back = importOtio(exportOtio(p, sid, {}, new Report()), {}, new Report());
		const c = back.sequences[back.top[0]!]!.video[0]!.clips[0]!;
		expect(c.transform!.position.keyframes.map((k) => k.spatial)).toEqual([auto, auto, lin]);
		const fx = c.effects.find((e) => e.effectId === 'jasper.transform')!;
		expect(fx.params.position!.keyframes.map((k) => k.spatial)).toEqual([bez, auto, lin]);
	});
});
