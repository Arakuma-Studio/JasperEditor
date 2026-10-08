// color-grade: face boxes in still frames for Colour Match's skin-tone protection ("Face Detection"), with the roto
// workstream's face models (MediaPipe BlazeFace via ONNX Runtime, models/face.ts). Runs in the jasper-roto child
// process like every model inference (heavy work never runs in the engine process, D-07):
//
//   jasper-roto --faces <spec.json> <out.json>
//
// The spec lists raw RGB24 frames (`path`, `width`, `height`); the output holds, per frame, the detected faces as
// normalised boxes (0..1 over the frame) with their scores.
import { readFile } from 'node:fs/promises';
import { rgbFloat } from '../core/image.ts';
import { FaceModels } from '../models/face.ts';

export type FaceDetectSpec = {
	faceDir: string;
	threads?: number;
	minScore?: number;
	images: { path: string; width: number; height: number }[];
};

export type FaceDetectOutput = { faces: { x: number; y: number; w: number; h: number; score: number }[][] };

export async function detectFacesInImages(spec: FaceDetectSpec): Promise<FaceDetectOutput> {
	const models = await FaceModels.load(
		'mediapipe-face-landmarker',
		{ detector: `${spec.faceDir}/face_detector.onnx`, landmarks: `${spec.faceDir}/face_landmarks.onnx` },
		spec.threads ?? 2,
	);
	try {
		const faces: FaceDetectOutput['faces'] = [];
		for (const im of spec.images) {
			const w = Math.max(1, Math.floor(im.width));
			const h = Math.max(1, Math.floor(im.height));
			const rgb = new Uint8Array(await readFile(im.path));
			if (rgb.length < w * h * 3) throw new Error(`Frame ${im.path} is shorter than ${w}×${h} RGB`);
			const dets = await models.detect(rgbFloat(rgb.subarray(0, w * h * 3)), w, h, spec.minScore ?? 0.5);
			faces.push(
				dets.map((d) => {
					const x0 = Math.max(0, Math.min(w, d.x0));
					const y0 = Math.max(0, Math.min(h, d.y0));
					const x1 = Math.max(0, Math.min(w, d.x1));
					const y1 = Math.max(0, Math.min(h, d.y1));
					return {
						x: x0 / w,
						y: y0 / h,
						w: Math.max(0, x1 - x0) / w,
						h: Math.max(0, y1 - y0) / h,
						score: Math.round(d.score * 1000) / 1000,
					};
				}),
			);
		}
		return { faces };
	} finally {
		await models.release();
	}
}
