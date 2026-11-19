import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Box, Check, Loader2, Plus, X } from 'lucide-react';
import { api } from '../api/client';
import type { PrinterLocation } from '../api/client';
import { AVAILABLE_ICONS } from '../components/IconPicker';
import { useToast } from '../contexts/ToastContext';

// printers.location / printer_locations.name are VARCHAR(100).
const NAME_MAX_LENGTH = 100;

export type MovablePrinter = { id: number; name: string; location?: string | null };

function TileIcon({ location }: { location: Pick<PrinterLocation, 'icon' | 'color'> }) {
  const Icon = AVAILABLE_ICONS.find((i) => i.name === location.icon)?.icon ?? Box;
  return (
    <span className="p-1.5 rounded-md bg-bambu-dark relative overflow-hidden flex-shrink-0">
      <Icon className="w-5 h-5 text-bambu-gray" />
      {location.color && (
        <span className="absolute top-0 left-0 w-1 h-full" style={{ backgroundColor: location.color }} />
      )}
    </span>
  );
}

const TILE =
  'min-h-[3.25rem] px-3 py-2 rounded-lg border text-left flex items-center gap-2 transition-colors disabled:cursor-not-allowed';
const TILE_IDLE = 'border-bambu-dark-tertiary bg-bambu-dark-secondary hover:border-bambu-green hover:bg-bambu-dark-tertiary';
const TILE_CURRENT = 'border-bambu-green bg-bambu-green/10';

/** Rendered into `document.body`: a card being dragged or sorted carries a
 *  `transform`, which would make a `fixed` overlay position against the card. */
export function MoveToLocationDialog({ printer, onClose }: { printer: MovablePrinter; onClose: () => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const current = printer.location?.trim() || null;

  const { data: locations, isLoading } = useQuery({
    queryKey: ['printer-locations'],
    queryFn: api.getPrinterLocations,
  });

  const mutation = useMutation({
    mutationFn: (location: string | null) => api.assignPrinterLocation([printer.id], location),
    onSuccess: (_data, location) => {
      showToast(
        location
          ? t('hyyz17200.printerMove.moved', { name: printer.name, location })
          : t('hyyz17200.printerMove.removed', { name: printer.name }),
        'success',
      );
      onClose();
    },
    onError: (error: Error) =>
      showToast(t('printers.locations.failed', { error: error.message || String(error) }), 'error'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['printers'] });
      queryClient.invalidateQueries({ queryKey: ['printer-locations'] });
    },
  });
  const saving = mutation.isPending;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saving, onClose]);

  const move = (location: string | null) => {
    if (saving || location === current) return;
    mutation.mutate(location);
  };
  const submitNew = () => {
    const name = newName.trim();
    if (name) move(name);
  };

  return createPortal(
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={saving ? undefined : onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="hyyz17200-move-title"
        className="w-full max-w-2xl max-h-[90vh] flex flex-col bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-xl shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2 p-4 border-b border-bambu-dark-tertiary">
          <div className="min-w-0">
            <h2 id="hyyz17200-move-title" className="text-lg font-semibold text-white truncate">
              {t('hyyz17200.printerMove.title', { name: printer.name })}
            </h2>
            <p className="text-sm text-bambu-gray truncate">
              {t('hyyz17200.printerMove.current', {
                location: current ?? t('printers.locations.noLocation'),
              })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label={t('common.cancel')}
            className="p-2 -m-1 rounded-lg text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto">
          {isLoading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="w-6 h-6 animate-spin text-bambu-gray" />
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {(locations ?? []).map((loc) => {
                const isCurrent = loc.name === current;
                const pending = saving && mutation.variables === loc.name;
                return (
                  <button
                    key={loc.name}
                    type="button"
                    disabled={saving || isCurrent}
                    aria-current={isCurrent || undefined}
                    onClick={() => move(loc.name)}
                    className={`${TILE} ${isCurrent ? TILE_CURRENT : TILE_IDLE}`}
                    title={loc.name}
                  >
                    <TileIcon location={loc} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-white truncate">{loc.name}</span>
                      <span className="block text-xs text-bambu-gray">
                        {isCurrent
                          ? t('hyyz17200.printerMove.here')
                          : t('hyyz17200.printerMove.count', { count: loc.printer_count })}
                      </span>
                    </span>
                    {pending ? (
                      <Loader2 className="w-4 h-4 animate-spin text-bambu-green flex-shrink-0" />
                    ) : (
                      isCurrent && <Check className="w-4 h-4 text-bambu-green flex-shrink-0" />
                    )}
                  </button>
                );
              })}
              <button
                type="button"
                disabled={saving || current === null}
                aria-current={current === null || undefined}
                onClick={() => move(null)}
                className={`${TILE} ${current === null ? TILE_CURRENT : TILE_IDLE}`}
              >
                <span className="p-1.5 rounded-md bg-bambu-dark flex-shrink-0">
                  <X className="w-5 h-5 text-bambu-gray" />
                </span>
                <span className="min-w-0 flex-1 text-sm text-bambu-gray truncate">
                  {t('printers.locations.noLocation')}
                </span>
                {saving && mutation.variables === null ? (
                  <Loader2 className="w-4 h-4 animate-spin text-bambu-green flex-shrink-0" />
                ) : (
                  current === null && <Check className="w-4 h-4 text-bambu-green flex-shrink-0" />
                )}
              </button>
              {!creating && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setCreating(true)}
                  className={`${TILE} border-dashed border-bambu-dark-tertiary hover:border-bambu-green text-bambu-gray hover:text-white`}
                >
                  <span className="p-1.5 rounded-md bg-bambu-dark flex-shrink-0">
                    <Plus className="w-5 h-5" />
                  </span>
                  <span className="text-sm truncate">{t('hyyz17200.bulk.move.newLocation')}</span>
                </button>
              )}
            </div>
          )}

          {creating && (
            <div className="flex gap-2 mt-3">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitNew()}
                placeholder={t('hyyz17200.bulk.move.newLocationName')}
                aria-label={t('hyyz17200.bulk.move.newLocationName')}
                maxLength={NAME_MAX_LENGTH}
                disabled={saving}
                autoFocus
                className="flex-1 min-w-0 px-4 py-2 text-sm bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white placeholder-bambu-gray focus:outline-none focus:ring-2 focus:ring-bambu-green/50 focus:border-bambu-green"
              />
              <button
                type="button"
                onClick={submitNew}
                disabled={saving || !newName.trim() || newName.trim() === current}
                className="px-4 py-2 text-sm rounded-lg bg-bambu-green text-white hover:bg-bambu-green/80 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving && mutation.variables === newName.trim() ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  t('printers.locations.moveButton')
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
