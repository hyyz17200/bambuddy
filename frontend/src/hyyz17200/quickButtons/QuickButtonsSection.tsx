import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/Button';
import { Card, CardContent } from '../../components/Card';
import { Toggle } from '../../components/Toggle';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  ENHANCED_SETTINGS_QUERY_KEY,
  getEnhancedSettings,
  saveEnhancedSettingsSection,
  type EnhancedSettings,
} from '../enhancedSettingsApi';
import { normalizeQuickButtons, type QuickButtonSettings } from './quickButtonsSettings';

const SECTION = 'quick_buttons';
const K = 'hyyz17200.quickButtons';

/** Which shortcut buttons the frame shows. Saving updates the shared settings
 *  query, and EnhancedSettingsSync applies it at once. */
export function QuickButtonsSection() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const canEdit = hasPermission('settings:update');

  const { data, isLoading } = useQuery({ queryKey: ENHANCED_SETTINGS_QUERY_KEY, queryFn: getEnhancedSettings });
  const saved = normalizeQuickButtons(data?.[SECTION]);
  const [draft, setDraft] = useState<QuickButtonSettings | null>(null);
  const shown = draft ?? saved;
  const changed = shown.hide_bug_report !== saved.hide_bug_report || shown.select_button !== saved.select_button;

  const saveMutation = useMutation({
    mutationFn: (value: QuickButtonSettings) => saveEnhancedSettingsSection(SECTION, value),
    onSuccess: (value) => {
      queryClient.setQueryData<EnhancedSettings>(ENHANCED_SETTINGS_QUERY_KEY, (old) => ({ ...old, [SECTION]: value }));
      setDraft(null);
      showToast(t(`${K}.saved`), 'success');
    },
    onError: () => showToast(t(`${K}.saveFailed`), 'error'),
  });

  if (isLoading) return <p className="text-sm text-bambu-gray">{t('common.loading')}</p>;

  const row = (field: keyof QuickButtonSettings) => (
    <label className="flex items-center justify-between gap-4">
      <span>
        <span className="block text-sm text-white">{t(`${K}.${field}`)}</span>
        <span className="block text-xs text-bambu-gray">{t(`${K}.${field}Hint`)}</span>
      </span>
      <Toggle
        checked={shown[field]}
        disabled={!canEdit}
        onChange={(on: boolean) => setDraft({ ...shown, [field]: on })}
      />
    </label>
  );

  return (
    <div>
      <p className="text-sm text-bambu-gray mb-4">{t(`${K}.description`)}</p>

      <Card>
        <CardContent className="flex flex-col gap-5">
          {row('select_button')}
          {row('hide_bug_report')}

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
