import React, { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  CheckCircle2,
  Crown,
  Database,
  Download,
  Layers,
  Play,
  Save,
  Search,
  Settings,
  Shield,
  Sparkles,
} from 'lucide-react';
import type {
  AccessMode,
  AdEventItem,
  AdGlobalSettings,
  AdPolicyConfig,
  AdUnlockSettings,
  BadgeConfig,
  BadgeStyleConfig,
  CustomAdItem,
  EpisodeItem,
  FailureFallbackAction,
  MovieItem,
  SeasonAccessConfig,
  SubscriptionPlan,
  UnlockValidityMode,
  UserProfile,
  VastAdItem,
} from '../../types/streaming';
import {
  batchSaveEpisodeAccess,
  fetchSeriesEpisodes,
  seedAdUnlockDatasetToFirestore,
} from '../../lib/firebase';
import {
  buildBulkEpisodePatches,
  mergeAdUnlockSettings,
  mergeBadgeConfig,
  resolveAccess,
  resolveContentBadges,
  resolveUnlockAdPlan,
  summarizeBulkDiff,
  type BulkEpisodePatch,
  type BulkEpisodeRuleKind,
} from '../../utils/access';
import { formatCompactNumber, formatMonthlyPrice } from '../../utils/catalog';
import { formatReportTimestamp } from '../../utils/adEngine';
import { ContentBadgeList } from '../user/ContentBadgeList';
import { Modal } from '../ui/Modal';
import { AdPolicyEditor } from './AdPolicyEditor';

type HubTab = 'assignment' | 'bulk' | 'settings' | 'simulator' | 'analytics';

interface AdUnlockBadgesHubProps {
  movies: MovieItem[];
  plans: SubscriptionPlan[];
  customAds: CustomAdItem[];
  vastAds: VastAdItem[];
  adEvents: AdEventItem[];
  adSettings: AdGlobalSettings;
  adminUid: string;
  adminName: string;
  onSaveMovie: (movie: MovieItem) => Promise<void>;
  onSaveAdSettings: (next: AdGlobalSettings) => Promise<void>;
  onReloadCatalogAndAds: () => Promise<void>;
  onNotify: (msg: string, type: 'success' | 'error' | 'info') => void;
}

const MODE_LABELS: Record<AccessMode, string> = {
  inherit: 'Inherit Global',
  free: 'Free',
  ad_unlock: 'Watch Ad Only',
  subscription_or_ad: 'Subscribe or Ad',
  subscription: 'Paid Subscription Only',
};

const MODE_BADGE_CLASSES: Record<AccessMode, string> = {
  inherit: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  free: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  ad_unlock: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  subscription_or_ad: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400',
  subscription: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
};

function describeAdPolicy(policy?: AdPolicyConfig | null): { label: string; tone: string } {
  const mode = policy?.adFormatMode ?? 'auto';
  if (policy?.active === false) {
    return { label: 'Paused', tone: 'bg-rose-500/15 text-rose-400' };
  }
  switch (mode) {
    case 'vast':
      return { label: 'Video Ad (VAST)', tone: 'bg-sky-500/15 text-sky-400' };
    case 'banner':
      return { label: 'Clickable Banner', tone: 'bg-fuchsia-500/15 text-fuchsia-400' };
    case 'rotation':
      return {
        label: `Rotation (${policy?.rotationAdRefs?.length ?? 0})`,
        tone: 'bg-violet-500/15 text-violet-400',
      };
    default:
      return { label: 'Auto Selection', tone: 'bg-zinc-500/15 text-zinc-400' };
  }
}

export const AdUnlockBadgesHub: React.FC<AdUnlockBadgesHubProps> = ({
  movies,
  plans,
  customAds,
  vastAds,
  adEvents,
  adSettings,
  adminUid,
  adminName,
  onSaveMovie,
  onSaveAdSettings,
  onReloadCatalogAndAds,
  onNotify,
}) => {
  const [subTab, setSubTab] = useState<HubTab>('assignment');
  const [seeding, setSeeding] = useState(false);

  // Tab 1: Per-Title Assignment State
  const [searchTitle, setSearchTitle] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'movie' | 'series'>('all');
  const [formatFilter, setFormatFilter] = useState<'all' | 'vast' | 'banner' | 'rotation' | 'auto'>('all');
  const [editingTitle, setEditingTitle] = useState<MovieItem | null>(null);
  const [editMode, setEditMode] = useState<AccessMode>('free');
  const [editPlanId, setEditPlanId] = useState<string>('');
  const [editPolicy, setEditPolicy] = useState<AdPolicyConfig | null>(null);
  const [editSeasonAccess, setEditSeasonAccess] = useState<Record<string, SeasonAccessConfig>>({});
  const [activeSeasonKey, setActiveSeasonKey] = useState('1');
  const [savingTitle, setSavingTitle] = useState(false);

  // Tab 2: Bulk Episode Manager State
  const seriesMovies = useMemo(() => movies.filter((m) => m.type === 'series'), [movies]);
  const [bulkSeriesId, setBulkSeriesId] = useState<string>(seriesMovies[0]?.id ?? '');
  const [bulkEpisodes, setBulkEpisodes] = useState<EpisodeItem[]>([]);
  const [loadingBulkEps, setLoadingBulkEps] = useState(false);
  const [selectedEpIds, setSelectedEpIds] = useState<Set<string>>(new Set());
  const [ruleKind, setRuleKind] = useState<BulkEpisodeRuleKind>('first_n_free');
  const [ruleN, setRuleN] = useState(1);
  const [ruleTargetMode, setRuleTargetMode] = useState<AccessMode>('subscription_or_ad');
  const [ruleRestMode, setRuleRestMode] = useState<AccessMode>('subscription_or_ad');
  const [rulePlanId, setRulePlanId] = useState<string>(plans.find((p) => p.isActive)?.id ?? '');
  const [ruleAdPolicy, setRuleAdPolicy] = useState<AdPolicyConfig | null>({ adFormatMode: 'auto' });
  const [previewPatches, setPreviewPatches] = useState<BulkEpisodePatch[] | null>(null);
  const [committingBulk, setCommittingBulk] = useState(false);
  const [undoSnapshot, setUndoSnapshot] = useState<EpisodeItem[] | null>(null);

  // Tab 3: Global Settings & Badges Draft
  const [unlockDraft, setUnlockDraft] = useState<AdUnlockSettings>(() =>
    mergeAdUnlockSettings(adSettings.adUnlock)
  );
  const [badgesDraft, setBadgesDraft] = useState<BadgeConfig>(() =>
    mergeBadgeConfig(adSettings.badges)
  );
  const [savingGlobal, setSavingGlobal] = useState(false);

  // Tab 4: Simulator State
  const [simRole, setSimRole] = useState<'guest' | 'free' | 'subscriber'>('free');
  const [simMovieId, setSimMovieId] = useState<string>(movies[0]?.id ?? '');
  const [simEpisodes, setSimEpisodes] = useState<EpisodeItem[]>([]);
  const [simEpisodeId, setSimEpisodeId] = useState<string>('');

  useEffect(() => {
    setUnlockDraft(mergeAdUnlockSettings(adSettings.adUnlock));
    setBadgesDraft(mergeBadgeConfig(adSettings.badges));
  }, [adSettings]);

  useEffect(() => {
    if (!bulkSeriesId && seriesMovies[0]?.id) {
      setBulkSeriesId(seriesMovies[0].id);
    }
  }, [seriesMovies, bulkSeriesId]);

  useEffect(() => {
    if (!simMovieId && movies[0]?.id) {
      setSimMovieId(movies[0].id);
    }
  }, [movies, simMovieId]);

  useEffect(() => {
    if (!bulkSeriesId) {
      setBulkEpisodes([]);
      return;
    }
    let active = true;
    (async () => {
      setLoadingBulkEps(true);
      try {
        const eps = await fetchSeriesEpisodes(bulkSeriesId);
        if (!active) return;
        setBulkEpisodes(eps);
        setSelectedEpIds(new Set(eps.map((e) => e.id)));
        setPreviewPatches(null);
      } finally {
        if (active) setLoadingBulkEps(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [bulkSeriesId]);

  const simMovie = useMemo(
    () => movies.find((m) => m.id === simMovieId) ?? movies[0] ?? null,
    [movies, simMovieId]
  );

  useEffect(() => {
    if (!simMovie || simMovie.type !== 'series') {
      setSimEpisodes([]);
      setSimEpisodeId('');
      return;
    }
    let active = true;
    fetchSeriesEpisodes(simMovie.id).then((eps) => {
      if (!active) return;
      setSimEpisodes(eps);
      setSimEpisodeId((prev) => (eps.some((e) => e.id === prev) ? prev : eps[0]?.id ?? ''));
    });
    return () => {
      active = false;
    };
  }, [simMovie?.id, simMovie?.type]);

  const filteredTitles = useMemo(() => {
    const q = searchTitle.trim().toLowerCase();
    return movies.filter((m) => {
      if (typeFilter !== 'all' && m.type !== typeFilter) return false;
      const fmt = m.adPolicy?.adFormatMode ?? 'auto';
      if (formatFilter !== 'all' && fmt !== formatFilter) return false;
      if (q && !m.title.toLowerCase().includes(q) && !m.slug.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [movies, searchTitle, typeFilter, formatFilter]);

  const handleSeedDataset = async () => {
    setSeeding(true);
    try {
      await seedAdUnlockDatasetToFirestore(adminUid);
      await onReloadCatalogAndAds();
      onNotify(
        'Seeded "Chronicles of Aethelgard" (5 episodes: Free, Banner, VAST, Rotation, Paid) + Banner & VAST Ads.',
        'success'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Seed failed.', 'error');
    } finally {
      setSeeding(false);
    }
  };

  // --- Bulk Diff Computation ---
  const computeBulkPreview = () => {
    const targetEps = bulkEpisodes.filter((ep) => selectedEpIds.has(ep.id));
    if (targetEps.length === 0) {
      onNotify('Select at least one episode first.', 'info');
      return;
    }
    const patches = buildBulkEpisodePatches(targetEps, {
      kind: ruleKind,
      n: ruleN,
      targetMode: ruleTargetMode,
      restMode: ruleRestMode,
      requiredPlanId: rulePlanId || null,
      adPolicy: ruleAdPolicy,
    });
    setPreviewPatches(patches);
  };

  const handleCommitBulk = async () => {
    if (!previewPatches || previewPatches.length === 0) return;
    setCommittingBulk(true);
    try {
      setUndoSnapshot(bulkEpisodes);
      const chosenPlan = rulePlanId ? plans.find((p) => p.id === rulePlanId) : null;
      const updatedEps: EpisodeItem[] = previewPatches.map((p) => ({
        ...p.episode,
        accessMode: p.nextMode,
        requiredPlanId: p.nextPlanId,
        requiredPlanName: p.nextPlanId ? chosenPlan?.name ?? p.episode.requiredPlanName ?? null : null,
        adPolicy: p.nextAdPolicy,
      }));
      await batchSaveEpisodeAccess(updatedEps, adminUid);
      const updatedMap = new Map(updatedEps.map((e) => [e.id, e]));
      setBulkEpisodes((prev) => prev.map((e) => updatedMap.get(e.id) ?? e));
      setPreviewPatches(null);
      onNotify(`Saved access & ad rules for ${updatedEps.length} episodes.`, 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Batch save failed.', 'error');
    } finally {
      setCommittingBulk(false);
    }
  };

  const handleUndoBulk = async () => {
    if (!undoSnapshot) return;
    setCommittingBulk(true);
    try {
      await batchSaveEpisodeAccess(undoSnapshot, adminUid);
      setBulkEpisodes(undoSnapshot);
      setUndoSnapshot(null);
      onNotify('Reverted last bulk episode update.', 'info');
    } finally {
      setCommittingBulk(false);
    }
  };

  // --- Analytics Summary ---
  const analyticsStats = useMemo(() => {
    const counts = {
      gateViews: 0,
      adStarts: 0,
      vastCompletes: 0,
      bannerCompletes: 0,
      unlockCompletes: 0,
      unlockFails: 0,
      bannerClicks: 0,
      subClicks: 0,
      subConverts: 0,
    };
    for (const ev of adEvents) {
      if (ev.event === 'gate_view') counts.gateViews += 1;
      else if (ev.event === 'ad_start') counts.adStarts += 1;
      else if (ev.event === 'unlock_complete') {
        counts.unlockCompletes += 1;
        if (ev.method === 'vast') counts.vastCompletes += 1;
      } else if (ev.event === 'banner_complete') counts.bannerCompletes += 1;
      else if (ev.event === 'unlock_fail') counts.unlockFails += 1;
      else if (ev.event === 'click') counts.bannerClicks += 1;
      else if (ev.event === 'subscribe_click') counts.subClicks += 1;
      else if (ev.event === 'subscribe_convert') counts.subConverts += 1;
    }
    const dropOffPct =
      counts.adStarts > 0
        ? Math.max(0, Math.round(((counts.adStarts - counts.unlockCompletes) / counts.adStarts) * 100))
        : 0;
    return { ...counts, dropOffPct };
  }, [adEvents]);

  const exportFunnelCsv = () => {
    const rows = [
      ['Ad-Unlock & Subscription Funnel Report'],
      [`Generated By: ${adminName}`],
      [`Generated On: ${formatReportTimestamp(new Date())}`],
      ['Metric', 'Count'],
      ['Gate Views', String(analyticsStats.gateViews)],
      ['Ad Starts', String(analyticsStats.adStarts)],
      ['Verified Banner Completions', String(analyticsStats.bannerCompletes)],
      ['VAST Unlock Completions', String(analyticsStats.vastCompletes)],
      ['Total Completed Unlocks', String(analyticsStats.unlockCompletes)],
      ['Ad Failures', String(analyticsStats.unlockFails)],
      ['Banner Sponsor Clicks', String(analyticsStats.bannerClicks)],
      ['Subscribe Plan Clicks', String(analyticsStats.subClicks)],
      ['Subscription Conversions', String(analyticsStats.subConverts)],
      ['Drop-Off Rate (%)', `${analyticsStats.dropOffPct}%`],
    ];
    const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Ad_Unlock_Funnel_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Header Banner + Seed Button */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-[#13131c]">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-violet-500" />
            <h2 className="font-display text-lg font-bold tracking-tight">
              Ad Unlock, Format Assignment &amp; Badge Control
            </h2>
          </div>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Assign Video (VAST) or Timed Clickable Banner ads per movie, series, season, or episode, configure bulk episode rules, and customize badges.
          </p>
        </div>

        <button
          type="button"
          disabled={seeding}
          onClick={handleSeedDataset}
          className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
        >
          <Database className="h-3.5 w-3.5" />
          {seeding ? 'Seeding Test Dataset...' : 'Seed Test Dataset'}
        </button>
      </div>

      {/* Sub-Tabs */}
      <div className="flex flex-wrap gap-2">
        {(
          [
            { id: 'assignment', label: 'Access & Ad Assignment', icon: <Shield className="h-3.5 w-3.5" /> },
            { id: 'bulk', label: 'Bulk Episode Manager', icon: <Layers className="h-3.5 w-3.5" /> },
            { id: 'settings', label: 'Global Settings & Badges', icon: <Settings className="h-3.5 w-3.5" /> },
            { id: 'simulator', label: 'Preview & Simulator', icon: <Play className="h-3.5 w-3.5" /> },
            { id: 'analytics', label: 'Analytics & Funnel', icon: <BarChart3 className="h-3.5 w-3.5" /> },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setSubTab(tab.id)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors ${
              subTab === tab.id
                ? 'bg-violet-600 text-white'
                : 'border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-[#13131c] dark:text-zinc-300 dark:hover:bg-zinc-800'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* SUB-TAB 1: ACCESS & AD ASSIGNMENT */}
      {subTab === 'assignment' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-[#13131c]">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <input
                type="search"
                value={searchTitle}
                onChange={(e) => setSearchTitle(e.target.value)}
                placeholder="Search movie or series poster..."
                className="w-full rounded-lg border border-zinc-300 bg-transparent py-2 pl-9 pr-3 text-xs dark:border-zinc-700"
              />
            </div>

            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as 'all' | 'movie' | 'series')}
              className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="all">All Types</option>
              <option value="movie">Movies</option>
              <option value="series">Series</option>
            </select>

            <select
              value={formatFilter}
              onChange={(e) =>
                setFormatFilter(e.target.value as 'all' | 'vast' | 'banner' | 'rotation' | 'auto')
              }
              className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="all">All Ad Formats</option>
              <option value="vast">Video Ad (VAST)</option>
              <option value="banner">Clickable Banner</option>
              <option value="rotation">Multi-Ad Rotation</option>
              <option value="auto">Auto Selection</option>
            </select>
          </div>

          <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-[#13131c]">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800">
                <tr>
                  <th className="p-3">Poster &amp; Title</th>
                  <th className="p-3">Type</th>
                  <th className="p-3">Access Mode</th>
                  <th className="p-3">Plan</th>
                  <th className="p-3">Assigned Ad Format</th>
                  <th className="p-3 text-right">Configure</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {filteredTitles.map((m) => {
                  const effectiveMode: AccessMode =
                    m.accessMode ?? (m.requiredPlanId || m.isPremium ? 'subscription' : 'free');
                  const fmtMeta = describeAdPolicy(m.adPolicy);
                  const seasonOverrideCount = Object.keys(m.seasonAccess ?? {}).length;

                  return (
                    <tr key={m.id}>
                      <td className="p-3">
                        <div className="flex items-center gap-3">
                          <img
                            src={m.posterUrl}
                            alt={m.title}
                            className="h-12 w-8 shrink-0 rounded object-cover"
                          />
                          <div>
                            <p className="font-semibold text-sm">{m.title}</p>
                            <p className="text-[11px] text-zinc-500">
                              {m.releaseYear} · {m.slug}
                              {seasonOverrideCount > 0 ? ` · ${seasonOverrideCount} season override(s)` : ''}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="p-3 capitalize">{m.type}</td>
                      <td className="p-3">
                        <span
                          className={`inline-flex rounded px-2 py-0.5 text-[11px] font-semibold ${MODE_BADGE_CLASSES[effectiveMode]}`}
                        >
                          {MODE_LABELS[effectiveMode]}
                        </span>
                      </td>
                      <td className="p-3 text-zinc-500">{m.requiredPlanName || '—'}</td>
                      <td className="p-3">
                        <span
                          className={`inline-flex rounded px-2 py-0.5 text-[11px] font-semibold ${fmtMeta.tone}`}
                        >
                          {fmtMeta.label}
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingTitle(m);
                            setEditMode(effectiveMode);
                            setEditPlanId(m.requiredPlanId ?? '');
                            setEditPolicy(m.adPolicy ?? { adFormatMode: 'auto' });
                            setEditSeasonAccess(m.seasonAccess ?? {});
                            setActiveSeasonKey('1');
                          }}
                          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-semibold hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                        >
                          Edit Access &amp; Ad
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUB-TAB 2: BULK EPISODE MANAGER */}
      {subTab === 'bulk' && (
        <div className="space-y-5">
          {seriesMovies.length === 0 ? (
            <div className="rounded-xl border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-[#13131c]">
              No Series titles found. Add a Series or click &ldquo;Seed Test Dataset&rdquo; above.
            </div>
          ) : (
            <>
              {/* Series Picker & Heatmap */}
              <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-4 dark:border-zinc-800 dark:bg-[#13131c]">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-zinc-500">
                      Select Series
                    </label>
                    <select
                      value={bulkSeriesId}
                      onChange={(e) => setBulkSeriesId(e.target.value)}
                      className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium dark:border-zinc-700 dark:bg-zinc-900"
                    >
                      {seriesMovies.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 bg-emerald-500/15 text-emerald-500 font-semibold">
                      Free
                    </span>
                    <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 bg-violet-500/15 text-violet-400 font-semibold">
                      Ad Unlock
                    </span>
                    <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 bg-amber-500/15 text-amber-400 font-semibold">
                      Paid Sub Only
                    </span>
                    {undoSnapshot && (
                      <button
                        type="button"
                        onClick={handleUndoBulk}
                        disabled={committingBulk}
                        className="ml-2 rounded-lg border border-zinc-300 px-3 py-1 font-semibold hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                      >
                        Undo Last Batch
                      </button>
                    )}
                  </div>
                </div>

                {/* Color-coded Episode Heatmap Grid */}
                {loadingBulkEps ? (
                  <p className="text-xs text-zinc-500">Loading episodes...</p>
                ) : bulkEpisodes.length === 0 ? (
                  <p className="text-xs text-zinc-500">No episodes stored for this series yet.</p>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs text-zinc-500">
                      <span>Episode Access Heatmap ({selectedEpIds.size}/{bulkEpisodes.length} selected)</span>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setSelectedEpIds(new Set(bulkEpisodes.map((e) => e.id)))}
                          className="font-semibold text-violet-400 hover:underline"
                        >
                          Select All
                        </button>
                        <button
                          type="button"
                          onClick={() => setSelectedEpIds(new Set())}
                          className="hover:underline"
                        >
                          Clear
                        </button>
                      </div>
                    </div>

                    <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
                      {bulkEpisodes.map((ep) => {
                        const mode = ep.accessMode ?? 'inherit';
                        const checked = selectedEpIds.has(ep.id);
                        const fmt = ep.adPolicy?.adFormatMode;
                        return (
                          <label
                            key={ep.id}
                            className={`flex cursor-pointer flex-col gap-1 rounded-lg border p-2.5 text-xs transition ${
                              checked
                                ? 'border-violet-500 bg-violet-500/10'
                                : 'border-zinc-200 dark:border-zinc-800'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono font-bold">
                                S{ep.seasonNumber}·E{ep.number}
                              </span>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => {
                                  const next = new Set(selectedEpIds);
                                  if (e.target.checked) next.add(ep.id);
                                  else next.delete(ep.id);
                                  setSelectedEpIds(next);
                                }}
                                className="accent-violet-600"
                              />
                            </div>
                            <p className="truncate font-medium">{ep.title}</p>
                            <div className="mt-1 flex flex-wrap gap-1">
                              <span
                                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${MODE_BADGE_CLASSES[mode]}`}
                              >
                                {MODE_LABELS[mode]}
                              </span>
                              {fmt && (
                                <span className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] uppercase text-zinc-200">
                                  {fmt}
                                </span>
                              )}
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Bulk Rule Builder + Ad Policy Assignment */}
              <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-4 dark:border-zinc-800 dark:bg-[#13131c]">
                <h3 className="font-display text-sm font-bold">Bulk Rule &amp; Ad Format Assignment</h3>
                <div className="grid gap-3 sm:grid-cols-4">
                  <div>
                    <label className="mb-1 block text-xs text-zinc-500">Rule Pattern</label>
                    <select
                      value={ruleKind}
                      onChange={(e) => setRuleKind(e.target.value as BulkEpisodeRuleKind)}
                      className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                    >
                      <option value="first_n_free">First N Episodes Free, Rest Protected</option>
                      <option value="all_mode">Apply Mode to All Selected</option>
                      <option value="every_nth_free">Every Nth Episode Free</option>
                      <option value="remaining_mode">Episodes After N</option>
                    </select>
                  </div>

                  {ruleKind !== 'all_mode' && (
                    <div>
                      <label className="mb-1 block text-xs text-zinc-500">N (Count)</label>
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={ruleN}
                        onChange={(e) => setRuleN(Math.max(1, Number(e.target.value) || 1))}
                        className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-xs tabular-nums dark:border-zinc-700"
                      />
                    </div>
                  )}

                  <div>
                    <label className="mb-1 block text-xs text-zinc-500">
                      {ruleKind === 'all_mode' ? 'Target Mode' : 'Protected Episodes Mode'}
                    </label>
                    <select
                      value={ruleKind === 'all_mode' ? ruleTargetMode : ruleRestMode}
                      onChange={(e) => {
                        const v = e.target.value as AccessMode;
                        if (ruleKind === 'all_mode') setRuleTargetMode(v);
                        else {
                          setRuleRestMode(v);
                          setRuleTargetMode(v);
                        }
                      }}
                      className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                    >
                      <option value="free">Free</option>
                      <option value="ad_unlock">Watch Ad to Unlock</option>
                      <option value="subscription_or_ad">Subscribe or Watch Ad</option>
                      <option value="subscription">Paid Subscription Only</option>
                    </select>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs text-zinc-500">Required Plan</label>
                    <select
                      value={rulePlanId}
                      onChange={(e) => setRulePlanId(e.target.value)}
                      className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                    >
                      <option value="">Default Active Plan</option>
                      {plans.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <AdPolicyEditor
                  title="Batch Ad Format for Protected Episodes"
                  value={ruleAdPolicy}
                  onChange={setRuleAdPolicy}
                  vastAds={vastAds}
                  customAds={customAds}
                />

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={computeBulkPreview}
                    className="rounded-lg border border-violet-500/40 bg-violet-500/10 px-4 py-2 text-xs font-semibold text-violet-400 hover:bg-violet-500/20"
                  >
                    Dry-Run Diff Preview
                  </button>
                  {previewPatches && (
                    <button
                      type="button"
                      disabled={committingBulk}
                      onClick={handleCommitBulk}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-5 py-2 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {committingBulk
                        ? 'Committing...'
                        : `Commit ${previewPatches.length} Episodes`}
                    </button>
                  )}
                </div>

                {previewPatches && (
                  <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
                    {(() => {
                      const summary = summarizeBulkDiff(previewPatches);
                      return (
                        <p className="mb-2 text-xs font-semibold">
                          Dry-Run Diff: {summary.changed} of {summary.total} selected episodes will change
                        </p>
                      );
                    })()}
                    <div className="max-h-48 space-y-1 overflow-y-auto text-xs">
                      {previewPatches.map((p) => (
                        <div key={p.episode.id} className="flex items-center justify-between gap-2 py-1">
                          <span className="truncate font-medium">
                            S{p.episode.seasonNumber}·E{p.episode.number} {p.episode.title}
                          </span>
                          <span className="font-mono shrink-0 text-[11px]">
                            <span className="text-zinc-400">{p.previousMode}</span> →{' '}
                            <span className="font-bold text-violet-400">{p.nextMode}</span>
                            {p.nextAdPolicy?.adFormatMode
                              ? ` (${p.nextAdPolicy.adFormatMode})`
                              : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* SUB-TAB 3: GLOBAL SETTINGS & BADGES */}
      {subTab === 'settings' && (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Global Ad-Unlock Rules */}
          <div className="space-y-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-[#13131c]">
            <h3 className="font-display text-base font-bold">Global Ad Unlock Rules &amp; Gate Copy</h3>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex items-center justify-between rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
                <span className="font-semibold">Enable Ad Unlock System</span>
                <input
                  type="checkbox"
                  checked={unlockDraft.enabled}
                  onChange={(e) => setUnlockDraft((d) => ({ ...d, enabled: e.target.checked }))}
                  className="accent-violet-600"
                />
              </label>
              <label className="flex items-center justify-between rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
                <span className="font-semibold">Allow Guest Ad Unlocks</span>
                <input
                  type="checkbox"
                  checked={unlockDraft.guestAdUnlockEnabled}
                  onChange={(e) =>
                    setUnlockDraft((d) => ({ ...d, guestAdUnlockEnabled: e.target.checked }))
                  }
                  className="accent-violet-600"
                />
              </label>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-[11px] font-medium text-zinc-500">
                  Max Unlocks / Hour
                </label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={unlockDraft.maxUnlocksPerHour}
                  onChange={(e) =>
                    setUnlockDraft((d) => ({
                      ...d,
                      maxUnlocksPerHour: Math.max(1, Number(e.target.value) || 20),
                    }))
                  }
                  className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-xs tabular-nums dark:border-zinc-700"
                />
              </div>

              <div>
                <label className="mb-1 block text-[11px] font-medium text-zinc-500">
                  Unlock Validity Mode
                </label>
                <select
                  value={unlockDraft.validityMode}
                  onChange={(e) =>
                    setUnlockDraft((d) => ({
                      ...d,
                      validityMode: e.target.value as UnlockValidityMode,
                    }))
                  }
                  className="w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                >
                  <option value="hours">Fixed Hours</option>
                  <option value="session">Browser Session</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-[11px] font-medium text-zinc-500">
                  Validity Hours
                </label>
                <input
                  type="number"
                  min={1}
                  max={168}
                  disabled={unlockDraft.validityMode === 'session'}
                  value={unlockDraft.validityHours}
                  onChange={(e) =>
                    setUnlockDraft((d) => ({
                      ...d,
                      validityHours: Math.max(1, Number(e.target.value) || 24),
                    }))
                  }
                  className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-xs tabular-nums disabled:opacity-40 dark:border-zinc-700"
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-[11px] font-medium text-zinc-500">
                  After 2 Ad Failures
                </label>
                <select
                  value={unlockDraft.failureFallback}
                  onChange={(e) =>
                    setUnlockDraft((d) => ({
                      ...d,
                      failureFallback: e.target.value as FailureFallbackAction,
                    }))
                  }
                  className="w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                >
                  <option value="keep_locked">Keep Locked (Require Plan/Retry)</option>
                  <option value="allow_one_free">Allow One Free Playback</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-[11px] font-medium text-zinc-500">
                  Default Banner Duration (s)
                </label>
                <input
                  type="number"
                  min={3}
                  max={120}
                  value={unlockDraft.defaultBannerDurationSeconds}
                  onChange={(e) =>
                    setUnlockDraft((d) => ({
                      ...d,
                      defaultBannerDurationSeconds: Math.max(3, Number(e.target.value) || 30),
                    }))
                  }
                  className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-xs tabular-nums dark:border-zinc-700"
                />
              </div>

              <div>
                <label className="mb-1 block text-[11px] font-medium text-zinc-500">
                  VAST Skip After (0 = Lock)
                </label>
                <input
                  type="number"
                  min={0}
                  max={60}
                  value={unlockDraft.allowSkipAfterSeconds}
                  onChange={(e) =>
                    setUnlockDraft((d) => ({
                      ...d,
                      allowSkipAfterSeconds: Math.max(0, Number(e.target.value) || 0),
                    }))
                  }
                  className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-xs tabular-nums dark:border-zinc-700"
                />
              </div>
            </div>

            <div className="space-y-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
              <p className="text-xs font-semibold">Editable Watch Gate Copy</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-[11px] text-zinc-500">Gate Title</label>
                  <input
                    type="text"
                    value={unlockDraft.gateTitle}
                    onChange={(e) => setUnlockDraft((d) => ({ ...d, gateTitle: e.target.value }))}
                    className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-xs dark:border-zinc-700"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-zinc-500">Primary CTA Label</label>
                  <input
                    type="text"
                    value={unlockDraft.watchAdButtonText}
                    onChange={(e) =>
                      setUnlockDraft((d) => ({ ...d, watchAdButtonText: e.target.value }))
                    }
                    className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-xs dark:border-zinc-700"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-zinc-500">Gate Description</label>
                <textarea
                  rows={2}
                  value={unlockDraft.gateDescription}
                  onChange={(e) =>
                    setUnlockDraft((d) => ({ ...d, gateDescription: e.target.value }))
                  }
                  className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-xs dark:border-zinc-700"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-[11px] text-zinc-500">Watch Ad Subtext</label>
                  <input
                    type="text"
                    value={unlockDraft.watchAdSubtext}
                    onChange={(e) =>
                      setUnlockDraft((d) => ({ ...d, watchAdSubtext: e.target.value }))
                    }
                    className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-xs dark:border-zinc-700"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-zinc-500">Subscribe Subtext</label>
                  <input
                    type="text"
                    value={unlockDraft.subscribeSubtext}
                    onChange={(e) =>
                      setUnlockDraft((d) => ({ ...d, subscribeSubtext: e.target.value }))
                    }
                    className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-xs dark:border-zinc-700"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Badge Customization */}
          <div className="space-y-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-[#13131c]">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-bold">Content Badges Customizer</h3>
              <label className="flex items-center gap-2 text-xs font-medium">
                <input
                  type="checkbox"
                  checked={badgesDraft.mobileCompact}
                  onChange={(e) =>
                    setBadgesDraft((b) => ({ ...b, mobileCompact: e.target.checked }))
                  }
                  className="accent-violet-600"
                />
                Compact Mobile Badges
              </label>
            </div>

            {(
              [
                { key: 'paid', label: 'Paid Subscription Badge' },
                { key: 'freeWithAds', label: 'Free With Ads Badge' },
                { key: 'free', label: 'Free Content Badge' },
                { key: 'included', label: 'Included in Plan Badge' },
                { key: 'someEpisodesFree', label: 'Mixed Series ("Some Episodes Free")' },
              ] as const
            ).map(({ key, label }) => {
              const cfg: BadgeStyleConfig = badgesDraft[key];
              const updateBadge = (patch: Partial<BadgeStyleConfig>) => {
                setBadgesDraft((b) => ({
                  ...b,
                  [key]: { ...b[key], ...patch },
                }));
              };
              return (
                <div
                  key={key}
                  className="rounded-lg border border-zinc-200 p-3 space-y-2 dark:border-zinc-800"
                >
                  <div className="flex items-center justify-between gap-2">
                    <label className="flex items-center gap-2 text-xs font-semibold">
                      <input
                        type="checkbox"
                        checked={cfg.enabled}
                        onChange={(e) => updateBadge({ enabled: e.target.checked })}
                        className="accent-violet-600"
                      />
                      {label}
                    </label>
                    <ContentBadgeList
                      badges={[
                        {
                          key,
                          text: cfg.text,
                          color: cfg.color,
                          textColor: cfg.textColor,
                          icon: cfg.icon,
                          tooltip: cfg.text,
                        },
                      ]}
                    />
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    <input
                      type="text"
                      value={cfg.text}
                      onChange={(e) => updateBadge({ text: e.target.value })}
                      className="col-span-2 rounded border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-700"
                    />
                    <select
                      value={cfg.icon}
                      onChange={(e) => updateBadge({ icon: e.target.value })}
                      className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                    >
                      <option value="crown">Crown</option>
                      <option value="lock">Lock</option>
                      <option value="play">Play</option>
                      <option value="gift">Gift</option>
                      <option value="unlock">Unlock</option>
                      <option value="sparkles">Sparkles</option>
                    </select>
                    <input
                      type="color"
                      value={cfg.color}
                      onChange={(e) => updateBadge({ color: e.target.value })}
                      aria-label={`${label} color`}
                      className="h-7 w-full cursor-pointer rounded border border-zinc-300 bg-transparent dark:border-zinc-700"
                    />
                  </div>
                </div>
              );
            })}

            <button
              type="button"
              disabled={savingGlobal}
              onClick={async () => {
                setSavingGlobal(true);
                try {
                  await onSaveAdSettings({
                    ...adSettings,
                    adUnlock: unlockDraft,
                    badges: badgesDraft,
                  });
                } finally {
                  setSavingGlobal(false);
                }
              }}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {savingGlobal ? 'Saving Settings & Badges...' : 'Save Global Settings & Badges'}
            </button>
          </div>
        </div>
      )}

      {/* SUB-TAB 4: PREVIEW & SIMULATOR */}
      {subTab === 'simulator' && (
        <div className="space-y-5">
          <div className="grid gap-3 rounded-xl border border-zinc-200 bg-white p-4 sm:grid-cols-3 dark:border-zinc-800 dark:bg-[#13131c]">
            <div>
              <label className="mb-1 block text-xs text-zinc-500">Simulate Viewer Account</label>
              <select
                value={simRole}
                onChange={(e) => setSimRole(e.target.value as 'guest' | 'free' | 'subscriber')}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="guest">Guest (Not Signed In)</option>
                <option value="free">Signed-In Free User</option>
                <option value="subscriber">Cinema Plus Active Subscriber</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs text-zinc-500">Title / Poster</label>
              <select
                value={simMovie?.id ?? ''}
                onChange={(e) => setSimMovieId(e.target.value)}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              >
                {movies.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title} ({m.type})
                  </option>
                ))}
              </select>
            </div>

            {simMovie?.type === 'series' && (
              <div>
                <label className="mb-1 block text-xs text-zinc-500">Episode</label>
                <select
                  value={simEpisodeId}
                  onChange={(e) => setSimEpisodeId(e.target.value)}
                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                >
                  {simEpisodes.map((ep) => (
                    <option key={ep.id} value={ep.id}>
                      S{ep.seasonNumber}·E{ep.number} — {ep.title}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {simMovie &&
            (() => {
              const fakeUser: UserProfile | null =
                simRole === 'guest'
                  ? null
                  : {
                      uid: 'sim-user',
                      displayName: simRole === 'subscriber' ? 'Cinema Plus Member' : 'Free Member',
                      email: 'preview@kinovault.example',
                      photoURL: '',
                      role: 'user',
                      status: 'active',
                      plan: simRole === 'subscriber' ? 'premium' : 'free',
                      subscriptionPlanId:
                        simRole === 'subscriber'
                          ? plans.find((p) => p.isActive)?.id ?? 'plan-cinema-plus'
                          : null,
                      subscriptionPlanName:
                        simRole === 'subscriber' ? 'Cinema Plus' : null,
                      planExpiresAt: null,
                      createdAt: new Date().toISOString(),
                      lastLoginAt: new Date().toISOString(),
                    };

              const ep = simEpisodes.find((e) => e.id === simEpisodeId) ?? null;
              const access = resolveAccess(fakeUser, simMovie, ep, {
                plans,
                adUnlockSettings: unlockDraft,
              });
              const adPlan = resolveUnlockAdPlan({
                contentId: access.contentId,
                adPolicy: access.adPolicy,
                vastAds,
                customAds,
                settings: unlockDraft,
                adsRequired: access.adsRequired,
              });
              const cardBadges = resolveContentBadges({
                movie: simMovie,
                user: fakeUser,
                episodes: simEpisodes,
                plans,
                badgeConfig: badgesDraft,
                adUnlockSettings: unlockDraft,
              });

              const firstStep = adPlan.steps[0];

              return (
                <div className="grid gap-6 lg:grid-cols-2">
                  <div className="space-y-3 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-[#13131c]">
                    <h4 className="font-display text-sm font-bold">Resolved Access &amp; Ad Plan</h4>
                    <div className="space-y-2 text-xs">
                      <p>
                        Access Decision:{' '}
                        <strong className={access.allowed ? 'text-emerald-500' : 'text-amber-400'}>
                          {access.allowed ? `ALLOWED (${access.reason})` : `GATED (${access.reason})`}
                        </strong>
                      </p>
                      <p>
                        Rule Layer: <span className="font-mono">{access.sourceLayer}</span> · Mode:{' '}
                        <span className="font-mono">{access.effectiveMode}</span>
                      </p>
                      <p>
                        Assigned Format:{' '}
                        <strong className="uppercase text-violet-400">{adPlan.assignmentMode}</strong>{' '}
                        ({adPlan.manuallyAssigned ? 'Manual Lock' : 'Auto Pool'})
                      </p>
                      {firstStep?.kind === 'banner' && (
                        <div className="mt-2 rounded-lg border border-fuchsia-500/30 bg-fuchsia-500/10 p-3">
                          <p className="font-semibold text-fuchsia-300">
                            Banner Unlock Preview: {firstStep.banner.advertiserName}
                          </p>
                          <p className="mt-0.5 text-[11px] text-zinc-300">
                            Timer: {firstStep.banner.displayDurationSeconds}s · Redirect:{' '}
                            {firstStep.banner.destinationUrl}
                          </p>
                        </div>
                      )}
                      {firstStep?.kind === 'vast' && (
                        <div className="mt-2 rounded-lg border border-sky-500/30 bg-sky-500/10 p-3">
                          <p className="font-semibold text-sky-300">
                            VAST Video Preview: {firstStep.vast.vastAd.name}
                          </p>
                          <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-300">
                            {firstStep.vast.vastAd.vastTagUrl}
                          </p>
                        </div>
                      )}
                      {adPlan.unavailableReason && (
                        <p className="text-rose-400">{adPlan.unavailableReason}</p>
                      )}
                    </div>

                    <div className="border-t border-zinc-200 pt-3 dark:border-zinc-800">
                      <p className="mb-2 text-xs font-semibold">Poster Card Badges (Desktop &amp; Mobile)</p>
                      <ContentBadgeList badges={cardBadges.badges} />
                    </div>
                  </div>

                  {/* Watch Gate Preview */}
                  <div className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 p-6 text-center text-white">
                    <img
                      src={simMovie.posterUrl}
                      alt={simMovie.title}
                      className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover opacity-20 blur-2xl"
                    />
                    <div className="relative mx-auto max-w-sm space-y-4">
                      <div className="mx-auto inline-flex items-center gap-1.5 rounded-md bg-orange-500/15 px-3 py-1 text-xs font-semibold text-orange-400">
                        <Crown className="h-3.5 w-3.5" />
                        <span>{access.requiredPlanName}</span>
                      </div>
                      <h3 className="font-display text-xl font-bold">{unlockDraft.gateTitle}</h3>
                      <p className="text-xs text-zinc-300">{unlockDraft.gateDescription}</p>
                      {access.options.watchAd && (
                        <div className="space-y-1">
                          <span className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-xs font-semibold text-white">
                            <Play className="h-3.5 w-3.5 fill-current" />
                            {unlockDraft.watchAdButtonText}
                          </span>
                          <p className="text-[11px] text-zinc-400">{unlockDraft.watchAdSubtext}</p>
                        </div>
                      )}
                      {access.options.subscribe && (
                        <div className="space-y-1">
                          <span className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-600 bg-zinc-900/70 px-4 py-2 text-xs font-semibold">
                            View {access.requiredPlanName} Plan (
                            {access.requiredPlan
                              ? formatMonthlyPrice(
                                  access.requiredPlan.pricePerMonth,
                                  access.requiredPlan.currency
                                )
                              : '$9.99/mo'}
                            )
                          </span>
                          <p className="text-[11px] text-zinc-400">{unlockDraft.subscribeSubtext}</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}
        </div>
      )}

      {/* SUB-TAB 5: ANALYTICS & FUNNEL */}
      {subTab === 'analytics' && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-display text-base font-bold">
              Banner vs Video Unlock Performance &amp; Subscription Funnel
            </h3>
            <button
              type="button"
              onClick={exportFunnelCsv}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3.5 py-2 text-xs font-semibold hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              <Download className="h-3.5 w-3.5" />
              Export Funnel CSV
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {[
              { label: 'Gate Views', val: formatCompactNumber(analyticsStats.gateViews) },
              { label: 'Ad Starts', val: formatCompactNumber(analyticsStats.adStarts) },
              {
                label: 'Verified Banner Views',
                val: formatCompactNumber(analyticsStats.bannerCompletes),
              },
              {
                label: 'VAST Completions',
                val: formatCompactNumber(analyticsStats.vastCompletes),
              },
              {
                label: 'Ad Drop-off Rate',
                val: `${analyticsStats.dropOffPct}%`,
              },
            ].map((k) => (
              <div
                key={k.label}
                className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-[#13131c]"
              >
                <p className="text-xs text-zinc-500">{k.label}</p>
                <p className="font-mono-tabular mt-1 text-2xl font-bold">{k.val}</p>
              </div>
            ))}
          </div>

          {/* Banner vs Video Comparison SVG Bar Chart */}
          <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-[#13131c]">
            <h4 className="mb-3 font-display text-sm font-bold">
              Format Funnel Breakdown
            </h4>
            {(() => {
              const items = [
                { label: 'Gate Views', val: analyticsStats.gateViews, color: '#6366f1' },
                { label: 'Ad Starts', val: analyticsStats.adStarts, color: '#8b5cf6' },
                { label: 'Completed Unlocks', val: analyticsStats.unlockCompletes, color: '#10b981' },
                { label: 'Banner Verified', val: analyticsStats.bannerCompletes, color: '#d946ef' },
                { label: 'Banner Clicks', val: analyticsStats.bannerClicks, color: '#ec4899' },
                { label: 'Subscribe Clicks', val: analyticsStats.subClicks, color: '#f59e0b' },
                { label: 'Sub Conversions', val: analyticsStats.subConverts, color: '#22c55e' },
              ];
              const maxVal = Math.max(1, ...items.map((x) => x.val));
              return (
                <div className="space-y-2.5">
                  {items.map((row) => {
                    const widthPct = Math.round((row.val / maxVal) * 100);
                    return (
                      <div key={row.label} className="grid grid-cols-12 items-center gap-3 text-xs">
                        <span className="col-span-4 truncate font-medium sm:col-span-3">
                          {row.label}
                        </span>
                        <div className="col-span-6 h-3 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800 sm:col-span-8">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{ width: `${Math.max(2, widthPct)}%`, backgroundColor: row.color }}
                          />
                        </div>
                        <span className="font-mono-tabular col-span-2 text-right font-bold sm:col-span-1">
                          {row.val}
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* Per-Title Assignment Edit Modal */}
      <Modal
        open={Boolean(editingTitle)}
        onClose={() => setEditingTitle(null)}
        title={editingTitle ? `Access & Ad Assignment — ${editingTitle.title}` : 'Assign Ad'}
        maxWidthClass="max-w-3xl"
      >
        {editingTitle && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-500">
                  Access Mode
                </label>
                <select
                  value={editMode}
                  onChange={(e) => setEditMode(e.target.value as AccessMode)}
                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                >
                  <option value="inherit">Inherit Global</option>
                  <option value="free">Free</option>
                  <option value="ad_unlock">Watch Ad to Unlock Only</option>
                  <option value="subscription_or_ad">Subscribe or Watch Ad</option>
                  <option value="subscription">Paid Subscription Only</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-500">
                  Required Plan
                </label>
                <select
                  value={editPlanId}
                  onChange={(e) => setEditPlanId(e.target.value)}
                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                >
                  <option value="">None (Free / Ad-Only)</option>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({formatMonthlyPrice(p.pricePerMonth, p.currency)})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <AdPolicyEditor
              title="Title Default Advertisement Format"
              value={editPolicy}
              onChange={setEditPolicy}
              vastAds={vastAds}
              customAds={customAds}
            />

            {editingTitle.type === 'series' && (
              <div className="space-y-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold">Per-Season Overrides</span>
                  <div className="flex gap-1">
                    {['1', '2', '3', '4'].map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setActiveSeasonKey(s)}
                        className={`rounded px-2 py-0.5 text-xs font-semibold ${
                          activeSeasonKey === s
                            ? 'bg-violet-600 text-white'
                            : 'border border-zinc-300 dark:border-zinc-700'
                        }`}
                      >
                        S{s}
                      </button>
                    ))}
                  </div>
                </div>
                <AdPolicyEditor
                  compact
                  title={`Season ${activeSeasonKey} Ad Format`}
                  value={editSeasonAccess[activeSeasonKey]?.adPolicy}
                  onChange={(next) =>
                    setEditSeasonAccess((prev) => ({
                      ...prev,
                      [activeSeasonKey]: {
                        ...(prev[activeSeasonKey] ?? {}),
                        adPolicy: next,
                      },
                    }))
                  }
                  vastAds={vastAds}
                  customAds={customAds}
                />
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditingTitle(null)}
                className="rounded-lg border border-zinc-300 px-4 py-2 text-xs font-medium dark:border-zinc-700"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={savingTitle}
                onClick={async () => {
                  setSavingTitle(true);
                  try {
                    const chosenPlan = editPlanId ? plans.find((p) => p.id === editPlanId) : null;
                    await onSaveMovie({
                      ...editingTitle,
                      accessMode: editMode,
                      requiredPlanId: editPlanId || null,
                      requiredPlanName: chosenPlan?.name ?? null,
                      isPremium:
                        editMode === 'subscription' || editMode === 'subscription_or_ad',
                      adPolicy: editPolicy,
                      seasonAccess: editingTitle.type === 'series' ? editSeasonAccess : undefined,
                      updatedAt: new Date().toISOString(),
                    });
                    setEditingTitle(null);
                  } finally {
                    setSavingTitle(false);
                  }
                }}
                className="rounded-lg bg-violet-600 px-5 py-2 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
              >
                {savingTitle ? 'Saving...' : 'Save Assignment'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};
