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
import {
  MAX_COLUMNS_RANGE,
  MIN_WIDTH_RANGE,
  WIDE_GRID_DEFAULTS,
  WIDE_GRID_KEYS,
  normalizeWideGrid,
  type GridLimit,
  type WideGridKey,
  type WideGridSettings,
} from './wideGrid';

const SECTION = 'wide_grid';

const inputClass =
  'w-24 px-3 py-1.5 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-bambu-green disabled:opacity-50';

/** How many printer cards and camera tiles share a row on a wide screen. */
export function WideGridSection() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const canEdit = hasPermission('settings:update');

  const { data, isLoading } = useQuery({ queryKey: ENHANCED_SETTINGS_QUERY_KEY, queryFn: getEnhancedSettings });
  const saved = normalizeWideGrid(data?.[SECTION]);
  const [draft, setDraft] = useState<WideGridSettings | null>(null);
  const shown = draft ?? saved;
  const changed = JSON.stringify(shown) !== JSON.stringify(saved);

  const saveMutation = useMutation({
    mutationFn: (value: WideGridSettings) => saveEnhancedSettingsSection(SECTION, value),
    onSuccess: (value) => {
      queryClient.setQueryData<EnhancedSettings>(ENHANCED_SETTINGS_QUERY_KEY, (old) => ({ ...old, [SECTION]: value }));
      setDraft(null);
      showToast(t('hyyz17200.wideGrid.saved'), 'success');
    },
    onError: () => showToast(t('hyyz17200.wideGrid.saveFailed'), 'error'),
  });

  const setGrid = (key: WideGridKey, patch: Partial<GridLimit>) =>
    setDraft({ ...shown, [key]: { ...shown[key], ...patch } });

  if (isLoading) return <p className="text-sm text-bambu-gray">{t('common.loading')}</p>;

  return (
    <div>
      <p className="text-sm text-bambu-gray mb-4">{t('hyyz17200.wideGrid.description')}</p>

      <Card>
        <CardContent className="flex flex-col gap-5">
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm text-white">{t('hyyz17200.wideGrid.enabled')}</span>
              <span className="block text-xs text-bambu-gray">{t('hyyz17200.wideGrid.enabledHint')}</span>
            </span>
            <Toggle
              checked={shown.enabled}
              disabled={!canEdit}
              onChange={(enabled) => setDraft({ ...shown, enabled })}
            />
          </label>

          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-bambu-gray">
                <th className="font-normal pb-2" />
                <th className="font-normal pb-2">{t('hyyz17200.wideGrid.maxColumns')}</th>
                <th className="font-normal pb-2">{t('hyyz17200.wideGrid.minWidth')}</th>
              </tr>
            </thead>
            <tbody>
              {WIDE_GRID_KEYS.map((key) => (
                <tr key={key} className="border-t border-bambu-dark-tertiary">
                  <th scope="row" className="text-left font-normal text-white py-2 pr-4">
                    {t(`hyyz17200.wideGrid.grids.${key}`)}
                  </th>
                  <td className="py-2 pr-4">
                    <NumberInput
                      value={shown[key].max_columns}
                      min={MAX_COLUMNS_RANGE.min}
                      max={MAX_COLUMNS_RANGE.max}
                      disabled={!canEdit || !shown.enabled}
                      onChange={(max_columns) => setGrid(key, { max_columns })}
                      aria-label={`${t(`hyyz17200.wideGrid.grids.${key}`)} ${t('hyyz17200.wideGrid.maxColumns')}`}
                      className={inputClass}
                    />
                  </td>
                  <td className="py-2">
                    <NumberInput
                      value={shown[key].min_width}
                      min={MIN_WIDTH_RANGE.min}
                      max={MIN_WIDTH_RANGE.max}
                      disabled={!canEdit || !shown.enabled}
                      onChange={(min_width) => setGrid(key, { min_width })}
                      aria-label={`${t(`hyyz17200.wideGrid.grids.${key}`)} ${t('hyyz17200.wideGrid.minWidth')}`}
                      className={inputClass}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="text-xs text-bambu-gray">{t('hyyz17200.wideGrid.minWidthHint')}</p>

          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button disabled={!changed || saveMutation.isPending} onClick={() => saveMutation.mutate(shown)}>
                {t('hyyz17200.wideGrid.save')}
              </Button>
              <Button
                variant="secondary"
                disabled={saveMutation.isPending || JSON.stringify(shown) === JSON.stringify(WIDE_GRID_DEFAULTS)}
                onClick={() => setDraft(WIDE_GRID_DEFAULTS)}
              >
                {t('hyyz17200.wideGrid.reset')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
