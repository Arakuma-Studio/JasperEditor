// Browser entry of the text paint tests (text-paint.e2e.test.ts, spec 13 SH-004): mounts a Remotion Player of
// SequenceComposition (preview mode, as the Program monitor) for every document the test puts on `window.__docs`
// and exposes the text box measurer (`measureTextBox`, the editor's measurer) as `window.__textPaint.measure`.
import { Player, type PlayerRef } from '@remotion/player';
import { createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_RENDER_OPTIONS, type RenderDoc, SequenceComposition } from '../../src/index.ts';
import { type MeasureFace, measureTextBox, whenFacesSettled } from '../../src/layers/text/box-measure.ts';

type Docs = Record<string, RenderDoc>;
const docs = (window as unknown as { __docs: Docs }).__docs;
const refs: Record<string, React.RefObject<PlayerRef | null>> = {};

for (const [name, doc] of Object.entries(docs)) {
	refs[name] = createRef<PlayerRef>();
	const el = document.createElement('div');
	el.id = name;
	el.style.width = `${doc.settings.width}px`;
	el.style.height = `${doc.settings.height}px`;
	document.body.appendChild(el);
	createRoot(el).render(
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

(window as unknown as { __textPaint: unknown }).__textPaint = {
	seek(name: string, frame: number) {
		refs[name]?.current?.seekTo(frame);
	},
	async measure(
		content: Parameters<typeof measureTextBox>[0],
		box: Parameters<typeof measureTextBox>[1],
		faces: MeasureFace[],
	) {
		await whenFacesSettled(faces);
		return measureTextBox(content, box, faces);
	},
	/** Counts of the painted copies of the first text layer (fast path vs filter tiles). */
	structure(name: string) {
		const root = document.getElementById(name)!;
		return {
			blocks: root.querySelectorAll('[data-text-block]').length,
			copies: root.querySelectorAll('[data-text-copy]').length,
			tiles: root.querySelectorAll('[data-text-tile]').length,
			shadows: root.querySelectorAll('[data-text-shadow]').length,
		};
	},
};
