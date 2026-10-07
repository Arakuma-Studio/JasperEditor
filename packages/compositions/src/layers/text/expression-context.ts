// The text Expression Selector in the composition (workstream text-animators): SequenceComposition provides, once
// the expression engine is loaded and the snapshot has expressions, a factory of per-clip selector hosts evaluated
// in the snapshot's expression world (works after JSON, in the Remotion renderer).
import type { TextSelectorExpressionHost } from '@jasper/project';
import { createContext } from 'react';

export type TextExpressionHostFactory = (clipId: string) => TextSelectorExpressionHost | null;

export const TextExpressionContext = createContext<TextExpressionHostFactory | null>(null);
