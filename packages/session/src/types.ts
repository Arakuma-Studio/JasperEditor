import type { Issue, Origin, ProjectDocument } from '@jasper/project';
import type { SequenceViewState } from './view.ts';

export type { SequenceViewState } from './view.ts';

export type GapRef = { trackId: string; start: number; end: number };

export type Selection = {
	timeline: { clips: string[]; transitions: string[]; gaps: GapRef[]; primaryClip: string | null };
	keyframes: { clipOrTrackId: string; keyframeIds: string[] } | null;
	markers: string[];
	project: { items: string[]; primary: string | null };
	tracks: string[];
	/** Sound cues (spec 12 §2.7 Cue Seam), ids from `Sequence.soundDesign.cues`; absent = none. */
	cues?: string[];
};

export type SelectionDomain =
	| 'timeline'
	| 'project'
	| 'markers'
	| 'tracks'
	| 'keyframes'
	| 'transitions'
	| 'gaps'
	| 'cues';
export type SelectMode = 'replace' | 'add' | 'toggle' | 'remove';

export type ActiveTool =
	| 'selection'
	| 'trackSelectForward'
	| 'trackSelectBackward'
	| 'ripple'
	| 'rolling'
	| 'rateStretch'
	| 'remix'
	| 'razor'
	| 'slip'
	| 'slide'
	| 'pen'
	| 'rectangle'
	| 'ellipse'
	| 'polygon'
	| 'star'
	| 'hand'
	| 'zoom'
	| 'type'
	| 'camera';

export type SessionToggles = {
	linkedSelection: boolean;
	snapping: boolean;
	useProxies: boolean;
	previewQuality: 'full' | 'half' | 'quarter';
	activeTool: ActiveTool;
	rippleMarkers: boolean;
	/**
	 * Timeline toggle "Insert and overwrite sequences as nests or individual clips" — on
	 * (default): a sequence placed from the Source monitor or the bin becomes nest clips; off: its clips are copied.
	 */
	insertSequencesAsNests?: boolean;
	/** Sequence ▸ Show Through Edits (default on) — through-edit markers on cuts. */
	showThroughEdits?: boolean;
	/**
	 * The monitors play attached proxies (`MediaAsset.proxy`)
	 * instead of the originals. Independent of the playback resolution's engine proxies (`useProxies`). Exports never
	 * use proxies unless asked.
	 */
	attachedProxies?: boolean;
};

export type DerivativeStatus = {
	state: 'none' | 'queued' | 'running' | 'ready' | 'failed';
	progress: number;
	error?: string;
};

/** Runtime media status (S01:LIFE-050). Never in the document. */
export type MediaRuntime = {
	availability: 'resolving' | 'online' | 'offline' | 'needs-engine' | 'error';
	playbackUrl: string | null;
	proxyUrl: string | null;
	posterUrl: string | null;
	spriteUrl: string | null;
	peaksUrl: string | null;
	proxy: DerivativeStatus;
	thumbs: DerivativeStatus;
	peaks: DerivativeStatus;
	derived: DerivativeStatus | null;
	ingest: { phase: 'copying' | 'uploading' | 'fingerprinting' | 'probing'; progress: number } | null;
	/**
	 * The engine's interpreted picture the asset is shown from (`<kind>:<variant>`: a still's
	 * display PNG, a video's interpreted proxy). Absent = none needed.
	 */
	variant?: { key: string; state: 'queued' | 'running' | 'ready' | 'failed'; url?: string; error?: string };
};

export type LeaseState = {
	status: 'none' | 'held' | 'lost' | 'read-only';
	leaseId: string | null;
	holder?: string;
};

export type HistoryEntryView = {
	id: number;
	label: string;
	origin: Origin;
	time: number;
	revisionBefore: number;
	revisionAfter: number;
	created: string[];
	changed: string[];
	deleted: string[];
};

export type HistoryState = { entries: HistoryEntryView[]; index: number; canUndo: boolean; canRedo: boolean };

export type SessionState = {
	document: ProjectDocument;
	revision: number;
	/** Transient gesture document (drawn by timeline/monitors), or null (S01:SES-006). */
	transient: ProjectDocument | null;
	gesture: { label: string } | null;
	selection: Selection;
	views: Record<string, SequenceViewState>;
	tabs: { open: string[] };
	activeSequenceId: string | null;
	toggles: SessionToggles;
	media: Record<string, MediaRuntime>;
	history: HistoryState;
	dirty: boolean;
	lease: LeaseState;
	readOnly: boolean;
	/** Issues found while opening (repairs, newer schema). */
	openIssues: Issue[];
};

export type DocChangedEvent = {
	revision: number;
	label: string;
	origin: Origin;
	created: string[];
	changed: string[];
	deleted: string[];
	isUndo: boolean;
	isRedo: boolean;
};

export type SessionEvents = {
	'doc.changed': DocChangedEvent;
	'selection.changed': { selection: Selection };
	'gesture.changed': { active: boolean; label: string | null };
	'agent.flash': { clipIds: string[]; agent: string };
	closed: Record<string, never>;
};
export type SessionEventName = keyof SessionEvents;
export type Unsubscribe = () => void;
