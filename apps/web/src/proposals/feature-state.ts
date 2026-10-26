// The engine's view of a proposal feature (spec 15 EA-001/EA-003): whether its producer re-plans stale items ("Refresh
// proposal" is disabled with a reason otherwise) and whether agents may accept its proposals in this project. Read
// once per project and feature; a failed read leaves it unknown (null), never an error in the panel.
import type { ProposalFeature } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { useEffect, useState } from 'react';

type FeaturesEngine = Partial<Pick<EngineClient, 'proposalFeatures'>>;

export function useProposalFeature(
	engine: FeaturesEngine | null,
	projectId: string,
	feature: string | null | undefined,
): ProposalFeature | null {
	const [info, setInfo] = useState<ProposalFeature | null>(null);
	useEffect(() => {
		setInfo(null);
		if (!engine?.proposalFeatures || !feature) return;
		let live = true;
		engine
			.proposalFeatures(projectId)
			.then((r) => {
				if (live) setInfo(r.features.find((f) => f.id === feature) ?? null);
			})
			.catch(() => {
				if (live) setInfo(null);
			});
		return () => {
			live = false;
		};
	}, [engine, projectId, feature]);
	return info;
}
