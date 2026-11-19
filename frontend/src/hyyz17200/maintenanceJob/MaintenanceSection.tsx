import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import type { LibraryFolderTree } from '../../api/client';
import { Button } from '../../components/Button';
import { Card, CardContent } from '../../components/Card';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  ENHANCED_SETTINGS_QUERY_KEY,
  getEnhancedSettings,
  saveEnhancedSettingsSection,
  type EnhancedSettings,
} from '../enhancedSettingsApi';
import { MAINTENANCE_SECTION, normalizeMaintenance, type MaintenanceSettings } from './maintenanceApi';

/** Every folder as "Parent / Child", in tree order. */
function flatten(folders: LibraryFolderTree[], prefix = ''): { id: number; label: string }[] {
  return folders.flatMap((folder) => {
    const label = prefix ? `${prefix} / ${folder.name}` : folder.name;
    return [{ id: folder.id, label }, ...flatten(folder.children ?? [], label)];
  });
}

/** Which library folder the card menu's "Send maintenance G-code" offers. */
export function MaintenanceSection() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const canEdit = hasPermission('settings:update');

  const { data, isLoading } = useQuery({ queryKey: ENHANCED_SETTINGS_QUERY_KEY, queryFn: getEnhancedSettings });
  const { data: folders } = useQuery({ queryKey: ['hyyz17200', 'maintenance-folders'], queryFn: api.getLibraryFolders });
  const saved = normalizeMaintenance(data?.[MAINTENANCE_SECTION]);
  const [draft, setDraft] = useState<MaintenanceSettings | null>(null);
  const shown = draft ?? saved;
  const changed = shown.folder_id !== saved.folder_id;
  const options = flatten(folders ?? []);
  const missing = shown.folder_id !== null && folders !== undefined && !options.some((o) => o.id === shown.folder_id);

  const saveMutation = useMutation({
    mutationFn: (value: MaintenanceSettings) => saveEnhancedSettingsSection(MAINTENANCE_SECTION, value),
    onSuccess: (value) => {
      queryClient.setQueryData<EnhancedSettings>(ENHANCED_SETTINGS_QUERY_KEY, (old) => ({
        ...old,
        [MAINTENANCE_SECTION]: value,
      }));
      setDraft(null);
      showToast(t('hyyz17200.maintenance.settings.saved'), 'success');
    },
    onError: () => showToast(t('hyyz17200.maintenance.settings.saveFailed'), 'error'),
  });

  if (isLoading) return <p className="text-sm text-bambu-gray">{t('common.loading')}</p>;

  return (
    <div>
      <p className="text-sm text-bambu-gray mb-4">{t('hyyz17200.maintenance.settings.description')}</p>

      <Card>
        <CardContent className="flex flex-col gap-5">
          <label className="flex flex-col gap-2">
            <span>
              <span className="block text-sm text-white">{t('hyyz17200.maintenance.settings.folder')}</span>
              <span className="block text-xs text-bambu-gray">{t('hyyz17200.maintenance.settings.folderHint')}</span>
            </span>
            <select
              value={shown.folder_id ?? ''}
              disabled={!canEdit}
              onChange={(e) => setDraft({ folder_id: e.target.value ? Number(e.target.value) : null })}
              className="w-full max-w-md px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-bambu-green disabled:opacity-50"
            >
              <option value="">{t('hyyz17200.maintenance.settings.none')}</option>
              {missing && <option value={shown.folder_id ?? ''}>{t('hyyz17200.maintenance.settings.missing')}</option>}
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <ul className="list-disc pl-5 text-xs text-bambu-gray space-y-1">
            <li>{t('hyyz17200.maintenance.settings.noteBypass')}</li>
            <li>{t('hyyz17200.maintenance.settings.notePlate')}</li>
            <li>{t('hyyz17200.maintenance.settings.noteRisk')}</li>
            <li>{t('hyyz17200.maintenance.settings.noteStats')}</li>
          </ul>

          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button disabled={!changed || saveMutation.isPending} onClick={() => saveMutation.mutate(shown)}>
                {t('hyyz17200.maintenance.settings.save')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
