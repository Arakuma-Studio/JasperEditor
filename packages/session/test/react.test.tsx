import { createCounterIdSource, createEmptyProject, defaultRegistries } from '@jasper/project';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EditorSession } from '../src/index.ts';
import { SessionProvider, useDocument, useSessionState } from '../src/react/index.ts';

function ClipCount() {
	const n = useDocument((d) => Object.values(Object.values(d.sequences)[0]!.clips).length);
	const rev = useSessionState((s) => s.revision);
	return (
		<p>
			clips:{n} rev:{rev}
		</p>
	);
}

describe('@jasper/session/react', () => {
	it('re-renders selectors on document changes', () => {
		const ids = createCounterIdSource(1);
		const doc = createEmptyProject({ ids, name: 'R' });
		const s = new EditorSession({
			projectId: doc.projectId,
			document: doc,
			ctx: { ids, now: () => 't', registries: defaultRegistries() },
		});
		render(
			<SessionProvider session={s}>
				<ClipCount />
			</SessionProvider>,
		);
		expect(screen.getByText('clips:0 rev:0')).toBeTruthy();
		act(() => {
			s.apply({
				label: 'Add',
				origin: 'user',
				commands: [{ type: 'clip.addSolid', at: 0, duration: 10, track: 'V1', color: [1, 1, 1, 1] }],
			});
		});
		expect(screen.getByText('clips:1 rev:1')).toBeTruthy();
	});
});
