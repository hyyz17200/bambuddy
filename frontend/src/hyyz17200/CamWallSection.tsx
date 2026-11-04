import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/Button';
import { Card, CardContent } from '../components/Card';
import { NumberInput } from '../components/NumberInput';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import {
  CAM_WALL_DEFAULTS,
  CONCURRENCY_RANGE,
  MAX_LIVE_LIMIT_RANGE,
  applyCamWall,
  normalizeCamWall,
  type CamWallSettings,
} from './camWallSettings';
import {
  ENHANCED_SETTINGS_QUERY_KEY,
  getEnhancedSettings,
  saveEnhancedSettingsSection,
  type EnhancedSettings,
} from './enhancedSettingsApi';

const SECTION = 'cam_wall';

const inputClass =
  'w-24 px-3 py-1.5 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-bambu-green disabled:opacity-50';

/** How many camera wall snapshots the server captures at once, and how many
 *  live streams the wall may be set to. */
export function CamWallSection() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const canEdit = hasPermission('settings:update');

  const { data, isLoading } = useQuery({ queryKey: ENHANCED_SETTINGS_QUERY_KEY, queryFn: getEnhancedSettings });
  const saved = normalizeCamWall(data?.[SECTION]);
  const [draft, setDraft] = useState<CamWallSettings | null>(null);
  const shown = draft ?? saved;
  const changed = JSON.stringify(shown) !== JSON.stringify(saved);

  const saveMutation = useMutation({
    mutationFn: (value: CamWallSettings) => saveEnhancedSettingsSection(SECTION, value),
    onSuccess: (value) => {
      queryClient.setQueryData<EnhancedSettings>(ENHANCED_SETTINGS_QUERY_KEY, (old) => ({ ...old, [SECTION]: value }));
      applyCamWall(value);
      setDraft(null);
      showToast(t('hyyz17200.camWall.settings.saved'), 'success');
    },
    onError: () => showToast(t('hyyz17200.camWall.settings.saveFailed'), 'error'),
  });

  if (isLoading) return <p className="text-sm text-bambu-gray">{t('common.loading')}</p>;

  return (
    <div>
      <p className="text-sm text-bambu-gray mb-4">{t('hyyz17200.camWall.settings.description')}</p>

      <Card>
        <CardContent className="flex flex-col gap-5">
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm text-white">{t('hyyz17200.camWall.settings.concurrency')}</span>
              <span className="block text-xs text-bambu-gray">{t('hyyz17200.camWall.settings.concurrencyHint')}</span>
            </span>
            <NumberInput
              value={shown.max_concurrent_captures}
              min={CONCURRENCY_RANGE.min}
              max={CONCURRENCY_RANGE.max}
              disabled={!canEdit}
              onChange={(max_concurrent_captures) => setDraft({ ...shown, max_concurrent_captures })}
              aria-label={t('hyyz17200.camWall.settings.concurrency')}
              className={inputClass}
            />
          </label>

          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm text-white">{t('hyyz17200.camWall.settings.maxLiveLimit')}</span>
              <span className="block text-xs text-bambu-gray">{t('hyyz17200.camWall.settings.maxLiveLimitHint')}</span>
            </span>
            <NumberInput
              value={shown.max_live_limit}
              min={MAX_LIVE_LIMIT_RANGE.min}
              max={MAX_LIVE_LIMIT_RANGE.max}
              disabled={!canEdit}
              onChange={(max_live_limit) => setDraft({ ...shown, max_live_limit })}
              aria-label={t('hyyz17200.camWall.settings.maxLiveLimit')}
              className={inputClass}
            />
          </label>

          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button disabled={!changed || saveMutation.isPending} onClick={() => saveMutation.mutate(shown)}>
                {t('hyyz17200.camWall.settings.save')}
              </Button>
              <Button
                variant="secondary"
                disabled={saveMutation.isPending || JSON.stringify(shown) === JSON.stringify(CAM_WALL_DEFAULTS)}
                onClick={() => setDraft(CAM_WALL_DEFAULTS)}
              >
                {t('hyyz17200.camWall.settings.reset')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
