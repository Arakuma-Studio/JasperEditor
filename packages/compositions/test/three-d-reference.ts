// Independent CPU reference for solid layers, whose pixels are known without a browser.
// Pointwise adjustments operate on the full backdrop in straight RGBA, including 3D runs and blend modes.
import {
	activeCameraAt,
	applyMat3,
	blendPixel,
	type ClassicSetup,
	type CpuPlane,
	clipContentTime,
	compositeClassicCPU,
	dissolveSeed,
	dofPicture,
	invertMat3,
	layerMapOf,
	layerWorldMatrix,
	lightsAt,
	materialAt,
	newFloatImage,
	prepareClassicPlane,
	type RenderSnapshot,
	type Rgba,
	resolveLayerProps,
	runs3d,
	stackAt,
} from '@jasper/project';

export function referenceFrame(
	snap: RenderSnapshot,
	frame: number,
	opts: { adjust?: (straight: Rgba) => Rgba } = {},
): Uint8ClampedArray {
	const W = snap.settings.width;
	const H = snap.settings.height;
	const canvas = newFloatImage(W, H);
	const bg = snap.settings.backgroundColor;
	for (let i = 0; i < W * H; i++)
		canvas.data.set([bg[0] * bg[3], bg[1] * bg[3], bg[2] * bg[3], bg[3]], i * 4);
	const clips = new Map(snap.videoTracks.flatMap((t) => t.clips).map((c) => [c.clipId, c]));
	const stack = stackAt(snap.videoTracks, frame);
	const runs = runs3d(stack);
	const camera = activeCameraAt(snap, frame);
	const setup: ClassicSetup = {
		width: W,
		height: H,
		scale: 1,
		frame: { width: W, height: H },
		camera,
		lights: lightsAt(snap.scene3d, frame, snap.settings.fps),
	};
	for (let k = 0; k < stack.length; k++) {
		const item = stack[k]!;
		const c = clips.get(item.key);
		if (c?.kind === 'adjustment' && opts.adjust) {
			for (let i = 0; i < W * H; i++) {
				const a = canvas.data[i * 4 + 3]!;
				if (a <= 0) continue;
				const s: Rgba = [
					canvas.data[i * 4]! / a,
					canvas.data[i * 4 + 1]! / a,
					canvas.data[i * 4 + 2]! / a,
					a,
				];
				const r = opts.adjust(s);
				canvas.data.set([r[0] * r[3], r[1] * r[3], r[2] * r[3], r[3]], i * 4);
			}
			continue;
		}
		if (!c || !('color' in c.source)) throw new Error(`reference: only solids (${item.key})`);
		const col = c.source.color;
		const t = clipContentTime(c, frame, snap.settings.fps);
		const props = resolveLayerProps(c, t);
		if (!item.is3d) {
			const inv = invertMat3(layerMapOf(props))!;
			for (let y = 0; y < H; y++)
				for (let x = 0; x < W; x++) {
					const [u, v] = applyMat3(inv, [x + 0.5, y + 0.5]);
					if (u < 0 || v < 0 || u >= c.intrinsicBox.width || v >= c.intrinsicBox.height) continue;
					const a = col[3] * (props.opacity / 100);
					const i = (y * W + x) * 4;
					const d: Rgba = [canvas.data[i]!, canvas.data[i + 1]!, canvas.data[i + 2]!, canvas.data[i + 3]!];
					canvas.data.set(blendPixel(c.blendMode, d, [col[0] * a, col[1] * a, col[2] * a, a], 0.5), i);
				}
			continue;
		}
		const run = runs.find((r) => r.members[0] === item.key);
		if (!run) continue;
		const planes: CpuPlane[] = [];
		run.members.forEach((id, order) => {
			const m = clips.get(id)!;
			const mt = clipContentTime(m, frame, snap.settings.fps);
			const mp = resolveLayerProps(m, mt);
			const color = (m.source as { color: number[] }).color;
			const w = m.intrinsicBox.width;
			const h = m.intrinsicBox.height;
			const pic = newFloatImage(w, h);
			for (let i = 0; i < w * h; i++)
				pic.data.set([color[0]! * color[3]!, color[1]! * color[3]!, color[2]! * color[3]!, color[3]!], i * 4);
			const p = prepareClassicPlane(setup, {
				key: id,
				width: w,
				height: h,
				layerToPicture: [1, 0, 0, 0, 1, 0, 0, 0, 1],
				world: layerWorldMatrix(m, mt, { cameraEye: camera.eye }),
				material: materialAt(m.threeD!.material, mt),
				opacity: mp.opacity / 100,
				mode: m.blendMode,
				seed: dissolveSeed(id, frame - m.start),
				order,
				draw: m.threeD!.material.castsShadows !== 'only',
			});
			if (p) planes.push({ ...p, pixels: p.dof && camera.dof ? dofPicture(p, pic, camera.dof) : pic });
		});
		compositeClassicCPU(canvas, setup, planes);
		k += run.members.length - 1;
	}
	const out = new Uint8ClampedArray(W * H * 4);
	for (let i = 0; i < W * H; i++) {
		const a = Math.min(1, Math.max(0, canvas.data[i * 4 + 3]!));
		for (let c = 0; c < 3; c++)
			out[i * 4 + c] = a > 0 ? Math.round((Math.min(a, Math.max(0, canvas.data[i * 4 + c]!)) / a) * 255) : 0;
		out[i * 4 + 3] = Math.round(a * 255);
	}
	return out;
}
