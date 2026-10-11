import { z } from 'zod';
import type { Rgba } from './core.ts';

const channel = z.number().min(0).max(1);

/** Straight sRGB RGBA in 0..1; arrays preserve the native template JSON schema. */
export const rgbaParam = (defaults: Rgba) =>
	z
		.array(channel)
		.length(4)
		.default([...defaults]);
