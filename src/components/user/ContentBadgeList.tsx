import React from 'react';
import { Crown, Gift, Lock, Play, Sparkles, Unlock } from 'lucide-react';
import type { ResolvedBadge } from '../../utils/access';

interface ContentBadgeListProps {
  badges: ResolvedBadge[];
  mobileCompact?: boolean;
  className?: string;
}

function renderBadgeIcon(icon: string, className = 'h-3 w-3 shrink-0') {
  switch (icon) {
    case 'crown':
      return <Crown className={className} />;
    case 'lock':
      return <Lock className={className} />;
    case 'play':
      return <Play className={`${className} fill-current`} />;
    case 'gift':
      return <Gift className={className} />;
    case 'unlock':
      return <Unlock className={className} />;
    case 'sparkles':
    default:
      return <Sparkles className={className} />;
  }
}

export const ContentBadgeList: React.FC<ContentBadgeListProps> = ({
  badges,
  mobileCompact = false,
  className = '',
}) => {
  if (!badges || badges.length === 0) return null;

  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`}>
      {badges.map((b) => (
        <span
          key={b.key}
          title={b.tooltip}
          aria-label={b.text}
          style={{
            backgroundColor: b.color,
            color: b.textColor,
          }}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide shadow-sm"
        >
          {renderBadgeIcon(b.icon)}
          <span className={mobileCompact ? 'hidden sm:inline' : ''}>{b.text}</span>
        </span>
      ))}
    </div>
  );
};
