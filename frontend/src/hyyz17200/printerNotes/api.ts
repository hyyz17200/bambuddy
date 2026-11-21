import { hyyz17200Request } from '../request';

// Must match BODY_MAX_LENGTH in backend/app/hyyz17200/printer_notes.py.
export const NOTE_MAX_LENGTH = 2000;

/** info: a standing description; todo: something to look at; done: resolved,
 *  or logged as already done. Must match NOTE_KINDS in the backend model. */
export type NoteKind = 'info' | 'todo' | 'done';
export const NOTE_KINDS: NoteKind[] = ['info', 'todo', 'done'];

export interface PrinterNote {
  id: number;
  printer_id: number;
  kind: NoteKind;
  body: string;
  created_at: string | null;
  created_by: string | null;
  edited_at: string | null;
  edited_by: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
}

export interface PrinterNoteSummary {
  printer_id: number;
  todo_count: number;
  info_count: number;
  /** The newest todo, or without one the newest info, cut short. */
  latest: string;
}

/** Invalidating this refreshes both the card markers and any open notes dialog. */
export const NOTES_QUERY_KEY = ['hyyz17200', 'printer-notes'];
export const NOTE_SUMMARY_QUERY_KEY = [...NOTES_QUERY_KEY, 'summary'];
export const printerNotesQueryKey = (printerId: number) => [...NOTES_QUERY_KEY, printerId];

export async function listNoteSummaries(): Promise<PrinterNoteSummary[]> {
  return (await hyyz17200Request('/printers/notes/summary')).json();
}

export async function listPrinterNotes(printerId: number): Promise<PrinterNote[]> {
  return (await hyyz17200Request(`/printers/${printerId}/notes`)).json();
}

export async function addPrinterNote(printerId: number, body: string, kind: NoteKind): Promise<PrinterNote> {
  return (
    await hyyz17200Request(`/printers/${printerId}/notes`, {
      method: 'POST',
      body: JSON.stringify({ body, kind }),
    })
  ).json();
}

export async function updatePrinterNote(
  printerId: number,
  noteId: number,
  change: { body?: string; kind?: NoteKind },
): Promise<PrinterNote> {
  return (
    await hyyz17200Request(`/printers/${printerId}/notes/${noteId}`, {
      method: 'PATCH',
      body: JSON.stringify(change),
    })
  ).json();
}

export async function deletePrinterNote(printerId: number, noteId: number): Promise<void> {
  await hyyz17200Request(`/printers/${printerId}/notes/${noteId}`, { method: 'DELETE' });
}
