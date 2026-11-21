import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { Button } from '../components/Button';
import { Card, CardContent } from '../components/Card';
import { ConfirmModal } from '../components/ConfirmModal';
import { Toggle } from '../components/Toggle';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import {
  ENHANCED_SETTINGS_QUERY_KEY,
  getEnhancedSettings,
  saveEnhancedSettingsSection,
  type EnhancedSettings,
} from './enhancedSettingsApi';
import { normalizeSdReuse, SD_REUSE_CACHE_FILE, type SdReuseSettings } from './sdReuseSettings';

const SECTION = 'sd_reuse';
const K = 'hyyz17200.sdReuse';

/** Print the file a printer printed last from its SD card instead of uploading
 *  it again. The backend does the work; this edits the switch, and turning it
 *  on asks the user to accept the power-cycle risk first. */
export function SdReuseSection() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const canEdit = hasPermission('settings:update');

  const { data, isLoading } = useQuery({ queryKey: ENHANCED_SETTINGS_QUERY_KEY, queryFn: getEnhancedSettings });
  const saved = normalizeSdReuse(data?.[SECTION]);
  const [draft, setDraft] = useState<SdReuseSettings | null>(null);
  const [confirming, setConfirming] = useState(false);
  const shown = draft ?? saved;
  const changed = shown.enabled !== saved.enabled;

  const saveMutation = useMutation({
    mutationFn: (value: SdReuseSettings) => saveEnhancedSettingsSection(SECTION, value),
    onSuccess: (value) => {
      queryClient.setQueryData<EnhancedSettings>(ENHANCED_SETTINGS_QUERY_KEY, (old) => ({ ...old, [SECTION]: value }));
      setDraft(null);
      showToast(t(`${K}.saved`), 'success');
    },
    onError: () => showToast(t(`${K}.saveFailed`), 'error'),
  });

  const toggle = (enabled: boolean) => {
    if (enabled) setConfirming(true);
    else setDraft({ enabled: false });
  };

  if (isLoading) return <p className="text-sm text-bambu-gray">{t('common.loading')}</p>;

  return (
    <div>
      <p className="text-sm text-bambu-gray mb-4">{t(`${K}.description`)}</p>

      <Card>
        <CardContent className="flex flex-col gap-5">
          <div className="flex gap-3 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-yellow-400" />
            <p className="text-xs text-white">{t(`${K}.risk`)}</p>
          </div>

          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm text-white">{t(`${K}.enabled`)}</span>
              <span className="block text-xs text-bambu-gray">{t(`${K}.enabledHint`)}</span>
            </span>
            <Toggle checked={shown.enabled} disabled={!canEdit} onChange={toggle} />
          </label>

          <ul className="list-disc pl-5 text-xs text-bambu-gray space-y-1">
            <li>{t(`${K}.ruleSame`)}</li>
            <li>{t(`${K}.ruleLast`)}</li>
            <li>{t(`${K}.ruleRestart`)}</li>
            <li>{t(`${K}.ruleFile`, { file: SD_REUSE_CACHE_FILE })}</li>
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

      {confirming && (
        <ConfirmModal
          title={t(`${K}.confirmTitle`)}
          message={t(`${K}.risk`)}
          confirmText={t(`${K}.confirmAccept`)}
          variant="warning"
          onConfirm={() => {
            setDraft({ enabled: true });
            setConfirming(false);
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
