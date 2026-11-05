import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ListPlus } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

/** Printers page header, next to Add Printer: opens the bulk import page.
 *  PrintersPage.tsx mounts it with one line. */
export function PrinterImportButton({ inMenu = false }: { inMenu?: boolean }) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  if (!hasPermission('printers:create')) return null;
  return (
    <Link
      to="/hyyz17200/printer-import"
      title={t('hyyz17200.printerImport.buttonTitle')}
      className={`inline-flex items-center justify-center gap-2 rounded-lg bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white text-sm font-medium !h-8 !min-h-8 px-2 py-0 ${inMenu ? 'w-full' : ''}`}
    >
      <ListPlus className="w-4 h-4" />
      {t('hyyz17200.printerImport.button')}
    </Link>
  );
}
