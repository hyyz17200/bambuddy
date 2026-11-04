import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, ArrowLeftRight, Plus, Trash2 } from 'lucide-react';
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
import {
  QUICK_COLOR_DEFAULTS,
  QUICK_COLOR_LIMITS,
  isHex6,
  normalizeQuickColors,
  type QuickColor,
  type QuickColorSettings,
} from './quickColors';

const SECTION = 'quick_colors';
type ListKey = 'basic' | 'extended';
const LISTS: ListKey[] = ['basic', 'extended'];

const inputClass =
  'px-2 py-1 bg-bambu-dark border rounded-md text-white text-sm focus:outline-none focus:border-bambu-green disabled:opacity-50';

/** The quick colour swatches of the AMS slot dialog and the spool form. */
export function QuickColorsSection() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const canEdit = hasPermission('settings:update');

  const { data, isLoading } = useQuery({ queryKey: ENHANCED_SETTINGS_QUERY_KEY, queryFn: getEnhancedSettings });
  const saved = normalizeQuickColors(data?.[SECTION]);
  const [draft, setDraft] = useState<QuickColorSettings | null>(null);
  const shown = draft ?? saved;
  const changed = JSON.stringify(shown) !== JSON.stringify(saved);

  const allHex = [...shown.basic, ...shown.extended].map((c) => c.hex.toUpperCase());
  const isDuplicate = (hex: string) => allHex.filter((h) => h === hex.toUpperCase()).length > 1;
  const isBadName = (name: string) => !name.trim() || name.trim().length > QUICK_COLOR_LIMITS.name;
  const valid =
    [...shown.basic, ...shown.extended].every((c) => isHex6(c.hex) && !isBadName(c.name) && !isDuplicate(c.hex)) &&
    shown.basic.length <= QUICK_COLOR_LIMITS.basic &&
    shown.extended.length <= QUICK_COLOR_LIMITS.extended;

  const saveMutation = useMutation({
    mutationFn: (value: QuickColorSettings) => saveEnhancedSettingsSection(SECTION, value),
    onSuccess: (value) => {
      queryClient.setQueryData<EnhancedSettings>(ENHANCED_SETTINGS_QUERY_KEY, (old) => ({ ...old, [SECTION]: value }));
      setDraft(null);
      showToast(t('hyyz17200.quickColors.saved'), 'success');
    },
    onError: () => showToast(t('hyyz17200.quickColors.saveFailed'), 'error'),
  });

  const setList = (key: ListKey, list: QuickColor[]) => setDraft({ ...shown, [key]: list });
  const editColor = (key: ListKey, index: number, patch: Partial<QuickColor>) =>
    setList(key, shown[key].map((c, i) => (i === index ? { ...c, ...patch } : c)));
  const moveColor = (key: ListKey, index: number, delta: number) => {
    const list = [...shown[key]];
    [list[index], list[index + delta]] = [list[index + delta], list[index]];
    setList(key, list);
  };
  const switchList = (key: ListKey, index: number) => {
    const other: ListKey = key === 'basic' ? 'extended' : 'basic';
    setDraft({
      ...shown,
      [key]: shown[key].filter((_, i) => i !== index),
      [other]: [...shown[other], shown[key][index]],
    });
  };
  const addColor = (key: ListKey) => {
    // A colour not yet in either list, so the new row starts out valid.
    let n = 0x808080;
    while (allHex.includes(n.toString(16).toUpperCase().padStart(6, '0'))) n = (n + 0x111111) % 0x1000000;
    setList(key, [...shown[key], { name: t('hyyz17200.quickColors.newColor'), hex: n.toString(16).toUpperCase().padStart(6, '0') }]);
  };

  if (isLoading) return <p className="text-sm text-bambu-gray">{t('common.loading')}</p>;

  const editable = canEdit && shown.customized;

  return (
    <div>
      <p className="text-sm text-bambu-gray mb-4">{t('hyyz17200.quickColors.description')}</p>

      <Card>
        <CardContent className="flex flex-col gap-5">
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm text-white">{t('hyyz17200.quickColors.customized')}</span>
              <span className="block text-xs text-bambu-gray">{t('hyyz17200.quickColors.customizedHint')}</span>
            </span>
            <Toggle
              checked={shown.customized}
              disabled={!canEdit}
              onChange={(customized) => setDraft({ ...shown, customized })}
            />
          </label>

          {LISTS.map((key) => (
            <div key={key}>
              <div className="flex items-center justify-between mb-2">
                <span>
                  <span className="block text-sm text-white">
                    {t(`hyyz17200.quickColors.${key}`)} ({shown[key].length}/{QUICK_COLOR_LIMITS[key]})
                  </span>
                  <span className="block text-xs text-bambu-gray">{t(`hyyz17200.quickColors.${key}Hint`)}</span>
                </span>
                {editable && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={shown[key].length >= QUICK_COLOR_LIMITS[key]}
                    onClick={() => addColor(key)}
                  >
                    <Plus className="w-4 h-4" />
                    {t('hyyz17200.quickColors.add')}
                  </Button>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                {shown[key].map((color, index) => {
                  const hexOk = isHex6(color.hex) && !isDuplicate(color.hex);
                  return (
                    <div key={index} className="flex items-center gap-2" data-testid={`quick-color-${key}-${index}`}>
                      <input
                        type="color"
                        value={isHex6(color.hex) ? `#${color.hex}` : '#000000'}
                        disabled={!editable}
                        onChange={(e) => editColor(key, index, { hex: e.target.value.slice(1).toUpperCase() })}
                        aria-label={t('hyyz17200.quickColors.pick')}
                        className="w-8 h-8 rounded-md cursor-pointer border border-bambu-dark-tertiary bg-transparent disabled:cursor-default"
                      />
                      <input
                        type="text"
                        value={color.name}
                        disabled={!editable}
                        maxLength={QUICK_COLOR_LIMITS.name}
                        onChange={(e) => editColor(key, index, { name: e.target.value })}
                        aria-label={t('hyyz17200.quickColors.name')}
                        className={`${inputClass} flex-1 min-w-0 ${isBadName(color.name) ? 'border-red-500' : 'border-bambu-dark-tertiary'}`}
                      />
                      <input
                        type="text"
                        value={color.hex}
                        disabled={!editable}
                        onChange={(e) =>
                          editColor(key, index, {
                            hex: e.target.value.replace(/[^0-9A-Fa-f]/g, '').slice(0, 6).toUpperCase(),
                          })
                        }
                        aria-label={t('hyyz17200.quickColors.hex')}
                        title={isDuplicate(color.hex) ? t('hyyz17200.quickColors.duplicate') : undefined}
                        className={`${inputClass} w-24 font-mono ${hexOk ? 'border-bambu-dark-tertiary' : 'border-red-500'}`}
                      />
                      {editable && (
                        <span className="flex items-center gap-0.5 text-bambu-gray">
                          <button
                            type="button"
                            disabled={index === 0}
                            onClick={() => moveColor(key, index, -1)}
                            title={t('hyyz17200.quickColors.moveUp')}
                            className="p-1 hover:text-white disabled:opacity-30"
                          >
                            <ArrowUp className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            disabled={index === shown[key].length - 1}
                            onClick={() => moveColor(key, index, 1)}
                            title={t('hyyz17200.quickColors.moveDown')}
                            className="p-1 hover:text-white disabled:opacity-30"
                          >
                            <ArrowDown className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => switchList(key, index)}
                            title={t(`hyyz17200.quickColors.${key === 'basic' ? 'toExtended' : 'toBasic'}`)}
                            className="p-1 hover:text-white"
                          >
                            <ArrowLeftRight className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setList(key, shown[key].filter((_, i) => i !== index))}
                            title={t('hyyz17200.quickColors.remove')}
                            className="p-1 hover:text-red-400"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </span>
                      )}
                    </div>
                  );
                })}
                {shown[key].length === 0 && (
                  <p className="text-xs text-bambu-gray">{t('hyyz17200.quickColors.empty')}</p>
                )}
              </div>
            </div>
          ))}

          {!valid && <p className="text-xs text-red-400">{t('hyyz17200.quickColors.invalid')}</p>}

          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={!changed || !valid || saveMutation.isPending}
                onClick={() => saveMutation.mutate(shown)}
              >
                {t('hyyz17200.quickColors.save')}
              </Button>
              <Button
                variant="secondary"
                disabled={saveMutation.isPending || JSON.stringify(shown) === JSON.stringify(QUICK_COLOR_DEFAULTS)}
                onClick={() => setDraft(QUICK_COLOR_DEFAULTS)}
              >
                {t('hyyz17200.quickColors.reset')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
