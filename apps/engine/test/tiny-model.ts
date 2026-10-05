import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tinySrModel } from '../src/processing/proc/tiny-onnx.ts';

export function writeTinySrModel(file: string): string {
	const bytes = tinySrModel();
	writeFileSync(file, bytes);
	return createHash('sha256').update(bytes).digest('hex');
}
