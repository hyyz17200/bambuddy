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
import { normalizeCameraLed, OFF_DELAY_RANGE, type CameraLedSettings } from './cameraLedSettings';

const SECTION = 'camera_led';
const K = 'hyyz17200.cameraLed';

const inputClass =
  'w-24 px-3 py-1.5 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-bambu-green disabled:opacity-50';

/** Keep the chamber light on for the whole print and off once idle. The
 *  backend switches the lights; this only edits the settings. */
export function CameraLedSection() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const canEdit = hasPermission('settings:update');

  const { data, isLoading } = useQuery({ queryKey: ENHANCED_SETTINGS_QUERY_KEY, queryFn: getEnhancedSettings });
  const saved = normalizeCameraLed(data?.[SECTION]);
  const [draft, setDraft] = useState<CameraLedSettings | null>(null);
  const shown = draft ?? saved;
  const changed = JSON.stringify(shown) !== JSON.stringify(saved);

  const saveMutation = useMutation({
    mutationFn: (value: CameraLedSettings) => saveEnhancedSettingsSection(SECTION, value),
    onSuccess: (value) => {
      queryClient.setQueryData<EnhancedSettings>(ENHANCED_SETTINGS_QUERY_KEY, (old) => ({ ...old, [SECTION]: value }));
      setDraft(null);
      showToast(t(`${K}.saved`), 'success');
    },
    onError: () => showToast(t(`${K}.saveFailed`), 'error'),
  });

  if (isLoading) return <p className="text-sm text-bambu-gray">{t('common.loading')}</p>;

  const active = shown.enabled || shown.obico_force;

  return (
    <div>
      <p className="text-sm text-bambu-gray mb-4">{t(`${K}.description`)}</p>

      <Card>
        <CardContent className="flex flex-col gap-5">
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm text-white">{t(`${K}.enabled`)}</span>
              <span className="block text-xs text-bambu-gray">{t(`${K}.enabledHint`)}</span>
            </span>
            <Toggle
              checked={shown.enabled}
              disabled={!canEdit}
              onChange={(enabled) => setDraft({ ...shown, enabled })}
            />
          </label>

          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm text-white">{t(`${K}.obicoForce`)}</span>
              <span className="block text-xs text-bambu-gray">{t(`${K}.obicoForceHint`)}</span>
            </span>
            <Toggle
              checked={shown.obico_force}
              disabled={!canEdit}
              onChange={(obico_force) => setDraft({ ...shown, obico_force })}
            />
          </label>

          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm text-white">{t(`${K}.offDelay`)}</span>
              <span className="block text-xs text-bambu-gray">{t(`${K}.offDelayHint`)}</span>
            </span>
            <NumberInput
              value={shown.off_delay_seconds}
              min={OFF_DELAY_RANGE.min}
              max={OFF_DELAY_RANGE.max}
              disabled={!canEdit || !active}
              onChange={(off_delay_seconds) => setDraft({ ...shown, off_delay_seconds })}
              aria-label={t(`${K}.offDelay`)}
              className={inputClass}
            />
          </label>

          <ul className="list-disc pl-5 text-xs text-bambu-gray space-y-1">
            <li>{t(`${K}.ruleVerify`)}</li>
            <li>{t(`${K}.ruleManual`)}</li>
            <li>{t(`${K}.ruleCamera`)}</li>
            <li>{t(`${K}.ruleIdle`)}</li>
          </ul>

          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button disabled={!changed || saveMutation.isPending} onClick={() => saveMutation.mutate(shown)}>
                {t(`${K}.save`)}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
