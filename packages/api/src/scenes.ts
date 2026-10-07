// Scene Edit Detection contracts (workstream `time`, docs/wp-notes/time.md).
import { z } from 'zod';

/**
 * `POST /api/scenes/detect` → EngineJob (kind `scene-detect`; result = SceneDetectResult). Analyses the media frames
 * between `startSec` and `endSec` (seconds from the start of the file) and returns the media times where a new shot
 * starts. The client turns them into edits / subclips / clip markers with `clip.applySceneEdits` (one undo step).
 */
export const SceneDetectRequestSchema = z.object({
	projectId: z.string().optional(),
	mediaKey: z.string(),
	startSec: z.number().min(0),
	endSec: z.number().positive(),
	/** 0 (only the most obvious cuts) … 100 (also subtle ones). */
	sensitivity: z.number().min(0).max(100).default(50),
	/** Shortest shot kept, in media frames. */
	minShotFrames: z.number().int().min(1).max(10_000).default(2),
});
export type SceneDetectRequest = z.infer<typeof SceneDetectRequestSchema>;

export const SceneDetectResultSchema = z.object({
	/** Media seconds of the first frame of each new shot, ascending. */
	cuts: z.array(z.number()),
	/** Frames analysed. */
	frames: z.number().int().min(0),
	/** Dissimilarity of each analysed frame to the previous one (0…1), for diagnostics and graphs. */
	scores: z.array(z.number()),
	/** Media seconds of each analysed frame. */
	times: z.array(z.number()),
	/** The threshold the sensitivity gave. */
	threshold: z.number(),
	framesPerSec: z.number().optional(),
});
export type SceneDetectResult = z.infer<typeof SceneDetectResultSchema>;
