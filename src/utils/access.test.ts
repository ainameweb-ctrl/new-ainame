import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AdUnlockRecord,
  CustomAdItem,
  EpisodeItem,
  MovieItem,
  SubscriptionPlan,
  UserProfile,
  VastAdItem,
} from '../types/streaming';
import {
  applyFailureFallback,
  buildBulkEpisodePatches,
  buildUnlockRecord,
  getEffectiveAccessConfig,
  resolveAccess,
  resolveContentBadges,
  resolveUnlockAdPlan,
  summarizeBulkDiff,
} from './access';

const NOW = Date.parse('2026-11-18T12:00:00Z');

const PLAN: SubscriptionPlan = {
  id: 'plan-cinema-plus',
  name: 'Cinema Plus',
  slug: 'cinema-plus',
  pricePerMonth: 9.99,
  currency: 'USD',
  billingInterval: 'monthly',
  description: 'Ad-free 4K anime streaming',
  features: ['No Ads'],
  badgeColor: '#ea580c',
  isActive: true,
  order: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const BASE_SERIES: MovieItem = {
  id: 'series-1',
  title: 'Chronicles of Aethelgard',
  slug: 'chronicles-of-aethelgard',
  type: 'series',
  description: 'Fantasy anime saga',
  releaseYear: 2026,
  duration: 24,
  rating: 9.1,
  ageRating: 'PG-13',
  language: 'Japanese',
  country: 'Japan',
  genres: ['Anime', 'Action'],
  cast: [],
  director: 'K. Sato',
  tags: [],
  posterUrl: '/p.jpg',
  bannerUrl: '/b.jpg',
  trailerUrl: '',
  videoSources: [{ label: '1080p', url: 'https://cdn.example.com/s1.mp4', type: 'mp4' }],
  subtitles: [],
  isFeatured: true,
  isTrending: true,
  isPremium: true,
  requiredPlanId: 'plan-cinema-plus',
  requiredPlanName: 'Cinema Plus',
  accessMode: 'subscription_or_ad',
  seasonAccess: {
    '2': { accessMode: 'subscription', requiredPlanId: 'plan-cinema-plus' },
  },
  status: 'published',
  views: 100,
  likesCount: 10,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const EP_FREE: EpisodeItem = {
  id: 'ep-1',
  seriesId: 'series-1',
  seasonId: 's1',
  seasonNumber: 1,
  number: 1,
  title: 'Awakening',
  description: 'Ep 1',
  duration: 24,
  thumbnailUrl: '/t1.jpg',
  videoSources: [{ label: '1080p', url: 'https://cdn.example.com/ep1.mp4', type: 'mp4' }],
  subtitles: [],
  accessMode: 'free',
  createdAt: '2026-01-01T00:00:00Z',
};

const EP_AD_BANNER: EpisodeItem = {
  ...EP_FREE,
  id: 'ep-2',
  number: 2,
  accessMode: 'subscription_or_ad',
  adPolicy: {
    adFormatMode: 'banner',
    inlineBanner: {
      imageUrl: '/banner.jpg',
      advertiserName: 'Sponsor Brand',
      destinationUrl: 'https://sponsor.example.com',
      displayDurationSeconds: 30,
      status: 'active',
    },
  },
};

const EP_SEASON2_INHERIT: EpisodeItem = {
  ...EP_FREE,
  id: 'ep-s2-1',
  seasonId: 's2',
  seasonNumber: 2,
  number: 1,
  accessMode: 'inherit',
};

const FREE_USER: UserProfile = {
  uid: 'u1',
  displayName: 'Kenji',
  email: 'kenji@example.com',
  photoURL: '',
  role: 'user',
  status: 'active',
  plan: 'free',
  planExpiresAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  lastLoginAt: '2026-11-18T00:00:00Z',
};

const SUB_USER: UserProfile = {
  ...FREE_USER,
  uid: 'u2',
  plan: 'premium',
  subscriptionPlanId: 'plan-cinema-plus',
  planExpiresAt: '2027-01-01T00:00:00Z',
};

const VAST_A: VastAdItem = {
  id: 'vast-a',
  name: 'Vast A',
  type: 'pre-roll',
  vastTagUrl: 'https://ads.example.com/vast-a.xml',
  targetType: 'movie',
  targetIds: [],
  midRollAtSeconds: [],
  overlayStartSeconds: 0,
  overlayDurationSeconds: 10,
  skipAfterSeconds: 5,
  startDate: '2026-01-01',
  endDate: '2027-12-31',
  status: 'active',
  priority: 9,
  audience: 'all',
  devices: ['desktop', 'mobile', 'tablet'],
  impressions: 10,
  completions: 8,
  skips: 1,
  clicks: 0,
  errors: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  createdBy: 'admin',
};

const BANNER_B: CustomAdItem = {
  id: 'banner-b',
  name: 'Banner B',
  advertiserName: 'Studio Merch',
  type: 'image',
  placement: 'banner',
  imageUrl: '/b2.jpg',
  altText: 'Merch',
  redirectUrl: 'https://merch.example.com',
  openInNewTab: true,
  displayDurationSeconds: 25,
  targetContentType: 'all',
  targetIds: [],
  startDate: '2026-01-01',
  endDate: '2027-12-31',
  status: 'active',
  priority: 5,
  weight: 50,
  dailyImpressionCap: 0,
  devices: ['desktop', 'mobile', 'tablet'],
  audience: 'all',
  impressions: 20,
  clicks: 4,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  createdBy: 'admin',
};

test('hierarchy resolves Episode -> Season -> Movie -> Global', () => {
  assert.equal(getEffectiveAccessConfig(BASE_SERIES, EP_FREE).accessMode, 'free');
  assert.equal(getEffectiveAccessConfig(BASE_SERIES, EP_SEASON2_INHERIT).accessMode, 'subscription');
  assert.equal(getEffectiveAccessConfig(BASE_SERIES, null).accessMode, 'subscription_or_ad');
});

test('subscriber gets direct playback without gate; free user sees ad + subscribe options', () => {
  const subRes = resolveAccess(SUB_USER, BASE_SERIES, EP_AD_BANNER, { plans: [PLAN], nowMs: NOW });
  assert.equal(subRes.allowed, true);
  assert.equal(subRes.reason, 'subscribed');

  const freeRes = resolveAccess(FREE_USER, BASE_SERIES, EP_AD_BANNER, { plans: [PLAN], nowMs: NOW });
  assert.equal(freeRes.allowed, false);
  assert.equal(freeRes.reason, 'gated');
  assert.equal(freeRes.options.watchAd, true);
  assert.equal(freeRes.options.subscribe, true);
});

test('unlock is per-episode and respects expiry and hourly rate limit', () => {
  const unlockEp2: AdUnlockRecord = buildUnlockRecord({
    movieId: BASE_SERIES.id,
    episodeId: EP_AD_BANNER.id,
    method: 'banner',
    adId: 'inline-banner-ep-2',
    validityMode: 'hours',
    validityHours: 24,
    nowMs: NOW,
  });

  const unlockedEp2 = resolveAccess(FREE_USER, BASE_SERIES, EP_AD_BANNER, {
    plans: [PLAN],
    adUnlocks: { [EP_AD_BANNER.id]: unlockEp2 },
    nowMs: NOW + 60_000,
  });
  assert.equal(unlockedEp2.allowed, true);
  assert.equal(unlockedEp2.reason, 'unlocked');

  // Different episode in same series remains gated!
  const otherEp: EpisodeItem = { ...EP_AD_BANNER, id: 'ep-3', number: 3 };
  const gatedEp3 = resolveAccess(FREE_USER, BASE_SERIES, otherEp, {
    plans: [PLAN],
    adUnlocks: { [EP_AD_BANNER.id]: unlockEp2 },
    nowMs: NOW + 60_000,
  });
  assert.equal(gatedEp3.allowed, false);

  // Hourly rate limit (20 unlocks/hour) blocks watchAd while allowing subscribe
  const limited = resolveAccess(FREE_USER, BASE_SERIES, otherEp, {
    plans: [PLAN],
    hourlyUnlockCount: 20,
    nowMs: NOW,
  });
  assert.equal(limited.allowed, false);
  assert.equal(limited.reason, 'rate_limited');
  assert.equal(limited.options.watchAd, false);
  assert.equal(limited.options.subscribe, true);
});

test('manual VAST or Banner assignment never gets replaced randomly', () => {
  const manualVast = resolveUnlockAdPlan({
    contentId: 'm1',
    adPolicy: { adFormatMode: 'vast', vastAdId: 'vast-a', skipAfterSeconds: 0 },
    vastAds: [VAST_A],
    customAds: [BANNER_B],
    rotationSeed: 99,
    nowMs: NOW,
  });
  assert.equal(manualVast.steps.length, 1);
  assert.equal(manualVast.steps[0].kind, 'vast');
  if (manualVast.steps[0].kind === 'vast') {
    assert.equal(manualVast.steps[0].vast.id, 'vast-a');
    assert.equal(manualVast.steps[0].vast.skipAfterSeconds, 0);
  }

  const manualBanner = resolveUnlockAdPlan({
    contentId: 'ep-2',
    adPolicy: EP_AD_BANNER.adPolicy,
    vastAds: [VAST_A],
    customAds: [BANNER_B],
    rotationSeed: 42,
    nowMs: NOW,
  });
  assert.equal(manualBanner.steps.length, 1);
  assert.equal(manualBanner.steps[0].kind, 'banner');
  if (manualBanner.steps[0].kind === 'banner') {
    assert.equal(manualBanner.steps[0].banner.advertiserName, 'Sponsor Brand');
    assert.equal(manualBanner.steps[0].banner.displayDurationSeconds, 30);
  }
});

test('failure fallback retries once then applies configured fallback after 2 failures', () => {
  assert.deepEqual(applyFailureFallback(1, { failureFallback: 'allow_one_free' }), {
    canRetry: true,
    fallback: null,
  });
  assert.deepEqual(applyFailureFallback(2, { failureFallback: 'allow_one_free' }), {
    canRetry: false,
    fallback: 'allow_one_free',
  });
});

test('badges show FREE WITH ADS for free users, INCLUDED for subscribers, and Some Episodes Free for mixed series', () => {
  const paidSeries: MovieItem = { ...BASE_SERIES, accessMode: 'subscription' };
  const freeBadges = resolveContentBadges({
    movie: paidSeries,
    user: FREE_USER,
    episodes: [EP_FREE, EP_SEASON2_INHERIT],
    plans: [PLAN],
    nowMs: NOW,
  });
  assert.deepEqual(
    freeBadges.badges.map((b) => b.key),
    ['paid', 'someEpisodesFree']
  );

  const subBadges = resolveContentBadges({
    movie: paidSeries,
    user: SUB_USER,
    episodes: [EP_FREE, EP_SEASON2_INHERIT],
    plans: [PLAN],
    nowMs: NOW,
  });
  assert.deepEqual(
    subBadges.badges.map((b) => b.key),
    ['included']
  );
});

test('bulk episode rule builder computes dry-run diffs accurately', () => {
  const eps: EpisodeItem[] = [1, 2, 3, 4].map((num) => ({
    ...EP_FREE,
    id: `e-${num}`,
    number: num,
    accessMode: 'inherit',
  }));
  const patches = buildBulkEpisodePatches(eps, {
    kind: 'first_n_free',
    n: 2,
    targetMode: 'subscription_or_ad',
  });
  assert.deepEqual(
    patches.map((p) => p.nextMode),
    ['free', 'free', 'subscription_or_ad', 'subscription_or_ad']
  );
  const diff = summarizeBulkDiff(patches);
  assert.equal(diff.total, 4);
  assert.equal(diff.changed, 4);
});
