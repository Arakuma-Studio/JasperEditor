import type { ParamValue } from '@jasper/project/audio';
import { expect } from 'vitest';
import type { AudioProcessor } from '../src/core/effect.ts';
import { createProcessor } from '../src/registry.ts';
import { SR } from './util.ts';

export function fx(id: string, params: Record<string, ParamValue> = {}, channels = 2): AudioProcessor {
	const e = createProcessor(`jasper.audio.${id}`, SR, channels);
	if (!e) throw new Error(`no effect ${id}`);
	for (const [k, v] of Object.entries(params)) expect(e.setParam(k, v), `${id}.${k}`).toBe(true);
	e.reset();
	return e;
}
