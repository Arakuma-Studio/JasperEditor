// The plan's `style.cueSources` (WP3.3b, the Auto Sound Pass… dialog's "Sources for cues"): derived cues come only from
// the chosen sources; stored cues are planned whatever their source; the request schema refuses unknown sources.
import type { SoundDesignPlanRequest } from '@jasper/api';
import { mgRegistry } from '@jasper/mg-templates';
import { describe, expect, it } from 'vitest';
import { collectPlanCues, resolveStyle } from '../src/sound-design/plan.ts';
import { fixture } from './sound-design-fixture.ts';

function cuesOf(req: Partial<SoundDesignPlanRequest>) {
	const { doc, seqId } = fixture();
	const request = { projectId: doc.projectId, sequenceId: seqId, ...req } as SoundDesignPlanRequest;
	const seq = doc.sequences[seqId]!;
	const style = resolveStyle(request, seq);
	return collectPlanCues(doc, seq, request, style, { mgTemplates: mgRegistry }).cues;
}

describe('sound-design plan: cue sources', () => {
	it('derives only from the chosen sources (default: all)', () => {
		const all = cuesOf({});
		const kinds = (cs: ReturnType<typeof cuesOf>) => [...new Set(cs.map((c) => c.kind))].sort();
		expect(kinds(all)).toEqual(expect.arrayContaining(['cut', 'transition']));
		const edits = cuesOf({ style: { cueSources: ['edits'] } });
		expect(edits.length).toBeGreaterThan(0);
		expect(edits.length).toBeLessThan(all.length);
		expect(kinds(edits)).toEqual(['cut']);
		const transitions = cuesOf({ style: { cueSources: ['transitions'] } });
		expect(kinds(transitions)).toEqual(['transition']);
		// every cue of a subset is one of the full run's (same frames)
		const frames = new Set(all.map((c) => `${c.kind}@${c.frame}`));
		for (const c of [...edits, ...transitions]) expect(frames.has(`${c.kind}@${c.frame}`)).toBe(true);
	});
});
