import { DEFAULT_AD_UNLOCK_SETTINGS, DEFAULT_BADGE_CONFIG } from '../data/seedAds';
import type {
  AccessMode,
  AdAssignmentMode,
  AdPolicyConfig,
  AdUnlockRecord,
  AdUnlockSettings,
  BadgeConfig,
  BadgeStyleConfig,
  CustomAdItem,
  EpisodeItem,
  FailureFallbackAction,
  MovieItem,
  SubscriptionPlan,
  UserProfile,
  VastAdItem,
} from '../types/streaming';
import { computeAdStatus } from './adEngine';

const GUEST_UNLOCKS_LS_KEY = 'kinovault_guest_ad_unlocks_v1';
const GUEST_UNLOCKS_SS_KEY = 'kinovault_session_ad_unlocks_v1';
const UNLOCK_RATE_TIMESTAMPS_KEY = 'kinovault_unlock_timestamps_v1';

export interface EffectiveAccessConfig {
  accessMode: Exclude<AccessMode, 'inherit'>;
  requiredPlanId: string | null;
  requiredPlanName: string | null;
  adPolicy: AdPolicyConfig;
  sourceLayer: 'episode' | 'season' | 'movie' | 'global';
}

export interface AccessCheckContext {
  plans?: SubscriptionPlan[];
  adUnlocks?: Record<string, AdUnlockRecord>;
  adUnlockSettings?: Partial<AdUnlockSettings> | null;
  hourlyUnlockCount?: number;
  nowMs?: number;
}

export interface ResolvedAccessResult {
  allowed: boolean;
  reason:
    | 'admin'
    | 'free'
    | 'subscribed'
    | 'unlocked'
    | 'gated'
    | 'sign_in_required'
    | 'rate_limited'
    | 'banned';
  options: {
    subscribe: boolean;
    watchAd: boolean;
  };
  effectiveMode: Exclude<AccessMode, 'inherit'>;
  sourceLayer: 'episode' | 'season' | 'movie' | 'global';
  requiredPlan?: SubscriptionPlan;
  requiredPlanName: string;
  adPolicy: AdPolicyConfig;
  activeUnlock?: AdUnlockRecord | null;
  hourlyCount: number;
  maxUnlocksPerHour: number;
  hourlyRemaining: number;
  adsRequired: number;
  contentId: string;
  contentType: 'movie' | 'episode';
  requiresSignIn: boolean;
}

export interface UnlockBannerPayload {
  id: string;
  name: string;
  advertiserName: string;
  imageUrl: string;
  destinationUrl: string;
  displayDurationSeconds: number;
  altText: string;
  source: 'customAd' | 'inline';
  linkedCustomAdId?: string;
}

export interface UnlockVastPayload {
  id: string;
  vastAd: VastAdItem;
  skipAfterSeconds: number | null;
  source: 'vastAd' | 'customUrl';
}

export type UnlockAdStep =
  | {
      kind: 'vast';
      stepIndex: number;
      totalSteps: number;
      vast: UnlockVastPayload;
    }
  | {
      kind: 'banner';
      stepIndex: number;
      totalSteps: number;
      banner: UnlockBannerPayload;
    };

export interface UnlockAdResolution {
  steps: UnlockAdStep[];
  assignmentMode: AdAssignmentMode;
  manuallyAssigned: boolean;
  unavailableReason?: string;
}

export interface ResolvedBadge {
  key: 'paid' | 'freeWithAds' | 'free' | 'included' | 'someEpisodesFree';
  text: string;
  color: string;
  textColor: string;
  icon: string;
  tooltip: string;
}

export function mergeAdUnlockSettings(
  partial?: Partial<AdUnlockSettings> | null
): AdUnlockSettings {
  return {
    ...DEFAULT_AD_UNLOCK_SETTINGS,
    ...(partial ?? {}),
  };
}

export function mergeBadgeConfig(partial?: Partial<BadgeConfig> | null): BadgeConfig {
  return {
    paid: { ...DEFAULT_BADGE_CONFIG.paid, ...(partial?.paid ?? {}) },
    freeWithAds: { ...DEFAULT_BADGE_CONFIG.freeWithAds, ...(partial?.freeWithAds ?? {}) },
    free: { ...DEFAULT_BADGE_CONFIG.free, ...(partial?.free ?? {}) },
    included: { ...DEFAULT_BADGE_CONFIG.included, ...(partial?.included ?? {}) },
    someEpisodesFree: {
      ...DEFAULT_BADGE_CONFIG.someEpisodesFree,
      ...(partial?.someEpisodesFree ?? {}),
    },
    mobileCompact: partial?.mobileCompact ?? DEFAULT_BADGE_CONFIG.mobileCompact,
  };
}

function inferLegacyMovieAccessMode(movie: MovieItem): Exclude<AccessMode, 'inherit'> {
  if (movie.accessMode && movie.accessMode !== 'inherit') {
    return movie.accessMode;
  }
  if (movie.isPremium || movie.requiredPlanId) {
    return 'subscription';
  }
  return 'free';
}

function mergeAdPolicies(
  ...policies: (AdPolicyConfig | null | undefined)[]
): AdPolicyConfig {
  const merged: AdPolicyConfig = {};
  for (const p of policies) {
    if (!p) continue;
    if (p.overrideGlobal !== undefined) merged.overrideGlobal = p.overrideGlobal;
    if (p.adFormatMode !== undefined) merged.adFormatMode = p.adFormatMode;
    if (p.vastAdId !== undefined) merged.vastAdId = p.vastAdId;
    if (p.customVastUrl !== undefined) merged.customVastUrl = p.customVastUrl;
    if (p.skipAfterSeconds !== undefined) merged.skipAfterSeconds = p.skipAfterSeconds;
    if (p.bannerAdId !== undefined) merged.bannerAdId = p.bannerAdId;
    if (p.inlineBanner !== undefined) merged.inlineBanner = p.inlineBanner;
    if (p.rotationAdRefs !== undefined) merged.rotationAdRefs = p.rotationAdRefs;
    if (p.adsRequired !== undefined) merged.adsRequired = p.adsRequired;
    if (p.validityMode !== undefined) merged.validityMode = p.validityMode;
    if (p.validityHours !== undefined) merged.validityHours = p.validityHours;
    if (p.active !== undefined) merged.active = p.active;
  }
  return merged;
}

export function getEffectiveAccessConfig(
  movie: MovieItem,
  episode?: EpisodeItem | null,
  rawSettings?: Partial<AdUnlockSettings> | null
): EffectiveAccessConfig {
  const settings = mergeAdUnlockSettings(rawSettings);
  const seasonKey = episode ? String(episode.seasonNumber) : '';
  const seasonCfg = seasonKey && movie.seasonAccess ? movie.seasonAccess[seasonKey] : undefined;

  const baseMovieMode: Exclude<AccessMode, 'inherit'> =
    movie.accessMode === 'inherit'
      ? settings.defaultGlobalAccessMode
      : inferLegacyMovieAccessMode(movie);

  let effectiveMode: Exclude<AccessMode, 'inherit'> = baseMovieMode;
  let sourceLayer: EffectiveAccessConfig['sourceLayer'] =
    movie.accessMode === 'inherit' ? 'global' : 'movie';

  let requiredPlanId: string | null =
    movie.requiredPlanId ?? settings.defaultRequiredPlanId ?? null;
  let requiredPlanName: string | null = movie.requiredPlanName ?? null;

  if (seasonCfg?.accessMode && seasonCfg.accessMode !== 'inherit') {
    effectiveMode = seasonCfg.accessMode;
    sourceLayer = 'season';
  }
  if (seasonCfg?.requiredPlanId) {
    requiredPlanId = seasonCfg.requiredPlanId;
    requiredPlanName = seasonCfg.requiredPlanName ?? requiredPlanName;
  }

  if (episode?.accessMode && episode.accessMode !== 'inherit') {
    effectiveMode = episode.accessMode;
    sourceLayer = 'episode';
  }
  if (episode?.requiredPlanId) {
    requiredPlanId = episode.requiredPlanId;
    requiredPlanName = episode.requiredPlanName ?? requiredPlanName;
  }

  const adPolicy = mergeAdPolicies(
    movie.adPolicy,
    seasonCfg?.adPolicy,
    episode?.adPolicy
  );

  return {
    accessMode: effectiveMode,
    requiredPlanId,
    requiredPlanName,
    adPolicy,
    sourceLayer,
  };
}

export function isUserSubscriptionActive(
  user: UserProfile | null,
  requiredPlanId: string | null | undefined,
  nowMs = Date.now()
): boolean {
  if (!user) return false;
  if (user.status === 'banned') return false;
  if (user.role === 'admin') return true;
  if (user.plan !== 'premium' && !user.subscriptionPlanId) return false;

  if (user.planExpiresAt) {
    const exp = Date.parse(user.planExpiresAt);
    if (!Number.isNaN(exp) && exp < nowMs) {
      return false;
    }
  }

  if (requiredPlanId) {
    return user.subscriptionPlanId === requiredPlanId;
  }
  return user.plan === 'premium' || Boolean(user.subscriptionPlanId);
}

export function isAdUnlockRecordValid(
  record: AdUnlockRecord | null | undefined,
  nowMs = Date.now()
): boolean {
  if (!record) return false;
  if (record.method === 'fallback' && (record.remainingPlaybacks ?? 1) <= 0) {
    return false;
  }
  if (record.expiresAt === null) {
    // Session-scoped unlocks are considered valid until cleared on new browser session
    return true;
  }
  const expMs = Date.parse(record.expiresAt);
  if (Number.isNaN(expMs)) return false;
  return expMs > nowMs;
}

export function resolveAccess(
  user: UserProfile | null,
  movie: MovieItem,
  episode: EpisodeItem | null | undefined,
  ctx: AccessCheckContext = {}
): ResolvedAccessResult {
  const nowMs = ctx.nowMs ?? Date.now();
  const plans = ctx.plans ?? [];
  const settings = mergeAdUnlockSettings(ctx.adUnlockSettings);
  const contentType: 'movie' | 'episode' = episode ? 'episode' : 'movie';
  const contentId = episode ? episode.id : movie.id;
  const effective = getEffectiveAccessConfig(movie, episode, settings);

  const requiredPlan = effective.requiredPlanId
    ? plans.find((p) => p.id === effective.requiredPlanId)
    : plans.find((p) => p.isActive);
  const requiredPlanName =
    requiredPlan?.name ?? effective.requiredPlanName ?? 'Cinema Plus';

  const hourlyCount = ctx.hourlyUnlockCount ?? 0;
  const maxUnlocksPerHour = Math.max(1, settings.maxUnlocksPerHour || 20);
  const hourlyRemaining = Math.max(0, maxUnlocksPerHour - hourlyCount);
  const adsRequired = Math.max(1, Math.min(3, effective.adPolicy.adsRequired ?? 1));

  const baseFields = {
    effectiveMode: effective.accessMode,
    sourceLayer: effective.sourceLayer,
    requiredPlan,
    requiredPlanName,
    adPolicy: effective.adPolicy,
    hourlyCount,
    maxUnlocksPerHour,
    hourlyRemaining,
    adsRequired,
    contentId,
    contentType,
    requiresSignIn: Boolean(movie.requiresSignIn),
  };

  if (user?.status === 'banned') {
    return {
      allowed: false,
      reason: 'banned',
      options: { subscribe: false, watchAd: false },
      ...baseFields,
    };
  }

  if (user?.role === 'admin') {
    return {
      allowed: true,
      reason: 'admin',
      options: { subscribe: false, watchAd: false },
      ...baseFields,
    };
  }

  // Free content (with optional sign-in gate)
  if (effective.accessMode === 'free') {
    if (movie.requiresSignIn && !user) {
      return {
        allowed: false,
        reason: 'sign_in_required',
        options: { subscribe: false, watchAd: false },
        ...baseFields,
      };
    }
    return {
      allowed: true,
      reason: 'free',
      options: { subscribe: false, watchAd: false },
      ...baseFields,
    };
  }

  // Active subscriber bypasses all gates and unlock ads
  if (isUserSubscriptionActive(user, effective.requiredPlanId, nowMs)) {
    return {
      allowed: true,
      reason: 'subscribed',
      options: { subscribe: false, watchAd: false },
      ...baseFields,
    };
  }

  // Existing per-content / per-episode unlock
  const candidateUnlock = ctx.adUnlocks?.[contentId];
  if (isAdUnlockRecordValid(candidateUnlock, nowMs)) {
    return {
      allowed: true,
      reason: 'unlocked',
      activeUnlock: candidateUnlock,
      options: { subscribe: false, watchAd: false },
      ...baseFields,
    };
  }

  const modeSupportsSub =
    effective.accessMode === 'subscription' || effective.accessMode === 'subscription_or_ad';
  const modeSupportsAd =
    effective.accessMode === 'ad_unlock' || effective.accessMode === 'subscription_or_ad';
  const adFeatureEnabled = settings.enabled && effective.adPolicy.active !== false;
  const userCanUseAd = adFeatureEnabled && (Boolean(user) || settings.guestAdUnlockEnabled);

  if (!user && effective.accessMode === 'subscription') {
    return {
      allowed: false,
      reason: 'sign_in_required',
      options: { subscribe: true, watchAd: false },
      ...baseFields,
    };
  }

  if (!user && modeSupportsAd && !settings.guestAdUnlockEnabled) {
    return {
      allowed: false,
      reason: 'sign_in_required',
      options: { subscribe: modeSupportsSub, watchAd: false },
      ...baseFields,
    };
  }

  if (modeSupportsAd && userCanUseAd && hourlyCount >= maxUnlocksPerHour) {
    return {
      allowed: false,
      reason: 'rate_limited',
      options: { subscribe: modeSupportsSub, watchAd: false },
      ...baseFields,
    };
  }

  return {
    allowed: false,
    reason: 'gated',
    options: {
      subscribe: modeSupportsSub,
      watchAd: Boolean(modeSupportsAd && userCanUseAd),
    },
    ...baseFields,
  };
}

// Preserve requested alias `canWatch`
export const canWatch = resolveAccess;

// --- Per-Title / Per-Episode Advertisement Format & Manual Selector ---

function buildSyntheticVastFromCustomUrl(
  url: string,
  contentId: string,
  skipAfterSeconds: number | null | undefined,
  defaultSkip: number
): VastAdItem {
  const effectiveSkip =
    skipAfterSeconds !== undefined && skipAfterSeconds !== null
      ? skipAfterSeconds
      : defaultSkip;
  return {
    id: `custom-vast-${contentId}`,
    name: 'Assigned Unlock Video Ad',
    type: 'pre-roll',
    vastTagUrl: url.trim(),
    targetType: 'movie',
    targetIds: [contentId],
    midRollAtSeconds: [],
    overlayStartSeconds: 0,
    overlayDurationSeconds: 10,
    skipAfterSeconds: Math.max(0, effectiveSkip),
    startDate: '2020-01-01',
    endDate: '2099-12-31',
    status: 'active',
    priority: 10,
    audience: 'all',
    devices: ['desktop', 'mobile', 'tablet'],
    impressions: 0,
    completions: 0,
    skips: 0,
    clicks: 0,
    errors: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    createdBy: 'policy',
  };
}

function toBannerPayloadFromCustomAd(
  ad: CustomAdItem,
  defaultDuration: number
): UnlockBannerPayload {
  return {
    id: ad.id,
    name: ad.name,
    advertiserName: ad.advertiserName?.trim() || ad.name,
    imageUrl: ad.imageUrl,
    destinationUrl: ad.redirectUrl,
    displayDurationSeconds: Math.max(
      3,
      ad.displayDurationSeconds && ad.displayDurationSeconds > 0
        ? ad.displayDurationSeconds
        : defaultDuration
    ),
    altText: ad.altText || ad.name,
    source: 'customAd',
    linkedCustomAdId: ad.id,
  };
}

export function resolveUnlockAdPlan(params: {
  contentId: string;
  adPolicy?: AdPolicyConfig | null;
  vastAds: VastAdItem[];
  customAds: CustomAdItem[];
  settings?: Partial<AdUnlockSettings> | null;
  adsRequired?: number;
  rotationSeed?: number;
  nowMs?: number;
}): UnlockAdResolution {
  const {
    contentId,
    adPolicy,
    vastAds,
    customAds,
    settings: rawSettings,
    rotationSeed = 0,
    nowMs = Date.now(),
  } = params;
  const settings = mergeAdUnlockSettings(rawSettings);
  const policy = adPolicy ?? {};
  const totalSteps = Math.max(
    1,
    Math.min(3, params.adsRequired ?? policy.adsRequired ?? 1)
  );
  const defaultBannerDuration = Math.max(3, settings.defaultBannerDurationSeconds || 30);

  if (policy.active === false) {
    return {
      steps: [],
      assignmentMode: policy.adFormatMode ?? 'auto',
      manuallyAssigned: true,
      unavailableReason: 'Advertisement policy for this title is set to inactive.',
    };
  }

  const mode: AdAssignmentMode = policy.adFormatMode ?? 'auto';
  const defaultSkip = settings.allowSkipAfterSeconds ?? 0;

  // 1. STRICT MANUAL VIDEO AD (VAST)
  if (mode === 'vast') {
    const selectedVast = policy.vastAdId
      ? vastAds.find((v) => v.id === policy.vastAdId)
      : undefined;
    const customUrl = (policy.customVastUrl || '').trim();

    if (selectedVast) {
      if (selectedVast.status !== 'active' && !customUrl) {
        return {
          steps: [],
          assignmentMode: 'vast',
          manuallyAssigned: true,
          unavailableReason: `Assigned VAST ad "${selectedVast.name}" is inactive.`,
        };
      }
      const skipOverride =
        policy.skipAfterSeconds !== undefined && policy.skipAfterSeconds !== null
          ? policy.skipAfterSeconds
          : defaultSkip;
      const steps: UnlockAdStep[] = Array.from({ length: totalSteps }, (_, idx) => ({
        kind: 'vast',
        stepIndex: idx,
        totalSteps,
        vast: {
          id: selectedVast.id,
          vastAd: selectedVast,
          skipAfterSeconds: skipOverride,
          source: 'vastAd',
        },
      }));
      return { steps, assignmentMode: 'vast', manuallyAssigned: true };
    }

    if (customUrl) {
      const synthetic = buildSyntheticVastFromCustomUrl(
        customUrl,
        contentId,
        policy.skipAfterSeconds,
        defaultSkip
      );
      const steps: UnlockAdStep[] = Array.from({ length: totalSteps }, (_, idx) => ({
        kind: 'vast',
        stepIndex: idx,
        totalSteps,
        vast: {
          id: synthetic.id,
          vastAd: synthetic,
          skipAfterSeconds: synthetic.skipAfterSeconds,
          source: 'customUrl',
        },
      }));
      return { steps, assignmentMode: 'vast', manuallyAssigned: true };
    }

    return {
      steps: [],
      assignmentMode: 'vast',
      manuallyAssigned: true,
      unavailableReason: 'No VAST advertisement has been configured for this title.',
    };
  }

  // 2. STRICT MANUAL CLICKABLE BANNER AD
  if (mode === 'banner') {
    if (policy.inlineBanner && policy.inlineBanner.imageUrl?.trim()) {
      if (policy.inlineBanner.status !== 'active') {
        return {
          steps: [],
          assignmentMode: 'banner',
          manuallyAssigned: true,
          unavailableReason: 'Assigned inline banner advertisement is inactive.',
        };
      }
      const bannerPayload: UnlockBannerPayload = {
        id: `inline-banner-${contentId}`,
        name: policy.inlineBanner.advertiserName || 'Sponsored Banner',
        advertiserName: policy.inlineBanner.advertiserName || 'Sponsor',
        imageUrl: policy.inlineBanner.imageUrl.trim(),
        destinationUrl: policy.inlineBanner.destinationUrl?.trim() || 'https://example.com',
        displayDurationSeconds: Math.max(
          3,
          policy.inlineBanner.displayDurationSeconds || defaultBannerDuration
        ),
        altText:
          policy.inlineBanner.altText ||
          policy.inlineBanner.advertiserName ||
          'Sponsored Banner Advertisement',
        source: 'inline',
      };
      const steps: UnlockAdStep[] = Array.from({ length: totalSteps }, (_, idx) => ({
        kind: 'banner',
        stepIndex: idx,
        totalSteps,
        banner: bannerPayload,
      }));
      return { steps, assignmentMode: 'banner', manuallyAssigned: true };
    }

    const selectedBanner = policy.bannerAdId
      ? customAds.find((c) => c.id === policy.bannerAdId)
      : undefined;
    if (selectedBanner) {
      if (selectedBanner.status !== 'active') {
        return {
          steps: [],
          assignmentMode: 'banner',
          manuallyAssigned: true,
          unavailableReason: `Assigned banner ad "${selectedBanner.name}" is inactive.`,
        };
      }
      const payload = toBannerPayloadFromCustomAd(selectedBanner, defaultBannerDuration);
      const steps: UnlockAdStep[] = Array.from({ length: totalSteps }, (_, idx) => ({
        kind: 'banner',
        stepIndex: idx,
        totalSteps,
        banner: payload,
      }));
      return { steps, assignmentMode: 'banner', manuallyAssigned: true };
    }

    return {
      steps: [],
      assignmentMode: 'banner',
      manuallyAssigned: true,
      unavailableReason: 'No banner advertisement has been configured for this title.',
    };
  }

  // 3. EXPLICIT MULTI-AD ROTATION
  if (mode === 'rotation') {
    const refs = policy.rotationAdRefs ?? [];
    const pool: (
      | { kind: 'vast'; vast: UnlockVastPayload }
      | { kind: 'banner'; banner: UnlockBannerPayload }
    )[] = [];

    for (const ref of refs) {
      if (ref.kind === 'vast') {
        const v = vastAds.find((item) => item.id === ref.id);
        if (v && v.status === 'active') {
          pool.push({
            kind: 'vast',
            vast: {
              id: v.id,
              vastAd: v,
              skipAfterSeconds:
                policy.skipAfterSeconds !== undefined && policy.skipAfterSeconds !== null
                  ? policy.skipAfterSeconds
                  : defaultSkip,
              source: 'vastAd',
            },
          });
        }
      } else if (ref.kind === 'banner') {
        const c = customAds.find((item) => item.id === ref.id);
        if (c && c.status === 'active') {
          pool.push({
            kind: 'banner',
            banner: toBannerPayloadFromCustomAd(c, defaultBannerDuration),
          });
        }
      }
    }

    if (pool.length === 0) {
      return {
        steps: [],
        assignmentMode: 'rotation',
        manuallyAssigned: true,
        unavailableReason: 'No active ads remain in this title rotation pool.',
      };
    }

    const steps: UnlockAdStep[] = Array.from({ length: totalSteps }, (_, idx) => {
      const picked = pool[Math.abs(rotationSeed + idx) % pool.length];
      if (picked.kind === 'vast') {
        return { kind: 'vast', stepIndex: idx, totalSteps, vast: picked.vast };
      }
      return { kind: 'banner', stepIndex: idx, totalSteps, banner: picked.banner };
    });

    return { steps, assignmentMode: 'rotation', manuallyAssigned: true };
  }

  // 4. AUTOMATIC SELECTION (eligible active VAST or Banner ad)
  const activeVasts = vastAds
    .filter((v) => computeAdStatus(v, nowMs) === 'active')
    .sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1));
  const activeBanners = customAds
    .filter(
      (c) =>
        computeAdStatus(c, nowMs) === 'active' &&
        (c.placement === 'player' || c.placement === 'banner')
    )
    .sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1));

  const autoPool: (
    | { kind: 'vast'; vast: UnlockVastPayload }
    | { kind: 'banner'; banner: UnlockBannerPayload }
  )[] = [
    ...activeVasts.map((v) => ({
      kind: 'vast' as const,
      vast: {
        id: v.id,
        vastAd: v,
        skipAfterSeconds: defaultSkip,
        source: 'vastAd' as const,
      },
    })),
    ...activeBanners.map((c) => ({
      kind: 'banner' as const,
      banner: toBannerPayloadFromCustomAd(c, defaultBannerDuration),
    })),
  ];

  if (autoPool.length === 0) {
    return {
      steps: [],
      assignmentMode: 'auto',
      manuallyAssigned: false,
      unavailableReason: 'No active video or banner ads are currently available.',
    };
  }

  const steps: UnlockAdStep[] = Array.from({ length: totalSteps }, (_, idx) => {
    const picked = autoPool[Math.abs(rotationSeed + idx) % autoPool.length];
    if (picked.kind === 'vast') {
      return { kind: 'vast', stepIndex: idx, totalSteps, vast: picked.vast };
    }
    return { kind: 'banner', stepIndex: idx, totalSteps, banner: picked.banner };
  });

  return { steps, assignmentMode: 'auto', manuallyAssigned: false };
}

export function applyFailureFallback(
  failureCount: number,
  settings?: Partial<AdUnlockSettings> | null
): { canRetry: boolean; fallback: FailureFallbackAction | null } {
  const merged = mergeAdUnlockSettings(settings);
  if (failureCount < 2) {
    return { canRetry: true, fallback: null };
  }
  return {
    canRetry: false,
    fallback: merged.failureFallback,
  };
}

// --- Badges Engine ---

function styleToBadge(
  key: ResolvedBadge['key'],
  style: BadgeStyleConfig,
  tooltip: string,
  textOverride?: string
): ResolvedBadge {
  return {
    key,
    text: textOverride || style.text,
    color: style.color,
    textColor: style.textColor,
    icon: style.icon,
    tooltip,
  };
}

export function resolveContentBadges(params: {
  movie: MovieItem;
  user: UserProfile | null;
  episodes?: EpisodeItem[];
  plans?: SubscriptionPlan[];
  badgeConfig?: Partial<BadgeConfig> | null;
  adUnlockSettings?: Partial<AdUnlockSettings> | null;
  nowMs?: number;
}): { badges: ResolvedBadge[]; mobileCompact: boolean } {
  const { movie, user, episodes = [], plans = [], nowMs = Date.now() } = params;
  const cfg = mergeBadgeConfig(params.badgeConfig);
  const effective = getEffectiveAccessConfig(movie, null, params.adUnlockSettings);
  const planObj = effective.requiredPlanId
    ? plans.find((p) => p.id === effective.requiredPlanId)
    : plans.find((p) => p.isActive);
  const planLabel = planObj?.name || effective.requiredPlanName || 'Cinema Plus';
  const isSubscribed = isUserSubscriptionActive(user, effective.requiredPlanId, nowMs);

  const badges: ResolvedBadge[] = [];

  if (effective.accessMode === 'free') {
    if (cfg.free.enabled) {
      badges.push(styleToBadge('free', cfg.free, 'Free to watch'));
    }
  } else if (effective.accessMode === 'subscription') {
    if (isSubscribed) {
      if (cfg.included.enabled) {
        badges.push(styleToBadge('included', cfg.included, `Included in ${planLabel}`));
      }
    } else if (cfg.paid.enabled) {
      badges.push(
        styleToBadge(
          'paid',
          cfg.paid,
          `Requires ${planLabel}`,
          cfg.paid.text
        )
      );
    }
  } else if (
    effective.accessMode === 'ad_unlock' ||
    effective.accessMode === 'subscription_or_ad'
  ) {
    if (isSubscribed) {
      if (cfg.included.enabled) {
        badges.push(styleToBadge('included', cfg.included, `Ad-free with ${planLabel}`));
      }
    } else {
      if (cfg.freeWithAds.enabled) {
        badges.push(
          styleToBadge(
            'freeWithAds',
            cfg.freeWithAds,
            `Watch a short ad to unlock free, or subscribe (${planLabel})`
          )
        );
      } else if (effective.accessMode === 'subscription_or_ad' && cfg.paid.enabled) {
        badges.push(styleToBadge('paid', cfg.paid, `Requires ${planLabel}`));
      }
    }
  }

  // Series with mixed episodes (e.g., Episode 1 Free + Paid later episodes)
  if (movie.type === 'series' && episodes.length > 0 && cfg.someEpisodesFree.enabled && !isSubscribed) {
    const epModes = episodes.map(
      (ep) => getEffectiveAccessConfig(movie, ep, params.adUnlockSettings).accessMode
    );
    const hasFreeOrAdEp = epModes.some(
      (m) => m === 'free' || m === 'ad_unlock' || m === 'subscription_or_ad'
    );
    const hasPaidEp = epModes.some(
      (m) => m === 'subscription' || m === 'subscription_or_ad'
    );
    if (hasFreeOrAdEp && hasPaidEp && effective.accessMode === 'subscription') {
      badges.push(
        styleToBadge(
          'someEpisodesFree',
          cfg.someEpisodesFree,
          'Some episodes in this series can be watched free or with ads'
        )
      );
    }
  }

  return { badges, mobileCompact: cfg.mobileCompact };
}

export function resolveEpisodeBadge(params: {
  movie: MovieItem;
  episode: EpisodeItem;
  user: UserProfile | null;
  adUnlocks?: Record<string, AdUnlockRecord>;
  badgeConfig?: Partial<BadgeConfig> | null;
  adUnlockSettings?: Partial<AdUnlockSettings> | null;
  nowMs?: number;
}): ResolvedBadge | null {
  const { movie, episode, user, adUnlocks, nowMs = Date.now() } = params;
  const cfg = mergeBadgeConfig(params.badgeConfig);
  const access = resolveAccess(user, movie, episode, {
    adUnlocks,
    adUnlockSettings: params.adUnlockSettings,
    nowMs,
  });

  if (access.reason === 'unlocked') {
    return {
      key: 'free',
      text: 'UNLOCKED',
      color: '#10b981',
      textColor: '#ffffff',
      icon: 'unlock',
      tooltip: 'Unlocked via ad view',
    };
  }
  if (access.reason === 'subscribed' || access.reason === 'admin') {
    if (!cfg.included.enabled) return null;
    return styleToBadge('included', cfg.included, `Included in ${access.requiredPlanName}`);
  }
  if (access.effectiveMode === 'free') {
    return styleToBadge('free', { ...cfg.free, enabled: true }, 'Free episode');
  }
  if (access.effectiveMode === 'subscription') {
    if (!cfg.paid.enabled) return null;
    return styleToBadge('paid', cfg.paid, `Requires ${access.requiredPlanName}`);
  }
  if (cfg.freeWithAds.enabled) {
    return styleToBadge(
      'freeWithAds',
      cfg.freeWithAds,
      'Watch a short ad to unlock or subscribe'
    );
  }
  return null;
}

// --- Client Unlock Storage & Rate Limiting (Guest + Multi-Tab Sync) ---

function safeGetStorage(kind: 'local' | 'session'): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function loadGuestUnlocks(nowMs = Date.now()): Record<string, AdUnlockRecord> {
  const out: Record<string, AdUnlockRecord> = {};
  const ls = safeGetStorage('local');
  const ss = safeGetStorage('session');

  for (const store of [ls, ss]) {
    if (!store) continue;
    const key = store === ls ? GUEST_UNLOCKS_LS_KEY : GUEST_UNLOCKS_SS_KEY;
    try {
      const raw = store.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as Record<string, AdUnlockRecord>;
      let mutated = false;
      for (const [id, rec] of Object.entries(parsed)) {
        if (isAdUnlockRecordValid(rec, nowMs)) {
          out[id] = rec;
        } else {
          delete parsed[id];
          mutated = true;
        }
      }
      if (mutated) {
        store.setItem(key, JSON.stringify(parsed));
      }
    } catch {
      // Ignore corrupt storage
    }
  }
  return out;
}

export function saveGuestUnlock(
  record: AdUnlockRecord,
  validityMode: 'hours' | 'session'
): Record<string, AdUnlockRecord> {
  const store = safeGetStorage(validityMode === 'session' ? 'session' : 'local');
  const key = validityMode === 'session' ? GUEST_UNLOCKS_SS_KEY : GUEST_UNLOCKS_LS_KEY;
  if (store) {
    try {
      const existingRaw = store.getItem(key);
      const existing = existingRaw
        ? (JSON.parse(existingRaw) as Record<string, AdUnlockRecord>)
        : {};
      existing[record.contentId] = record;
      store.setItem(key, JSON.stringify(existing));
    } catch {
      // Ignore quota errors
    }
  }
  return loadGuestUnlocks();
}

export function consumeFallbackGuestUnlock(contentId: string): Record<string, AdUnlockRecord> {
  for (const kind of ['local', 'session'] as const) {
    const store = safeGetStorage(kind);
    const key = kind === 'local' ? GUEST_UNLOCKS_LS_KEY : GUEST_UNLOCKS_SS_KEY;
    if (!store) continue;
    try {
      const raw = store.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as Record<string, AdUnlockRecord>;
      const target = parsed[contentId];
      if (target && target.method === 'fallback') {
        const nextCount = (target.remainingPlaybacks ?? 1) - 1;
        if (nextCount <= 0) {
          delete parsed[contentId];
        } else {
          parsed[contentId] = { ...target, remainingPlaybacks: nextCount };
        }
        store.setItem(key, JSON.stringify(parsed));
      }
    } catch {
      // ignore
    }
  }
  return loadGuestUnlocks();
}

export function buildUnlockRecord(params: {
  movieId: string;
  episodeId?: string | null;
  method: 'vast' | 'banner' | 'fallback';
  adId?: string | null;
  validityMode?: 'hours' | 'session';
  validityHours?: number;
  nowMs?: number;
}): AdUnlockRecord {
  const nowMs = params.nowMs ?? Date.now();
  const isSession = params.validityMode === 'session';
  const hours = Math.max(1, params.validityHours ?? 24);
  const contentId = params.episodeId || params.movieId;
  return {
    contentId,
    movieId: params.movieId,
    episodeId: params.episodeId ?? null,
    type: params.episodeId ? 'episode' : 'movie',
    method: params.method,
    adId: params.adId ?? null,
    unlockedAt: new Date(nowMs).toISOString(),
    expiresAt:
      params.method === 'fallback'
        ? new Date(nowMs + 2 * 3600_000).toISOString()
        : isSession
        ? null
        : new Date(nowMs + hours * 3600_000).toISOString(),
    ...(params.method === 'fallback' ? { remainingPlaybacks: 1 } : {}),
  };
}

export function getHourlyUnlockTimestamps(nowMs = Date.now()): number[] {
  const ls = safeGetStorage('local');
  if (!ls) return [];
  const oneHourAgo = nowMs - 3600_000;
  try {
    const raw = ls.getItem(UNLOCK_RATE_TIMESTAMPS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as number[];
    const fresh = arr.filter((ts) => typeof ts === 'number' && ts > oneHourAgo && ts <= nowMs + 60_000);
    if (fresh.length !== arr.length) {
      ls.setItem(UNLOCK_RATE_TIMESTAMPS_KEY, JSON.stringify(fresh));
    }
    return fresh;
  } catch {
    return [];
  }
}

export function countUnlocksInLastHour(nowMs = Date.now()): number {
  return getHourlyUnlockTimestamps(nowMs).length;
}

export function recordUnlockRateTimestamp(nowMs = Date.now()): number {
  const ls = safeGetStorage('local');
  const current = getHourlyUnlockTimestamps(nowMs);
  const updated = [...current, nowMs];
  if (ls) {
    try {
      ls.setItem(UNLOCK_RATE_TIMESTAMPS_KEY, JSON.stringify(updated));
    } catch {
      // ignore
    }
  }
  return updated.length;
}

export function subscribeGuestStorageUpdates(
  onSync: () => void
): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: StorageEvent) => {
    if (
      e.key === GUEST_UNLOCKS_LS_KEY ||
      e.key === UNLOCK_RATE_TIMESTAMPS_KEY ||
      e.key === null
    ) {
      onSync();
    }
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}

// --- Bulk Episode Rule Engine & Dry-Run Diff ---

export type BulkEpisodeRuleKind =
  | 'first_n_free'
  | 'all_mode'
  | 'every_nth_free'
  | 'remaining_mode';

export interface BulkEpisodeRuleInput {
  kind: BulkEpisodeRuleKind;
  n?: number;
  targetMode: AccessMode;
  restMode?: AccessMode;
  requiredPlanId?: string | null;
  adPolicy?: AdPolicyConfig | null;
}

export interface BulkEpisodePatch {
  episode: EpisodeItem;
  previousMode: AccessMode;
  nextMode: AccessMode;
  nextAdPolicy: AdPolicyConfig | null;
  nextPlanId: string | null;
}

export function buildBulkEpisodePatches(
  episodes: EpisodeItem[],
  rule: BulkEpisodeRuleInput
): BulkEpisodePatch[] {
  const sorted = [...episodes].sort(
    (a, b) => a.seasonNumber - b.seasonNumber || a.number - b.number
  );
  const n = Math.max(1, Math.round(rule.n ?? 1));

  return sorted.map((ep, idx) => {
    const pos = idx + 1;
    let nextMode: AccessMode = rule.targetMode;

    if (rule.kind === 'first_n_free') {
      nextMode = ep.number <= n ? 'free' : rule.restMode ?? rule.targetMode;
    } else if (rule.kind === 'every_nth_free') {
      nextMode = pos % n === 0 ? 'free' : rule.restMode ?? rule.targetMode;
    } else if (rule.kind === 'remaining_mode') {
      nextMode = ep.number > n ? rule.targetMode : 'free';
    } else if (rule.kind === 'all_mode') {
      nextMode = rule.targetMode;
    }

    const previousMode: AccessMode = ep.accessMode ?? 'inherit';
    return {
      episode: ep,
      previousMode,
      nextMode,
      nextAdPolicy: rule.adPolicy !== undefined ? rule.adPolicy : ep.adPolicy ?? null,
      nextPlanId:
        rule.requiredPlanId !== undefined ? rule.requiredPlanId : ep.requiredPlanId ?? null,
    };
  });
}

export function summarizeBulkDiff(patches: BulkEpisodePatch[]): {
  total: number;
  changed: number;
  byMode: Record<string, number>;
} {
  const byMode: Record<string, number> = {};
  let changed = 0;
  for (const p of patches) {
    byMode[p.nextMode] = (byMode[p.nextMode] ?? 0) + 1;
    if (p.previousMode !== p.nextMode || p.nextAdPolicy !== (p.episode.adPolicy ?? null)) {
      changed += 1;
    }
  }
  return { total: patches.length, changed, byMode };
}
