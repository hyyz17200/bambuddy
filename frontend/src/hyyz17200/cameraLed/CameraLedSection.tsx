import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { Button } from '../../components/Button';
import { Card, CardContent } from '../../components/Card';
import { NumberInput } from '../../components/NumberInput';
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
  KEEP_CAMERA_CHOICES,
  keepCameraChoice,
  keepsCamera,
  normalizeCameraLed,
  OFF_DELAY_RANGE,
  withKeepCameraChoice,
  type CameraLedSettings,
  type KeepCameraChoice,
} from './cameraLedSettings';

const SECTION = 'camera_led';
const K = 'hyyz17200.cameraLed';

const inputClass =
  'w-24 px-3 py-1.5 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-bambu-green disabled:opacity-50';
const selectClass =
  'px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-bambu-green disabled:opacity-50';

/** Keep the chamber light on for the whole print and off once idle, and keep
 *  chosen printers' cameras connected while they print. The backend does the
 *  work; this edits the section, saved as a whole. */
export function CameraLedSection() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const canEdit = hasPermission('settings:update');

  const { data, isLoading } = useQuery({ queryKey: ENHANCED_SETTINGS_QUERY_KEY, queryFn: getEnhancedSettings });
  const saved = normalizeCameraLed(data?.[SECTION]);
  const [draft, setDraft] = useState<CameraLedSettings | null>(null);
  const shown = draft ?? saved;
  const changed = JSON.stringify(shown) !== JSON.stringify(saved);

  const saveMutation = useMutation({
    mutationFn: (value: CameraLedSettings) => saveEnhancedSettingsSection(SECTION, value),
    onSuccess: (value) => {
      queryClient.setQueryData<EnhancedSettings>(ENHANCED_SETTINGS_QUERY_KEY, (old) => ({ ...old, [SECTION]: value }));
      setDraft(null);
      showToast(t(`${K}.saved`), 'success');
    },
    onError: () => showToast(t(`${K}.saveFailed`), 'error'),
  });

  if (isLoading) return <p className="text-sm text-bambu-gray">{t('common.loading')}</p>;

  const active = shown.enabled || shown.obico_force;

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
            <Toggle checked={shown.enabled} disabled={!canEdit} onChange={(enabled) => setDraft({ ...shown, enabled })} />
          </label>

          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm text-white">{t(`${K}.obicoForce`)}</span>
              <span className="block text-xs text-bambu-gray">{t(`${K}.obicoForceHint`)}</span>
            </span>
            <Toggle
              checked={shown.obico_force}
              disabled={!canEdit}
              onChange={(obico_force) => setDraft({ ...shown, obico_force })}
            />
          </label>

          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm text-white">{t(`${K}.offDelay`)}</span>
              <span className="block text-xs text-bambu-gray">{t(`${K}.offDelayHint`)}</span>
            </span>
            <NumberInput
              value={shown.off_delay_seconds}
              min={OFF_DELAY_RANGE.min}
              max={OFF_DELAY_RANGE.max}
              disabled={!canEdit || !active}
              onChange={(off_delay_seconds) => setDraft({ ...shown, off_delay_seconds })}
              aria-label={t(`${K}.offDelay`)}
              className={inputClass}
            />
          </label>

          <ul className="list-disc pl-5 text-xs text-bambu-gray space-y-1">
            <li>{t(`${K}.ruleVerify`)}</li>
            <li>{t(`${K}.ruleManual`)}</li>
            <li>{t(`${K}.ruleCamera`)}</li>
            <li>{t(`${K}.ruleIdle`)}</li>
          </ul>
        </CardContent>
      </Card>

      <KeepCameraCard settings={shown} disabled={!canEdit || !active} onChange={setDraft} />

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button disabled={!changed || saveMutation.isPending} onClick={() => saveMutation.mutate(shown)}>
            {t(`${K}.save`)}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Keep the camera connected while printing: a global switch, and each
 *  printer following it or set on or off, laid out like the plate-clear tab. */
function KeepCameraCard({
  settings,
  disabled,
  onChange,
}: {
  settings: CameraLedSettings;
  disabled: boolean;
  onChange: (value: CameraLedSettings) => void;
}) {
  const { t } = useTranslation();
  const { data: printers } = useQuery({ queryKey: ['printers'], queryFn: api.getPrinters });

  const [search, setSearch] = useState('');
  const [model, setModel] = useState('');
  const [location, setLocation] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());

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

  const keeping = (printers ?? []).filter((p) => keepsCamera(settings, p.id)).length;
  const shownSelected = shown.filter((p) => selected.has(p.id));
  const allShownSelected = shown.length > 0 && shownSelected.length === shown.length;

  const set = (ids: number[], choice: KeepCameraChoice) => onChange(withKeepCameraChoice(settings, ids, choice));
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

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div>
          <span className="block text-sm text-white">{t(`${K}.keepCamera`)}</span>
          <span className="block text-xs text-bambu-gray">{t(`${K}.keepCameraHint`)}</span>
        </div>

        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="block text-sm text-white">{t(`${K}.keepCameraAll`)}</span>
            <span className="block text-xs text-bambu-gray">{t(`${K}.keepCameraAllHint`)}</span>
          </span>
          <Toggle
            checked={settings.keep_camera_all}
            disabled={disabled}
            onChange={(keep_camera_all) => onChange({ ...settings, keep_camera_all })}
          />
        </label>
        <p className="text-xs text-bambu-gray">
          {t(`${K}.keepCameraSummary`, { keeping, total: printers?.length ?? 0 })}
        </p>

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

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-bambu-gray">{t(`${K}.setSelected`, { count: shownSelected.length })}</span>
          {KEEP_CAMERA_CHOICES.map((choice) => (
            <Button
              key={choice}
              size="sm"
              variant="secondary"
              disabled={disabled || shownSelected.length === 0}
              onClick={() => set(shownSelected.map((p) => p.id), choice)}
            >
              {t(`${K}.choice.${choice}`)}
            </Button>
          ))}
        </div>

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
                    disabled={disabled || shown.length === 0}
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
                const keeps = keepsCamera(settings, p.id);
                return (
                  <tr key={p.id}>
                    <td className="py-1.5">
                      <input
                        type="checkbox"
                        className="accent-bambu-green"
                        aria-label={p.name}
                        checked={selected.has(p.id)}
                        disabled={disabled}
                        onChange={() => toggle(p.id)}
                      />
                    </td>
                    <td className="py-1.5 pr-3 text-white">{p.name}</td>
                    <td className="py-1.5 pr-3 text-bambu-gray">{p.model ?? ''}</td>
                    <td className="py-1.5 pr-3 text-bambu-gray">{p.location ?? ''}</td>
                    <td className="py-1.5 pr-3">
                      <select
                        value={keepCameraChoice(settings, p.id)}
                        disabled={disabled}
                        aria-label={t(`${K}.ownFor`, { name: p.name })}
                        onChange={(e) => set([p.id], e.target.value as KeepCameraChoice)}
                        className={selectClass}
                      >
                        {KEEP_CAMERA_CHOICES.map((choice) => (
                          <option key={choice} value={choice}>
                            {t(`${K}.choice.${choice}`)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className={`py-1.5 ${keeps ? 'text-bambu-green' : 'text-bambu-gray'}`}>
                      {t(keeps ? `${K}.keeps` : `${K}.doesNotKeep`)}
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
  );
}
