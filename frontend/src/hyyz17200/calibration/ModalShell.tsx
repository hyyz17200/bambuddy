import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Card, CardContent } from '../../components/Card';

interface Props {
  title: string;
  onClose: () => void;
  /** Escape and the backdrop do nothing while true. */
  busy?: boolean;
  footer: ReactNode;
  children: ReactNode;
}

/** The batch calibration dialogs' frame: wider than ConfirmModal, own buttons. */
export function ModalShell({ title, onClose, busy = false, footer, children }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={busy ? undefined : onClose}>
      <Card
        className="flex max-h-[90vh] w-full max-w-2xl flex-col"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
          <div className="flex items-center justify-between border-b border-bambu-dark-tertiary px-5 py-3">
            <h3 className="text-lg font-semibold text-white">{title}</h3>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded p-1 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white"
              aria-label="close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          <div className="flex flex-wrap justify-end gap-2 border-t border-bambu-dark-tertiary px-5 py-3">{footer}</div>
        </CardContent>
      </Card>
    </div>
  );
}
