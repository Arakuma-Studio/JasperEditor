// The preview mix graph of the composition being played (null in renders and without Web Audio).
import { createContext } from 'react';
import type { MixGraph } from './graph.ts';

export const MixGraphContext = createContext<MixGraph | null>(null);
