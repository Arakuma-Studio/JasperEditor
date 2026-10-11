import { ClipSchema } from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { nudgeSelection } from '../src/panels/program/edits.ts';
import { ClipView } from '../src/panels/timeline/components/ClipView.tsx';
import { makeSession } from './timeline-helpers.ts';

afterEach(cleanup);

function withExtension(kind: string, extension: Record<string, unknown>) {
	const { session: initial, seqId } = makeSession();
	const added = initial.apply({
		label: 'Layers',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [0, 0, 1, 1], ref: '$solid' },
			{ type: 'clip.addCamera', at: 0, duration: 30, name: 'Extension layer', ref: '$camera' },
		],
	});
	expect(added.ok).toBe(true);
	const document = structuredClone(initial.getCommitted());
	const cameraId = added.refs.$camera!;
	const seq = document.sequences[seqId]!;
	seq.clips[cameraId] = ClipSchema.parse({ ...seq.clips[cameraId], kind, ...extension });
	expect(seq.clips[cameraId]).toMatchObject(extension);
	const session = new EditorSession({ projectId: document.projectId, document, ctx: initial.ctx });
	return { session, seqId, cameraId, solidId: added.refs.$solid! };
}

it.each([
	{ kind: 'camera', transform: 'future-motion' },
	{ kind: 'camera', transform: null },
	{ kind: 'future-camera', transform: { vendorData: true } },
])(
	'nudges visual layers without interpreting $kind transform extension $transform',
	({ kind, transform }) => {
		const { session, seqId, cameraId, solidId } = withExtension(kind, { transform });
		const before = session.getCommitted();
		session.select('timeline', [cameraId, solidId]);
		expect(nudgeSelection(session, 0, 5, -2)).toBe(true);
		const seq = session.getCommitted().sequences[seqId]!;
		expect(seq.clips[cameraId]).toEqual(before.sequences[seqId]!.clips[cameraId]);
		expect(seq.clips[solidId]).toMatchObject({ transform: { position: { value: [965, 538] } } });
		expect(session.getState().history.entries).toHaveLength(1);
		session.undo();
		expect(session.getCommitted()).toEqual(before);
	},
);

it.each(['camera', 'future-camera'])('renders a %s clip with a null effects extension', (kind) => {
	const { session, seqId, cameraId } = withExtension(kind, { effects: null });
	const clip = session.getCommitted().sequences[seqId]!.clips[cameraId]!;
	const { getByText, queryByTitle } = render(
		<ClipView
			clip={clip}
			x={0}
			w={120}
			height={60}
			viewportWidth={960}
			scrollPx={0}
			scrollFrame={0}
			pxPerFrame={4}
			rate={{ num: 30, den: 1 }}
			selected={false}
			trackLocked={false}
			trackDimmed={false}
			linked={false}
			syncOffset={null}
			offline={false}
			flash={false}
			asset={undefined}
			runtime={undefined}
			engine={null}
			mediaVersion={0}
			display={{
				thumbnails: 'off',
				videoNames: true,
				audioNames: true,
				waveforms: false,
				rectified: false,
				fxBadges: true,
				engineBadges: false,
				labelColors: false,
				clipMarkers: false,
			}}
		/>,
	);
	expect(getByText('Extension layer')).toBeTruthy();
	expect(queryByTitle('Effects applied')).toBeNull();
	expect(clip).toMatchObject({ effects: null });
});
