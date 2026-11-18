import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, ExternalLink, PauseCircle, RotateCcw, ShieldCheck, X } from 'lucide-react';
import type { AdGlobalSettings, AdTargetContentType } from '../../types/streaming';
import type { UnlockBannerPayload } from '../../utils/access';
import { detectCurrentDevice } from '../../utils/adEngine';
import { trackAdEvent } from '../../lib/adsFirebase';

interface BannerUnlockOverlayProps {
  banner: UnlockBannerPayload;
  adSettings?: AdGlobalSettings;
  userId?: string;
  contentId: string;
  episodeId?: string;
  contentType: AdTargetContentType;
  stepIndex: number;
  totalSteps: number;
  onComplete: () => void;
  onCancel: () => void;
  onError: (reason: string) => void;
}

export const BannerUnlockOverlay: React.FC<BannerUnlockOverlayProps> = ({
  banner,
  adSettings,
  userId,
  contentId,
  episodeId,
  contentType,
  stepIndex,
  totalSteps,
  onComplete,
  onCancel,
  onError,
}) => {
  const totalSeconds = Math.max(3, Math.round(banner.displayDurationSeconds || 30));
  const [remainingSeconds, setRemainingSeconds] = useState<number>(totalSeconds);
  const [tabVisible, setTabVisible] = useState<boolean>(() =>
    typeof document !== 'undefined' ? document.visibilityState === 'visible' : true
  );
  const [imageReady, setImageReady] = useState<boolean>(false);
  const [imageError, setImageError] = useState<boolean>(false);
  const [imageAttempt, setImageAttempt] = useState<number>(0);

  const completedRef = useRef(false);
  const impressionTrackedRef = useRef(false);
  const device = detectCurrentDevice();
  const isTestMode = Boolean(adSettings?.testMode);
  const adKind = banner.source === 'customAd' ? 'custom' : 'unlock';

  // Reset state whenever banner step changes
  useEffect(() => {
    completedRef.current = false;
    impressionTrackedRef.current = false;
    setRemainingSeconds(totalSeconds);
    setImageReady(false);
    setImageError(false);
  }, [banner.id, stepIndex, totalSeconds]);

  // Track visible page state so background tabs do NOT count down toward unlock
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const handleVisibility = () => {
      setTabVisible(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  // Record impression once banner is mounted and image is loaded
  useEffect(() => {
    if (!imageReady || impressionTrackedRef.current) return;
    impressionTrackedRef.current = true;
    trackAdEvent(
      {
        adId: banner.id,
        adKind,
        event: 'impression',
        contentId,
        episodeId,
        contentType,
        placement: 'unlock_banner',
        method: 'banner',
        uid: userId || 'guest',
        device,
      },
      isTestMode
    );
  }, [imageReady, banner.id, adKind, contentId, episodeId, contentType, userId, device, isTestMode]);

  // Strict visible viewing-duration countdown (clicks & load do NOT unlock early)
  useEffect(() => {
    if (!tabVisible || !imageReady || imageError || completedRef.current || remainingSeconds <= 0) {
      return;
    }
    const timer = window.setInterval(() => {
      setRemainingSeconds((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [tabVisible, imageReady, imageError, remainingSeconds]);

  // Fire completion callback & verified telemetry only after remainingSeconds reaches 0 outside state updater
  useEffect(() => {
    if (remainingSeconds > 0 || !imageReady || imageError || completedRef.current) return;
    completedRef.current = true;
    trackAdEvent(
      {
        adId: banner.id,
        adKind,
        event: 'banner_complete',
        contentId,
        episodeId,
        contentType,
        placement: 'unlock_banner',
        method: 'banner',
        uid: userId || 'guest',
        device,
      },
      isTestMode
    );
    onComplete();
  }, [
    remainingSeconds,
    imageReady,
    imageError,
    banner.id,
    adKind,
    contentId,
    episodeId,
    contentType,
    userId,
    device,
    isTestMode,
    onComplete,
  ]);

  const progressPct = Math.min(
    100,
    Math.max(0, Math.round(((totalSeconds - remainingSeconds) / totalSeconds) * 100))
  );

  const handleBannerClick = () => {
    trackAdEvent(
      {
        adId: banner.id,
        adKind,
        event: 'click',
        contentId,
        episodeId,
        contentType,
        placement: 'unlock_banner',
        method: 'banner',
        uid: userId || 'guest',
        device,
      },
      isTestMode
    );
  };

  return (
    <div
      data-testid="banner-unlock-overlay"
      className="relative flex min-h-[340px] w-full flex-col justify-between overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 text-white shadow-2xl sm:aspect-video sm:min-h-0"
    >
      {/* Top Disclosure Bar */}
      <div className="relative z-20 flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-black/80 px-4 py-2.5 backdrop-blur-md">
        <div className="flex items-center gap-2 text-xs">
          <span className="rounded bg-violet-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
            {adSettings?.showAdLabel === false ? 'Sponsored' : adSettings?.adLabelText || 'Ad'}
          </span>
          <span className="font-semibold text-zinc-200 tabular-nums">
            Ad {stepIndex + 1} of {totalSteps}
          </span>
          <span aria-hidden="true" className="text-zinc-600">
            ·
          </span>
          <span className="truncate font-medium text-zinc-300">{banner.advertiserName}</span>
        </div>

        <div className="flex items-center gap-3">
          {!tabVisible && (
            <span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-amber-300">
              <PauseCircle className="h-3.5 w-3.5" />
              Paused while tab hidden
            </span>
          )}
          <span
            data-testid="banner-countdown"
            className="font-mono-tabular rounded-md border border-violet-400/35 bg-violet-500/15 px-2.5 py-1 text-xs font-bold text-violet-200"
          >
            Unlocks in 0:{String(remainingSeconds).padStart(2, '0')}
          </span>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel sponsor view"
            className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-white/15 hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
            Close
          </button>
        </div>
      </div>

      {/* Main Clickable Banner Area */}
      <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-gradient-to-br from-zinc-900 via-[#12121d] to-black p-4 sm:p-6">
        {imageError ? (
          <div className="mx-auto max-w-md space-y-3 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-rose-500/20 text-rose-400">
              <AlertCircle className="h-6 w-6" />
            </div>
            <h3 className="font-display text-base font-bold">Banner Creative Unavailable</h3>
            <p className="text-xs text-zinc-400">
              Could not load the sponsor banner image. You can retry loading or try another unlock attempt.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setImageError(false);
                  setImageAttempt((n) => n + 1);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-500"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Retry Image
              </button>
              <button
                type="button"
                onClick={() => onError('Sponsor banner image failed to load.')}
                className="rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-xs font-semibold text-white hover:bg-white/20"
              >
                Report Load Failure
              </button>
            </div>
          </div>
        ) : (
          <a
            key={`${banner.id}-${imageAttempt}`}
            href={banner.destinationUrl}
            target="_blank"
            rel="noopener noreferrer sponsored"
            onClick={handleBannerClick}
            aria-label={`Visit sponsor ${banner.advertiserName}`}
            className="group relative flex h-full w-full items-center justify-center overflow-hidden rounded-xl border border-white/15 bg-black/50 shadow-xl transition-transform hover:scale-[1.008] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
          >
            <img
              src={banner.imageUrl}
              alt={banner.altText || banner.advertiserName}
              referrerPolicy="no-referrer"
              onLoad={() => setImageReady(true)}
              onError={() => {
                setImageReady(false);
                setImageError(true);
              }}
              className="h-full w-full object-contain sm:object-cover"
            />
            {!imageReady && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-950/90">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-violet-500" />
                <p className="mt-2 text-xs text-zinc-400">Loading sponsor banner...</p>
              </div>
            )}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 bg-gradient-to-t from-black/95 via-black/65 to-transparent px-4 py-3">
              <div className="min-w-0">
                <p className="truncate font-display text-sm font-bold text-white">
                  {banner.advertiserName}
                </p>
                <p className="truncate text-[11px] text-zinc-300">
                  Clicking opens the sponsor site in a new tab · Viewing timer continues until verified
                </p>
              </div>
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-violet-600 px-3.5 py-2 text-xs font-semibold text-white shadow-md transition-colors group-hover:bg-violet-500">
                Visit Sponsor
                <ExternalLink className="h-3.5 w-3.5" />
              </span>
            </div>
          </a>
        )}
      </div>

      {/* Bottom Verified Progress Bar */}
      <div className="relative z-20 border-t border-white/10 bg-black/85 px-4 py-2.5">
        <div className="mb-1.5 flex items-center justify-between text-[11px] text-zinc-300">
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
            Keep banner visible to unlock playback ({remainingSeconds}s remaining)
          </span>
          <span className="font-mono-tabular text-zinc-400">{progressPct}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/15">
          <div
            className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all duration-500"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>
    </div>
  );
};
