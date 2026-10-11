import { registerRoot } from 'remotion';
import { setFxEffectRegistry } from '../../src/fx/registry.ts';
import { RemotionRoot } from '../../src/Root.tsx';
import { testFxRegistry } from '../fx-examples.ts';

setFxEffectRegistry(testFxRegistry);
registerRoot(RemotionRoot);
