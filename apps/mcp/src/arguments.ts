import { TimeInputSchema } from '@jasper/project';
import { z } from 'zod';

export const ProjectIdArg = z
	.string()
	.min(1)
	.describe('Project id ("prj_…") from list_projects or create_project');

export const SequenceIdArg = z
	.string()
	.optional()
	.describe('Sequence id ("seq_…"); default: the project\'s first sequence');

export const TIME_FORMATS =
	'Sequence time as frames (integer), {"frames": n}, {"seconds": x} or timecode "HH:MM:SS:FF" (";" before FF for drop-frame)';
export const timeArg = (what: string) => TimeInputSchema.describe(`${what}. ${TIME_FORMATS}`);
