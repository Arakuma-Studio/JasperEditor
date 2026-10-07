import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { registerAudioFxWorklet } from './audio/register.ts';
import { registerAllCommands } from './commands/index.ts';
import { registerServiceWorker } from './pwa/register.ts';
import './app.css';

registerAllCommands();
registerAudioFxWorklet();
registerServiceWorker();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
