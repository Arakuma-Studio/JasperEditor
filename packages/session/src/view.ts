import type { Issue } from '@jasper/project';
import { z } from 'zod';

const SequenceViewSchema = z.object({
	playhead: z.number().int().nonnegative(),
	pxPerFrame: z.number().positive(),
	scrollFrame: z.number(),
	scrollYVideo: z.number().nonnegative(),
	scrollYAudio: z.number().nonnegative(),
	dividerRatio: z.number().min(0).max(1),
	trackHeights: z.record(z.string(), z.number().positive()),
	collapsed: z.record(z.string(), z.boolean()),
	targeting: z.object({ video: z.array(z.string()), audio: z.array(z.string()) }),
	/** Source track label → destination track id; null disables the source track. */
	sourcePatching: z.record(z.string(), z.string().nullable()),
	/** Missing lanes use Opacity for video and Level for audio; `none` hides a lane. */
	keyframeDisplay: z.record(z.string(), z.string()),
	display: z.object({
		thumbnails: z.enum(['none', 'head', 'continuous']),
		waveforms: z.boolean(),
		clipNames: z.boolean(),
	}),
	/**
	 * Sequence ▸ Sound Design ▸ Show Cue Seam (spec 12 §2.7): `on` / `off` once the user chose; absent = automatic
	 * (shown in the Sound Design workspace and whenever the sequence has cues).
	 */
	cueSeam: z.enum(['on', 'off']).optional(),
});

export type SequenceViewState = z.infer<typeof SequenceViewSchema>;

const ProjectViewStateSchema = z.object({
	version: z.literal(1),
	views: z.record(z.string(), SequenceViewSchema.partial()),
	tabs: z.object({ open: z.array(z.string()) }),
	activeSequenceId: z.string().nullable(),
});

export type ProjectViewState = z.infer<typeof ProjectViewStateSchema>;

export function readProjectView(value: unknown): { view: ProjectViewState | null; issues: Issue[] } {
	if (value === null || value === undefined) return { view: null, issues: [] };
	const parsed = ProjectViewStateSchema.safeParse(value);
	if (parsed.success) return { view: parsed.data, issues: [] };
	return {
		view: null,
		issues: [
			{
				commandIndex: -1,
				code: 'W_REPAIRED',
				message: 'Saved view settings were invalid and have been reset. Project edits are unchanged.',
			},
		],
	};
}
