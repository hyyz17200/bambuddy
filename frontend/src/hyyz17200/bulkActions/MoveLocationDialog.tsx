import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { api } from '../../api/client';
import type { Printer } from '../../api/client';
import { Button } from '../../components/Button';
import { Card, CardContent } from '../../components/Card';
import { PrinterNameList } from './PrinterNameList';

const NO_LOCATION = '__none__';
const NEW_LOCATION = '__new__';

const fieldClass =
  'w-full px-4 py-2 text-sm bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-bambu-green/50 focus:border-bambu-green transition-colors';

interface Props {
  printers: Printer[];
  saving: boolean;
  onMove: (location: string | null) => void;
  onCancel: () => void;
}

/** Upstream's "Move" from the Locations page, plus typing a new location. */
export function MoveLocationDialog({ printers, saving, onMove, onCancel }: Props) {
  const { t } = useTranslation();
  const [target, setTarget] = useState('');
  const [newName, setNewName] = useState('');
  const { data: locations } = useQuery({ queryKey: ['printer-locations'], queryFn: api.getPrinterLocations });

  const location = target === NO_LOCATION ? null : target === NEW_LOCATION ? newName.trim() : target;
  const ready = target !== '' && (target !== NEW_LOCATION || newName.trim() !== '');
  const submit = () => {
    if (ready && !saving) onMove(location);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={saving ? undefined : onCancel}>
      <Card className="w-full max-w-md" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
        <CardContent className="space-y-4">
          <h2 className="text-lg font-semibold text-white">
            {t('printers.locations.moveTitleMany', { count: printers.length })}
          </h2>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            aria-label={t('printers.locations.targetPlaceholder')}
            className={fieldClass}
            disabled={saving}
            autoFocus
          >
            <option value="" disabled>
              {t('printers.locations.targetPlaceholder')}
            </option>
            {(locations ?? []).map((loc) => (
              <option key={loc.name} value={loc.name}>
                {loc.name}
              </option>
            ))}
            <option value={NO_LOCATION}>{t('printers.locations.noLocation')}</option>
            <option value={NEW_LOCATION}>{t('hyyz17200.bulk.move.newLocation')}</option>
          </select>
          {target === NEW_LOCATION && (
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder={t('hyyz17200.bulk.move.newLocationName')}
              aria-label={t('hyyz17200.bulk.move.newLocationName')}
              className={fieldClass}
              disabled={saving}
              maxLength={100}
              autoFocus
            />
          )}
          <PrinterNameList printers={printers} />
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={onCancel} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button onClick={submit} disabled={saving || !ready}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : t('printers.locations.moveButton')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
