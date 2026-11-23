import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/Button';
import { Card, CardContent } from '../../components/Card';
import { NumberInput } from '../../components/NumberInput';
import { Toggle } from '../../components/Toggle';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  ENHANCED_SETTINGS_QUERY_KEY,
  getEnhancedSettings,
  saveEnhancedSettingsSection,
  type EnhancedSettings,
} from '../enhancedSettingsApi';
import {
  MAX_CONCURRENT_RANGE,
  OBICO_SCHEDULER_DEFAULTS,
  OBICO_SCHEDULER_STATUS_KEY,
  normalizeObicoScheduler,
  type ObicoSchedulerSettings,
} from './obicoScheduler';
import { ObicoSchedulerStatus } from './ObicoSchedulerStatus';

const SECTION = 'obico';

const inputClass =
  'w-24 px-3 py-1.5 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-bambu-green disabled:opacity-50';

/** How Obico AI detection checks are scheduled. The interval itself stays in
 *  upstream's Failure Detection settings. */
export function ObicoSchedulerSection() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const canEdit = hasPermission('settings:update');

  const { data, isLoading } = useQuery({ queryKey: ENHANCED_SETTINGS_QUERY_KEY, queryFn: getEnhancedSettings });
  const saved = normalizeObicoScheduler(data?.[SECTION]);
  const [draft, setDraft] = useState<ObicoSchedulerSettings | null>(null);
  const shown = draft ?? saved;
  const changed = JSON.stringify(shown) !== JSON.stringify(saved);

  const saveMutation = useMutation({
    mutationFn: (value: ObicoSchedulerSettings) => saveEnhancedSettingsSection(SECTION, value),
    onSuccess: (value) => {
      queryClient.setQueryData<EnhancedSettings>(ENHANCED_SETTINGS_QUERY_KEY, (old) => ({ ...old, [SECTION]: value }));
      queryClient.invalidateQueries({ queryKey: OBICO_SCHEDULER_STATUS_KEY });
      setDraft(null);
      showToast(t('hyyz17200.obicoScheduler.saved'), 'success');
    },
    onError: () => showToast(t('hyyz17200.obicoScheduler.saveFailed'), 'error'),
  });

  if (isLoading) return <p className="text-sm text-bambu-gray">{t('common.loading')}</p>;

  return (
    <div>
      <p className="text-sm text-bambu-gray mb-4">{t('hyyz17200.obicoScheduler.description')}</p>

      <Card>
        <CardContent className="flex flex-col gap-5">
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm text-white">{t('hyyz17200.obicoScheduler.enabled')}</span>
              <span className="block text-xs text-bambu-gray">{t('hyyz17200.obicoScheduler.enabledHint')}</span>
            </span>
            <Toggle checked={shown.enabled} disabled={!canEdit} onChange={(enabled) => setDraft({ ...shown, enabled })} />
          </label>

          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm text-white">{t('hyyz17200.obicoScheduler.maxConcurrent')}</span>
              <span className="block text-xs text-bambu-gray">{t('hyyz17200.obicoScheduler.maxConcurrentHint')}</span>
            </span>
            <NumberInput
              value={shown.max_concurrent}
              min={MAX_CONCURRENT_RANGE.min}
              max={MAX_CONCURRENT_RANGE.max}
              disabled={!canEdit || !shown.enabled}
              onChange={(max_concurrent) => setDraft({ ...shown, max_concurrent })}
              aria-label={t('hyyz17200.obicoScheduler.maxConcurrent')}
              className={inputClass}
            />
          </label>

          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm text-white">{t('hyyz17200.obicoScheduler.skipPreparation')}</span>
              <span className="block text-xs text-bambu-gray">{t('hyyz17200.obicoScheduler.skipPreparationHint')}</span>
            </span>
            <Toggle
              checked={shown.skip_preparation}
              disabled={!canEdit}
              onChange={(skip_preparation) => setDraft({ ...shown, skip_preparation })}
            />
          </label>

          <ul className="text-xs text-bambu-gray list-disc pl-5 space-y-1">
            <li>{t('hyyz17200.obicoScheduler.ruleInterval')}</li>
            <li>{t('hyyz17200.obicoScheduler.ruleObico')}</li>
            <li>{t('hyyz17200.obicoScheduler.ruleSafety')}</li>
          </ul>

          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button disabled={!changed || saveMutation.isPending} onClick={() => saveMutation.mutate(shown)}>
                {t('hyyz17200.obicoScheduler.save')}
              </Button>
              <Button
                variant="secondary"
                disabled={saveMutation.isPending || JSON.stringify(shown) === JSON.stringify(OBICO_SCHEDULER_DEFAULTS)}
                onClick={() => setDraft(OBICO_SCHEDULER_DEFAULTS)}
              >
                {t('hyyz17200.obicoScheduler.reset')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {hasPermission('settings:read') && <ObicoSchedulerStatus />}
    </div>
  );
}
