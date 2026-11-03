import type { TFunction } from 'i18next';
import type { Printer, PrinterStatus } from '../../api/client';
import { parseUTCDate } from '../../utils/date';
import { getWifiStrength } from '../../utils/printer';

/** What the card's "Printer Information" window shows, one row per printer.
 *  Kept in the window's order, so a column there is a column here. */
type InfoStatus = Pick<
  PrinterStatus,
  'connected' | 'state' | 'wired_network' | 'wifi_signal' | 'firmware_version' | 'developer_mode'
>;

const STATE_KEYS: Record<string, string> = {
  IDLE: 'printers.status.idle',
  RUNNING: 'printers.status.printing',
  PAUSE: 'printers.status.paused',
  FINISH: 'printers.status.finished',
  FAILED: 'printers.status.error',
};

function isoDate(value: string | null | undefined): string {
  const date = parseUTCDate(value);
  if (!date) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function printerInfoTable(
  printers: Printer[],
  statusOf: (id: number) => InfoStatus | undefined,
  hoursOf: (id: number) => number | undefined,
  t: TFunction,
): string[][] {
  const enabled = (on: boolean) => (on ? t('printers.enabled') : t('printers.disabled'));
  const header = [
    t('hyyz17200.bulk.csv.name'),
    t('printers.model'),
    t('common.status'),
    t('printers.state'),
    t('printers.ipAddress'),
    t('printers.serialNumber'),
    t('printers.networkLabel', 'Network'),
    t('hyyz17200.bulk.csv.wifiDbm'),
    t('printers.firmware'),
    t('printers.developerMode'),
    t('printers.nozzleCount'),
    t('printers.autoArchive'),
    t('printers.totalPrintHours'),
    t('printers.sort.location'),
    t('printers.addedOn'),
  ];
  const rows = printers.map((printer) => {
    const status = statusOf(printer.id);
    const hours = hoursOf(printer.id);
    let network = '';
    if (status?.wired_network) network = t('printers.connection.ethernet', 'Ethernet');
    else if (status?.wifi_signal != null) network = `${t('hyyz17200.bulk.csv.wifi')} ${t(getWifiStrength(status.wifi_signal).labelKey)}`;
    return [
      printer.name,
      printer.model ?? '',
      status?.connected ? t('printers.status.available') : t('printers.status.offline'),
      status?.state ? t(STATE_KEYS[status.state] ?? 'printers.status.unknown') : '',
      printer.ip_address,
      printer.serial_number,
      network,
      !status?.wired_network && status?.wifi_signal != null ? String(status.wifi_signal) : '',
      status?.firmware_version ?? '',
      status?.developer_mode != null ? enabled(status.developer_mode) : '',
      String(printer.nozzle_count),
      enabled(printer.auto_archive),
      hours != null ? String(Math.round(hours * 10) / 10) : '',
      printer.location ?? '',
      isoDate(printer.created_at),
    ];
  });
  return [header, ...rows];
}

/** A spreadsheet runs a cell starting with one of these as a formula. Numbers
 *  such as a negative WiFi signal stay numbers. */
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: string): string {
  let text = value;
  if (FORMULA_START.test(text) && !Number.isFinite(Number(text))) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 with a byte order mark, so Excel reads the UTF-8 names correctly. */
export function toCsv(table: string[][]): string {
  return '﻿' + table.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function csvFilename(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `bambuddy-printers-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.csv`;
}
