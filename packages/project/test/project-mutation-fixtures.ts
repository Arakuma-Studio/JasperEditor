import type {
	ClipCommon,
	EffectInstance,
	ProjectDocument,
	ProjectEnvelope,
	Sequence,
	VideoClip,
} from '../src/index.ts';

export type MutationClip = Omit<ClipCommon, 'label'> & {
	kind: string;
	label: string;
	mediaId?: VideoClip['mediaId'];
	opacity?: VideoClip['opacity'];
	effects?: (EffectInstance & { extra?: string })[];
	futureField?: { nested: boolean };
	beam?: { power: number };
};

export type MutationDocument = Omit<ProjectDocument, 'sequences'> & {
	sequences: Record<string, Omit<Sequence, 'clips'> & { clips: Record<string, MutationClip> }>;
};

export type MutationEnvelope = Omit<ProjectEnvelope, 'document'> & {
	document: MutationDocument;
};
