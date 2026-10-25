// Content names of social-comment clips (App QA N5; docs/wp-notes/social-comments.md "Clip names"): every card was
// named "Social comment", so the timeline, the asset chip and export blockers could not tell them apart.
import {
	applyTransaction,
	type Clip,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	mgClipName,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { mgRegistry, SOCIAL_VARIANTS, socialClipName, VARIANT_LABELS } from '../src/index.ts';

describe('socialClipName', () => {
	it('is "<variant label> · <the name the card shows>"', () => {
		expect(socialClipName({ variant: 'x-post', displayName: 'Luna Park', handle: 'luna' })).toBe(
			'X post · Luna Park',
		);
		expect(socialClipName({ variant: 'tiktok-reply', displayName: 'luna.makes', handle: 'x' })).toBe(
			'TikTok reply · luna.makes',
		);
		expect(socialClipName({ variant: 'instagram-post', displayName: 'Luna', handle: 'luna.makes' })).toBe(
			'Instagram post comment · @luna.makes',
		);
		expect(socialClipName({ variant: 'youtube-comment', handle: '@lunapark' })).toBe(
			'YouTube comment · @lunapark',
		);
		for (const v of SOCIAL_VARIANTS)
			expect(socialClipName({ variant: v, displayName: '', handle: ' ' })).toBe(VARIANT_LABELS[v]);
		expect(socialClipName({ variant: 'nope', displayName: 'A' })).toBeUndefined();
		expect(socialClipName({})).toBeUndefined();
	});
	it('cuts long names and collapses whitespace', () => {
		const n = socialClipName({ variant: 'x-post', displayName: `A  long\nname ${'x'.repeat(80)}` })!;
		expect(n.startsWith('X post · A long name x')).toBe(true);
		expect(n.endsWith('…')).toBe(true);
		expect([...n.slice('X post · '.length)]).toHaveLength(32);
	});
});

describe('social-comment@1 clips are named from their content', () => {
	const info = mgRegistry.get('social-comment', 1)!;
	it('the registry entry carries the hook', () => {
		expect(mgClipName(info, { ...info.defaults, variant: 'x-post', displayName: 'Ada' })).toBe(
			'X post · Ada',
		);
		expect(mgClipName(info, { variant: 'nope' })).toBe('Social comment');
	});
	it('gallery-style insert (preset + fill), Add another and a Properties name edit', () => {
		const ids = createCounterIdSource(3);
		let doc = createEmptyProject({ ids, name: 'Names', preset: 'hd-1080p-30' });
		const ctx = { ids, now: () => 't', revision: 0, registries: defaultRegistries(mgRegistry) };
		const run = (commands: unknown[]) => {
			const r = applyTransaction(doc, { label: 't', origin: 'user', commands } as never, ctx);
			if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
			doc = r.document;
			return r.result;
		};
		const preset = info.presets!.find((p) => p.id === 'x-post')!;
		const r = run([
			{
				type: 'clip.addMotionGraphic',
				at: 0,
				duration: 150,
				track: 'V1',
				template: { id: 'social-comment', version: 1 },
				params: { ...preset.params, displayName: 'Luna Park' },
				fill: { seed: 9 },
				ref: '$c',
			},
		]);
		const id = r.refs.$c!;
		const clips = () => Object.values(doc.sequences)[0]!.clips as Record<string, Clip>;
		expect(clips()[id]!.name).toBe('X post · Luna Park');
		const dup = run([{ type: 'clip.duplicateMotionGraphic', clipId: id, seed: 4 }]);
		const copy = clips()[(dup.results[0] as { clipId: string }).clipId]!;
		const shown = (copy as Extract<Clip, { kind: 'motion-graphic' }>).params.displayName;
		expect(copy.name).toBe(`X post · ${shown}`);
		run([
			{
				type: 'clip.update',
				clipId: id,
				patch: { params: { variant: 'instagram-post', handle: 'luna.makes' } },
			},
		]);
		expect(clips()[id]!.name).toBe('Instagram post comment · @luna.makes');
	});
});
