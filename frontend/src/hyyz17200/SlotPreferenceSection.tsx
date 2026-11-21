import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/Button';
import { Card, CardContent } from '../components/Card';
import { Toggle } from '../components/Toggle';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import {
  ENHANCED_SETTINGS_QUERY_KEY,
  getEnhancedSettings,
  saveEnhancedSettingsSection,
  type EnhancedSettings,
} from './enhancedSettingsApi';
import { normalizeSlotPreference, type SlotPreferenceSettings } from './slotPreferenceSettings';

const SECTION = 'slot_preference';

/** Among identical spools, use the slot already loaded, else the one loaded
 *  last. The backend does the work; this only edits the switch. */
export function SlotPreferenceSection() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const canEdit = hasPermission('settings:update');

  const { data, isLoading } = useQuery({ queryKey: ENHANCED_SETTINGS_QUERY_KEY, queryFn: getEnhancedSettings });
  const saved = normalizeSlotPreference(data?.[SECTION]);
  const [draft, setDraft] = useState<SlotPreferenceSettings | null>(null);
  const shown = draft ?? saved;
  const changed = shown.enabled !== saved.enabled;

  const saveMutation = useMutation({
    mutationFn: (value: SlotPreferenceSettings) => saveEnhancedSettingsSection(SECTION, value),
    onSuccess: (value) => {
      queryClient.setQueryData<EnhancedSettings>(ENHANCED_SETTINGS_QUERY_KEY, (old) => ({ ...old, [SECTION]: value }));
      setDraft(null);
      showToast(t('hyyz17200.slotPreference.saved'), 'success');
    },
    onError: () => showToast(t('hyyz17200.slotPreference.saveFailed'), 'error'),
  });

  if (isLoading) return <p className="text-sm text-bambu-gray">{t('common.loading')}</p>;

  return (
    <div>
      <p className="text-sm text-bambu-gray mb-4">{t('hyyz17200.slotPreference.description')}</p>

      <Card>
        <CardContent className="flex flex-col gap-5">
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm text-white">{t('hyyz17200.slotPreference.enabled')}</span>
              <span className="block text-xs text-bambu-gray">{t('hyyz17200.slotPreference.enabledHint')}</span>
            </span>
            <Toggle checked={shown.enabled} disabled={!canEdit} onChange={(enabled) => setDraft({ enabled })} />
          </label>

          <ul className="list-disc pl-5 text-xs text-bambu-gray space-y-1">
            <li>{t('hyyz17200.slotPreference.ruleOrder')}</li>
            <li>{t('hyyz17200.slotPreference.ruleSameSpool')}</li>
            <li>{t('hyyz17200.slotPreference.ruleWhere')}</li>
            <li>{t('hyyz17200.slotPreference.rulePreferLowest')}</li>
          </ul>

          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button disabled={!changed || saveMutation.isPending} onClick={() => saveMutation.mutate(shown)}>
                {t('hyyz17200.slotPreference.save')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
