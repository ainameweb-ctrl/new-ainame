import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import {
  AlertTriangle,
  ArrowLeft,
  Captions,
  Crown,
  Download,
  Lock,
  LogIn,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  SkipForward,
  Sparkles,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type {
  AdEventName,
  AdGlobalSettings,
  AdKind,
  AdPlacementConfig,
  AdUnlockRecord,
  CustomAdItem,
  EpisodeItem,
  MovieItem,
  PlayerCustomSettings,
  SubscriptionPlan,
  UserProfile,
  VastAdItem,
  VideoSource,
  WatchHistoryItem,
} from '../../types/streaming';
import { formatMonthlyPrice, formatTimecode } from '../../utils/catalog';
import {
  applyFailureFallback,
  buildUnlockRecord,
  countUnlocksInLastHour,
  mergeAdUnlockSettings,
  recordUnlockRateTimestamp,
  resolveAccess,
  resolveUnlockAdPlan,
  type UnlockAdResolution,
} from '../../utils/access';
import {
  detectCurrentDevice,
  pickEligibleVastAds,
  pickWeightedAd,
} from '../../utils/adEngine';
import { extractYouTubeVideoId } from '../../utils/youtube';
import { trackAdEvent } from '../../lib/adsFirebase';
import { BannerUnlockOverlay } from './BannerUnlockOverlay';
import { CustomAdSlot } from './CustomAdSlot';
import { AdSlot } from './SiteOverlays';
import { VastPlayerOverlay } from './VastPlayerOverlay';

interface YTPlayerInstance {
  playVideo: () => void;
  pauseVideo: () => void;
  stopVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  mute: () => void;
  unMute: () => void;
  setVolume: (volume: number) => void;
  setPlaybackRate: (rate: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getVideoLoadedFraction: () => number;
  destroy: () => void;
}

interface YTGlobal {
  Player: new (
    element: HTMLElement | string,
    options: {
      width?: string | number;
      height?: string | number;
      videoId: string;
      host?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (event: { target: YTPlayerInstance }) => void;
        onStateChange?: (event: { data: number; target: YTPlayerInstance }) => void;
        onError?: (event: { data: number }) => void;
      };
    }
  ) => YTPlayerInstance;
  PlayerState: {
    ENDED: number;
    PLAYING: number;
    PAUSED: number;
    BUFFERING: number;
  };
}

declare global {
  interface Window {
    YT?: YTGlobal;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytApiPromise: Promise<YTGlobal> | null = null;

function loadYouTubeIframeApi(): Promise<YTGlobal> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Window unavailable'));
  }
  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }
  if (ytApiPromise) return ytApiPromise;

  ytApiPromise = new Promise<YTGlobal>((resolve, reject) => {
    const prevReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prevReady?.();
      if (window.YT?.Player) {
        resolve(window.YT);
      } else {
        reject(new Error('YouTube API failed to initialize'));
      }
    };

    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://www.youtube.com/iframe_api"]'
    );
    if (!existing) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      tag.onerror = () => reject(new Error('Unable to load YouTube IFrame API'));
      document.head.appendChild(tag);
    }
  });
  return ytApiPromise;
}

interface VideoPlayerProps {
  movie: MovieItem;
  episode?: EpisodeItem | null;
  nextEpisode?: EpisodeItem | null;
  user: UserProfile | null;
  plans: SubscriptionPlan[];
  initialProgress?: WatchHistoryItem;
  playerConfig?: PlayerCustomSettings;
  belowPlayerAd?: AdPlacementConfig;
  customAds?: CustomAdItem[];
  vastAds?: VastAdItem[];
  adSettings?: AdGlobalSettings;
  adUnlocks?: Record<string, AdUnlockRecord>;
  onRecordUnlock?: (record: AdUnlockRecord) => Promise<void> | void;
  onConsumeUnlock?: (contentId: string) => Promise<void> | void;
  onTrackFunnelEvent?: (event: AdEventName, meta?: Record<string, unknown>) => void;
  onBack: () => void;
  onSaveProgress: (progressSeconds: number, durationSeconds: number, episode?: EpisodeItem | null) => void;
  onSelectEpisode: (ep: EpisodeItem) => void;
  onOpenAuth: () => void;
  onSubscribePrompt: (planId?: string) => void;
}

export function VideoPlayer({
  movie,
  episode,
  nextEpisode,
  user,
  plans,
  initialProgress,
  playerConfig,
  belowPlayerAd,
  customAds = [],
  vastAds = [],
  adSettings,
  adUnlocks = {},
  onRecordUnlock,
  onConsumeUnlock,
  onTrackFunnelEvent,
  onBack,
  onSaveProgress,
  onSelectEpisode,
  onOpenAuth,
  onSubscribePrompt,
}: VideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ytContainerRef = useRef<HTMLDivElement>(null);
  const ytPlayerRef = useRef<YTPlayerInstance | null>(null);
  const ytReadyRef = useRef(false);
  const ytPendingPlayRef = useRef(false);

  const playerAccent = playerConfig?.accentColor || 'var(--kv-accent,#e50914)';
  const countdownSec = playerConfig?.countdownSeconds ?? 5;
  const autoplayNextEnabled = playerConfig?.autoplayNext ?? true;
  const isCompactBar = playerConfig?.controlBarStyle === 'compact';

  const sources: VideoSource[] = useMemo(() => {
    const epSources = episode?.videoSources?.length ? episode.videoSources : [];
    return epSources.length > 0 ? epSources : movie.videoSources;
  }, [episode, movie.videoSources]);

  const subtitles = useMemo(() => {
    const epSubs = episode?.subtitles?.length ? episode.subtitles : [];
    return epSubs.length > 0 ? epSubs : movie.subtitles;
  }, [episode, movie.subtitles]);

  const defaultSourceIdx = useMemo(() => {
    const pref = playerConfig?.defaultQuality;
    if (!pref || pref === 'auto' || sources.length === 0) return 0;
    const match = sources.findIndex((s) => s.label.toLowerCase().includes(pref.toLowerCase()));
    return match >= 0 ? match : 0;
  }, [sources, playerConfig?.defaultQuality]);

  const [sourceIndex, setSourceIndex] = useState(defaultSourceIdx);
  const [subtitleLang, setSubtitleLang] = useState<string>(playerConfig?.defaultSubtitleLang || 'off');
  const [isPlaying, setIsPlaying] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [isEnded, setIsEnded] = useState(false);
  const [ytBuffering, setYtBuffering] = useState(false);
  const [ytRevealMask, setYtRevealMask] = useState(false);
  const ytMaskTimerRef = useRef<number | null>(null);
  const ytFirstPlayDoneRef = useRef(false);
  const [ytError, setYtError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(initialProgress?.progressSeconds ?? 0);
  const [duration, setDuration] = useState(
    (episode?.duration ?? movie.duration ?? 90) * 60
  );
  const [bufferedPct, setBufferedPct] = useState(0);
  const [volume, setVolume] = useState(0.85);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(playerConfig?.defaultSpeed || 1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [fallbackCanvasMode, setFallbackCanvasMode] = useState(false);
  const [nextCountdown, setNextCountdown] = useState<number | null>(null);

  // VAST + Pause Custom Ad orchestration
  const [activeVastAd, setActiveVastAd] = useState<VastAdItem | null>(null);
  const [activeOverlayAd, setActiveOverlayAd] = useState<VastAdItem | null>(null);
  const [pauseAdDismissed, setPauseAdDismissed] = useState(false);
  const preRollDoneRef = useRef(false);
  const postRollDoneRef = useRef(false);
  const triggeredMidCuesRef = useRef<Set<number>>(new Set());
  const overlayShownRef = useRef(false);
  const sessionAdsShownRef = useRef(0);
  const lastVideoAdAtMsRef = useRef(0);
  const resumeTimestampRef = useRef<number | null>(null);
  const adDevice = detectCurrentDevice();
  const adContentType = movie.type === 'series' ? 'tvshow' : 'movie';

  const armYtVeil = useCallback((ms = 3400) => {
    setYtRevealMask(true);
    if (ytMaskTimerRef.current !== null) {
      window.clearTimeout(ytMaskTimerRef.current);
    }
    ytMaskTimerRef.current = window.setTimeout(() => {
      setYtRevealMask(false);
      ytMaskTimerRef.current = null;
    }, ms);
  }, []);

  useEffect(() => {
    return () => {
      if (ytMaskTimerRef.current !== null) {
        window.clearTimeout(ytMaskTimerRef.current);
      }
    };
  }, []);

  const activeSource = sources[sourceIndex] ?? sources[0];
  const youtubeVideoId = useMemo(
    () => (activeSource?.url ? extractYouTubeVideoId(activeSource.url) : null),
    [activeSource?.url]
  );
  const isYouTubeMode = Boolean(youtubeVideoId);
  const isGenericEmbedMode = activeSource?.type === 'embed' && !isYouTubeMode;

  // Access & Ad-Unlock orchestration state
  const currentContentKey = `${movie.id}:${episode?.id ?? 'movie'}`;
  const [hourlyUnlockCount, setHourlyUnlockCount] = useState<number>(() => countUnlocksInLastHour());
  const [sessionUnlockedKey, setSessionUnlockedKey] = useState<string | null>(null);
  const [activeUnlockPlan, setActiveUnlockPlan] = useState<UnlockAdResolution | null>(null);
  const [activeUnlockStepIndex, setActiveUnlockStepIndex] = useState<number | null>(null);
  const [unlockFailures, setUnlockFailures] = useState<number>(0);
  const [unlockErrorMsg, setUnlockErrorMsg] = useState<string | null>(null);
  const [rotationSeed, setRotationSeed] = useState<number>(0);
  const autoStartAfterUnlockRef = useRef(false);
  const gateTrackedKeyRef = useRef<string | null>(null);
  const fallbackConsumedKeyRef = useRef<string | null>(null);

  const unlockSettings = useMemo(
    () => mergeAdUnlockSettings(adSettings?.adUnlock),
    [adSettings?.adUnlock]
  );

  const access = useMemo(
    () =>
      resolveAccess(user, movie, episode, {
        plans,
        adUnlocks,
        adUnlockSettings: unlockSettings,
        hourlyUnlockCount,
      }),
    [user, movie, episode, plans, adUnlocks, unlockSettings, hourlyUnlockCount]
  );

  // Mid-playback expiry grace: if playback was unlocked when starting this episode, allow finishing it cleanly
  const isLockedPremium = !access.allowed && sessionUnlockedKey !== currentContentKey;

  useEffect(() => {
    if (access.allowed && (hasStarted || isPlaying) && sessionUnlockedKey !== currentContentKey) {
      setSessionUnlockedKey(currentContentKey);
    }
  }, [access.allowed, hasStarted, isPlaying, sessionUnlockedKey, currentContentKey]);

  const resolvedAdPlan = useMemo(
    () =>
      resolveUnlockAdPlan({
        contentId: access.contentId,
        adPolicy: access.adPolicy,
        vastAds,
        customAds,
        settings: unlockSettings,
        adsRequired: access.adsRequired,
        rotationSeed,
      }),
    [access.contentId, access.adPolicy, vastAds, customAds, unlockSettings, access.adsRequired, rotationSeed]
  );

  // Track gate impression once per gated movie/episode load
  useEffect(() => {
    if (!isLockedPremium || access.reason === 'free') return;
    if (gateTrackedKeyRef.current === currentContentKey) return;
    gateTrackedKeyRef.current = currentContentKey;
    trackAdEvent(
      {
        adId: resolvedAdPlan.steps[0]?.kind === 'banner' ? resolvedAdPlan.steps[0].banner.id : resolvedAdPlan.steps[0]?.vast.id || 'gate',
        adKind: 'unlock',
        event: 'gate_view',
        contentId: movie.id,
        episodeId: episode?.id,
        contentType: adContentType,
        placement: 'watch_gate',
        uid: user?.uid || 'guest',
        device: adDevice,
      },
      Boolean(adSettings?.testMode)
    );
    onTrackFunnelEvent?.('gate_view', { movieId: movie.id, episodeId: episode?.id });
  }, [isLockedPremium, access.reason, currentContentKey, resolvedAdPlan.steps, movie.id, episode?.id, adContentType, user?.uid, adDevice, adSettings?.testMode, onTrackFunnelEvent]);

  // Reset source index and playback state when title or episode changes
  useEffect(() => {
    setSourceIndex(defaultSourceIdx);
    setNextCountdown(null);
    setFallbackCanvasMode(false);
    setHasStarted(false);
    setIsEnded(false);
    setIsPlaying(false);
    setYtBuffering(false);
    setYtRevealMask(false);
    ytFirstPlayDoneRef.current = false;
    setYtError(null);
    setActiveVastAd(null);
    setActiveOverlayAd(null);
    setPauseAdDismissed(false);
    setActiveUnlockPlan(null);
    setActiveUnlockStepIndex(null);
    setUnlockFailures(0);
    setUnlockErrorMsg(null);
    setSessionUnlockedKey(null);
    setHourlyUnlockCount(countUnlocksInLastHour());
    preRollDoneRef.current = false;
    postRollDoneRef.current = false;
    triggeredMidCuesRef.current = new Set();
    overlayShownRef.current = false;
    resumeTimestampRef.current = null;
    const startSec =
      initialProgress &&
      (!episode || initialProgress.episodeId === episode.id) &&
      initialProgress.progressSeconds > 5
        ? initialProgress.progressSeconds
        : 0;
    setCurrentTime(startSec);
  }, [movie.id, episode?.id, defaultSourceIdx]);

  // Mid-roll cue trigger + timed VAST non-linear overlay check
  useEffect(() => {
    if (!adSettings || vastAds.length === 0 || !isPlaying || activeVastAd || isLockedPremium) return;

    // Check Mid-Roll
    const eligibleMid = pickEligibleVastAds(
      vastAds,
      adSettings,
      { contentType: adContentType, contentId: movie.id, episodeId: episode?.id, device: adDevice, user },
      'mid-roll',
      sessionAdsShownRef.current,
      lastVideoAdAtMsRef.current
    );
    const chosenMid = pickWeightedAd(eligibleMid);
    if (chosenMid && chosenMid.midRollAtSeconds?.length) {
      const hitCue = chosenMid.midRollAtSeconds.find(
        (sec) => currentTime >= sec && currentTime <= sec + 3 && !triggeredMidCuesRef.current.has(sec)
      );
      if (hitCue !== undefined) {
        triggeredMidCuesRef.current.add(hitCue);
        resumeTimestampRef.current = currentTime;
        if (isYouTubeMode) ytPlayerRef.current?.pauseVideo?.();
        else if (videoRef.current) videoRef.current.pause();
        setIsPlaying(false);
        setActiveVastAd(chosenMid);
        return;
      }
    }

    // Check Timed Overlay
    if (!overlayShownRef.current && !activeOverlayAd) {
      const eligibleOverlay = pickEligibleVastAds(
        vastAds,
        adSettings,
        { contentType: adContentType, contentId: movie.id, episodeId: episode?.id, device: adDevice, user },
        'overlay',
        sessionAdsShownRef.current,
        lastVideoAdAtMsRef.current
      );
      const chosenOverlay = pickWeightedAd(eligibleOverlay);
      if (chosenOverlay && currentTime >= (chosenOverlay.overlayStartSeconds ?? 10)) {
        overlayShownRef.current = true;
        setActiveOverlayAd(chosenOverlay);
      }
    }
  }, [currentTime, isPlaying, activeVastAd, activeOverlayAd, isLockedPremium, adSettings, vastAds, adContentType, movie.id, episode?.id, adDevice, user, isYouTubeMode]);

  // Initialize privacy-enhanced YouTube player with custom KinoVault controls & shields
  useEffect(() => {
    if (isLockedPremium || !isYouTubeMode || !youtubeVideoId) return;
    const host = ytContainerRef.current;
    if (!host) return;

    let cancelled = false;
    ytReadyRef.current = false;
    setYtError(null);

    loadYouTubeIframeApi()
      .then((YT) => {
        if (cancelled || !ytContainerRef.current) return;
        ytContainerRef.current.innerHTML = '';
        const mount = document.createElement('div');
        mount.className = 'h-full w-full';
        ytContainerRef.current.appendChild(mount);

        const player = new YT.Player(mount, {
          width: '100%',
          height: '100%',
          videoId: youtubeVideoId,
          host: 'https://www.youtube-nocookie.com',
          playerVars: {
            controls: 0,
            rel: 0,
            modestbranding: 1,
            iv_load_policy: 3,
            fs: 0,
            disablekb: 1,
            playsinline: 1,
            autoplay: 0,
            enablejsapi: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: (ev) => {
              if (cancelled) return;
              ytReadyRef.current = true;
              const d = ev.target.getDuration?.();
              if (Number.isFinite(d) && d > 0) setDuration(d);
              ev.target.setVolume?.(Math.round(volume * 100));
              if (isMuted) ev.target.mute?.();
              if (currentTime > 5) {
                ev.target.seekTo?.(currentTime, true);
              }
              if (ytPendingPlayRef.current) {
                ytPendingPlayRef.current = false;
                ev.target.playVideo?.();
                setIsPlaying(true);
                setHasStarted(true);
              }
            },
            onStateChange: (ev) => {
              if (cancelled) return;
              if (ev.data === YT.PlayerState.BUFFERING) {
                setYtBuffering(true);
                armYtVeil(2000);
              } else if (ev.data === YT.PlayerState.PLAYING) {
                setYtBuffering(false);
                setIsPlaying(true);
                setHasStarted(true);
                setIsEnded(false);
                if (!ytFirstPlayDoneRef.current) {
                  ytFirstPlayDoneRef.current = true;
                  armYtVeil(3600);
                }
                const d = ev.target.getDuration?.();
                if (Number.isFinite(d) && d > 0) setDuration(d);
              } else if (ev.data === YT.PlayerState.PAUSED) {
                setYtBuffering(false);
                setIsPlaying(false);
              } else if (ev.data === YT.PlayerState.ENDED) {
                // Immediately cover & pause so YouTube suggested videos never display
                setYtBuffering(false);
                setIsPlaying(false);
                setIsEnded(true);
                ev.target.pauseVideo?.();
                const d = ev.target.getDuration?.() || duration;
                onSaveProgress(d, d, episode);
                if (adSettings && vastAds.length > 0 && !postRollDoneRef.current) {
                  const post = pickWeightedAd(
                    pickEligibleVastAds(
                      vastAds,
                      adSettings,
                      { contentType: adContentType, contentId: movie.id, episodeId: episode?.id, device: adDevice, user },
                      'post-roll',
                      sessionAdsShownRef.current,
                      lastVideoAdAtMsRef.current
                    )
                  );
                  if (post) {
                    postRollDoneRef.current = true;
                    setActiveVastAd(post);
                    return;
                  }
                }
                if (nextEpisode && autoplayNextEnabled) setNextCountdown(countdownSec);
              }
            },
            onError: (ev) => {
              if (cancelled) return;
              ytPendingPlayRef.current = false;
              if (ev.data === 101 || ev.data === 150) {
                setYtError('Embedded playback is restricted for this video by the uploader or network.');
              } else {
                setYtError('Unable to stream this embedded video source.');
              }
              setIsPlaying(false);
            },
          },
        });

        ytPlayerRef.current = player;
      })
      .catch(() => {
        if (!cancelled) {
          setFallbackCanvasMode(true);
        }
      });

    return () => {
      cancelled = true;
      ytReadyRef.current = false;
      try {
        ytPlayerRef.current?.destroy();
      } catch {
        // Ignore teardown errors
      }
      ytPlayerRef.current = null;
      if (ytContainerRef.current) {
        ytContainerRef.current.innerHTML = '';
      }
    };
  }, [isLockedPremium, isYouTubeMode, youtubeVideoId]);

  // Poll YouTube player timeline & intercept right before end to avoid YouTube recommendations
  useEffect(() => {
    if (!isYouTubeMode || !isPlaying || isLockedPremium) return;
    const timer = window.setInterval(() => {
      const p = ytPlayerRef.current;
      if (!p || !ytReadyRef.current) return;
      try {
        const cur = p.getCurrentTime?.() ?? 0;
        const dur = p.getDuration?.() ?? 0;
        const frac = p.getVideoLoadedFraction?.() ?? 0;
        if (Number.isFinite(dur) && dur > 0) setDuration(dur);
        if (Number.isFinite(cur)) setCurrentTime(cur);
        if (Number.isFinite(frac)) setBufferedPct(Math.min(100, Math.round(frac * 100)));

        // Intercept 0.9s before completion so YouTube's end-card suggestions never appear
        if (dur > 2 && cur >= dur - 0.9) {
          p.pauseVideo?.();
          setIsPlaying(false);
          setIsEnded(true);
          setCurrentTime(dur);
          onSaveProgress(dur, dur, episode);
          if (adSettings && vastAds.length > 0 && !postRollDoneRef.current) {
            const post = pickWeightedAd(
              pickEligibleVastAds(
                vastAds,
                adSettings,
                { contentType: adContentType, contentId: movie.id, episodeId: episode?.id, device: adDevice, user },
                'post-roll',
                sessionAdsShownRef.current,
                lastVideoAdAtMsRef.current
              )
            );
            if (post) {
              postRollDoneRef.current = true;
              setActiveVastAd(post);
              return;
            }
          }
          if (nextEpisode && autoplayNextEnabled) setNextCountdown(countdownSec);
        }
      } catch {
        // Ignore transient API polling issues
      }
    }, 400);
    return () => window.clearInterval(timer);
  }, [isYouTubeMode, isPlaying, isLockedPremium, episode, nextEpisode, onSaveProgress, autoplayNextEnabled, countdownSec]);

  // Attach HLS or MP4 stream (for non-YouTube sources)
  useEffect(() => {
    if (isLockedPremium || !activeSource || isYouTubeMode || isGenericEmbedMode) return;
    if (!activeSource.url || activeSource.url.startsWith('local://')) {
      setFallbackCanvasMode(true);
      return;
    }
    const video = videoRef.current;
    if (!video) return;

    let hls: Hls | null = null;
    if (activeSource.type === 'hls' && Hls.isSupported()) {
      hls = new Hls();
      hls.loadSource(activeSource.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (data.fatal) {
          setFallbackCanvasMode(true);
        }
      });
    } else {
      video.src = activeSource.url;
    }

    const onLoadedMeta = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        setDuration(video.duration);
      }
      if (currentTime > 0 && currentTime < (video.duration || duration)) {
        video.currentTime = currentTime;
      }
    };

    const onError = () => {
      setFallbackCanvasMode(true);
    };

    video.addEventListener('loadedmetadata', onLoadedMeta);
    video.addEventListener('error', onError);

    return () => {
      video.removeEventListener('loadedmetadata', onLoadedMeta);
      video.removeEventListener('error', onError);
      if (hls) hls.destroy();
    };
  }, [activeSource, isLockedPremium, isYouTubeMode, isGenericEmbedMode]);

  // Fallback simulated cinema player tick when video CDN is unreachable in sandbox
  useEffect(() => {
    if (!fallbackCanvasMode || !isPlaying || isLockedPremium || isYouTubeMode) return;
    const timer = window.setInterval(() => {
      setCurrentTime((prev) => {
        const next = prev + playbackRate * 0.5;
        if (next >= duration) {
          setIsPlaying(false);
          setIsEnded(true);
          if (nextEpisode && autoplayNextEnabled) setNextCountdown(countdownSec);
          return duration;
        }
        return next;
      });
      setBufferedPct((prev) =>
        Math.min(100, Math.max(prev, ((currentTime + 20) / Math.max(1, duration)) * 100))
      );
    }, 500);
    return () => window.clearInterval(timer);
  }, [fallbackCanvasMode, isPlaying, playbackRate, duration, isLockedPremium, isYouTubeMode, nextEpisode, currentTime, autoplayNextEnabled, countdownSec]);

  // Render animated cinema preview on fallback canvas
  useEffect(() => {
    if (!fallbackCanvasMode) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = '#09090d';
    ctx.fillRect(0, 0, w, h);

    const grad = ctx.createRadialGradient(
      w * (0.35 + 0.1 * Math.sin(currentTime * 0.4)),
      h * 0.42,
      20,
      w * 0.5,
      h * 0.5,
      w * 0.7
    );
    grad.addColorStop(0, 'rgba(229, 9, 20, 0.25)');
    grad.addColorStop(0.5, 'rgba(24, 24, 34, 0.85)');
    grad.addColorStop(1, '#09090d');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '600 28px Outfit, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(episode ? `${movie.title} — ${episode.title}` : movie.title, w / 2, h / 2 - 12);

    ctx.fillStyle = 'rgba(212,212,216,0.75)';
    ctx.font = '400 15px JetBrains Mono, monospace';
    ctx.fillText(
      `Preview Stream · ${formatTimecode(currentTime)} / ${formatTimecode(duration)}`,
      w / 2,
      h / 2 + 24
    );
  }, [fallbackCanvasMode, currentTime, duration, movie.title, episode]);

  // Persist watch progress every 15 seconds while playing
  const latestProgressRef = useRef({ currentTime, duration, episode });
  latestProgressRef.current = { currentTime, duration, episode };

  useEffect(() => {
    if (!isPlaying || isLockedPremium) return;
    const id = window.setInterval(() => {
      const snap = latestProgressRef.current;
      onSaveProgress(snap.currentTime, snap.duration, snap.episode);
    }, 15_000);
    return () => window.clearInterval(id);
  }, [isPlaying, isLockedPremium, onSaveProgress]);

  // Save on unmount / exit
  useEffect(() => {
    return () => {
      if (!isLockedPremium) {
        const snap = latestProgressRef.current;
        if (snap.currentTime > 1) {
          onSaveProgress(snap.currentTime, snap.duration, snap.episode);
        }
      }
    };
  }, [isLockedPremium, onSaveProgress]);

  // Next episode countdown
  useEffect(() => {
    if (nextCountdown === null || !nextEpisode) return;
    if (nextCountdown <= 0) {
      setNextCountdown(null);
      onSelectEpisode(nextEpisode);
      return;
    }
    const t = window.setTimeout(() => setNextCountdown((c) => (c !== null ? c - 1 : null)), 1000);
    return () => window.clearTimeout(t);
  }, [nextCountdown, nextEpisode, onSelectEpisode]);

  const startContentPlayback = useCallback(() => {
    setPauseAdDismissed(false);
    if (
      access.activeUnlock?.method === 'fallback' &&
      fallbackConsumedKeyRef.current !== currentContentKey
    ) {
      fallbackConsumedKeyRef.current = currentContentKey;
      void onConsumeUnlock?.(access.contentId);
    }
    if (isYouTubeMode) {
      const p = ytPlayerRef.current;
      if (!p || !ytReadyRef.current) {
        ytPendingPlayRef.current = true;
        return;
      }
      if (resumeTimestampRef.current !== null) {
        p.seekTo?.(resumeTimestampRef.current, true);
        resumeTimestampRef.current = null;
      }
      armYtVeil(ytFirstPlayDoneRef.current ? 1800 : 3600);
      p.playVideo?.();
      setIsPlaying(true);
      setHasStarted(true);
      setIsEnded(false);
      return;
    }
    if (fallbackCanvasMode) {
      setIsPlaying(true);
      setHasStarted(true);
      setIsEnded(false);
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    if (resumeTimestampRef.current !== null) {
      video.currentTime = resumeTimestampRef.current;
      resumeTimestampRef.current = null;
    }
    video.play().catch(() => setFallbackCanvasMode(true));
    setIsPlaying(true);
    setHasStarted(true);
    setIsEnded(false);
  }, [access.activeUnlock?.method, access.contentId, currentContentKey, onConsumeUnlock, isYouTubeMode, fallbackCanvasMode, armYtVeil]);

  // Auto-start video right after ad-unlock transition mounts player DOM
  useEffect(() => {
    if (!isLockedPremium && autoStartAfterUnlockRef.current) {
      autoStartAfterUnlockRef.current = false;
      preRollDoneRef.current = true;
      const t = window.setTimeout(() => {
        startContentPlayback();
      }, 60);
      return () => window.clearTimeout(t);
    }
  }, [isLockedPremium, startContentPlayback]);

  const togglePlay = useCallback(() => {
    if (isLockedPremium || activeVastAd) return;

    // Trigger pre-roll VAST on initial play press when eligible
    if (!hasStarted && !preRollDoneRef.current && adSettings && vastAds.length > 0) {
      preRollDoneRef.current = true;
      const pre = pickWeightedAd(
        pickEligibleVastAds(
          vastAds,
          adSettings,
          { contentType: adContentType, contentId: movie.id, episodeId: episode?.id, device: adDevice, user },
          'pre-roll',
          sessionAdsShownRef.current,
          lastVideoAdAtMsRef.current
        )
      );
      if (pre) {
        setActiveVastAd(pre);
        return;
      }
    }

    if (isYouTubeMode) {
      const p = ytPlayerRef.current;
      if (!p || !ytReadyRef.current) {
        ytPendingPlayRef.current = true;
        return;
      }
      if (isEnded) {
        setIsEnded(false);
        setCurrentTime(0);
        armYtVeil(2600);
        p.seekTo?.(0, true);
        p.playVideo?.();
        setIsPlaying(true);
        setHasStarted(true);
        return;
      }
      if (isPlaying) {
        p.pauseVideo?.();
        setIsPlaying(false);
        setPauseAdDismissed(false);
        onSaveProgress(currentTime, duration, episode);
      } else {
        startContentPlayback();
      }
      return;
    }

    if (fallbackCanvasMode) {
      if (isEnded) {
        setIsEnded(false);
        setCurrentTime(0);
        setIsPlaying(true);
        setHasStarted(true);
        return;
      }
      setIsPlaying((prev) => {
        if (prev) {
          setPauseAdDismissed(false);
          onSaveProgress(currentTime, duration, episode);
        } else {
          setHasStarted(true);
        }
        return !prev;
      });
      return;
    }

    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      startContentPlayback();
    } else {
      video.pause();
      setIsPlaying(false);
      setPauseAdDismissed(false);
      onSaveProgress(video.currentTime, video.duration || duration, episode);
    }
  }, [
    isLockedPremium,
    activeVastAd,
    hasStarted,
    adSettings,
    vastAds,
    adContentType,
    movie.id,
    episode,
    adDevice,
    user,
    isYouTubeMode,
    isEnded,
    isPlaying,
    fallbackCanvasMode,
    currentTime,
    duration,
    onSaveProgress,
    armYtVeil,
    startContentPlayback,
  ]);

  const seekTo = useCallback(
    (sec: number) => {
      const clamped = Math.max(0, Math.min(duration, sec));
      setCurrentTime(clamped);
      if (clamped < duration - 1) {
        setIsEnded(false);
      }
      if (isYouTubeMode && ytPlayerRef.current && ytReadyRef.current) {
        armYtVeil(2000);
        ytPlayerRef.current.seekTo?.(clamped, true);
        return;
      }
      if (!fallbackCanvasMode && videoRef.current) {
        videoRef.current.currentTime = clamped;
      }
    },
    [duration, fallbackCanvasMode, isYouTubeMode, armYtVeil]
  );

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      if (isYouTubeMode && ytPlayerRef.current && ytReadyRef.current) {
        if (next) ytPlayerRef.current.mute?.();
        else ytPlayerRef.current.unMute?.();
      }
      if (videoRef.current) videoRef.current.muted = next;
      return next;
    });
  }, [isYouTubeMode]);

  const changeVolume = useCallback(
    (val: number) => {
      const clamped = Math.max(0, Math.min(1, val));
      setVolume(clamped);
      setIsMuted(clamped === 0);
      if (isYouTubeMode && ytPlayerRef.current && ytReadyRef.current) {
        ytPlayerRef.current.setVolume?.(Math.round(clamped * 100));
        if (clamped === 0) ytPlayerRef.current.mute?.();
        else ytPlayerRef.current.unMute?.();
      }
      if (videoRef.current) {
        videoRef.current.volume = clamped;
        videoRef.current.muted = clamped === 0;
      }
    },
    [isYouTubeMode]
  );

  const changeSpeed = useCallback(
    (rate: number) => {
      setPlaybackRate(rate);
      if (isYouTubeMode && ytPlayerRef.current && ytReadyRef.current) {
        ytPlayerRef.current.setPlaybackRate?.(rate);
      }
      if (videoRef.current) videoRef.current.playbackRate = rate;
    },
    [isYouTubeMode]
  );

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.().catch(() => undefined);
      setIsFullscreen(true);
    } else {
      document.exitFullscreen?.().catch(() => undefined);
      setIsFullscreen(false);
    }
  }, []);

  const togglePiP = useCallback(async () => {
    const video = videoRef.current;
    if (!video || fallbackCanvasMode || isYouTubeMode) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (video.requestPictureInPicture) {
        await video.requestPictureInPicture();
      }
    } catch {
      // Ignore unsupported PiP
    }
  }, [fallbackCanvasMode, isYouTubeMode]);

  // Keyboard shortcuts: Space, Left/Right, Up/Down, F, M, C
  useEffect(() => {
    if (playerConfig?.enableKeyboardShortcuts === false) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k':
          e.preventDefault();
          togglePlay();
          break;
        case 'arrowleft':
          e.preventDefault();
          seekTo(currentTime - 10);
          break;
        case 'arrowright':
          e.preventDefault();
          seekTo(currentTime + 10);
          break;
        case 'arrowup':
          e.preventDefault();
          changeVolume(volume + 0.1);
          break;
        case 'arrowdown':
          e.preventDefault();
          changeVolume(volume - 0.1);
          break;
        case 'f':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'm':
          e.preventDefault();
          toggleMute();
          break;
        case 'c':
          e.preventDefault();
          setSubtitleLang((prev) =>
            prev === 'off' ? subtitles[0]?.lang ?? 'en' : 'off'
          );
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [playerConfig?.enableKeyboardShortcuts, togglePlay, seekTo, currentTime, changeVolume, volume, toggleFullscreen, toggleMute, subtitles]);

  // Auto-hide controls while playing
  useEffect(() => {
    if (!isPlaying) {
      setShowControls(true);
      return;
    }
    const timer = window.setTimeout(() => setShowControls(false), 3200);
    return () => window.clearTimeout(timer);
  }, [isPlaying, currentTime]);

  const completeUnlockAndPlay = async (
    method: 'vast' | 'banner' | 'fallback',
    adId?: string | null
  ) => {
    const policy = access.adPolicy;
    const record = buildUnlockRecord({
      movieId: movie.id,
      episodeId: episode?.id ?? null,
      method,
      adId: adId ?? null,
      validityMode: policy.validityMode ?? unlockSettings.validityMode,
      validityHours: policy.validityHours ?? unlockSettings.validityHours,
    });
    if (method !== 'fallback') {
      const nextCount = recordUnlockRateTimestamp();
      setHourlyUnlockCount(nextCount);
    }
    trackAdEvent(
      {
        adId: adId || 'unlock',
        adKind: 'unlock',
        event: 'unlock_complete',
        contentId: movie.id,
        episodeId: episode?.id,
        contentType: adContentType,
        placement: 'watch_gate',
        method,
        uid: user?.uid || 'guest',
        device: adDevice,
      },
      Boolean(adSettings?.testMode)
    );
    onTrackFunnelEvent?.('unlock_complete', { method, adId, contentId: access.contentId });

    setActiveUnlockPlan(null);
    setActiveUnlockStepIndex(null);
    setUnlockErrorMsg(null);
    setSessionUnlockedKey(currentContentKey);
    autoStartAfterUnlockRef.current = true;
    await onRecordUnlock?.(record);
  };

  const handleStartAdUnlock = () => {
    if (!navigator.onLine) {
      setUnlockErrorMsg('You appear to be offline. Reconnect to load sponsor advertisements.');
      return;
    }
    const nextPlan = resolveUnlockAdPlan({
      contentId: access.contentId,
      adPolicy: access.adPolicy,
      vastAds,
      customAds,
      settings: unlockSettings,
      adsRequired: access.adsRequired,
      rotationSeed,
    });
    if (nextPlan.steps.length === 0) {
      const nextFailures = unlockFailures + 1;
      setUnlockFailures(nextFailures);
      trackAdEvent(
        {
          adId: 'unavailable',
          adKind: 'unlock',
          event: 'unlock_fail',
          contentId: movie.id,
          episodeId: episode?.id,
          contentType: adContentType,
          placement: 'watch_gate',
          uid: user?.uid || 'guest',
          device: adDevice,
        },
        Boolean(adSettings?.testMode)
      );
      const decision = applyFailureFallback(nextFailures, unlockSettings);
      if (!decision.canRetry && decision.fallback === 'allow_one_free') {
        void completeUnlockAndPlay('fallback', 'fallback-no-ad');
        return;
      }
      setUnlockErrorMsg(
        nextPlan.unavailableReason || 'Advertisement could not be loaded (blocked or unavailable).'
      );
      return;
    }

    const firstStep = nextPlan.steps[0];
    const firstAdId = firstStep.kind === 'banner' ? firstStep.banner.id : firstStep.vast.id;
    trackAdEvent(
      {
        adId: firstAdId,
        adKind: 'unlock',
        event: 'ad_start',
        contentId: movie.id,
        episodeId: episode?.id,
        contentType: adContentType,
        placement: 'watch_gate',
        method: firstStep.kind,
        uid: user?.uid || 'guest',
        device: adDevice,
      },
      Boolean(adSettings?.testMode)
    );
    onTrackFunnelEvent?.('ad_start', { method: firstStep.kind, adId: firstAdId });
    setUnlockErrorMsg(null);
    setActiveUnlockPlan(nextPlan);
    setActiveUnlockStepIndex(0);
  };

  const handleUnlockStepError = (reason: string) => {
    const step =
      activeUnlockPlan && activeUnlockStepIndex !== null
        ? activeUnlockPlan.steps[activeUnlockStepIndex]
        : null;
    const stepAdId = step ? (step.kind === 'banner' ? step.banner.id : step.vast.id) : 'unlock-err';
    const nextFailures = unlockFailures + 1;
    setUnlockFailures(nextFailures);
    setActiveUnlockPlan(null);
    setActiveUnlockStepIndex(null);
    setRotationSeed((s) => s + 1);

    trackAdEvent(
      {
        adId: stepAdId,
        adKind: 'unlock',
        event: 'unlock_fail',
        contentId: movie.id,
        episodeId: episode?.id,
        contentType: adContentType,
        placement: 'watch_gate',
        method: step?.kind,
        uid: user?.uid || 'guest',
        device: adDevice,
      },
      Boolean(adSettings?.testMode)
    );
    onTrackFunnelEvent?.('unlock_fail', { reason, attempt: nextFailures });

    const decision = applyFailureFallback(nextFailures, unlockSettings);
    if (!decision.canRetry && decision.fallback === 'allow_one_free') {
      void completeUnlockAndPlay('fallback', stepAdId);
      return;
    }
    setUnlockErrorMsg(
      !decision.canRetry
        ? 'Advertisement failed to load (ad blocker or network issue). Subscribe for uninterrupted access.'
        : reason || 'Could not play the sponsor advertisement. Please try again.'
    );
  };

  const handleSubscribeCta = (planId?: string) => {
    trackAdEvent(
      {
        adId: planId || access.requiredPlan?.id || 'plan',
        adKind: 'unlock',
        event: 'subscribe_click',
        contentId: movie.id,
        episodeId: episode?.id,
        contentType: adContentType,
        placement: 'watch_gate',
        uid: user?.uid || 'guest',
        device: adDevice,
      },
      Boolean(adSettings?.testMode)
    );
    onTrackFunnelEvent?.('subscribe_click', { planId: planId || access.requiredPlan?.id });
    onSubscribePrompt(planId);
  };

  if (isLockedPremium) {
    const planLabel = access.requiredPlan?.name ?? access.requiredPlanName ?? 'Cinema Plus';
    const priceLabel = access.requiredPlan
      ? formatMonthlyPrice(access.requiredPlan.pricePerMonth, access.requiredPlan.currency)
      : '';
    const activeUnlockStep =
      activeUnlockPlan && activeUnlockStepIndex !== null
        ? activeUnlockPlan.steps[activeUnlockStepIndex] ?? null
        : null;
    const previewFirstStep = resolvedAdPlan.steps[0];
    const adDurationHint =
      previewFirstStep?.kind === 'banner'
        ? `Free · About ${previewFirstStep.banner.displayDurationSeconds} seconds`
        : unlockSettings.watchAdSubtext || 'Free · About 30 seconds';
    const canRetryAfterFailure = applyFailureFallback(unlockFailures, unlockSettings).canRetry;

    // Active In-Player Ad-Unlock Experience (VAST Video or Clickable Sponsor Banner)
    if (activeUnlockStep) {
      return (
        <div className="mx-auto max-w-5xl px-4 py-10">
          <div className="mb-4 flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                setActiveUnlockPlan(null);
                setActiveUnlockStepIndex(null);
              }}
              className="inline-flex items-center gap-2 text-sm font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
            >
              <ArrowLeft className="h-4 w-4" />
              Cancel Ad Unlock
            </button>
            <span className="text-xs text-zinc-400">
              {episode ? `${movie.title} · S${episode.seasonNumber} E${episode.number}` : movie.title}
            </span>
          </div>

          <div className="relative min-h-[340px] w-full overflow-hidden rounded-2xl border border-zinc-800 bg-black shadow-2xl sm:aspect-video sm:min-h-0">
            {activeUnlockStep.kind === 'banner' ? (
              <BannerUnlockOverlay
                banner={activeUnlockStep.banner}
                adSettings={adSettings}
                userId={user?.uid}
                contentId={movie.id}
                episodeId={episode?.id}
                contentType={adContentType}
                stepIndex={activeUnlockStep.stepIndex}
                totalSteps={activeUnlockStep.totalSteps}
                onComplete={() => {
                  const nextIdx = (activeUnlockStepIndex ?? 0) + 1;
                  if (activeUnlockPlan && nextIdx < activeUnlockPlan.steps.length) {
                    setActiveUnlockStepIndex(nextIdx);
                  } else {
                    void completeUnlockAndPlay('banner', activeUnlockStep.banner.id);
                  }
                }}
                onCancel={() => {
                  setActiveUnlockPlan(null);
                  setActiveUnlockStepIndex(null);
                  setUnlockErrorMsg('Sponsor banner closed before timer completed — watch full duration to unlock.');
                }}
                onError={(msg) => handleUnlockStepError(msg)}
              />
            ) : (
              <VastPlayerOverlay
                ad={activeUnlockStep.vast.vastAd}
                adSettings={adSettings ?? {
                  adsEnabled: true,
                  hideAdsForPremium: true,
                  maxAdsPerSession: 4,
                  minSecondsBetweenVideoAds: 180,
                  adLabelText: 'Ad',
                  showAdLabel: true,
                  testMode: false,
                  defaultDailyCap: 0,
                }}
                userId={user?.uid}
                contentId={movie.id}
                contentType={adContentType}
                unlockConfig={{
                  isUnlockFlow: true,
                  skipAfterSecondsOverride: activeUnlockStep.vast.skipAfterSeconds,
                  stepIndex: activeUnlockStep.stepIndex,
                  totalSteps: activeUnlockStep.totalSteps,
                }}
                onFinish={(outcome) => {
                  if (outcome === 'error') {
                    handleUnlockStepError('VAST video ad blocked or unavailable.');
                    return;
                  }
                  if (outcome === 'skip') {
                    const skipOverride = activeUnlockStep.vast.skipAfterSeconds ?? 0;
                    if (skipOverride <= 0) {
                      setActiveUnlockPlan(null);
                      setActiveUnlockStepIndex(null);
                      setUnlockErrorMsg('Ad closed early before completion — watch the full ad to unlock.');
                      return;
                    }
                  }
                  const nextIdx = (activeUnlockStepIndex ?? 0) + 1;
                  if (activeUnlockPlan && nextIdx < activeUnlockPlan.steps.length) {
                    setActiveUnlockStepIndex(nextIdx);
                  } else {
                    void completeUnlockAndPlay('vast', activeUnlockStep.vast.id);
                  }
                }}
              />
            )}
          </div>
        </div>
      );
    }

    // Blurred-Poster Subscription & Ad-Unlock Watch Gate
    return (
      <div className="mx-auto max-w-5xl px-4 py-10" data-testid="watch-gate">
        <button
          type="button"
          onClick={onBack}
          className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Details
        </button>

        <div className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 p-6 text-center text-white shadow-2xl sm:p-12">
          <img
            src={episode?.thumbnailUrl || movie.bannerUrl || movie.posterUrl}
            alt={movie.title}
            referrerPolicy="no-referrer"
            className="absolute inset-0 h-full w-full scale-105 object-cover opacity-30 blur-sm"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black via-black/75 to-black/65" />

          <div className="relative z-10 mx-auto max-w-md space-y-4 py-6 sm:py-10">
            {/* Orange Subscription Badge + Format Indicator */}
            <div className="flex flex-wrap items-center justify-center gap-2">
              {access.options.subscribe ? (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/20 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-amber-300">
                  <Crown className="h-3.5 w-3.5" />
                  {planLabel}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-violet-500/40 bg-violet-500/20 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-violet-200">
                  <Sparkles className="h-3.5 w-3.5" />
                  Ad Unlock
                </span>
              )}
              {episode && (
                <span className="rounded-md border border-white/15 bg-black/50 px-2.5 py-1 text-[11px] font-medium text-zinc-300">
                  S{episode.seasonNumber} · E{episode.number}
                </span>
              )}
            </div>

            {access.reason === 'sign_in_required' && !access.options.watchAd ? (
              <>
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-white/15 text-white">
                  <LogIn className="h-6 w-6" />
                </div>
                <h1 className="font-display text-2xl font-bold sm:text-3xl">Sign In to Watch</h1>
                <p className="text-sm leading-relaxed text-zinc-300">
                  Sign in to continue watching “{movie.title}”
                  {episode ? ` — S${episode.seasonNumber} E${episode.number}` : ''}.
                </p>
                <div className="flex flex-col items-center gap-3 pt-2">
                  <button
                    type="button"
                    onClick={onOpenAuth}
                    className="w-full max-w-xs rounded-xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white shadow-lg transition-colors hover:bg-violet-500"
                  >
                    Sign In to Watch
                  </button>
                  {access.options.subscribe && (
                    <button
                      type="button"
                      onClick={() => handleSubscribeCta(access.requiredPlan?.id ?? movie.requiredPlanId ?? undefined)}
                      className="w-full max-w-xs rounded-xl border border-white/30 bg-white/5 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-white/15"
                    >
                      View {planLabel} Plan{priceLabel ? ` (${priceLabel})` : ''}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/20 text-amber-400">
                  <Lock className="h-6 w-6" />
                </div>

                <h1 className="font-display text-2xl font-bold sm:text-3xl">
                  {access.options.watchAd
                    ? unlockSettings.gateTitle || 'Unlock this episode'
                    : `Subscription Required: ${planLabel}`}
                </h1>

                <p className="text-sm leading-relaxed text-zinc-300">
                  {access.reason === 'rate_limited'
                    ? `You've reached the hourly limit of ${access.maxUnlocksPerHour} free ad unlocks. Upgrade to ${planLabel} for unlimited ad-free streaming.`
                    : access.options.watchAd
                    ? unlockSettings.gateDescription
                    : `“${movie.title}” requires an active “${planLabel}” subscription${priceLabel ? ` (${priceLabel})` : ''}.`}
                </p>

                {unlockErrorMsg && (
                  <div className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-500/15 p-3 text-left text-xs text-rose-200">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                    <span>{unlockErrorMsg}</span>
                  </div>
                )}

                <div className="space-y-3 pt-2">
                  {/* Guest Sign-In CTA when not signed in */}
                  {!user && (
                    <button
                      type="button"
                      onClick={onOpenAuth}
                      className="inline-flex w-full max-w-xs items-center justify-center gap-2 rounded-xl border border-white/25 bg-white/10 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-white/20"
                    >
                      <LogIn className="h-4 w-4" />
                      Sign In to Watch
                    </button>
                  )}

                  {/* 1 & 2. Purple Primary Watch Ad Button + Subtext */}
                  {access.options.watchAd && canRetryAfterFailure && (
                    <div className="space-y-1.5">
                      <button
                        type="button"
                        data-testid="watch-ad-unlock-btn"
                        onClick={handleStartAdUnlock}
                        className="inline-flex w-full max-w-xs items-center justify-center gap-2 rounded-xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white shadow-lg transition-colors hover:bg-violet-500"
                      >
                        <Play className="h-4 w-4 fill-current" />
                        {unlockFailures > 0
                          ? 'Try Again'
                          : unlockSettings.watchAdButtonText || 'Watch Ad to Unlock'}
                      </button>
                      <p className="text-xs text-zinc-400">
                        {adDurationHint}
                        {access.adsRequired > 1 ? ` · ${access.adsRequired} ads required` : ''}
                      </p>
                    </div>
                  )}

                  {/* 3 & 4. Outlined Subscription CTA + Subtext */}
                  {access.options.subscribe && (
                    <div className="space-y-1.5 pt-1">
                      <button
                        type="button"
                        data-testid="view-plan-btn"
                        onClick={() =>
                          handleSubscribeCta(access.requiredPlan?.id ?? movie.requiredPlanId ?? undefined)
                        }
                        className="w-full max-w-xs rounded-xl border border-white/30 bg-transparent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-white/10"
                      >
                        View {planLabel} Plan{priceLabel ? ` (${priceLabel})` : ''}
                      </button>
                      <p className="text-xs text-zinc-400">
                        {unlockSettings.subscribeSubtext || 'Subscribers watch without ads.'}
                      </p>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-200/70 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to {movie.title}
        </button>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {episode
            ? `Season ${episode.seasonNumber} · Episode ${episode.number}: ${episode.title}`
            : `${movie.releaseYear} · ${movie.ageRating}`}
        </div>
      </div>

      <div
        ref={containerRef}
        onMouseMove={() => setShowControls(true)}
        className="relative aspect-video w-full overflow-hidden rounded-xl border border-zinc-200 bg-black shadow-2xl dark:border-zinc-800"
      >
        {isGenericEmbedMode ? (
          <iframe
            src={activeSource.url}
            title={movie.title}
            className="h-full w-full"
            allowFullScreen
          />
        ) : (
          <>
            {isYouTubeMode ? (
              <div className="relative h-full w-full overflow-hidden bg-black">
                {/* Embedded youtube-nocookie iframe with Cinema Overscan Crop (hides top channel bar & bottom-right YouTube logo) */}
                <div
                  ref={ytContainerRef}
                  className="pointer-events-none h-full w-full origin-center select-none scale-[1.18]"
                />

                {/* Edge Cinema Vignette Guards to mask top/bottom boundaries cleanly */}
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-black/85 to-transparent"
                />
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-10 bg-gradient-to-t from-black/90 to-transparent"
                />

                {/* Transparent click shield: intercepts all clicks/hover/right-click so viewers never click out */}
                <div
                  role="presentation"
                  onClick={togglePlay}
                  onDoubleClick={toggleFullscreen}
                  onContextMenu={(e) => e.preventDefault()}
                  className="absolute inset-0 z-10 cursor-pointer"
                />

                {/* Startup / Buffering / Seek Cinema Veil hides YouTube's transient title & channel bar */}
                {hasStarted && isPlaying && !isEnded && !ytError && (ytBuffering || ytRevealMask) && (
                  <div
                    onContextMenu={(e) => e.preventDefault()}
                    className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/95 text-white transition-opacity duration-500"
                  >
                    <div
                      className="h-9 w-9 animate-spin rounded-full border-2 border-white/20"
                      style={{ borderTopColor: playerAccent }}
                    />
                    <p className="mt-3 font-display text-sm font-semibold tracking-wide text-zinc-200">
                      {episode ? `${movie.title} — ${episode.title}` : movie.title}
                    </p>
                    <p className="mt-1 text-[11px] text-zinc-400">
                      Preparing KinoVault stream...
                    </p>
                  </div>
                )}

                {/* Custom idle / paused / ended poster cover hides native YouTube overlays & end suggestions */}
                {(!hasStarted || !isPlaying || isEnded || ytError) && nextCountdown === null && (
                  <div
                    onClick={!ytError ? togglePlay : undefined}
                    onContextMenu={(e) => e.preventDefault()}
                    className="absolute inset-0 z-10 flex cursor-pointer flex-col items-center justify-center bg-zinc-950 px-6 text-center text-white"
                  >
                    {(playerConfig?.loadingImageUrl || episode?.thumbnailUrl || movie.bannerUrl || movie.posterUrl) && (
                      <img
                        src={(!hasStarted && playerConfig?.loadingImageUrl) || episode?.thumbnailUrl || movie.bannerUrl || movie.posterUrl}
                        alt={movie.title}
                        referrerPolicy="no-referrer"
                        className="absolute inset-0 h-full w-full object-cover opacity-40"
                      />
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-black via-black/45 to-black/70" />
                    <div className="relative z-10 max-w-md space-y-3">
                      {ytError ? (
                        <>
                          <p className="font-display text-lg font-bold">Playback Unavailable</p>
                          <p className="text-xs text-zinc-300">{ytError}</p>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              togglePlay();
                            }}
                            aria-label={isEnded ? 'Replay video' : 'Play video'}
                            style={{ backgroundColor: playerAccent }}
                            className="mx-auto flex h-16 w-16 items-center justify-center rounded-full text-white shadow-2xl transition-transform hover:scale-105"
                          >
                            {isEnded ? (
                              <RotateCcw className="h-7 w-7" />
                            ) : (
                              <Play className="ml-0.5 h-7 w-7 fill-current" />
                            )}
                          </button>
                          <p className="font-display text-lg font-semibold">
                            {episode ? `${movie.title} — ${episode.title}` : movie.title}
                          </p>
                          <p className="text-xs text-zinc-300">
                            {isEnded
                              ? 'Playback finished · Click to replay'
                              : hasStarted
                              ? 'Paused · Click to resume'
                              : currentTime > 5
                              ? `Resume from ${formatTimecode(currentTime)}`
                              : 'Click Play to start streaming'}
                          </p>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : !fallbackCanvasMode ? (
              <video
                ref={videoRef}
                className="h-full w-full object-contain"
                playsInline
                crossOrigin="anonymous"
                onClick={togglePlay}
                onTimeUpdate={(e) => {
                  const v = e.currentTarget;
                  setCurrentTime(v.currentTime);
                  if (v.buffered.length > 0 && v.duration > 0) {
                    const end = v.buffered.end(v.buffered.length - 1);
                    setBufferedPct((end / v.duration) * 100);
                  }
                }}
                onPlay={() => {
                  setIsPlaying(true);
                  setHasStarted(true);
                  setIsEnded(false);
                }}
                onPause={() => setIsPlaying(false)}
                onEnded={() => {
                  setIsPlaying(false);
                  setIsEnded(true);
                  onSaveProgress(duration, duration, episode);
                  if (nextEpisode && autoplayNextEnabled) setNextCountdown(countdownSec);
                }}
              >
                {subtitles.map((sub) =>
                  sub.url ? (
                    <track
                      key={sub.lang}
                      kind="subtitles"
                      srcLang={sub.lang}
                      label={sub.label}
                      src={sub.url}
                      default={subtitleLang === sub.lang}
                    />
                  ) : null
                )}
              </video>
            ) : (
              <canvas
                ref={canvasRef}
                width={1280}
                height={720}
                onClick={togglePlay}
                className="h-full w-full cursor-pointer object-contain"
              />
            )}

            {/* Custom Watermark Overlay */}
            {playerConfig?.watermarkEnabled && (
              <div
                style={{ opacity: playerConfig.watermarkOpacity ?? 0.45 }}
                className={`pointer-events-none absolute z-20 select-none px-3 py-2 ${
                  playerConfig.watermarkPosition === 'top-left'
                    ? 'left-3 top-3'
                    : playerConfig.watermarkPosition === 'bottom-left'
                    ? 'bottom-20 left-3'
                    : playerConfig.watermarkPosition === 'bottom-right'
                    ? 'bottom-20 right-3'
                    : 'right-3 top-3'
                }`}
              >
                {playerConfig.watermarkMode === 'image' && playerConfig.watermarkImageUrl ? (
                  <img
                    src={playerConfig.watermarkImageUrl}
                    alt="Watermark"
                    className="h-8 w-auto object-contain"
                  />
                ) : (
                  <span className="rounded bg-black/45 px-2.5 py-1 font-display text-xs font-bold tracking-wider text-white">
                    {playerConfig.watermarkText || 'KinoVault'}
                  </span>
                )}
              </div>
            )}

            {/* Skip Intro Floating Action */}
            {playerConfig?.showSkipIntro && hasStarted && !isEnded && currentTime > 1 && currentTime < 75 && (
              <button
                type="button"
                onClick={() => seekTo(currentTime + (playerConfig.skipIntroSeconds || 15))}
                className="absolute bottom-24 right-4 z-20 rounded-lg border border-white/30 bg-black/75 px-3.5 py-1.5 text-xs font-semibold text-white backdrop-blur-md transition hover:bg-black"
              >
                Skip Intro (+{playerConfig.skipIntroSeconds || 15}s)
              </button>
            )}

            {/* Subtitle overlay when captions enabled */}
            {subtitleLang !== 'off' && (
              <div
                className={`pointer-events-none absolute left-0 right-0 z-20 flex justify-center px-6 ${
                  playerConfig?.subtitlePosition === 'top' ? 'top-6' : 'bottom-20'
                }`}
              >
                <span
                  style={{
                    fontSize: `${playerConfig?.subtitleFontSize ?? 15}px`,
                    color: playerConfig?.subtitleColor || '#ffffff',
                    backgroundColor: `rgba(0,0,0,${playerConfig?.subtitleBgOpacity ?? 0.8})`,
                  }}
                  className="rounded px-3 py-1 font-medium"
                >
                  [{subtitleLang.toUpperCase()}] {episode ? episode.title : movie.title} — Captions active
                </span>
              </div>
            )}

            {/* Next episode countdown overlay */}
            {nextCountdown !== null && nextEpisode && (
              <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/85 backdrop-blur-sm">
                <div className="max-w-sm rounded-xl border border-white/15 bg-[#15151e] p-6 text-center text-white">
                  <p className="text-xs uppercase tracking-wider text-zinc-400">Up Next</p>
                  <h3 className="mt-1 font-display text-lg font-semibold">
                    E{nextEpisode.number}: {nextEpisode.title}
                  </h3>
                  <p className="mt-2 text-sm text-zinc-300 tabular-nums">
                    Starting in {nextCountdown}s
                  </p>
                  <div className="mt-4 flex items-center justify-center gap-3">
                    <button
                      type="button"
                      onClick={() => setNextCountdown(null)}
                      className="rounded-lg border border-zinc-700 px-4 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setNextCountdown(null);
                        onSelectEpisode(nextEpisode);
                      }}
                      style={{ backgroundColor: playerAccent }}
                      className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white"
                    >
                      <SkipForward className="h-3.5 w-3.5" />
                      Play Now
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Pause-Screen Dismissible Custom Image Ad */}
            {adSettings &&
              customAds.length > 0 &&
              hasStarted &&
              !isPlaying &&
              !isEnded &&
              !activeVastAd &&
              !pauseAdDismissed && (
                <div className="pointer-events-auto absolute bottom-20 left-4 z-20 hidden sm:block">
                  <CustomAdSlot
                    placement="player"
                    variant="pause-overlay"
                    customAds={customAds}
                    adSettings={adSettings}
                    user={user}
                    contentType={adContentType}
                    contentId={movie.id}
                    episodeId={episode?.id}
                    onDismiss={() => setPauseAdDismissed(true)}
                  />
                </div>
              )}

            {/* Non-Linear VAST Overlay Banner */}
            {activeOverlayAd && adSettings && !activeVastAd && !isEnded && (
              <VastPlayerOverlay
                ad={activeOverlayAd}
                adSettings={adSettings}
                userId={user?.uid}
                contentId={movie.id}
                contentType={adContentType}
                onFinish={() => setActiveOverlayAd(null)}
              />
            )}

            {/* Full-Slot Linear VAST Video Ad (Pre-Roll / Mid-Roll / Post-Roll) */}
            {activeVastAd && adSettings && (
              <VastPlayerOverlay
                ad={activeVastAd}
                adSettings={adSettings}
                userId={user?.uid}
                contentId={movie.id}
                contentType={adContentType}
                onFinish={() => {
                  const finishedType = activeVastAd.type;
                  sessionAdsShownRef.current += 1;
                  lastVideoAdAtMsRef.current = Date.now();
                  setActiveVastAd(null);
                  if (finishedType === 'post-roll') {
                    if (nextEpisode && autoplayNextEnabled) setNextCountdown(countdownSec);
                  } else {
                    startContentPlayback();
                  }
                }}
              />
            )}

            {/* Custom Controls Bar */}
            <div
              className={`absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/95 via-black/75 to-transparent px-4 transition-opacity duration-200 ${
                isCompactBar ? 'pb-2 pt-6' : 'pb-3 pt-10'
              } ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
            >
              {/* Seek Bar */}
              <div className="group relative mb-3 flex h-3 cursor-pointer items-center">
                <div className="h-1 w-full overflow-hidden rounded-full bg-white/25">
                  <div
                    className="h-full bg-white/40"
                    style={{ width: `${Math.min(100, bufferedPct)}%` }}
                  />
                </div>
                <div
                  className="pointer-events-none absolute left-0 h-1 rounded-full"
                  style={{
                    width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%`,
                    backgroundColor: playerAccent,
                  }}
                />
                <input
                  type="range"
                  min={0}
                  max={Math.max(1, duration)}
                  step={0.5}
                  value={currentTime}
                  aria-label="Seek video timeline"
                  onChange={(e) => seekTo(Number(e.target.value))}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-white">
                <div className="flex items-center gap-2 sm:gap-3">
                  <button
                    type="button"
                    onClick={togglePlay}
                    aria-label={isPlaying ? 'Pause' : 'Play'}
                    className="rounded-md p-1.5 hover:bg-white/15"
                  >
                    {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 fill-current" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => seekTo(currentTime - 10)}
                    aria-label="Rewind 10 seconds"
                    className="rounded-md p-1.5 hover:bg-white/15"
                  >
                    <RotateCcw className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => seekTo(currentTime + 10)}
                    aria-label="Forward 10 seconds"
                    className="rounded-md p-1.5 hover:bg-white/15"
                  >
                    <RotateCw className="h-4 w-4" />
                  </button>

                  {/* Volume */}
                  <div className="hidden items-center gap-1.5 sm:flex">
                    <button
                      type="button"
                      onClick={toggleMute}
                      aria-label={isMuted ? 'Unmute' : 'Mute'}
                      className="rounded-md p-1.5 hover:bg-white/15"
                    >
                      {isMuted || volume === 0 ? (
                        <VolumeX className="h-4 w-4" />
                      ) : (
                        <Volume2 className="h-4 w-4" />
                      )}
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={isMuted ? 0 : volume}
                      aria-label="Volume"
                      onChange={(e) => changeVolume(Number(e.target.value))}
                      className="h-1 w-16 accent-[var(--kv-accent,#e50914)]"
                    />
                  </div>

                  <span className="font-mono-tabular text-xs text-zinc-300">
                    {formatTimecode(currentTime)} / {formatTimecode(duration)}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {/* Playback speed */}
                  {!isCompactBar && (playerConfig?.enableSpeedControl ?? true) && (
                    <select
                      aria-label="Playback speed"
                      value={playbackRate}
                      onChange={(e) => changeSpeed(Number(e.target.value))}
                      className="rounded bg-white/10 px-2 py-1 text-xs font-medium text-white outline-none hover:bg-white/20"
                    >
                      {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => (
                        <option key={r} value={r} className="bg-zinc-900 text-white">
                          {r}x
                        </option>
                      ))}
                    </select>
                  )}

                  {/* Quality selector */}
                  {!isCompactBar && sources.length > 0 && (
                    <select
                      aria-label="Video quality"
                      value={sourceIndex}
                      onChange={(e) => setSourceIndex(Number(e.target.value))}
                      className="rounded bg-white/10 px-2 py-1 text-xs font-medium text-white outline-none hover:bg-white/20"
                    >
                      {sources.map((src, idx) => (
                        <option key={`${src.label}-${idx}`} value={idx} className="bg-zinc-900 text-white">
                          {src.label}
                        </option>
                      ))}
                    </select>
                  )}

                  {/* Download (only when enabled by admin & non-YouTube external MP4) */}
                  {playerConfig?.showDownloadButton &&
                    !isYouTubeMode &&
                    activeSource?.url &&
                    !activeSource.url.startsWith('local://') && (
                      <a
                        href={activeSource.url}
                        download
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="Download video"
                        className="rounded-md p-1.5 text-white hover:bg-white/15"
                      >
                        <Download className="h-4 w-4" />
                      </a>
                    )}

                  {/* Subtitles */}
                  <button
                    type="button"
                    onClick={() =>
                      setSubtitleLang((prev) =>
                        prev === 'off' ? subtitles[0]?.lang ?? 'en' : 'off'
                      )
                    }
                    aria-label="Toggle subtitles"
                    style={subtitleLang !== 'off' ? { color: playerAccent } : undefined}
                    className="rounded-md p-1.5 text-white transition-colors hover:bg-white/15"
                  >
                    <Captions className="h-4 w-4" />
                  </button>

                  {/* Picture in Picture (native video only & when enabled) */}
                  {!isYouTubeMode && (playerConfig?.enablePiP ?? true) && (
                    <button
                      type="button"
                      onClick={togglePiP}
                      aria-label="Picture in picture"
                      className="hidden rounded-md p-1.5 hover:bg-white/15 sm:inline-flex"
                    >
                      <PictureInPicture2 className="h-4 w-4" />
                    </button>
                  )}

                  {/* Fullscreen */}
                  <button
                    type="button"
                    onClick={toggleFullscreen}
                    aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                    className="rounded-md p-1.5 hover:bg-white/15"
                  >
                    {isFullscreen ? (
                      <Minimize className="h-4 w-4" />
                    ) : (
                      <Maximize className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Keyboard shortcut legend */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
        {playerConfig?.enableKeyboardShortcuts !== false ? (
          <span>
            Shortcuts: Space (Play/Pause) · ←/→ (±10s) · M (Mute) · C (Subtitles) · F (Fullscreen)
          </span>
        ) : (
          <span />
        )}
        {nextEpisode && (
          <button
            type="button"
            onClick={() => onSelectEpisode(nextEpisode)}
            className="inline-flex items-center gap-1.5 font-medium text-zinc-900 hover:text-[var(--kv-accent,#e50914)] dark:text-zinc-200"
          >
            <SkipForward className="h-3.5 w-3.5" />
            Next: E{nextEpisode.number} · {nextEpisode.title}
          </button>
        )}
      </div>

      {/* Player Image Ad Slot (Custom Ads) + Legacy Below-Player Ad Slot */}
      {adSettings && customAds.length > 0 && (
        <CustomAdSlot
          placement="player"
          customAds={customAds}
          adSettings={adSettings}
          user={user}
          contentType={adContentType}
          contentId={movie.id}
          episodeId={episode?.id}
          className="mt-4"
        />
      )}
      {belowPlayerAd?.enabled && <AdSlot config={belowPlayerAd} label="Below player banner" />}
    </div>
  );
}
