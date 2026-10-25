// Entry for @remotion/bundler in the engine (ARCHITECTURE §9.5): registers the JasperSequence composition.
import { registerRoot } from 'remotion';
import { installTextMeasureHook } from './layers/text/box-measure.ts';
import { RemotionRoot } from './Root.tsx';

// spec 13 SH-004: the engine's headless text measurer opens this bundle's page and calls the hook.
installTextMeasureHook();
registerRoot(RemotionRoot);
