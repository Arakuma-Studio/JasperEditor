import { setInvariantMode } from '@jasper/project';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { registerAllCommands } from './commands/index.ts';
import { installGapsRuntime } from './gaps/startup.ts';
import { registerServiceWorker } from './pwa/register.ts';
import './app.css';

// gaps: audio output routing and reduced motion, before anything creates an AudioContext.
installGapsRuntime();
// perf-core: dev builds check every transaction both incrementally and fully (they must agree).
if (import.meta.env.DEV) setInvariantMode('verify');
registerAllCommands();
registerServiceWorker();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
