import React, { useState } from 'react';
import {
  Film,
  Image as ImageIcon,
  Layers,
  Sparkles,
  Upload,
} from 'lucide-react';
import type {
  AdAssignmentMode,
  AdFormatType,
  AdPolicyConfig,
  AdRotationRef,
  CustomAdItem,
  InlineBannerAdConfig,
  VastAdItem,
} from '../../types/streaming';
import { uploadFileWithProgress } from '../../lib/firebase';
import { validateAdImageFile } from '../../utils/adEngine';

interface AdPolicyEditorProps {
  value: AdPolicyConfig | null | undefined;
  onChange: (next: AdPolicyConfig | null) => void;
  vastAds: VastAdItem[];
  customAds: CustomAdItem[];
  adminUid?: string;
  compact?: boolean;
  title?: string;
  showOverrideToggle?: boolean;
}

const DEFAULT_INLINE_BANNER: InlineBannerAdConfig = {
  imageUrl: '',
  advertiserName: '',
  destinationUrl: 'https://',
  displayDurationSeconds: 30,
  status: 'active',
  altText: '',
};

export const AdPolicyEditor: React.FC<AdPolicyEditorProps> = ({
  value,
  onChange,
  vastAds,
  customAds,
  compact = false,
  title = 'Advertisement Format & Assignment',
  showOverrideToggle = false,
}) => {
  const policy: AdPolicyConfig = value ?? {};
  const mode: AdAssignmentMode = policy.adFormatMode ?? 'auto';
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [bannerSourceMode, setBannerSourceMode] = useState<'existing' | 'inline'>(() =>
    policy.inlineBanner?.imageUrl ? 'inline' : policy.bannerAdId ? 'existing' : 'existing'
  );

  const update = (patch: Partial<AdPolicyConfig>) => {
    onChange({
      ...policy,
      ...patch,
    });
  };

  const inlineBanner = policy.inlineBanner ?? DEFAULT_INLINE_BANNER;

  const updateInlineBanner = (patch: Partial<InlineBannerAdConfig>) => {
    update({
      bannerAdId: null,
      inlineBanner: {
        ...inlineBanner,
        ...patch,
      },
    });
  };

  const handleBannerUpload = async (file: File) => {
    setUploadErr(null);
    const check = validateAdImageFile(file);
    if (!check.valid) {
      setUploadErr(check.error || 'Invalid image file.');
      return;
    }
    try {
      const path = `ads/inline-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const url = await uploadFileWithProgress(path, file, (pct) => setUploadPct(pct));
      updateInlineBanner({ imageUrl: url });
    } catch (err) {
      setUploadErr(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploadPct(null);
    }
  };

  const rotationRefs = policy.rotationAdRefs ?? [];
  const toggleRotationRef = (kind: AdFormatType, id: string, checked: boolean) => {
    const next: AdRotationRef[] = checked
      ? [...rotationRefs.filter((r) => !(r.kind === kind && r.id === id)), { kind, id }]
      : rotationRefs.filter((r) => !(r.kind === kind && r.id === id));
    update({ rotationAdRefs: next });
  };

  const formatButtons: { id: AdAssignmentMode; label: string; icon: React.ReactNode; desc: string }[] = [
    {
      id: 'auto',
      label: 'Automatic',
      icon: <Sparkles className="h-3.5 w-3.5" />,
      desc: 'Automatically picks an active video or banner ad.',
    },
    {
      id: 'vast',
      label: 'Video Ad (VAST)',
      icon: <Film className="h-3.5 w-3.5" />,
      desc: 'Strictly plays your selected VAST video ad or URL.',
    },
    {
      id: 'banner',
      label: 'Clickable Banner',
      icon: <ImageIcon className="h-3.5 w-3.5" />,
      desc: 'Strictly displays your timed clickable sponsor banner.',
    },
    {
      id: 'rotation',
      label: 'Multi-Ad Rotation',
      icon: <Layers className="h-3.5 w-3.5" />,
      desc: 'Rotates only within the specific ads you check below.',
    },
  ];

  return (
    <div
      className={`rounded-xl border border-zinc-200 bg-zinc-50/70 dark:border-zinc-800 dark:bg-zinc-900/40 ${
        compact ? 'p-3 space-y-3' : 'p-4 space-y-4'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="font-display text-xs font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-200">
            {title}
          </h4>
          <p className="text-[11px] text-zinc-500">
            Manual selections always play the exact ad you assign. Rotation only runs when chosen.
          </p>
        </div>

        <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium">
          <input
            type="checkbox"
            checked={policy.active !== false}
            onChange={(e) => update({ active: e.target.checked })}
            className="accent-violet-600"
          />
          <span>Policy Active</span>
        </label>
      </div>

      {showOverrideToggle && (
        <label className="flex items-center gap-2 text-xs font-medium text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={Boolean(policy.overrideGlobal)}
            onChange={(e) => update({ overrideGlobal: e.target.checked })}
            className="accent-violet-600"
          />
          Override parent/global advertisement settings for this level
        </label>
      )}

      {/* Format Mode Grid */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {formatButtons.map((btn) => {
          const active = mode === btn.id;
          return (
            <button
              key={btn.id}
              type="button"
              onClick={() => update({ adFormatMode: btn.id })}
              className={`rounded-lg border p-2.5 text-left transition ${
                active
                  ? 'border-violet-500 bg-violet-500/15 text-violet-950 dark:text-white'
                  : 'border-zinc-200 bg-white hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-950/60'
              }`}
            >
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <span className={active ? 'text-violet-400' : 'text-zinc-400'}>{btn.icon}</span>
                <span>{btn.label}</span>
              </div>
              {!compact && (
                <p className="mt-1 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
                  {btn.desc}
                </p>
              )}
            </button>
          );
        })}
      </div>

      {/* Mode A: VAST Video Ad Configuration */}
      {mode === 'vast' && (
        <div className="space-y-3 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950/60">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[11px] font-medium text-zinc-500">
                Existing VAST Ad Campaign
              </label>
              <select
                value={policy.vastAdId ?? ''}
                onChange={(e) =>
                  update({
                    vastAdId: e.target.value || null,
                    ...(e.target.value ? { customVastUrl: '' } : {}),
                  })
                }
                className="w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="">-- Select a VAST Ad or enter custom URL --</option>
                {vastAds.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} ({v.type} · {v.status})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium text-zinc-500">
                Skip Settings (seconds, 0 = Non-skippable)
              </label>
              <input
                type="number"
                min={0}
                max={60}
                value={policy.skipAfterSeconds ?? 0}
                onChange={(e) => update({ skipAfterSeconds: Math.max(0, Number(e.target.value)) })}
                className="w-full rounded-lg border border-zinc-300 bg-transparent px-2.5 py-2 text-xs tabular-nums dark:border-zinc-700"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium text-zinc-500">
              Or Custom VAST XML Tag URL for this title
            </label>
            <input
              type="url"
              value={policy.customVastUrl ?? ''}
              onChange={(e) =>
                update({
                  customVastUrl: e.target.value,
                  ...(e.target.value.trim() ? { vastAdId: null } : {}),
                })
              }
              placeholder="https://pubads.g.doubleclick.net/gampad/ads?..."
              className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 font-mono text-xs dark:border-zinc-700"
            />
          </div>
        </div>
      )}

      {/* Mode B: Clickable Banner Ad Configuration */}
      {mode === 'banner' && (
        <div className="space-y-3 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950/60">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setBannerSourceMode('existing');
                update({ inlineBanner: null });
              }}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
                bannerSourceMode === 'existing'
                  ? 'bg-violet-600 text-white'
                  : 'border border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300'
              }`}
            >
              Choose Existing Banner Ad
            </button>
            <button
              type="button"
              onClick={() => {
                setBannerSourceMode('inline');
                if (!policy.inlineBanner) {
                  updateInlineBanner(DEFAULT_INLINE_BANNER);
                }
              }}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
                bannerSourceMode === 'inline'
                  ? 'bg-violet-600 text-white'
                  : 'border border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300'
              }`}
            >
              Custom Inline Banner (Per-Title Upload / URL)
            </button>
          </div>

          {bannerSourceMode === 'existing' ? (
            <div>
              <label className="mb-1 block text-[11px] font-medium text-zinc-500">
                Select Existing Clickable Banner Ad
              </label>
              <select
                value={policy.bannerAdId ?? ''}
                onChange={(e) =>
                  update({ bannerAdId: e.target.value || null, inlineBanner: null })
                }
                className="w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="">-- Select Custom Banner Ad --</option>
                {customAds.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.advertiserName ? ` (${c.advertiserName})` : ''} ·{' '}
                    {c.displayDurationSeconds || 30}s · {c.status}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-zinc-500">
                    Advertiser Name
                  </label>
                  <input
                    type="text"
                    value={inlineBanner.advertiserName}
                    onChange={(e) => updateInlineBanner({ advertiserName: e.target.value })}
                    placeholder="e.g. Tokyo Otaku Box"
                    className="w-full rounded-lg border border-zinc-300 bg-transparent px-2.5 py-2 text-xs dark:border-zinc-700"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-zinc-500">
                    Destination Website URL (new tab)
                  </label>
                  <input
                    type="url"
                    value={inlineBanner.destinationUrl}
                    onChange={(e) => updateInlineBanner({ destinationUrl: e.target.value })}
                    placeholder="https://advertiser.example.com"
                    className="w-full rounded-lg border border-zinc-300 bg-transparent px-2.5 py-2 text-xs dark:border-zinc-700"
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="sm:col-span-2">
                  <label className="mb-1 block text-[11px] font-medium text-zinc-500">
                    Banner Image URL or Upload
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={inlineBanner.imageUrl}
                      onChange={(e) => updateInlineBanner({ imageUrl: e.target.value })}
                      placeholder="https://... or /src/assets/..."
                      className="flex-1 rounded-lg border border-zinc-300 bg-transparent px-2.5 py-2 text-xs dark:border-zinc-700"
                    />
                    <label className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-zinc-300 px-3 py-2 text-xs font-semibold hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
                      <Upload className="h-3.5 w-3.5" />
                      {uploadPct !== null ? `${uploadPct}%` : 'Upload'}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/gif"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void handleBannerUpload(f);
                        }}
                      />
                    </label>
                  </div>
                  {uploadErr && <p className="mt-1 text-[11px] text-rose-500">{uploadErr}</p>}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-zinc-500">
                      Duration (sec)
                    </label>
                    <input
                      type="number"
                      min={3}
                      max={120}
                      value={inlineBanner.displayDurationSeconds || 30}
                      onChange={(e) =>
                        updateInlineBanner({
                          displayDurationSeconds: Math.max(3, Number(e.target.value) || 30),
                        })
                      }
                      className="w-full rounded-lg border border-zinc-300 bg-transparent px-2.5 py-2 text-xs tabular-nums dark:border-zinc-700"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-zinc-500">
                      Status
                    </label>
                    <select
                      value={inlineBanner.status}
                      onChange={(e) =>
                        updateInlineBanner({ status: e.target.value as 'active' | 'inactive' })
                      }
                      className="w-full rounded-lg border border-zinc-300 bg-white px-2 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                    >
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </div>
                </div>
              </div>

              {inlineBanner.imageUrl && (
                <div className="overflow-hidden rounded-lg border border-zinc-200 bg-zinc-950 p-2 dark:border-zinc-800">
                  <img
                    src={inlineBanner.imageUrl}
                    alt={inlineBanner.advertiserName || 'Banner preview'}
                    className="h-24 w-full rounded object-cover"
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Mode C: Explicit Multi-Ad Rotation */}
      {mode === 'rotation' && (
        <div className="space-y-3 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950/60">
          <p className="text-[11px] text-zinc-500">
            Check the Video (VAST) and Clickable Banner ads included in this title&apos;s rotation pool ({rotationRefs.length} selected):
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1.5 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">
                VAST Video Ads
              </p>
              <div className="max-h-36 space-y-1 overflow-y-auto rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
                {vastAds.length === 0 ? (
                  <p className="text-[11px] text-zinc-500">No VAST ads available.</p>
                ) : (
                  vastAds.map((v) => {
                    const checked = rotationRefs.some((r) => r.kind === 'vast' && r.id === v.id);
                    return (
                      <label key={v.id} className="flex cursor-pointer items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => toggleRotationRef('vast', v.id, e.target.checked)}
                          className="accent-violet-600"
                        />
                        <span className="truncate">{v.name}</span>
                        <span className="ml-auto text-[10px] text-zinc-400">{v.status}</span>
                      </label>
                    );
                  })
                )}
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">
                Clickable Banner Ads
              </p>
              <div className="max-h-36 space-y-1 overflow-y-auto rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
                {customAds.length === 0 ? (
                  <p className="text-[11px] text-zinc-500">No banner ads available.</p>
                ) : (
                  customAds.map((c) => {
                    const checked = rotationRefs.some((r) => r.kind === 'banner' && r.id === c.id);
                    return (
                      <label key={c.id} className="flex cursor-pointer items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => toggleRotationRef('banner', c.id, e.target.checked)}
                          className="accent-violet-600"
                        />
                        <span className="truncate">{c.name}</span>
                        <span className="ml-auto text-[10px] text-zinc-400">
                          {c.displayDurationSeconds || 30}s
                        </span>
                      </label>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Shared Unlock Policy Controls */}
      <div className="grid gap-3 pt-1 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-[11px] font-medium text-zinc-500">
            Ads Required to Unlock
          </label>
          <input
            type="number"
            min={1}
            max={3}
            value={policy.adsRequired ?? 1}
            onChange={(e) =>
              update({ adsRequired: Math.max(1, Math.min(3, Number(e.target.value) || 1)) })
            }
            className="w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs tabular-nums dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-medium text-zinc-500">
            Unlock Validity
          </label>
          <select
            value={policy.validityMode ?? 'hours'}
            onChange={(e) => update({ validityMode: e.target.value as 'hours' | 'session' })}
            className="w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="hours">Fixed Hours</option>
            <option value="session">Browser Session</option>
          </select>
        </div>

        {(policy.validityMode ?? 'hours') === 'hours' && (
          <div>
            <label className="mb-1 block text-[11px] font-medium text-zinc-500">
              Validity Duration (hours)
            </label>
            <input
              type="number"
              min={1}
              max={168}
              value={policy.validityHours ?? 24}
              onChange={(e) =>
                update({ validityHours: Math.max(1, Number(e.target.value) || 24) })
              }
              className="w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs tabular-nums dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>
        )}
      </div>
    </div>
  );
};
