// A stored keyframe's fields other than its value (the value is the param spec's to judge).

import { z } from 'zod';
import { keyframeSchema } from '../schema/common.ts';

const KeySchema = keyframeSchema(z.unknown());

export const isKeyframedParamValid = (k: unknown): boolean => KeySchema.safeParse(k).success;
