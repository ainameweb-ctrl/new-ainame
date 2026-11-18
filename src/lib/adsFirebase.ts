import {
  DEFAULT_AD_SETTINGS,
  DEFAULT_AD_UNLOCK_SETTINGS,
  DEFAULT_BADGE_CONFIG,
  SEED_CUSTOM_ADS,
  SEED_VAST_ADS,
} from '../data/seedAds';
import type {
  AdEventItem,
  AdGlobalSettings,
  CustomAdItem,
  VastAdItem,
} from '../types/streaming';
import { stripUndefinedDeep } from './firebase';

const ADS_CACHE_KEY = 'kv_ads_bundle_v1';
const DAILY_CAPS_KEY = 'kv_daily_ad_caps_v1';

let memoryAdsBundle: {
  customAds: CustomAdItem[];
  vastAds: VastAdItem[];
  adSettings: AdGlobalSettings;
} | null = null;

export function clearAdsBundleCache(): void {
  memoryAdsBundle = null;
  try {
    sessionStorage.removeItem(ADS_CACHE_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function getDailyImpressionCounts(): Record<string, number> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const raw = localStorage.getItem(DAILY_CAPS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { date?: string; counts?: Record<string, number> };
    if (parsed.date !== today) return {};
    return parsed.counts || {};
  } catch {
    return {};
  }
}

export function incrementLocalDailyImpression(adId: string): void {
  const today = new Date().toISOString().slice(0, 10);
  const current = getDailyImpressionCounts();
  const next = { ...current, [adId]: (current[adId] ?? 0) + 1 };
  try {
    localStorage.setItem(DAILY_CAPS_KEY, JSON.stringify({ date: today, counts: next }));
  } catch {
    // Ignore storage failures
  }
}

function mergeGlobalAdSettings(raw?: Partial<AdGlobalSettings> | null): AdGlobalSettings {
  return {
    ...DEFAULT_AD_SETTINGS,
    ...(raw ?? {}),
    adUnlock: {
      ...DEFAULT_AD_UNLOCK_SETTINGS,
      ...(raw?.adUnlock ?? {}),
    },
    badges: {
      paid: { ...DEFAULT_BADGE_CONFIG.paid, ...(raw?.badges?.paid ?? {}) },
      freeWithAds: { ...DEFAULT_BADGE_CONFIG.freeWithAds, ...(raw?.badges?.freeWithAds ?? {}) },
      free: { ...DEFAULT_BADGE_CONFIG.free, ...(raw?.badges?.free ?? {}) },
      included: { ...DEFAULT_BADGE_CONFIG.included, ...(raw?.badges?.included ?? {}) },
      someEpisodesFree: {
        ...DEFAULT_BADGE_CONFIG.someEpisodesFree,
        ...(raw?.badges?.someEpisodesFree ?? {}),
      },
      mobileCompact: raw?.badges?.mobileCompact ?? DEFAULT_BADGE_CONFIG.mobileCompact,
    },
  };
}

export async function fetchAdSettings(): Promise<AdGlobalSettings> {
  return mergeGlobalAdSettings();
}

export async function saveAdSettings(
  settings: AdGlobalSettings,
  _adminUid: string
): Promise<void> {
  memoryAdsBundle = {
    customAds: memoryAdsBundle?.customAds ?? SEED_CUSTOM_ADS,
    vastAds: memoryAdsBundle?.vastAds ?? SEED_VAST_ADS,
    adSettings: mergeGlobalAdSettings(settings),
  };
}

export async function loadAds(): Promise<{
  customAds: CustomAdItem[];
  vastAds: VastAdItem[];
  adSettings: AdGlobalSettings;
}> {
  if (memoryAdsBundle) {
    return memoryAdsBundle;
  }
  const bundle = {
    customAds: SEED_CUSTOM_ADS,
    vastAds: SEED_VAST_ADS,
    adSettings: mergeGlobalAdSettings(),
  };
  memoryAdsBundle = bundle;
  return bundle;
}

export async function fetchAllAdsAdminData(): Promise<{
  customAds: CustomAdItem[];
  vastAds: VastAdItem[];
  adEvents: AdEventItem[];
  adSettings: AdGlobalSettings;
}> {
  return {
    customAds: SEED_CUSTOM_ADS,
    vastAds: SEED_VAST_ADS,
    adEvents: [],
    adSettings: mergeGlobalAdSettings(),
  };
}

export async function saveCustomAdDoc(
  _ad: CustomAdItem,
  _adminUid: string,
  _isNew: boolean
): Promise<void> {
  clearAdsBundleCache();
}

export async function deleteCustomAdDoc(
  _ad: CustomAdItem,
  _adminUid: string
): Promise<void> {
  clearAdsBundleCache();
}

export async function saveVastAdDoc(
  _ad: VastAdItem,
  _adminUid: string,
  _isNew: boolean
): Promise<void> {
  clearAdsBundleCache();
}

export async function deleteVastAdDoc(
  _ad: VastAdItem,
  _adminUid: string
): Promise<void> {
  clearAdsBundleCache();
}

export async function seedSampleAdsToFirestore(_adminUid: string): Promise<void> {
  clearAdsBundleCache();
}

const recentEventsInMemory: Omit<AdEventItem, 'id'>[] = [];

export function trackAdEvent(
  input: Omit<AdEventItem, 'id' | 'createdAt'>,
  testMode = false
): void {
  if (testMode) return;
  if (input.event === 'impression') {
    incrementLocalDailyImpression(input.adId);
  }
  recentEventsInMemory.push({
    ...stripUndefinedDeep(input),
    createdAt: new Date().toISOString(),
  });
  if (recentEventsInMemory.length > 200) {
    recentEventsInMemory.shift();
  }
}

export async function flushAdEvents(): Promise<void> {
  // No Firestore writes in Auth-only mode
}
