// Test helpers for the WP-2D inspector panels: an in-memory EditorSession with solid clips.
import { mgRegistry } from '@jasper/mg-templates';
import { type Clip, createEmptyProject, createSeededIdSource, defaultRegistries } from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';

export function makeSession(): EditorSession {
	const ids = createSeededIdSource(11);
	const document = createEmptyProject({ ids, name: 'Inspector test', preset: 'hd-1080p-30' });
	return new EditorSession({
		projectId: document.projectId,
		document,
		ctx: { ids, now: () => '2026-09-30T10:00:00.000Z', registries: defaultRegistries(mgRegistry) },
		coalesceWindowMs: 0,
	});
}

/** Adds solids at the given starts (each `duration` frames long) on V1 and returns their ids. */
export function addSolids(session: EditorSession, starts: number[], duration = 50): string[] {
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		commands: starts.map((at, i) => ({
			type: 'clip.addSolid',
			at,
			duration,
			track: `V${(i % 3) + 1}`,
			color: [0, 0, 1, 1],
		})) as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return r.created.filter((id) => id.startsWith('clp_'));
}

export function clipOf(session: EditorSession, id: string): Clip {
	const seq = Object.values(session.getCommitted().sequences)[0]!;
	return seq.clips[id]!;
}

export function renderWithSession(session: EditorSession, ui: ReactNode) {
	return render(<SessionProvider session={session}>{ui}</SessionProvider>);
}
