import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/Button';
import { Card, CardContent } from '../components/Card';
import { NumberInput } from '../components/NumberInput';
import { Toggle } from '../components/Toggle';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import {
  ENHANCED_SETTINGS_QUERY_KEY,
  getEnhancedSettings,
  saveEnhancedSettingsSection,
  type EnhancedSettings,
} from './enhancedSettingsApi';
import { IDLE_MINUTES_RANGE, normalizeAutoUnload, type AutoUnloadSettings } from './autoUnloadSettings';

const SECTION = 'auto_unload';

const inputClass =
  'w-24 px-3 py-1.5 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-bambu-green disabled:opacity-50';

/** Unload the filament back into the AMS once a printer has sat idle a while.
 *  The backend does the work; this only edits the two settings. */
export function AutoUnloadSection() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const canEdit = hasPermission('settings:update');

  const { data, isLoading } = useQuery({ queryKey: ENHANCED_SETTINGS_QUERY_KEY, queryFn: getEnhancedSettings });
  const saved = normalizeAutoUnload(data?.[SECTION]);
  const [draft, setDraft] = useState<AutoUnloadSettings | null>(null);
  const shown = draft ?? saved;
  const changed = JSON.stringify(shown) !== JSON.stringify(saved);

  const saveMutation = useMutation({
    mutationFn: (value: AutoUnloadSettings) => saveEnhancedSettingsSection(SECTION, value),
    onSuccess: (value) => {
      queryClient.setQueryData<EnhancedSettings>(ENHANCED_SETTINGS_QUERY_KEY, (old) => ({ ...old, [SECTION]: value }));
      setDraft(null);
      showToast(t('hyyz17200.autoUnload.saved'), 'success');
    },
    onError: () => showToast(t('hyyz17200.autoUnload.saveFailed'), 'error'),
  });

  if (isLoading) return <p className="text-sm text-bambu-gray">{t('common.loading')}</p>;

  return (
    <div>
      <p className="text-sm text-bambu-gray mb-4">{t('hyyz17200.autoUnload.description')}</p>

      <Card>
        <CardContent className="flex flex-col gap-5">
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm text-white">{t('hyyz17200.autoUnload.enabled')}</span>
              <span className="block text-xs text-bambu-gray">{t('hyyz17200.autoUnload.enabledHint')}</span>
            </span>
            <Toggle checked={shown.enabled} disabled={!canEdit} onChange={(enabled) => setDraft({ ...shown, enabled })} />
          </label>

          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm text-white">{t('hyyz17200.autoUnload.idleMinutes')}</span>
              <span className="block text-xs text-bambu-gray">{t('hyyz17200.autoUnload.idleMinutesHint')}</span>
            </span>
            <NumberInput
              value={shown.idle_minutes}
              min={IDLE_MINUTES_RANGE.min}
              max={IDLE_MINUTES_RANGE.max}
              disabled={!canEdit}
              onChange={(idle_minutes) => setDraft({ ...shown, idle_minutes })}
              aria-label={t('hyyz17200.autoUnload.idleMinutes')}
              className={inputClass}
            />
          </label>

          <ul className="list-disc pl-5 text-xs text-bambu-gray space-y-1">
            <li>{t('hyyz17200.autoUnload.ruleSkipped')}</li>
            <li>{t('hyyz17200.autoUnload.ruleRefresh')}</li>
            <li>{t('hyyz17200.autoUnload.ruleQueue')}</li>
            <li>{t('hyyz17200.autoUnload.rulePower')}</li>
          </ul>

          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button disabled={!changed || saveMutation.isPending} onClick={() => saveMutation.mutate(shown)}>
                {t('hyyz17200.autoUnload.save')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
