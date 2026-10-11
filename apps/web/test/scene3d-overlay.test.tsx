import { buildRenderSnapshot } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { monitorStores } from '../src/panels/program/monitor-store.ts';
import { Scene3DOverlay } from '../src/three-d/Scene3DOverlay.tsx';
import { makeSession } from './timeline-helpers.ts';

afterEach(cleanup);

it('renders the active camera from the supplied 3D document', () => {
	const { session, seqId } = makeSession();
	const added = session.apply({
		label: 'Camera',
		origin: 'user',
		sequenceId: seqId,
		commands: [{ type: 'clip.addCamera', at: 0, duration: 30, name: 'Audit Camera' }],
	});
	expect(added.ok).toBe(true);
	const doc = buildRenderSnapshot(session.getDrawn(), seqId, {
		resolveMedia: () => null,
		resolveFont: () => null,
	});
	render(
		<SessionProvider session={session}>
			<Scene3DOverlay
				session={session}
				doc={doc}
				view={{ scale: 0.5, x: 0, y: 0 }}
				viewport={{ width: 960, height: 540 }}
				transport={session.transport}
				monitor={monitorStores.program.getState()}
			/>
		</SessionProvider>,
	);
	expect(screen.getByTestId('scene3d-overlay')).toBeTruthy();
	expect(screen.getByRole('option', { name: 'Active Camera (Audit Camera)' })).toBeTruthy();
});
