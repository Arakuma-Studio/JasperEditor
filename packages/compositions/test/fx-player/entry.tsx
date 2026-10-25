// Browser entry of the shader-effect Player test (fx-player.e2e.test.ts): mounts Remotion Players of
// SequenceComposition (preview mode) for documents the test puts on `window.__docs`, with the test effects installed.
// `window.__fxPlayer.seek(name, frame)` / `.setDoc(name, doc)` drive them.
import { Player, type PlayerRef } from '@remotion/player';
import { createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { setFxEffectRegistry } from '../../src/fx/registry.ts';
import { DEFAULT_RENDER_OPTIONS, type RenderDoc, SequenceComposition } from '../../src/index.ts';
import { testFxRegistry } from '../fx-examples.ts';

setFxEffectRegistry(testFxRegistry);

type Docs = Record<string, RenderDoc>;
const docs = (window as unknown as { __docs: Docs }).__docs;
const refs: Record<string, React.RefObject<PlayerRef | null>> = {};
const roots: Record<string, ReturnType<typeof createRoot>> = {};

function mount(name: string, doc: RenderDoc) {
	refs[name] ??= createRef<PlayerRef>();
	let el = document.getElementById(name);
	if (!el) {
		el = document.createElement('div');
		el.id = name;
		el.style.width = `${doc.settings.width}px`;
		el.style.height = `${doc.settings.height}px`;
		document.body.appendChild(el);
		roots[name] = createRoot(el);
	}
	roots[name]!.render(
		<Player
			ref={refs[name]}
			component={SequenceComposition}
			inputProps={{ doc, options: DEFAULT_RENDER_OPTIONS }}
			compositionWidth={doc.settings.width}
			compositionHeight={doc.settings.height}
			durationInFrames={Math.max(1, doc.durationFrames)}
			fps={doc.settings.fps.num / doc.settings.fps.den}
			style={{ width: doc.settings.width, height: doc.settings.height }}
			controls={false}
			acknowledgeRemotionLicense
		/>,
	);
}

for (const [name, doc] of Object.entries(docs)) mount(name, doc);

(window as unknown as { __fxPlayer: unknown }).__fxPlayer = {
	frame(name: string) {
		return refs[name]?.current?.getCurrentFrame() ?? null;
	},
	seek(name: string, frame: number) {
		refs[name]?.current?.seekTo(frame);
	},
	setDoc(name: string, doc: RenderDoc) {
		mount(name, doc);
	},
	chip(name: string) {
		return document.getElementById(name)?.querySelector('[data-grade-chip]')?.textContent ?? null;
	},
};
