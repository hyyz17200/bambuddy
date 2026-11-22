import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { api } from '../../api/client';
import type { Printer } from '../../api/client';
import { Button } from '../../components/Button';
import { Card, CardContent } from '../../components/Card';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { runBatch } from '../bulkActions/runBatch';
import { plateClearApplies } from '../plateClear';
import {
  DEFAULT_CAPACITY,
  MAX_PLATES,
  isCounted,
  parseWhole,
  platesLeft,
  setPlateCapacity,
  setPlates,
  setPlateShowCount,
} from './api';

const K = 'hyyz17200.plateCount.settings';

const inputClass =
  'px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-bambu-green disabled:opacity-50';

/** Upstream's plate changer count (#3575) for the whole farm: upstream sets it in
 *  Edit Printer, one printer at a time; this lists every printer with its
 *  capacity and count, filters them, and sets many at once. Everything here is
 *  upstream's printer fields, written through upstream's API. */
export function PlateCountSection() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const canUpdate = hasPermission('printers:update');
  const canRefill = hasPermission('printers:clear_plate');

  const { data: printers, isLoading } = useQuery({ queryKey: ['printers'], queryFn: api.getPrinters });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const plateClearSetting = settings?.require_plate_clear ?? false;

  const [search, setSearch] = useState('');
  const [model, setModel] = useState('');
  const [location, setLocation] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkCapacity, setBulkCapacity] = useState(String(DEFAULT_CAPACITY));
  const [saving, setSaving] = useState(false);
  // Capacity being typed, per printer, until it is saved.
  const [typing, setTyping] = useState<Record<number, string>>({});

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (printers ?? [])
      .filter((p) => !needle || p.name.toLowerCase().includes(needle))
      .filter((p) => !model || (p.model ?? '') === model)
      .filter((p) => !location || (p.location ?? '') === location)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [printers, search, model, location]);
  const models = useMemo(() => [...new Set((printers ?? []).map((p) => p.model ?? ''))].sort(), [printers]);
  const locations = useMemo(() => [...new Set((printers ?? []).map((p) => p.location ?? ''))].sort(), [printers]);

  const shownSelected = rows.filter((p) => selected.has(p.id));
  const allSelected = rows.length > 0 && shownSelected.length === rows.length;
  const countedTotal = (printers ?? []).filter(isCounted).length;
  const emptyTotal = (printers ?? []).filter((p) => platesLeft(p) === 0).length;

  /** Runs `task` on each printer it applies to, then reports. */
  const apply = async <P extends Printer>(targets: P[], task: (p: P) => Promise<unknown>) => {
    if (!targets.length) {
      showToast(t(`${K}.nothingToChange`), 'info');
      return;
    }
    setSaving(true);
    const done = await runBatch(targets, task);
    setSaving(false);
    await queryClient.invalidateQueries({ queryKey: ['printers'] });
    if (done.failed.length) {
      showToast(
        t(`${K}.failedSome`, { count: done.failed.length, names: done.failed.map((f) => f.printer.name).join(', ') }),
        'error',
      );
    } else {
      showToast(t(`${K}.applied`, { count: done.ok.length }), 'success');
    }
  };

  const saveCapacity = (printer: Printer) => {
    const text = typing[printer.id];
    if (text === undefined) return;
    setTyping((old) => {
      const next = { ...old };
      delete next[printer.id];
      return next;
    });
    const value = text.trim() === '' ? null : parseWhole(text, 1, MAX_PLATES);
    if (text.trim() !== '' && value === null) {
      showToast(t(`${K}.badCapacity`, { max: MAX_PLATES }), 'error');
      return;
    }
    if (value !== (printer.plate_capacity ?? null)) apply([printer], (p) => setPlateCapacity(p.id, value));
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
      for (const p of rows) {
        if (allSelected) next.delete(p.id);
        else next.add(p.id);
      }
      return next;
    });

  if (isLoading) return <p className="text-sm text-bambu-gray">{t('common.loading')}</p>;

  const bulkValue = parseWhole(bulkCapacity, 1, MAX_PLATES);
  const selectedCounted = shownSelected.filter(isCounted);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-bambu-gray">{t(`${K}.description`)}</p>

      <Card>
        <CardContent className="flex flex-col gap-3">
          <ul className="list-disc pl-5 text-xs text-bambu-gray space-y-1">
            <li>{t(`${K}.ruleWho`)}</li>
            <li>{t(`${K}.ruleCount`)}</li>
            <li>{t(`${K}.ruleHold`)}</li>
            <li>{t(`${K}.ruleRefill`)}</li>
            <li>{t(`${K}.ruleMaintenance`)}</li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-bambu-gray">
            {t(`${K}.summary`, { counted: countedTotal, total: printers?.length ?? 0, empty: emptyTotal })}
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

          {(canUpdate || canRefill) && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-bambu-gray">{t(`${K}.setSelected`, { count: shownSelected.length })}</span>
              {canUpdate && (
                <>
                  <input
                    type="number"
                    min={1}
                    max={MAX_PLATES}
                    value={bulkCapacity}
                    onChange={(e) => setBulkCapacity(e.target.value)}
                    aria-label={t(`${K}.bulkCapacity`)}
                    className={`${inputClass} w-20`}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={saving || !shownSelected.length || bulkValue === null}
                    onClick={() =>
                      bulkValue !== null &&
                      apply(
                        shownSelected.filter((p) => p.plate_capacity !== bulkValue),
                        (p) => setPlateCapacity(p.id, bulkValue),
                      )
                    }
                  >
                    {t(`${K}.setCapacity`)}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={saving || !selectedCounted.length}
                    onClick={() => apply(selectedCounted, (p) => setPlateCapacity(p.id, null))}
                  >
                    {t(`${K}.turnOff`)}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={saving || !selectedCounted.length}
                    onClick={() =>
                      apply(
                        selectedCounted.filter((p) => p.plate_changer_show_count === false),
                        (p) => setPlateShowCount(p.id, true),
                      )
                    }
                  >
                    {t(`${K}.showCount`)}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={saving || !selectedCounted.length}
                    onClick={() =>
                      apply(
                        selectedCounted.filter((p) => p.plate_changer_show_count !== false),
                        (p) => setPlateShowCount(p.id, false),
                      )
                    }
                  >
                    {t(`${K}.hideCount`)}
                  </Button>
                </>
              )}
              <Button
                size="sm"
                variant="secondary"
                disabled={saving || !selectedCounted.length}
                onClick={() =>
                  apply(
                    selectedCounted.filter((p) => platesLeft(p) !== p.plate_capacity),
                    (p) => setPlates(p, p.plate_capacity, canRefill),
                  )
                }
              >
                {t(`${K}.refill`)}
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
                      disabled={rows.length === 0}
                      onChange={toggleAll}
                    />
                  </th>
                  <th className="py-2 pr-3">{t('hyyz17200.plateClear.name')}</th>
                  <th className="py-2 pr-3">{t('hyyz17200.plateClear.model')}</th>
                  <th className="py-2 pr-3">{t('hyyz17200.plateClear.location')}</th>
                  <th className="py-2 pr-3">{t(`${K}.capacity`)}</th>
                  <th className="py-2 pr-3">{t(`${K}.onCard`)}</th>
                  <th className="py-2">{t(`${K}.plates`)}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-bambu-dark-tertiary">
                {rows.map((p) => {
                  const left = platesLeft(p);
                  const confirmed = plateClearApplies(p.require_plate_clear, plateClearSetting);
                  return (
                    <tr key={p.id}>
                      <td className="py-1.5">
                        <input
                          type="checkbox"
                          className="accent-bambu-green"
                          aria-label={p.name}
                          checked={selected.has(p.id)}
                          onChange={() => toggle(p.id)}
                        />
                      </td>
                      <td className="py-1.5 pr-3 text-white">{p.name}</td>
                      <td className="py-1.5 pr-3 text-bambu-gray">{p.model ?? ''}</td>
                      <td className="py-1.5 pr-3 text-bambu-gray">{p.location ?? ''}</td>
                      <td className="py-1.5 pr-3">
                        <input
                          type="number"
                          min={1}
                          max={MAX_PLATES}
                          value={typing[p.id] ?? (p.plate_capacity == null ? '' : String(p.plate_capacity))}
                          placeholder={t(`${K}.off`)}
                          disabled={!canUpdate || saving}
                          aria-label={t(`${K}.capacityFor`, { name: p.name })}
                          onChange={(e) => setTyping((old) => ({ ...old, [p.id]: e.target.value }))}
                          onBlur={() => saveCapacity(p)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') e.currentTarget.blur();
                          }}
                          className={`${inputClass} w-20`}
                        />
                      </td>
                      <td className="py-1.5 pr-3">
                        <input
                          type="checkbox"
                          className="accent-bambu-green"
                          aria-label={t(`${K}.onCardFor`, { name: p.name })}
                          checked={p.plate_changer_show_count !== false}
                          disabled={!canUpdate || saving || left === null}
                          onChange={(e) => apply([p], (x) => setPlateShowCount(x.id, e.target.checked))}
                        />
                      </td>
                      <td className={`py-1.5 tabular-nums ${left === 0 ? 'text-red-400' : left === null ? 'text-bambu-gray' : 'text-white'}`}>
                        {left === null ? t(`${K}.notCounted`) : `${left}/${p.plate_capacity}`}
                        {left === 0 && ` · ${t(`${K}.held`)}`}
                        {left !== null && confirmed && (
                          <span className="block text-xs text-amber-400">{t(`${K}.confirmed`)}</span>
                        )}
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
