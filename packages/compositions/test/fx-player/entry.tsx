// Browser entry of the shader-effect Player test (fx-player.e2e.test.ts): mounts Remotion Players of
// SequenceComposition (preview mode) for documents the test puts on `window.__docs`, with the test effects installed.
// `window.__fxPlayer.seek(name, frame)` / `.setDoc(name, doc)` drive them.
import { Player, type PlayerRef } from '@remotion/player';
import { createRef, useContext, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Internals, useCurrentFrame } from 'remotion';
import { setFxEffectRegistry } from '../../src/fx/registry.ts';
import { DEFAULT_RENDER_OPTIONS, type RenderDoc, SequenceComposition } from '../../src/index.ts';
import type { RenderOptions } from '../../src/types.ts';
import { testFxRegistry } from '../fx-examples.ts';
import { observeBuffering, settlePlayer } from '../player-receipt.ts';

setFxEffectRegistry(testFxRegistry);

type Docs = Record<string, RenderDoc>;
const docs = (window as unknown as { __docs: Docs }).__docs;
const refs: Record<string, React.RefObject<PlayerRef | null>> = {};
const roots: Record<string, ReturnType<typeof createRoot>> = {};

const buffers: Record<string, { current: boolean }> = {};
const commits = new Map<string, { doc: RenderDoc; frame: number }>();
const waiting = new Set<{ name: string; doc: RenderDoc; frame?: number; resolve: () => void }>();
function committed(name: string, doc: RenderDoc, frame?: number): Promise<void> {
	const current = commits.get(name);
	if (current?.doc === doc && (frame === undefined || current.frame === frame)) return Promise.resolve();
	return new Promise((resolve) => waiting.add({ name, doc, frame, resolve }));
}
function ObservedComposition({
	name,
	doc,
	options,
}: {
	name: string;
	doc: RenderDoc;
	options: RenderOptions;
}) {
	const frame = useCurrentFrame();
	const buffering = useContext(Internals.BufferingContextReact);
	if (buffering) observeBuffering(buffering);
	useEffect(() => {
		if (!buffering) throw new Error('Player fixture has no buffering context');
		buffers[name] = buffering.buffering;
		commits.set(name, { doc, frame });
		for (const waiter of waiting)
			if (
				waiter.name === name &&
				waiter.doc === doc &&
				(waiter.frame === undefined || waiter.frame === frame)
			) {
				waiting.delete(waiter);
				waiter.resolve();
			}
	}, [name, doc, frame, buffering]);
	return <SequenceComposition doc={doc} options={options} />;
}

function mount(name: string, doc: RenderDoc): Promise<void> {
	docs[name] = doc;
	const ready = committed(name, doc);
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
			component={ObservedComposition}
			inputProps={{ name, doc, options: DEFAULT_RENDER_OPTIONS }}
			compositionWidth={doc.settings.width}
			compositionHeight={doc.settings.height}
			durationInFrames={Math.max(1, doc.durationFrames)}
			fps={doc.settings.fps.num / doc.settings.fps.den}
			style={{ width: doc.settings.width, height: doc.settings.height }}
			controls={false}
			acknowledgeRemotionLicense
		/>,
	);
	return ready;
}

const mounted = Promise.all(Object.entries(docs).map(([name, doc]) => mount(name, doc)));
async function settled(name: string) {
	await settlePlayer(refs[name]!.current!, document.getElementById(name)!, buffers[name]!);
}

(window as unknown as { __fxPlayer: unknown }).__fxPlayer = {
	async seek(name: string, frame: number) {
		await mounted;
		const ready = committed(name, docs[name]!, frame);
		refs[name]!.current!.seekTo(frame);
		await ready;
		await settled(name);
	},
	async ready(name: string) {
		await mounted;
		await settled(name);
	},
	async setDoc(name: string, doc: RenderDoc) {
		await mounted;
		await mount(name, doc);
		await settled(name);
	},
	chip(name: string) {
		return document.getElementById(name)?.querySelector('[data-grade-chip]')?.textContent ?? null;
	},
};
