import { CheckSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useIsSidebarCompact } from '../../hooks/useIsSidebarCompact';
import { useHyyz17200QuickButtons } from './quickButtonsSettings';
import { useSelectToggle } from './selectToggle';

/** PC: a round Select button in the bottom-right corner, where upstream's bug
 *  disc sits (above it while that is still shown). Hidden while selecting: the
 *  selection toolbar has its own close button, and on a narrow PC window it can
 *  reach the corner. Below the compact breakpoint the top bar has the button
 *  instead. Mounted in AppMount, it shows only while the printer page lends
 *  its toggle. */
export function Hyyz17200FloatingSelect() {
  const { t } = useTranslation();
  const { select_button, hide_bug_report } = useHyyz17200QuickButtons();
  const select = useSelectToggle();
  const compact = useIsSidebarCompact();

  if (!select_button || !select || select.active || compact) return null;

  return (
    <button
      type="button"
      onClick={select.toggle}
      className={`fixed ${hide_bug_report ? 'bottom-4' : 'bottom-20'} right-4 z-40 w-12 h-12 rounded-full bg-bambu-green text-white shadow-lg hover:shadow-xl hover:bg-bambu-green/80 transition-all duration-200 hover:scale-110 flex items-center justify-center`}
      title={t('printers.bulk.select')}
      aria-label={t('printers.bulk.select')}
      data-hyyz17200="floating-select"
    >
      <CheckSquare className="w-5 h-5" />
    </button>
  );
}

/** Phone: a Select toggle in Layout's compact top bar, right of the camera
 *  button. The bar is fixed, so it is in reach however far the list scrolls. */
export function Hyyz17200HeaderSelect() {
  const { t } = useTranslation();
  const { select_button, hide_bug_report } = useHyyz17200QuickButtons();
  const select = useSelectToggle();

  if (!select_button || !select) return null;

  return (
    <button
      type="button"
      onClick={select.toggle}
      className={`p-2 ${hide_bug_report ? '-mr-2' : ''} rounded-lg transition-colors ${
        select.active ? 'text-bambu-green bg-bambu-dark-tertiary' : 'text-white hover:bg-bambu-dark-tertiary'
      }`}
      title={t('printers.bulk.select')}
      aria-label={t('printers.bulk.select')}
      aria-pressed={select.active}
      data-hyyz17200="header-select"
    >
      <CheckSquare className="w-5 h-5" />
    </button>
  );
}
