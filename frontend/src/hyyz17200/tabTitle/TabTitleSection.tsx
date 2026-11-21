import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
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
import { APP_TITLE } from './ownTitle';
import {
  COUNT_KEYS,
  COUNT_NAME_KEYS,
  DEFAULT_LABELS,
  LABEL_MAX,
  TAB_TITLE_DEFAULTS,
  formatTabTitle,
  normalizeTabTitle,
  type CountKey,
  type StateCounts,
  type TabTitleSettings,
} from './tabTitleSettings';

const SECTION = 'tab_title';

const inputClass =
  'px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded-md text-white text-sm focus:outline-none focus:border-bambu-green disabled:opacity-50';

// The preview's numbers: made up, so every count shows something.
const SAMPLE: StateCounts = { printing: 12, paused: 1, finished: 5, idle: 3, error: 2, offline: 4, total: 25 };

/** The tab title override: which printer-state counts the browser tab shows,
 *  in what order, with what label. TabTitleSync does the showing. */
export function TabTitleSection() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const canEdit = hasPermission('settings:update');

  const { data, isLoading } = useQuery({ queryKey: ENHANCED_SETTINGS_QUERY_KEY, queryFn: getEnhancedSettings });
  const saved = normalizeTabTitle(data?.[SECTION]);
  const [draft, setDraft] = useState<TabTitleSettings | null>(null);
  const shown = draft ?? saved;
  const changed = JSON.stringify(shown) !== JSON.stringify(saved);

  const saveMutation = useMutation({
    mutationFn: (value: TabTitleSettings) => saveEnhancedSettingsSection(SECTION, value),
    onSuccess: (value) => {
      queryClient.setQueryData<EnhancedSettings>(ENHANCED_SETTINGS_QUERY_KEY, (old) => ({ ...old, [SECTION]: value }));
      setDraft(null);
      showToast(t('hyyz17200.tabTitle.saved'), 'success');
    },
    onError: () => showToast(t('hyyz17200.tabTitle.saveFailed'), 'error'),
  });

  if (isLoading) return <p className="text-sm text-bambu-gray">{t('common.loading')}</p>;

  const edit = (patch: Partial<TabTitleSettings>) => setDraft({ ...shown, ...patch });
  const setItems = (items: TabTitleSettings['items']) => edit({ items });
  const move = (index: number, by: -1 | 1) => {
    const items = [...shown.items];
    [items[index], items[index + by]] = [items[index + by], items[index]];
    setItems(items);
  };
  const unused = COUNT_KEYS.filter((key) => !shown.items.some((item) => item.key === key));
  const name = (key: CountKey) => t(COUNT_NAME_KEYS[key]);

  return (
    <div>
      <p className="text-sm text-bambu-gray mb-4">{t('hyyz17200.tabTitle.description')}</p>

      <Card>
        <CardContent className="flex flex-col gap-5">
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm text-white">{t('hyyz17200.tabTitle.enabled')}</span>
              <span className="block text-xs text-bambu-gray">{t('hyyz17200.tabTitle.enabledHint')}</span>
            </span>
            <Toggle checked={shown.enabled} disabled={!canEdit} onChange={(enabled) => edit({ enabled })} />
          </label>

          <div>
            <p className="text-sm text-white mb-1">{t('hyyz17200.tabTitle.items')}</p>
            <p className="text-xs text-bambu-gray mb-2">{t('hyyz17200.tabTitle.itemsHint')}</p>
            <div className="flex flex-col gap-1.5">
              {shown.items.map((item, index) => (
                <div key={item.key} className="flex items-center gap-2" data-testid={`tab-title-item-${item.key}`}>
                  <input
                    type="text"
                    value={item.label}
                    maxLength={LABEL_MAX}
                    disabled={!canEdit}
                    placeholder={DEFAULT_LABELS[item.key]}
                    onChange={(e) =>
                      setItems(shown.items.map((other, i) => (i === index ? { ...other, label: e.target.value } : other)))
                    }
                    aria-label={t('hyyz17200.tabTitle.label', { name: name(item.key) })}
                    className={`${inputClass} w-20 text-center`}
                  />
                  <span className="flex-1 min-w-0 text-sm text-white truncate">{name(item.key)}</span>
                  {canEdit && (
                    <span className="flex items-center gap-0.5 text-bambu-gray">
                      <button
                        type="button"
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                        title={t('hyyz17200.tabTitle.moveUp')}
                        aria-label={t('hyyz17200.tabTitle.moveUp')}
                        className="p-1 hover:text-white disabled:opacity-30"
                      >
                        <ArrowUp className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        disabled={index === shown.items.length - 1}
                        onClick={() => move(index, 1)}
                        title={t('hyyz17200.tabTitle.moveDown')}
                        aria-label={t('hyyz17200.tabTitle.moveDown')}
                        className="p-1 hover:text-white disabled:opacity-30"
                      >
                        <ArrowDown className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setItems(shown.items.filter((_, i) => i !== index))}
                        title={t('hyyz17200.tabTitle.remove')}
                        aria-label={t('hyyz17200.tabTitle.remove')}
                        className="p-1 hover:text-red-400"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </span>
                  )}
                </div>
              ))}
              {shown.items.length === 0 && <p className="text-xs text-bambu-gray">{t('hyyz17200.tabTitle.empty')}</p>}
            </div>
            {canEdit && unused.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3">
                {unused.map((key) => (
                  <Button
                    key={key}
                    variant="secondary"
                    size="sm"
                    onClick={() => setItems([...shown.items, { key, label: DEFAULT_LABELS[key] }])}
                  >
                    <Plus className="w-4 h-4" />
                    {name(key)}
                  </Button>
                ))}
              </div>
            )}
          </div>

          <label className="flex items-center justify-between gap-4">
            <span className="block text-sm text-white">{t('hyyz17200.tabTitle.hideZero')}</span>
            <Toggle checked={shown.hide_zero} disabled={!canEdit} onChange={(hide_zero) => edit({ hide_zero })} />
          </label>
          <label className="flex items-center justify-between gap-4">
            <span className="block text-sm text-white">{t('hyyz17200.tabTitle.showAppName')}</span>
            <Toggle
              checked={shown.show_app_name}
              disabled={!canEdit}
              onChange={(show_app_name) => edit({ show_app_name })}
            />
          </label>

          <div>
            <p className="text-xs text-bambu-gray mb-1">{t('hyyz17200.tabTitle.preview')}</p>
            <p className="px-3 py-2 rounded-md bg-bambu-dark text-sm text-white font-mono break-all" data-testid="tab-title-preview">
              {formatTabTitle(shown, SAMPLE, APP_TITLE)}
            </p>
          </div>

          <ul className="list-disc pl-5 text-xs text-bambu-gray space-y-1">
            <li>{t('hyyz17200.tabTitle.ruleCounts')}</li>
            <li>{t('hyyz17200.tabTitle.ruleUpstream')}</li>
            <li>{t('hyyz17200.tabTitle.ruleGlobal')}</li>
          </ul>

          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button disabled={!changed || saveMutation.isPending} onClick={() => saveMutation.mutate(shown)}>
                {t('hyyz17200.tabTitle.save')}
              </Button>
              <Button
                variant="secondary"
                disabled={saveMutation.isPending || JSON.stringify(shown.items) === JSON.stringify(TAB_TITLE_DEFAULTS.items)}
                onClick={() => edit({ items: TAB_TITLE_DEFAULTS.items })}
              >
                {t('hyyz17200.tabTitle.reset')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
