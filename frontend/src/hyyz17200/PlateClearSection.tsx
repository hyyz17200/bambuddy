import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { api } from '../api/client';
import type { Printer } from '../api/client';
import { Button } from '../components/Button';
import { Card, CardContent } from '../components/Card';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { runBatch } from './bulkActions/runBatch';
import { PLATE_CLEAR_CHOICES, choiceOf, overrideOf, plateClearApplies, type PlateClearChoice } from './plateClear';

const K = 'hyyz17200.plateClear';

const selectClass =
  'px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-bambu-green disabled:opacity-50';

/** Upstream's plate-clear confirmation for the whole farm on one page: the app
 *  setting, and each printer's own setting, which is otherwise only in Edit
 *  Printer one printer at a time. Writes go through upstream's routes. */
export function PlateClearSection() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const canEditSetting = hasPermission('settings:update');
  const canEditPrinters = hasPermission('printers:update');

  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const { data: printers, isLoading } = useQuery({ queryKey: ['printers'], queryFn: api.getPrinters });
  const setting = settings?.require_plate_clear ?? false;

  const [search, setSearch] = useState('');
  const [model, setModel] = useState('');
  const [location, setLocation] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  const models = useMemo(() => [...new Set((printers ?? []).map((p) => p.model ?? ''))].sort(), [printers]);
  const locations = useMemo(() => [...new Set((printers ?? []).map((p) => p.location ?? ''))].sort(), [printers]);
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (printers ?? [])
      .filter((p) => !needle || p.name.toLowerCase().includes(needle))
      .filter((p) => !model || (p.model ?? '') === model)
      .filter((p) => !location || (p.location ?? '') === location)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [printers, search, model, location]);

  const holding = (printers ?? []).filter((p) => plateClearApplies(p.require_plate_clear, setting)).length;
  const shownSelected = shown.filter((p) => selected.has(p.id));
  const allShownSelected = shown.length > 0 && shownSelected.length === shown.length;

  const settingMutation = useMutation({
    mutationFn: (value: boolean) => api.updateSettings({ require_plate_clear: value }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      showToast(t(`${K}.saved`), 'success');
    },
    onError: () => showToast(t(`${K}.saveFailed`), 'error'),
  });

  const apply = async (targets: Printer[], choice: PlateClearChoice) => {
    const value = overrideOf(choice);
    const changing = targets.filter((p) => (p.require_plate_clear ?? null) !== value);
    if (!changing.length) return;
    setSaving(true);
    const done = await runBatch(changing, (p) => api.updatePrinter(p.id, { require_plate_clear: value }));
    setSaving(false);
    await queryClient.invalidateQueries({ queryKey: ['printers'] });
    if (done.failed.length) {
      showToast(
        t(`${K}.someFailed`, { count: done.failed.length, names: done.failed.map((f) => f.printer.name).join(', ') }),
        'error',
      );
    } else {
      showToast(t(`${K}.applied`, { count: done.ok.length }), 'success');
    }
  };

  const toggle = (id: number) =>
    setSelected((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected((old) => {
      const next = new Set(old);
      for (const p of shown) {
        if (allShownSelected) next.delete(p.id);
        else next.add(p.id);
      }
      return next;
    });

  if (isLoading) return <p className="text-sm text-bambu-gray">{t('common.loading')}</p>;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-bambu-gray">{t(`${K}.description`)}</p>

      <Card>
        <CardContent className="flex flex-col gap-2">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 accent-bambu-green"
              checked={setting}
              disabled={!canEditSetting || settingMutation.isPending || !settings}
              onChange={(e) => settingMutation.mutate(e.target.checked)}
            />
            <span>
              <span className="block text-sm text-white">{t(`${K}.appSetting`)}</span>
              <span className="block text-xs text-bambu-gray">{t(`${K}.appSettingHint`)}</span>
            </span>
          </label>
          <p className="text-xs text-bambu-gray">
            {t(`${K}.summary`, { holding, total: printers?.length ?? 0 })}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t(`${K}.search`)}
              aria-label={t(`${K}.search`)}
              className={`${selectClass} w-full sm:w-48`}
            />
            <select value={model} onChange={(e) => setModel(e.target.value)} aria-label={t(`${K}.model`)} className={selectClass}>
              <option value="">{t(`${K}.allModels`)}</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m || t(`${K}.none`)}
                </option>
              ))}
            </select>
            <select
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              aria-label={t(`${K}.location`)}
              className={selectClass}
            >
              <option value="">{t(`${K}.allLocations`)}</option>
              {locations.map((l) => (
                <option key={l} value={l}>
                  {l || t(`${K}.none`)}
                </option>
              ))}
            </select>
          </div>

          {canEditPrinters && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-bambu-gray">{t(`${K}.setSelected`, { count: shownSelected.length })}</span>
              {PLATE_CLEAR_CHOICES.map((choice) => (
                <Button
                  key={choice}
                  size="sm"
                  variant="secondary"
                  disabled={saving || shownSelected.length === 0}
                  onClick={() => apply(shownSelected, choice)}
                >
                  {t(`${K}.choice.${choice}`)}
                </Button>
              ))}
              {saving && <Loader2 className="h-4 w-4 animate-spin text-bambu-gray" />}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-bambu-gray">
                  <th className="w-8 py-2">
                    <input
                      type="checkbox"
                      className="accent-bambu-green"
                      aria-label={t(`${K}.selectAll`)}
                      checked={allShownSelected}
                      disabled={!canEditPrinters || shown.length === 0}
                      onChange={toggleAll}
                    />
                  </th>
                  <th className="py-2 pr-3">{t(`${K}.name`)}</th>
                  <th className="py-2 pr-3">{t(`${K}.model`)}</th>
                  <th className="py-2 pr-3">{t(`${K}.location`)}</th>
                  <th className="py-2 pr-3">{t(`${K}.own`)}</th>
                  <th className="py-2">{t(`${K}.effective`)}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-bambu-dark-tertiary">
                {shown.map((p) => {
                  const applies = plateClearApplies(p.require_plate_clear, setting);
                  return (
                    <tr key={p.id}>
                      <td className="py-1.5">
                        <input
                          type="checkbox"
                          className="accent-bambu-green"
                          aria-label={p.name}
                          checked={selected.has(p.id)}
                          disabled={!canEditPrinters}
                          onChange={() => toggle(p.id)}
                        />
                      </td>
                      <td className="py-1.5 pr-3 text-white">{p.name}</td>
                      <td className="py-1.5 pr-3 text-bambu-gray">{p.model ?? ''}</td>
                      <td className="py-1.5 pr-3 text-bambu-gray">{p.location ?? ''}</td>
                      <td className="py-1.5 pr-3">
                        <select
                          value={choiceOf(p.require_plate_clear)}
                          disabled={!canEditPrinters || saving}
                          aria-label={t(`${K}.ownFor`, { name: p.name })}
                          onChange={(e) => apply([p], e.target.value as PlateClearChoice)}
                          className={selectClass}
                        >
                          {PLATE_CLEAR_CHOICES.map((choice) => (
                            <option key={choice} value={choice}>
                              {t(`${K}.choice.${choice}`)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className={`py-1.5 ${applies ? 'text-yellow-400' : 'text-bambu-gray'}`}>
                        {t(applies ? `${K}.applies` : `${K}.notApplies`)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {shown.length === 0 && <p className="py-3 text-sm text-bambu-gray">{t(`${K}.noPrinters`)}</p>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
