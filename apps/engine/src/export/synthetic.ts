// Synthetic generators on the native path (edit-structure, docs/wp-notes/edit-structure.md): the pictures of Bars and
// Tone and the Universal Counting Leader and the sound of their audio clips are written from the pure generators of
// @jasper/project (`renderBars`, `renderCountingLeader`, `syntheticSamples`) — the same pixels and samples the Player
// draws — into per-job intermediates:
// - bars: one PNG (a `layer` override with `still`);
// - leader: a PNG-in-MOV of the content frames the clips show (`layer` override with `contentOrigin`);
// - tone / blips: a 48 kHz stereo WAV from content time 0, served to the builder as local media `syn:<id>`.
// The builder then applies effects, Motion, opacity, speed, frame holds and fades like any picture or sound.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import {
	clipPictureTime,
	encodeWavStereo16,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	type RenderAudioClip,
	type RenderSnapshot,
	type RenderVisualClip,
	renderBars,
	renderCountingLeader,
	syntheticSamples,
} from '@jasper/project';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import type { LayerOverride, NativeExtension, NativePrepareContext } from './native-ext.ts';
import type { LocalMedia, PlannedExport } from './planner.ts';

const SAMPLE_RATE = 48000;

/** A PNG (RGBA 8-bit, unfiltered rows, zlib) of straight-alpha pixels. */
export function encodePng(px: Uint8ClampedArray | Uint8Array, w: number, h: number): Buffer {
	const raw = Buffer.alloc((w * 4 + 1) * h);
	for (let y = 0; y < h; y++) {
		raw[y * (w * 4 + 1)] = 0;
		raw.set(px.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
	}
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(td) >>> 0);
		return Buffer.concat([len, td, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw, { level: 1 })),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

type Prepared = {
	/** clipId → picture override. */
	pictures: Map<string, LayerOverride>;
};

/** The content frames (sequence-rate grid) a generator clip shows over its drawn frames. */
function shownFrames(
	c: RenderVisualClip,
	fps: RenderSnapshot['settings']['fps'],
): { k0: number; k1: number } {
	const F = flicksPerFrame(fps);
	const a = c.start - (c.headHandle ?? 0);
	const b = c.start + c.duration + (c.tailHandle ?? 0) - 1;
	const ta = clipPictureTime(c, a, fps) / F;
	const tb = clipPictureTime(c, b, fps) / F;
	return {
		k0: Math.max(0, Math.floor(Math.min(ta, tb) + 1e-6)),
		k1: Math.floor(Math.max(ta, tb) + 1e-6) + 2,
	};
}

export function createSyntheticExtension(deps: { ffmpeg: Ffmpeg }): NativeExtension {
	return {
		id: 'synthetic',
		async prepare(planned: PlannedExport, ctx: NativePrepareContext): Promise<Prepared> {
			const pictures = new Map<string, LayerOverride>();
			let dir: string | null = null;
			const scratch = async () => {
				dir ??= await ctx.scratchDir();
				return dir;
			};
			const snap = planned.snapshot;
			// Pictures of this snapshot's layers (nested sequences get their own `prepare`, see `prepareNested`).
			const visit = async (s: RenderSnapshot) => {
				const fps = s.settings.fps;
				for (const t of s.videoTracks)
					for (const c of t.clips) {
						if (!('generator' in c.source)) continue;
						const w = Math.max(1, Math.round(c.intrinsicBox.width));
						const h = Math.max(1, Math.round(c.intrinsicBox.height));
						const g = c.source.generator;
						if (g.kind === 'bars') {
							const path = join(await scratch(), `bars-${w}x${h}.png`);
							await writeFile(path, encodePng(renderBars(w, h), w, h));
							pictures.set(c.clipId, { path, space: 'layer', startFrame: c.start, still: true });
							continue;
						}
						ctx.stage('Drawing the counting leader');
						const { k0, k1 } = shownFrames(c, fps);
						const d = join(await scratch(), `leader-${c.clipId}`);
						await mkdir(d, { recursive: true });
						const frameSec = fps.den / fps.num;
						for (let k = k0; k < k1; k++) {
							if (ctx.signal.aborted) throw new Error('cancelled');
							const px = renderCountingLeader(w, h, k * frameSec, g.style, frameSec);
							await writeFile(join(d, `f${String(k - k0).padStart(6, '0')}.png`), encodePng(px, w, h));
						}
						const path = join(d, 'leader.mov');
						await deps.ffmpeg.run(
							[
								'-framerate',
								`${fps.num}/${fps.den}`,
								'-i',
								join(d, 'f%06d.png'),
								'-c:v',
								'png',
								'-f',
								'mov',
								path,
							],
							{ signal: ctx.signal },
						);
						pictures.set(c.clipId, {
							path,
							space: 'layer',
							startFrame: c.start,
							contentOrigin: k0 * flicksPerFrame(fps),
						});
					}
			};
			await visit(snap);
			// Sounds: one WAV per synthetic audio source, from content time 0 to the latest content any clip plays.
			const needs = new Map<string, { clip: RenderAudioClip; seconds: number }>();
			const frameSec = snap.settings.fps.den / snap.settings.fps.num;
			for (const a of snap.audioClips) {
				if (!a.generator) continue;
				const end =
					(a.sourceIn +
						(a.duration + (a.tailHandle ?? 0) + 1) * frameSec * FLICKS_PER_SECOND * a.speed.rate) /
					FLICKS_PER_SECOND;
				const prev = needs.get(a.mediaId);
				if (!prev || prev.seconds < end) needs.set(a.mediaId, { clip: a, seconds: end });
			}
			for (const [mediaId, { clip, seconds }] of needs) {
				const n = Math.ceil(Math.max(1, seconds) * SAMPLE_RATE);
				const wav = encodeWavStereo16(
					syntheticSamples(clip.generator!, 0, n, SAMPLE_RATE, frameSec),
					SAMPLE_RATE,
				);
				const path = join(await scratch(), `${mediaId.replace(/[^\w-]/g, '_')}.wav`);
				await writeFile(path, wav);
				planned.media[mediaId] = generatedWav(path, n / SAMPLE_RATE, wav.length);
			}
			return { pictures };
		},
		override(clip, prepared) {
			return (prepared as Prepared | undefined)?.pictures.get(clip.clipId) ?? null;
		},
		blockers(clip) {
			return 'generator' in clip.source && clip.speed.reverse ? [`${clip.name} plays in reverse`] : [];
		},
	};
}

/** A generated WAV as local media of the builder (`sources.media`). */
function generatedWav(path: string, seconds: number, bytes: number): LocalMedia {
	return {
		path,
		record: {
			mediaKey: 'generated',
			fingerprint: 'generated',
			originalName: path,
			sizeBytes: bytes,
			mtimeMs: 0,
			container: 'wav',
			kind: 'audio',
			probe: {
				durationFlicks: Math.round(seconds * FLICKS_PER_SECOND),
				startTimecode: null,
				streams: [
					{
						index: 0,
						type: 'audio',
						codec: 'pcm_s16le',
						sampleRate: SAMPLE_RATE,
						channels: 2,
						channelLayout: 'stereo',
					},
				],
				rotationDegrees: 0,
				hasAlpha: false,
				variableFrameRate: false,
			},
			browserPlayable: 'yes',
			storage: { type: 'path', path },
			durationSec: seconds,
			display: null,
			hasAudio: true,
			registeredAt: new Date(0).toISOString(),
		} as unknown as LocalMedia['record'],
	};
}
