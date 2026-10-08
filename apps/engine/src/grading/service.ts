// color-grade: grading analysis on the engine — `scopes_read` (Lumetri Scopes as numbers), Colour Match and Auto
// tone. Frames are rendered by the engine's still renderer (the export paths: native, hybrid or Remotion, so what is
// measured is what exports), decoded with ffmpeg to RGBA, and analysed by the shared maths of @jasper/project.
// Face Detection uses the roto face model in the jasper-roto child process when it is installed.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
	AutoToneRequest,
	AutoToneResponse,
	ColorMatchRequest,
	ColorMatchResponse,
	GradingScopesRequest,
	GradingScopesResponse,
} from '@jasper/api';
import {
	AnalysisError,
	type Animatable,
	analysisLumetri,
	autoTone,
	type Clip,
	clipAnalysisDocument,
	clipContentTime,
	defaultEffectRegistry,
	type EffectInstance,
	type EffectParams,
	effectiveParams,
	evaluate,
	LUMETRI_EFFECT,
	type MatchImage,
	matchImageFromRgba8,
	type ProjectDocument,
	type Rational,
	readScopes,
	signalFromRgba8,
	solveColorMatch,
} from '@jasper/project';
import type { RotoService } from '../roto/service.ts';
import { HttpError } from '../tools/reply.ts';
import type { CoreServices } from '../tools/services.ts';

type Rgba = { data: Uint8Array; width: number; height: number; renderPath?: string };
type FaceBoxes = { x: number; y: number; w: number; h: number }[];

/** Width of the frames Colour Match and Auto analyse (they shrink to ≤ 128 px; this keeps faces detectable). */
const ANALYSIS_WIDTH = 640;

export class GradingService {
	constructor(
		private readonly core: CoreServices,
		private readonly roto: () => RotoService | undefined,
	) {}

	/** One rendered frame as straight RGBA8 (the still renderer → PNG → ffmpeg rawvideo). */
	async renderFrame(
		envelope: GradingScopesRequest['envelope'],
		sequenceId: string,
		frame: number,
		width: number,
	): Promise<Rgba> {
		const job = await this.core.exports.still({ envelope, sequenceId, frame, width }, { type: 'system' });
		const done = await this.core.queue.wait(job.id);
		if (done.state !== 'succeeded')
			throw new HttpError(
				422,
				done.error?.code ?? 'RENDER_FAILED',
				done.error?.message ?? `Frame render ${done.state}`,
				{
					jobId: done.id,
				},
			);
		const file = await this.core.exports.outputFile(job.id);
		if (!file) throw new HttpError(500, 'RENDER_FAILED', 'The rendered frame is missing', { jobId: job.id });
		const png = await readFile(file);
		if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47)
			throw new HttpError(500, 'RENDER_FAILED', 'The rendered frame is not a PNG', { jobId: job.id });
		const w = png.readUInt32BE(16);
		const h = png.readUInt32BE(20);
		if (!(w > 0 && h > 0 && w * h <= 8192 * 8192))
			throw new HttpError(500, 'RENDER_FAILED', `Unexpected frame size ${w}×${h}`, { jobId: job.id });
		const dir = await mkdtemp(join(tmpdir(), 'jasper-grading-'));
		try {
			const raw = join(dir, 'frame.rgba');
			await this.core.ffmpeg.run([
				'-v',
				'error',
				'-y',
				'-i',
				file,
				'-f',
				'rawvideo',
				'-pix_fmt',
				'rgba',
				raw,
			]);
			const data = new Uint8Array(await readFile(raw));
			if (data.length < w * h * 4)
				throw new HttpError(500, 'RENDER_FAILED', 'The decoded frame is shorter than its size', {
					jobId: job.id,
				});
			const renderPath = (done.result as { renderPath?: string } | undefined)?.renderPath;
			return {
				data: data.subarray(0, w * h * 4),
				width: w,
				height: h,
				...(renderPath ? { renderPath } : {}),
			};
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	private documentOf(envelope: GradingScopesRequest['envelope']): ProjectDocument {
		const doc = envelope.document as unknown as ProjectDocument;
		if (!doc || typeof doc !== 'object' || !doc.sequences)
			throw new HttpError(400, 'VALIDATION_FAILED', 'The envelope has no project document');
		return doc;
	}

	/** The envelope with its document replaced. */
	private withDocument(envelope: GradingScopesRequest['envelope'], doc: ProjectDocument) {
		return { ...envelope, document: doc as unknown as Record<string, unknown> };
	}

	private analysisDoc(doc: ProjectDocument, sequenceId: string, clipId: string, before: string | null) {
		try {
			return clipAnalysisDocument(doc, sequenceId, clipId, { before });
		} catch (e) {
			if (e instanceof AnalysisError)
				throw new HttpError(e.code.endsWith('NOT_FOUND') ? 404 : 400, e.code, e.message);
			throw e;
		}
	}

	/** The clip and its Lumetri instance (or null) for a match / auto request. */
	private target(doc: ProjectDocument, sequenceId: string, clipId: string, effectId?: string) {
		const seq = doc.sequences[sequenceId];
		if (!seq) throw new HttpError(404, 'SEQUENCE_NOT_FOUND', `Unknown sequence ${sequenceId}`);
		const clip = seq.clips[clipId];
		if (!clip) throw new HttpError(404, 'CLIP_NOT_FOUND', `Unknown clip ${clipId}`);
		const effects = ((clip as { effects?: EffectInstance[] }).effects ?? []) as EffectInstance[];
		const fx = analysisLumetri(effects, effectId);
		if (effectId && !fx)
			throw new HttpError(404, 'EFFECT_NOT_FOUND', `Clip ${clipId} has no Lumetri instance ${effectId}`);
		return { seq, clip, fx };
	}

	/** The instance's params evaluated at a sequence frame (content time; registry defaults filled in). */
	private paramsAt(fx: EffectInstance | null, clip: Clip, frame: number, rate: Rational): EffectParams {
		if (!fx) return effectiveParams(LUMETRI_EFFECT, {});
		const spec = defaultEffectRegistry.get(fx.effectId, fx.effectVersion) ?? LUMETRI_EFFECT;
		const f = Math.min(clip.start + clip.duration - 1, Math.max(clip.start, frame));
		const t = clipContentTime(clip as never, f, rate);
		const raw: Record<string, unknown> = {};
		for (const p of spec.params) {
			const a = fx.params[p.name] as Animatable<unknown> | undefined;
			raw[p.name] = a ? evaluate(a, t, { holdOnly: !p.animatable }) : p.default;
		}
		return effectiveParams(spec, raw);
	}

	async scopes(req: GradingScopesRequest): Promise<GradingScopesResponse> {
		let envelope = req.envelope;
		if (req.clipId) {
			const doc = this.documentOf(req.envelope);
			envelope = this.withDocument(req.envelope, this.analysisDoc(doc, req.sequenceId, req.clipId, null));
		}
		const img = await this.renderFrame(envelope, req.sequenceId, req.frame, req.width ?? 960);
		const sig = signalFromRgba8(img.data, img.width, img.height);
		const r = readScopes(sig, {
			...(req.scopes ? { scopes: req.scopes } : {}),
			...(req.waveformType ? { waveformType: req.waveformType } : {}),
			...(req.paradeType ? { paradeType: req.paradeType } : {}),
			...(req.matrix ? { matrix: req.matrix } : {}),
			...(req.clamp !== undefined ? { clamp: req.clamp } : {}),
			...(req.columns ? { columns: req.columns } : {}),
			...(req.peaks ? { peaks: req.peaks } : {}),
			...(req.bins !== undefined ? { bins: req.bins } : {}),
		});
		return {
			sequenceId: req.sequenceId,
			frame: req.frame,
			...(req.clipId ? { clipId: req.clipId } : {}),
			...(img.renderPath ? { renderPath: img.renderPath } : {}),
			...r,
		} as GradingScopesResponse;
	}

	private async faces(
		frames: Rgba[],
	): Promise<{ boxes: { x: number; y: number; w: number; h: number }[][] } | { note: string }> {
		const roto = this.roto();
		if (!roto) return { note: 'FACE_MODEL_NOT_INSTALLED' };
		const rgbFrames = frames.map((f) => {
			const rgb = new Uint8Array(f.width * f.height * 3);
			for (let i = 0, j = 0; i < f.width * f.height; i++, j += 3) {
				rgb[j] = f.data[i * 4]!;
				rgb[j + 1] = f.data[i * 4 + 1]!;
				rgb[j + 2] = f.data[i * 4 + 2]!;
			}
			return { rgb, width: f.width, height: f.height };
		});
		try {
			const r = await roto.detectFaces(rgbFrames);
			if ('unavailable' in r) return { note: r.unavailable };
			return { boxes: r.faces.map((list) => list.map(({ x, y, w, h }) => ({ x, y, w, h }))) };
		} catch (e) {
			return { note: `FACE_DETECTION_FAILED: ${(e as Error).message}` };
		}
	}

	async match(req: ColorMatchRequest): Promise<ColorMatchResponse> {
		const doc = this.documentOf(req.envelope);
		const { seq, clip, fx } = this.target(doc, req.sequenceId, req.clipId, req.effectId);
		const rate = seq.settings.frameRate as Rational;
		if (req.frame < clip.start || req.frame >= clip.start + clip.duration)
			throw new HttpError(400, 'VALIDATION_FAILED', `Frame ${req.frame} is not inside clip ${req.clipId}`);
		if (!doc.sequences[req.reference.sequenceId])
			throw new HttpError(
				404,
				'SEQUENCE_NOT_FOUND',
				`Unknown reference sequence ${req.reference.sequenceId}`,
			);
		const currentEnv = this.withDocument(
			req.envelope,
			this.analysisDoc(doc, req.sequenceId, req.clipId, fx?.id ?? null),
		);
		const current = await this.renderFrame(currentEnv, req.sequenceId, req.frame, ANALYSIS_WIDTH);
		const reference = await this.renderFrame(
			req.envelope,
			req.reference.sequenceId,
			req.reference.frame,
			ANALYSIS_WIDTH,
		);
		const faceDetection = req.faceDetection ?? true;
		let faces: { current: number; reference: number } | null = null;
		let faceNote: string | undefined;
		let detected: { current: FaceBoxes; reference: FaceBoxes } | undefined;
		if (faceDetection) {
			const f = await this.faces([current, reference]);
			if ('note' in f) faceNote = f.note;
			else {
				detected = { current: f.boxes[0] ?? [], reference: f.boxes[1] ?? [] };
				faces = { current: detected.current.length, reference: detected.reference.length };
			}
		}
		const base = this.paramsAt(fx, clip, req.frame, rate);
		const cur: MatchImage = matchImageFromRgba8(current.data, current.width, current.height);
		const ref: MatchImage = matchImageFromRgba8(reference.data, reference.width, reference.height);
		const m = solveColorMatch(cur, ref, base, { faceDetection, ...(detected ? { faces: detected } : {}) });
		return {
			clipId: req.clipId,
			effectId: fx?.id ?? null,
			params: {
				shadowsWheel: m.shadowsWheel,
				midtonesWheel: m.midtonesWheel,
				highlightsWheel: m.highlightsWheel,
				shadowsLevel: m.shadowsLevel,
				midtonesLevel: m.midtonesLevel,
				highlightsLevel: m.highlightsLevel,
				saturation: m.saturation,
			},
			before: m.before,
			after: m.after,
			skin: m.skin,
			skinShare: m.skinShare,
			skinHueShift: m.skinHueShift,
			faces,
			...(faceNote ? { faceNote } : {}),
		};
	}

	async autoTone(req: AutoToneRequest): Promise<AutoToneResponse> {
		const doc = this.documentOf(req.envelope);
		const { seq, clip, fx } = this.target(doc, req.sequenceId, req.clipId, req.effectId);
		const rate = seq.settings.frameRate as Rational;
		if (req.frame < clip.start || req.frame >= clip.start + clip.duration)
			throw new HttpError(400, 'VALIDATION_FAILED', `Frame ${req.frame} is not inside clip ${req.clipId}`);
		const env = this.withDocument(
			req.envelope,
			this.analysisDoc(doc, req.sequenceId, req.clipId, fx?.id ?? null),
		);
		const img = await this.renderFrame(env, req.sequenceId, req.frame, ANALYSIS_WIDTH);
		const base = this.paramsAt(fx, clip, req.frame, rate);
		// Auto starts from neutral tone sliders (Premiere's Auto replaces them).
		const neutral = { ...base, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 };
		const r = autoTone(matchImageFromRgba8(img.data, img.width, img.height), neutral);
		return {
			clipId: req.clipId,
			effectId: fx?.id ?? null,
			params: {
				exposure: r.exposure,
				contrast: r.contrast,
				highlights: r.highlights,
				shadows: r.shadows,
				whites: r.whites,
				blacks: r.blacks,
				saturation: r.saturation,
			},
			before: r.before,
			after: r.after,
		};
	}
}
