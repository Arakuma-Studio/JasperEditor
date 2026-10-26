// The card drawn for a social-comment variant whose platform card is not built yet: a visible striped card naming
// the variant, so a clip never renders blank or as another platform (AGENTS §0/§4).
import { type SocialVariant, VARIANT_LABELS } from '@jasper/mg-templates';
import type { SocialCardProps, SocialVariantImpl } from './contract.ts';

export function unavailableVariant(variant: SocialVariant): SocialVariantImpl {
	function UnavailableCard(_: SocialCardProps) {
		return (
			<div
				data-social-variant={variant}
				data-social-unavailable=""
				role="alert"
				style={{
					width: 420,
					boxSizing: 'border-box',
					padding: '18px 20px',
					borderRadius: 10,
					background: 'repeating-linear-gradient(135deg, #2a2a2a 0 10px, #1a1a1a 10px 20px)',
					border: '3px dashed #ffd400',
					color: '#ffd400',
					fontFamily: 'sans-serif',
					fontSize: 20,
					fontWeight: 700,
					lineHeight: 1.3,
					textAlign: 'center',
				}}
			>
				{`${VARIANT_LABELS[variant]}: this card style is not available yet`}
			</div>
		);
	}
	return { Card: UnavailableCard, growOrigin: '0% 0%', unavailable: true };
}
