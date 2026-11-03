import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Printer } from '../../api/client';
import { ConfirmModal } from '../../components/ConfirmModal';
import { PrinterNameList } from './PrinterNameList';

export interface Choice<K extends string> {
  key: K;
  label: string;
  description: string;
  /** The selected printers this choice changes; the rest are already there. */
  printers: Printer[];
  warning?: string;
}

interface Props<K extends string> {
  title: string;
  choices: Choice<K>[];
  selectedCount: number;
  running: boolean;
  onConfirm: (key: K, printers: Printer[]) => void;
  onCancel: () => void;
}

/**
 * Picking the direction is the confirmation: one dialog for "enter or leave
 * maintenance", "stop or resume taking jobs". Opens on the choice that
 * applies to the most printers.
 */
export function ChoiceDialog<K extends string>({ title, choices, selectedCount, running, onConfirm, onCancel }: Props<K>) {
  const { t } = useTranslation();
  const [key, setKey] = useState<K>(
    () => [...choices].sort((a, b) => b.printers.length - a.printers.length)[0].key,
  );
  const choice = choices.find((c) => c.key === key)!;
  const skipped = selectedCount - choice.printers.length;

  return (
    <ConfirmModal
      title={title}
      message={t('hyyz17200.bulk.chooseAction')}
      confirmText={choice.printers.length ? t('hyyz17200.bulk.applyTo', { action: choice.label, count: choice.printers.length }) : choice.label}
      confirmDisabled={!choice.printers.length}
      variant="warning"
      isLoading={running}
      onConfirm={() => onConfirm(key, choice.printers)}
      onCancel={onCancel}
    >
      <div role="radiogroup" className="mt-3 grid gap-2">
        {choices.map((c) => (
          <label
            key={c.key}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 ${
              c.key === key ? 'border-bambu-green bg-bambu-green/10' : 'border-bambu-dark-tertiary hover:bg-bambu-dark-tertiary'
            }`}
          >
            <input
              type="radio"
              name="hyyz17200-bulk-choice"
              className="mt-1 accent-bambu-green"
              checked={c.key === key}
              onChange={() => setKey(c.key)}
              disabled={running}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-white">
                {c.label}
                <span className="ml-2 text-xs text-bambu-gray">{t('hyyz17200.bulk.applicable', { count: c.printers.length })}</span>
              </span>
              <span className="block text-xs text-bambu-gray">{c.description}</span>
            </span>
          </label>
        ))}
      </div>
      <PrinterNameList printers={choice.printers} />
      {choice.warning && <p className="mt-2 text-xs text-yellow-400">{choice.warning}</p>}
      {skipped > 0 && <p className="mt-2 text-xs text-bambu-gray">{t('hyyz17200.bulk.skippedAlready', { count: skipped })}</p>}
    </ConfirmModal>
  );
}
