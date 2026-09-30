// Session state shapes (S01 §14, §15, §19.5; ARCHITECTURE §6).
import type { Issue, Origin, ProjectDocument } from '@jasper/project';

export type GapRef = { trackId: string; start: number; end: number };

/** S01:SEL-001. */
export type Selection = {
	timeline: { clips: string[]; transitions: string[]; gaps: GapRef[]; primaryClip: string | null };
	keyframes: { clipOrTrackId: string; keyframeIds: string[] } | null;
	markers: string[];
	project: { items: string[]; primary: string | null };
	tracks: string[];
};

export type SelectionDomain =
	| 'timeline'
	| 'project'
	| 'markers'
	| 'tracks'
	| 'keyframes'
	| 'transitions'
	| 'gaps';
export type SelectMode = 'replace' | 'add' | 'toggle' | 'remove';

/** Per-sequence view state (S01:SES-004, S02:TL-012/013). Persisted in the view record, never undoable. */
export type SequenceViewState = {
	playhead: number;
	pxPerFrame: number;
	scrollFrame: number;
	scrollYVideo: number;
	scrollYAudio: number;
	dividerRatio: number;
	trackHeights: Record<string, number>;
	collapsed: Record<string, boolean>;
	/** Targeted tracks (S02:TL-251). */
	targeting: { video: string[]; audio: string[] };
	/** Source patching: source track label (e.g. "V1"/"A1") → sequence track id or null (off). */
	sourcePatching: Record<string, string | null>;
	keyframeDisplay: Record<string, 'none' | 'opacity' | 'volume' | 'pan'>;
	display: { thumbnails: 'none' | 'head' | 'continuous'; waveforms: boolean; clipNames: boolean };
};

export type ActiveTool =
	| 'selection'
	| 'trackSelectForward'
	| 'trackSelectBackward'
	| 'ripple'
	| 'rolling'
	| 'rateStretch'
	| 'razor'
	| 'slip'
	| 'slide'
	| 'pen'
	| 'hand'
	| 'zoom'
	| 'type';

/** Session toggles (S01:SES-001 `toggles`). */
export type SessionToggles = {
	linkedSelection: boolean;
	snapping: boolean;
	useProxies: boolean;
	previewQuality: 'full' | 'half' | 'quarter';
	activeTool: ActiveTool;
	rippleMarkers: boolean;
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
