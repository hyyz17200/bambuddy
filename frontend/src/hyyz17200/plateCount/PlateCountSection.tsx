import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { api } from '../../api/client';
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
import {
  configurePlates,
  getPlateOverview,
  MAX_PLATES,
  normalizePlateCount,
  PLATE_COUNT_SECTION,
  PLATES_QUERY_KEY,
  type PlateConfigChange,
  type PlateCountSettings,
  type PrinterPlates,
} from './api';

const K = 'hyyz17200.plateCount.settings';

const inputClass =
  'px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-bambu-green disabled:opacity-50';

function validCapacity(text: string): number | null {
  const value = Number(text);
  return text.trim() !== '' && Number.isInteger(value) && value >= 1 && value <= MAX_PLATES ? value : null;
}

/** The plate count: the switch and default capacity, then each printer that
 *  swaps its own plates, which can be switched off or given its own capacity. */
export function PlateCountSection() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const canEditSetting = hasPermission('settings:update');
  const canEditPrinters = hasPermission('printers:update');

  const { data: settingsData, isLoading } = useQuery({ queryKey: ENHANCED_SETTINGS_QUERY_KEY, queryFn: getEnhancedSettings });
  const saved = normalizePlateCount(settingsData?.[PLATE_COUNT_SECTION]);
  const [draft, setDraft] = useState<{ enabled: boolean; capacity: string } | null>(null);
  const shown = draft ?? { enabled: saved.enabled, capacity: String(saved.default_capacity) };
  const draftCapacity = validCapacity(shown.capacity);
  const changed = shown.enabled !== saved.enabled || draftCapacity !== saved.default_capacity;

  const { data: overview } = useQuery({ queryKey: PLATES_QUERY_KEY, queryFn: getPlateOverview, refetchInterval: 15_000 });
  const { data: printers } = useQuery({ queryKey: ['printers'], queryFn: api.getPrinters });

  const [search, setSearch] = useState('');
  const [model, setModel] = useState('');
  const [location, setLocation] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkCapacity, setBulkCapacity] = useState('');
  const [saving, setSaving] = useState(false);
  // Own capacity being typed, per printer, until it is saved.
  const [typing, setTyping] = useState<Record<number, string>>({});

  const saveMutation = useMutation({
    mutationFn: (value: PlateCountSettings) => saveEnhancedSettingsSection(PLATE_COUNT_SECTION, value),
    onSuccess: (value) => {
      queryClient.setQueryData<EnhancedSettings>(ENHANCED_SETTINGS_QUERY_KEY, (old) => ({
        ...old,
        [PLATE_COUNT_SECTION]: value,
      }));
      setDraft(null);
      showToast(t(`${K}.saved`), 'success');
      // The backend starts counting within a few seconds.
      setTimeout(() => queryClient.invalidateQueries({ queryKey: PLATES_QUERY_KEY }), 12_000);
    },
    onError: () => showToast(t(`${K}.saveFailed`), 'error'),
  });

  const plates = useMemo(() => new Map(overview?.printers.map((p) => [p.printer_id, p])), [overview]);
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (printers ?? [])
      .filter((p) => plates.has(p.id))
      .filter((p) => !needle || p.name.toLowerCase().includes(needle))
      .filter((p) => !model || (p.model ?? '') === model)
      .filter((p) => !location || (p.location ?? '') === location)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((p) => ({ printer: p, plates: plates.get(p.id)! }));
  }, [printers, plates, search, model, location]);
  const models = useMemo(() => [...new Set((printers ?? []).map((p) => p.model ?? ''))].sort(), [printers]);
  const locations = useMemo(() => [...new Set((printers ?? []).map((p) => p.location ?? ''))].sort(), [printers]);

  const applicableRows = rows.filter((r) => r.plates.applicable);
  const shownSelected = applicableRows.filter((r) => selected.has(r.printer.id));
  const allSelected = applicableRows.length > 0 && shownSelected.length === applicableRows.length;
  const countedTotal = overview?.printers.filter((p) => p.counted).length ?? 0;
  const applicableTotal = overview?.printers.filter((p) => p.applicable).length ?? 0;

  const configure = async (ids: number[], change: PlateConfigChange) => {
    if (!ids.length) return;
    setSaving(true);
    try {
      await configurePlates(ids, change);
      showToast(t(`${K}.applied`, { count: ids.length }), 'success');
    } catch {
      showToast(t(`${K}.saveFailed`), 'error');
    } finally {
      setSaving(false);
      await queryClient.invalidateQueries({ queryKey: PLATES_QUERY_KEY });
    }
  };

  const saveOwnCapacity = (entry: PrinterPlates) => {
    const text = typing[entry.printer_id];
    if (text === undefined) return;
    setTyping((old) => {
      const next = { ...old };
      delete next[entry.printer_id];
      return next;
    });
    if (text.trim() === '') {
      if (entry.capacity !== null) configure([entry.printer_id], { default_capacity: true });
      return;
    }
    const value = validCapacity(text);
    if (value === null) {
      showToast(t(`${K}.badCapacity`, { max: MAX_PLATES }), 'error');
      return;
    }
    if (value !== entry.capacity) configure([entry.printer_id], { capacity: value });
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
      for (const r of applicableRows) {
        if (allSelected) next.delete(r.printer.id);
        else next.add(r.printer.id);
      }
      return next;
    });

  if (isLoading) return <p className="text-sm text-bambu-gray">{t('common.loading')}</p>;

  const selectedIds = shownSelected.map((r) => r.printer.id);
  const bulkValue = validCapacity(bulkCapacity);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-bambu-gray">{t(`${K}.description`)}</p>

      <Card>
        <CardContent className="flex flex-col gap-5">
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm text-white">{t(`${K}.enabled`)}</span>
              <span className="block text-xs text-bambu-gray">{t(`${K}.enabledHint`)}</span>
            </span>
            <Toggle
              checked={shown.enabled}
              disabled={!canEditSetting}
              onChange={(enabled) => setDraft({ ...shown, enabled })}
            />
          </label>

          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm text-white">{t(`${K}.defaultCapacity`)}</span>
              <span className="block text-xs text-bambu-gray">{t(`${K}.defaultCapacityHint`)}</span>
            </span>
            <input
              type="number"
              min={1}
              max={MAX_PLATES}
              value={shown.capacity}
              disabled={!canEditSetting}
              onChange={(e) => setDraft({ ...shown, capacity: e.target.value })}
              aria-label={t(`${K}.defaultCapacity`)}
              className={`${inputClass} w-20`}
            />
          </label>

          <ul className="list-disc pl-5 text-xs text-bambu-gray space-y-1">
            <li>{t(`${K}.ruleWho`)}</li>
            <li>{t(`${K}.ruleCount`)}</li>
            <li>{t(`${K}.ruleHold`)}</li>
            <li>{t(`${K}.ruleRefill`)}</li>
            <li>{t(`${K}.ruleMaintenance`)}</li>
            <li>{t(`${K}.ruleOutside`)}</li>
          </ul>

          {canEditSetting && (
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={!changed || draftCapacity === null || saveMutation.isPending}
                onClick={() =>
                  draftCapacity !== null && saveMutation.mutate({ enabled: shown.enabled, default_capacity: draftCapacity })
                }
              >
                {t(`${K}.save`)}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-bambu-gray">
            {overview?.enabled
              ? t(`${K}.summary`, { counted: countedTotal, applicable: applicableTotal, total: overview.printers.length })
              : t(`${K}.summaryOff`, { applicable: applicableTotal, total: overview?.printers.length ?? 0 })}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('hyyz17200.plateClear.search')}
              aria-label={t('hyyz17200.plateClear.search')}
              className={`${inputClass} w-full sm:w-48`}
            />
            <select value={model} onChange={(e) => setModel(e.target.value)} aria-label={t('hyyz17200.plateClear.model')} className={inputClass}>
              <option value="">{t('hyyz17200.plateClear.allModels')}</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m || t('hyyz17200.plateClear.none')}
                </option>
              ))}
            </select>
            <select
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              aria-label={t('hyyz17200.plateClear.location')}
              className={inputClass}
            >
              <option value="">{t('hyyz17200.plateClear.allLocations')}</option>
              {locations.map((l) => (
                <option key={l} value={l}>
                  {l || t('hyyz17200.plateClear.none')}
                </option>
              ))}
            </select>
          </div>

          {canEditPrinters && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-bambu-gray">{t(`${K}.setSelected`, { count: selectedIds.length })}</span>
              <Button size="sm" variant="secondary" disabled={saving || !selectedIds.length} onClick={() => configure(selectedIds, { disabled: false })}>
                {t(`${K}.on`)}
              </Button>
              <Button size="sm" variant="secondary" disabled={saving || !selectedIds.length} onClick={() => configure(selectedIds, { disabled: true })}>
                {t(`${K}.off`)}
              </Button>
              <input
                type="number"
                min={1}
                max={MAX_PLATES}
                value={bulkCapacity}
                onChange={(e) => setBulkCapacity(e.target.value)}
                placeholder={t(`${K}.capacity`)}
                aria-label={t(`${K}.bulkCapacity`)}
                className={`${inputClass} w-24`}
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={saving || !selectedIds.length || bulkValue === null}
                onClick={() => bulkValue !== null && configure(selectedIds, { capacity: bulkValue })}
              >
                {t(`${K}.setCapacity`)}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={saving || !selectedIds.length}
                onClick={() => configure(selectedIds, { default_capacity: true })}
              >
                {t(`${K}.useDefault`)}
              </Button>
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
                      aria-label={t('hyyz17200.plateClear.selectAll')}
                      checked={allSelected}
                      disabled={!canEditPrinters || applicableRows.length === 0}
                      onChange={toggleAll}
                    />
                  </th>
                  <th className="py-2 pr-3">{t('hyyz17200.plateClear.name')}</th>
                  <th className="py-2 pr-3">{t('hyyz17200.plateClear.model')}</th>
                  <th className="py-2 pr-3">{t('hyyz17200.plateClear.location')}</th>
                  <th className="py-2 pr-3">{t(`${K}.counting`)}</th>
                  <th className="py-2 pr-3">{t(`${K}.capacity`)}</th>
                  <th className="py-2">{t(`${K}.plates`)}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-bambu-dark-tertiary">
                {rows.map(({ printer: p, plates: entry }) => {
                  if (!entry.applicable) {
                    return (
                      <tr key={p.id} className="text-bambu-gray">
                        <td className="py-1.5" />
                        <td className="py-1.5 pr-3">{p.name}</td>
                        <td className="py-1.5 pr-3">{p.model ?? ''}</td>
                        <td className="py-1.5 pr-3">{p.location ?? ''}</td>
                        <td className="py-1.5 pr-3" colSpan={3}>
                          {t(`${K}.bypassed`)}
                        </td>
                      </tr>
                    );
                  }
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
                          value={entry.disabled ? 'off' : 'on'}
                          disabled={!canEditPrinters || saving}
                          aria-label={t(`${K}.countingFor`, { name: p.name })}
                          onChange={(e) => configure([p.id], { disabled: e.target.value === 'off' })}
                          className={inputClass}
                        >
                          <option value="on">{t(`${K}.on`)}</option>
                          <option value="off">{t(`${K}.off`)}</option>
                        </select>
                      </td>
                      <td className="py-1.5 pr-3">
                        <input
                          type="number"
                          min={1}
                          max={MAX_PLATES}
                          value={typing[p.id] ?? (entry.capacity === null ? '' : String(entry.capacity))}
                          placeholder={String(overview?.default_capacity ?? saved.default_capacity)}
                          disabled={!canEditPrinters || saving}
                          aria-label={t(`${K}.capacityFor`, { name: p.name })}
                          onChange={(e) => setTyping((old) => ({ ...old, [p.id]: e.target.value }))}
                          onBlur={() => saveOwnCapacity(entry)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') e.currentTarget.blur();
                          }}
                          className={`${inputClass} w-20`}
                        />
                      </td>
                      <td
                        className={`py-1.5 tabular-nums ${
                          entry.held ? 'text-red-400' : entry.counted ? 'text-white' : 'text-bambu-gray'
                        }`}
                      >
                        {entry.counted
                          ? `${entry.plates}/${entry.effective_capacity}${entry.in_use ? ` · ${t(`${K}.inUse`, { count: entry.in_use })}` : ''}${entry.held ? ` · ${t(`${K}.held`)}` : ''}`
                          : t(`${K}.notCounted`)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 0 && <p className="py-3 text-sm text-bambu-gray">{t('hyyz17200.plateClear.noPrinters')}</p>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
