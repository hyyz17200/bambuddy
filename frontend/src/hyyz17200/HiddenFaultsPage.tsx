import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '../components/Button';
import { Card, CardContent } from '../components/Card';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import {
  addHiddenFault,
  HIDDEN_FAULTS_QUERY_KEY,
  listHiddenFaults,
  removeHiddenFault,
  type HiddenFault,
} from './hiddenFaultsApi';

// The "AMS firmware does not match" warning for slots A-D and AMS Lite: the only
// codes reported as harmless on a BMCU (upstream issue #3269).
const BMCU_FAULTS: HiddenFault[] = ['0500', '0501', '0502', '0503', '0510'].map((slot) => ({
  code: `${slot}040000010044`,
  note: 'BMCU',
}));

function normalizeCode(raw: string): string {
  return raw.replace(/[\s_-]/g, '').toUpperCase().replace(/^0X/, '');
}

function displayCode(code: string): string {
  return code.match(/.{4}/g)!.join('-');
}

export function HiddenFaultsPage() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [note, setNote] = useState('');

  const canEdit = hasPermission('settings:update');
  const normalized = normalizeCode(code);
  const isValid = /^([0-9A-F]{8}|[0-9A-F]{16})$/.test(normalized);

  const { data: faults = [], isLoading } = useQuery({
    queryKey: HIDDEN_FAULTS_QUERY_KEY,
    queryFn: listHiddenFaults,
  });

  const onSettled = () => queryClient.invalidateQueries({ queryKey: HIDDEN_FAULTS_QUERY_KEY });
  const onError = () => showToast(t('hyyz17200.hiddenFaults.saveFailed'), 'error');

  const addMutation = useMutation({
    mutationFn: async (toAdd: HiddenFault[]) => {
      for (const fault of toAdd) await addHiddenFault(fault);
    },
    onSuccess: () => {
      setCode('');
      setNote('');
    },
    onError,
    onSettled,
  });

  const removeMutation = useMutation({ mutationFn: removeHiddenFault, onError, onSettled });

  const listed = new Set(faults.map((fault) => fault.code));
  const missingBmcu = BMCU_FAULTS.filter((fault) => !listed.has(fault.code));

  return (
    <div className="p-4 md:p-8 max-w-3xl">
      <h1 className="text-2xl font-bold text-white mb-2">{t('hyyz17200.hiddenFaults.title')}</h1>
      <p className="text-sm text-bambu-gray mb-6">{t('hyyz17200.hiddenFaults.description')}</p>

      {canEdit && (
        <Card className="mb-6">
          <CardContent>
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (isValid) addMutation.mutate([{ code: normalized, note: note.trim() }]);
              }}
            >
              <div className="flex flex-col md:flex-row gap-3">
                <input
                  type="text"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="0500-0400-0001-0044"
                  aria-label={t('hyyz17200.hiddenFaults.code')}
                  className="flex-1 px-3 py-2 font-mono bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-bambu-green"
                />
                <input
                  type="text"
                  value={note}
                  maxLength={200}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder={t('hyyz17200.hiddenFaults.note')}
                  aria-label={t('hyyz17200.hiddenFaults.note')}
                  className="flex-1 px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-bambu-green"
                />
                <Button type="submit" disabled={!isValid || addMutation.isPending}>
                  <Plus className="w-4 h-4" />
                  {t('hyyz17200.hiddenFaults.add')}
                </Button>
              </div>
              {code !== '' && !isValid && (
                <p className="text-xs text-status-error">{t('hyyz17200.hiddenFaults.invalidCode')}</p>
              )}
              {isValid && normalized.length === 8 && (
                <p className="text-xs text-status-warning">{t('hyyz17200.hiddenFaults.printErrorWarning')}</p>
              )}
              {missingBmcu.length > 0 && (
                <div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={addMutation.isPending}
                    onClick={() => addMutation.mutate(missingBmcu)}
                  >
                    {t('hyyz17200.hiddenFaults.addBmcu')}
                  </Button>
                </div>
              )}
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-bambu-gray">{t('common.loading')}</p>
          ) : faults.length === 0 ? (
            <p className="text-sm text-bambu-gray">{t('hyyz17200.hiddenFaults.empty')}</p>
          ) : (
            <ul className="divide-y divide-bambu-dark-tertiary">
              {faults.map((fault) => (
                <li key={fault.code} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="font-mono text-sm text-white">{displayCode(fault.code)}</p>
                    {fault.note && <p className="text-xs text-bambu-gray truncate">{fault.note}</p>}
                  </div>
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={removeMutation.isPending}
                      aria-label={t('hyyz17200.hiddenFaults.remove', { code: displayCode(fault.code) })}
                      onClick={() => removeMutation.mutate(fault.code)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
