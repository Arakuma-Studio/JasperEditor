import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';
import { ReviewBadge } from './badge.tsx';

// Review (spec 12 §2.7 "Review", P3-R6; WP3.3b): review a proposal (an agent's, or Auto Sound Pass's) item by item —
// decisions, alternates, notes, ▶ in context — and apply the accepted items as one undo step.
const review: PanelDefinition = {
	kind: 'review',
	title: () => 'Review',
	icon: 'panel.review',
	instance: 'single',
	minSize: { w: 300, h: 200 },
	keymapScope: 'review',
	touch: 'sheet',
	requires: ['engine'],
	dockWith: 'markers',
	agentDescription:
		'Review: the proposal under review (an agent’s or Auto Sound Pass’s) item by item, grouped by role (Hero, Support, Bed, Layers, Tracks; setup items folded) in time order — each row with ✓ / ✕ / · decision, timecode, cue kind, sound, role, gain, reason, ▶ play in context, ⇄ alternates and ✎ note; stale or invalid items say why. Enter accepts, Backspace rejects, U clears, A toggles A/B (Hear proposal), Space plays the item, Shift+Space the range, Ctrl+Enter applies (only the user’s own key press or click), Esc exits; Accept all, Reject all, "Apply n of m". UI commands: proposals.review, proposals.nextItem / prevItem, proposals.acceptItem / rejectItem / clearItem, proposals.cycleAlternative, proposals.playItem / playRange, proposals.toggleHear, proposals.exitReview.',
	menu: [
		{ type: 'command', command: 'proposals.acceptAll', label: 'Accept All' },
		{ type: 'command', command: 'proposals.rejectAll', label: 'Reject All' },
		{ type: 'separator' },
		{ type: 'command', command: 'proposals.toggleHear', label: 'Hear Proposal (A/B)' },
		{ type: 'command', command: 'proposals.playRange', label: 'Play Proposal Range' },
		{ type: 'separator' },
		{ type: 'command', command: 'proposals.discard', label: 'Discard Proposal…' },
		{ type: 'command', command: 'proposals.exitReview', label: 'Exit Review' },
		{ type: 'separator' },
		{ type: 'command', command: 'sound.autoSoundPass', label: 'Auto Sound Pass…' },
	],
	badge: ReviewBadge,
	component: lazyPanel(() => import('./ReviewPanel.tsx'), 'ReviewPanel'),
};
export default review;
