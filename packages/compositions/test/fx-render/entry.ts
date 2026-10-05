// Remotion entry of the shader-effect render test (fx-render.e2e.test.ts): the production root plus the test-only
// example effects (fx-examples.ts), installed with `setFxEffectRegistry` before the root registers.
import { registerRoot } from 'remotion';
import { setFxEffectRegistry } from '../../src/fx/registry.ts';
import { RemotionRoot } from '../../src/Root.tsx';
import { testFxRegistry } from '../fx-examples.ts';

setFxEffectRegistry(testFxRegistry);
registerRoot(RemotionRoot);
