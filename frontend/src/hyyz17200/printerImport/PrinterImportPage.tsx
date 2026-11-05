import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowLeft, CheckCircle2, ClipboardPaste, Download, FileUp, Loader2, Plus, Radar, ScanSearch, Square, Trash2,
  XCircle,
} from 'lucide-react';
import { api } from '../../api/client';
import { Button } from '../../components/Button';
import { Card, CardContent } from '../../components/Card';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { mapModelCode } from '../../utils/printerModel';
import { Hyyz17200RequestError } from '../request';
import { importPrinter, probePrinters } from './api';
import {
  CSV_TEMPLATE, emptyRow, mergeCsvRows, mergeDiscovered, MODEL_OPTIONS, normalizeModel, rowProblems, rowsFromCsv,
  type Field, type ImportRow, type Problem,
} from './rows';
import { useNetworkScan } from './useNetworkScan';

const K = 'hyyz17200.printerImport';
const PROBE_CHUNK = 8;

const inputBase =
  'w-full min-w-0 px-2 py-1 bg-bambu-dark border rounded text-white text-sm focus:outline-none disabled:opacity-60';

function borderFor(problems: Problem[]): string {
  if (problems.some((p) => p.level === 'error')) return 'border-red-500 focus:border-red-400';
  if (problems.some((p) => p.level === 'warning')) return 'border-yellow-500 focus:border-yellow-400';
  return 'border-bambu-dark-tertiary focus:border-bambu-green';
}

/** Connection state of a printer the import just added. */
function AddedStatus({ printerId }: { printerId: number }) {
  const { t } = useTranslation();
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), 30_000);
    return () => clearTimeout(timer);
  }, []);
  const { data } = useQuery({
    queryKey: ['printerStatus', printerId],
    queryFn: () => api.getPrinterStatus(printerId),
    refetchInterval: (query) => (query.state.data?.connected ? false : 3000),
  });
  if (data?.connected) {
    return (
      <span className="inline-flex items-center gap-1 text-bambu-green">
        <CheckCircle2 className="w-4 h-4" /> {t(`${K}.status.connected`)}
      </span>
    );
  }
  if (!waited) {
    return (
      <span className="inline-flex items-center gap-1 text-bambu-gray">
        <Loader2 className="w-4 h-4 animate-spin" /> {t(`${K}.status.connecting`)}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-yellow-500" title={t(`${K}.status.notConnectedHint`)}>
      <AlertTriangle className="w-4 h-4" /> {t(`${K}.status.notConnected`)}
    </span>
  );
}

/** Add many printers at once: load a CSV, read the serials from the IPs, check
 *  the table by eye, then add the rows one by one through upstream's route. */
export function PrinterImportPage() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [verify, setVerify] = useState(false);
  const [probing, setProbing] = useState(false);
  const [adding, setAdding] = useState(false);
  const stopRequested = useRef(false);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const { data: printers } = useQuery({ queryKey: ['printers'], queryFn: api.getPrinters });
  const existing = useMemo(
    () => (printers ?? []).filter((p) => !rows.some((r) => r.printerId === p.id)),
    [printers, rows],
  );
  const problems = useMemo(
    () => new Map(rows.map((row) => [row.key, rowProblems(row, rows, existing)])),
    [rows, existing],
  );
  const pending = rows.filter((r) => r.status !== 'added');
  const ready = pending.filter((r) => !problems.get(r.key)!.some((p) => p.level === 'error'));
  const blocked = pending.length - ready.length;
  const allowed = hasPermission('printers:create');
  const scan = useNetworkScan();
  const busy = probing || adding || scan.running;

  const update = (key: number, fields: Partial<ImportRow>) =>
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...fields } : r)));

  const readSerials = async (target: ImportRow[]) => {
    const todo = target.filter((r) => r.status !== 'added' && !r.serial.trim() && r.ip.trim());
    if (todo.length === 0) return;
    setProbing(true);
    const keys = new Set(todo.map((r) => r.key));
    setRows((current) => current.map((r) => (keys.has(r.key) ? { ...r, probe: 'reading' } : r)));
    try {
      for (let i = 0; i < todo.length; i += PROBE_CHUNK) {
        const chunk = todo.slice(i, i + PROBE_CHUNK);
        let results: Awaited<ReturnType<typeof probePrinters>> = [];
        try {
          results = await probePrinters(chunk.map((r) => r.ip.trim()));
        } catch {
          // Leave these rows unread; the serial can still be typed in.
        }
        const byIp = new Map(results.map((res) => [res.ip_address, res]));
        const chunkKeys = new Set(chunk.map((r) => r.key));
        setRows((current) =>
          current.map((r) => {
            if (!chunkKeys.has(r.key)) return r;
            const res = byIp.get(r.ip.trim());
            if (!res?.serial_number) return { ...r, probe: res?.source === 'virtual' ? 'virtual' : 'failed' };
            // Typed in while the read was running: keep what the user typed.
            if (r.serial.trim()) return { ...r, probe: undefined };
            return {
              ...r,
              probe: undefined,
              serial: res.serial_number,
              serialSource: res.source as 'ssdp' | 'certificate',
              model: r.model || normalizeModel(mapModelCode(res.model)),
              name: r.name || res.name || res.serial_number,
            };
          }),
        );
      }
    } finally {
      setProbing(false);
    }
  };

  const load = (text: string) => {
    const loaded = rowsFromCsv(text);
    if (loaded.length === 0) {
      showToast(t(`${K}.emptyCsv`), 'error');
      return;
    }
    // Merged by IP, so a CSV of IPs and access codes completes a scanned table.
    const merged = mergeCsvRows(rowsRef.current, loaded);
    setRows(merged);
    void readSerials(merged);
  };

  // Scan results join the table as they arrive; once the scan ends, the
  // printers that did not tell their serial get the probe's certificate read.
  const printersRef = useRef(printers);
  printersRef.current = printers;
  useEffect(() => {
    if (scan.found.length > 0) setRows((current) => mergeDiscovered(current, scan.found, printersRef.current ?? []));
  }, [scan.found]);
  const wasScanning = useRef(false);
  useEffect(() => {
    if (wasScanning.current && !scan.running) {
      const merged = mergeDiscovered(rowsRef.current, scan.found, printersRef.current ?? []);
      setRows(merged);
      void readSerials(merged);
    }
    wasScanning.current = scan.running;
    // readSerials only uses state setters and its argument.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan.running]);
  const foundInBambuddy = scan.found.filter((p) =>
    (printers ?? []).some(
      (e) => e.ip_address === p.ip_address || e.serial_number.toUpperCase() === p.serial.toUpperCase(),
    ),
  ).length;

  // Enter moves down a column (Shift+Enter up), so a column of access codes
  // can be typed without the mouse.
  const onTableKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const col = target.dataset.col;
    if (e.key !== 'Enter' || !col) return;
    e.preventDefault();
    const next = Number(target.dataset.row) + (e.shiftKey ? -1 : 1);
    const cell = document.querySelector<HTMLInputElement>(`[data-col="${col}"][data-row="${next}"]`);
    cell?.focus();
    cell?.select?.();
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    load(await file.text());
    if (fileInput.current) fileInput.current.value = '';
  };

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([String.fromCharCode(0xfeff) + CSV_TEMPLATE], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bambuddy-printers.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const errorText = (error: unknown): string => {
    if (error instanceof Hyyz17200RequestError) {
      if (error.detail === 'duplicate_serial') return t(`${K}.error.duplicateSerial`);
      if (error.detail === 'printer_connection_failed') return t(`${K}.error.connectionFailed`);
      if (error.status === 403) return t(`${K}.error.forbidden`);
      return error.detail ?? error.message;
    }
    return error instanceof Error ? error.message : String(error);
  };

  const addAll = async () => {
    stopRequested.current = false;
    setAdding(true);
    let ok = 0;
    let failed = 0;
    try {
      for (const { key } of ready) {
        if (stopRequested.current) break;
        // Read the row now: it may have been edited since the button was pressed.
        const row = rowsRef.current.find((r) => r.key === key);
        if (!row || row.status === 'added') continue;
        update(key, { status: 'adding', error: undefined });
        try {
          const created = await importPrinter(
            {
              name: row.name.trim(),
              ip_address: row.ip.trim(),
              access_code: row.accessCode.trim(),
              serial_number: row.serial.trim().toUpperCase(),
              model: row.model || undefined,
              location: row.location.trim() || null,
              auto_archive: row.autoArchive,
            },
            verify,
          );
          update(key, { status: 'added', printerId: created.id });
          ok++;
        } catch (error) {
          update(key, { status: 'failed', error: errorText(error) });
          failed++;
        }
      }
    } finally {
      setAdding(false);
      queryClient.invalidateQueries({ queryKey: ['printers'] });
      queryClient.invalidateQueries({ queryKey: ['printer-locations'] });
    }
    showToast(t(`${K}.done`, { ok, failed }), failed ? 'error' : 'success');
  };

  const problemTitle = (rowProblems: Problem[], field: Field) =>
    rowProblems
      .filter((p) => p.field === field)
      .map((p) => t(`${K}.problem.${p.key}`, p.params))
      .join('\n') || undefined;

  const cell = (row: ImportRow, field: Field) => {
    const own = problems.get(row.key)!.filter((p) => p.field === field);
    return { className: `${inputBase} ${borderFor(own)}`, title: problemTitle(own, field) };
  };

  const statusCell = (row: ImportRow) => {
    if (row.status === 'adding') return <Loader2 className="w-4 h-4 animate-spin text-bambu-gray" />;
    if (row.status === 'added' && row.printerId) return <AddedStatus printerId={row.printerId} />;
    if (row.status === 'failed')
      return (
        <span className="inline-flex items-center gap-1 text-red-400" title={row.error}>
          <XCircle className="w-4 h-4 shrink-0" /> <span className="truncate max-w-[12rem]">{row.error}</span>
        </span>
      );
    const own = problems.get(row.key)!;
    if (own.some((p) => p.level === 'error'))
      return <span className="text-red-400">{t(`${K}.status.needsFix`)}</span>;
    return <span className="text-bambu-gray">{t(`${K}.status.ready`)}</span>;
  };

  return (
    <div className="p-4 md:p-8">
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-bambu-gray hover:text-white mb-3">
        <ArrowLeft className="w-4 h-4" /> {t(`${K}.back`)}
      </Link>
      <h1 className="text-2xl font-bold text-white mb-2">{t(`${K}.title`)}</h1>
      <p className="text-sm text-bambu-gray mb-6 max-w-3xl">{t(`${K}.description`)}</p>

      {!allowed && <p className="mb-4 text-sm text-yellow-500">{t(`${K}.noPermission`)}</p>}

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input
          ref={fileInput}
          type="file"
          accept=".csv,.txt,text/csv"
          className="hidden"
          data-testid="csv-file"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
        <Button onClick={() => fileInput.current?.click()} disabled={busy}>
          <FileUp className="w-4 h-4" /> {t(`${K}.loadCsv`)}
        </Button>
        <Button variant="secondary" onClick={() => setPasteOpen((v) => !v)} disabled={busy}>
          <ClipboardPaste className="w-4 h-4" /> {t(`${K}.paste`)}
        </Button>
        <Button variant="secondary" onClick={downloadTemplate}>
          <Download className="w-4 h-4" /> {t(`${K}.template`)}
        </Button>
        <Button variant="secondary" onClick={() => setRows((r) => [...r, emptyRow()])} disabled={adding}>
          <Plus className="w-4 h-4" /> {t(`${K}.addRow`)}
        </Button>
        <Button variant="secondary" onClick={() => readSerials(rows)} disabled={busy || rows.length === 0}>
          {probing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ScanSearch className="w-4 h-4" />}
          {t(`${K}.readSerials`)}
        </Button>
        {rows.length > 0 && (
          <Button variant="ghost" onClick={() => setRows([])} disabled={busy}>
            <Trash2 className="w-4 h-4" /> {t(`${K}.clear`)}
          </Button>
        )}
      </div>

      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-center gap-2">
          <Radar className="w-4 h-4 text-bambu-gray" />
          <span className="text-sm text-white">{t(`${K}.scan.title`)}</span>
          <select
            className="px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white text-sm focus:border-bambu-green focus:outline-none"
            value={scan.subnet}
            disabled={scan.running}
            aria-label={t(`${K}.scan.subnet`)}
            onChange={(e) => scan.setSubnet(e.target.value)}
          >
            {scan.subnets.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
            <option value="__custom__">{t(`${K}.scan.custom`)}</option>
          </select>
          {scan.subnet === '__custom__' && (
            <input
              className="w-40 px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white text-sm font-mono focus:border-bambu-green focus:outline-none"
              value={scan.customSubnet}
              disabled={scan.running}
              placeholder="192.168.1.0/24"
              aria-label={t(`${K}.scan.customLabel`)}
              onChange={(e) => scan.setCustomSubnet(e.target.value)}
            />
          )}
          {scan.running ? (
            <Button variant="secondary" size="sm" onClick={scan.stop}>
              <Square className="w-4 h-4" /> {t(`${K}.scan.stop`)}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={scan.start}
              disabled={!hasPermission('discovery:scan') || !scan.cidr || probing || adding}
              title={!hasPermission('discovery:scan') ? t(`${K}.scan.noPermission`) : undefined}
            >
              <Radar className="w-4 h-4" /> {t(`${K}.scan.start`)}
            </Button>
          )}
          <span className="text-sm text-bambu-gray">
            {scan.running && <Loader2 className="inline w-4 h-4 mr-1 animate-spin" />}
            {(scan.running || scan.found.length > 0) &&
              t(`${K}.scan.progress`, {
                scanned: scan.progress.scanned,
                total: scan.progress.total,
                found: scan.found.length,
                existing: foundInBambuddy,
              })}
          </span>
          {scan.error && (
            <span className="text-sm text-red-400">
              {['invalid_subnet', 'subnet_too_large', 'scan_running'].includes(scan.error)
                ? t(`${K}.scan.error.${scan.error}`)
                : scan.error}
            </span>
          )}
          <p className="basis-full text-xs text-bambu-gray">{t(`${K}.scan.hint`)}</p>
        </CardContent>
      </Card>

      {pasteOpen && (
        <Card className="mb-4">
          <CardContent>
            <p className="text-sm text-bambu-gray mb-2">{t(`${K}.pasteHint`)}</p>
            <textarea
              className="w-full h-40 px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white font-mono text-sm focus:border-bambu-green focus:outline-none"
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={CSV_TEMPLATE}
              aria-label={t(`${K}.paste`)}
            />
            <div className="flex justify-end mt-2">
              <Button
                onClick={() => {
                  load(pasteText);
                  setPasteOpen(false);
                }}
                disabled={!pasteText.trim()}
              >
                {t(`${K}.pasteLoad`)}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {rows.length === 0 ? (
        <Card>
          <CardContent className="text-sm text-bambu-gray space-y-2">
            <p>{t(`${K}.emptyHint`)}</p>
            <p className="font-mono text-xs whitespace-pre text-bambu-gray-light">{CSV_TEMPLATE}</p>
            <p>{t(`${K}.columnsHint`)}</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-bambu-gray border-b border-bambu-dark-tertiary">
                  <th className="px-2 py-2 w-8">#</th>
                  <th className="px-2 py-2 min-w-[9rem]">{t(`${K}.col.name`)}</th>
                  <th className="px-2 py-2 min-w-[8rem]">{t(`${K}.col.ip`)}</th>
                  <th className="px-2 py-2 min-w-[7rem]">{t(`${K}.col.accessCode`)}</th>
                  <th className="px-2 py-2 min-w-[11rem]">{t(`${K}.col.serial`)}</th>
                  <th className="px-2 py-2 min-w-[7rem]">{t(`${K}.col.model`)}</th>
                  <th className="px-2 py-2 min-w-[7rem]">{t(`${K}.col.location`)}</th>
                  <th className="px-2 py-2" title={t('printers.autoArchive')}>{t(`${K}.col.autoArchive`)}</th>
                  <th className="px-2 py-2 min-w-[8rem]">{t(`${K}.col.status`)}</th>
                  <th className="px-2 py-2 w-8" />
                </tr>
              </thead>
              <tbody onKeyDown={onTableKeyDown}>
                {rows.map((row, index) => {
                  const locked = row.status === 'added' || row.status === 'adding' || adding;
                  const serialCell = cell(row, 'serial');
                  return (
                    <tr key={row.key} className="border-b border-bambu-dark-tertiary/60 align-middle" data-testid="import-row">
                      <td className="px-2 py-1 text-bambu-gray">{index + 1}</td>
                      <td className="px-2 py-1">
                        <input
                          {...cell(row, 'name')}
                          value={row.name}
                          disabled={locked}
                          aria-label={t(`${K}.col.name`)}
                          data-col="name"
                          data-row={index}
                          onChange={(e) => update(row.key, { name: e.target.value })}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          {...cell(row, 'ip')}
                          value={row.ip}
                          disabled={locked}
                          aria-label={t(`${K}.col.ip`)}
                          data-col="ip"
                          data-row={index}
                          onChange={(e) => update(row.key, { ip: e.target.value, probe: undefined })}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          {...cell(row, 'accessCode')}
                          value={row.accessCode}
                          disabled={locked}
                          aria-label={t(`${K}.col.accessCode`)}
                          data-col="accessCode"
                          data-row={index}
                          className={`${cell(row, 'accessCode').className} font-mono`}
                          onChange={(e) => update(row.key, { accessCode: e.target.value })}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <div className="flex items-center gap-1">
                          <input
                            {...serialCell}
                            className={`${serialCell.className} font-mono`}
                            value={row.serial}
                            disabled={locked}
                            aria-label={t(`${K}.col.serial`)}
                            data-col="serial"
                            data-row={index}
                            placeholder={row.probe === 'reading' ? t(`${K}.reading`) : t(`${K}.serialPlaceholder`)}
                            onChange={(e) =>
                              update(row.key, { serial: e.target.value.toUpperCase(), serialSource: 'manual' })
                            }
                          />
                          {row.probe === 'reading' && <Loader2 className="w-4 h-4 animate-spin text-bambu-gray shrink-0" />}
                          {row.serial && row.serialSource && row.serialSource !== 'manual' && row.serialSource !== 'csv' && (
                            <span
                              className="text-[10px] px-1 rounded bg-bambu-dark-tertiary text-bambu-gray shrink-0"
                              title={t(`${K}.source.${row.serialSource}`)}
                            >
                              {t(`${K}.sourceShort.${row.serialSource}`)}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-1">
                        <select
                          {...cell(row, 'model')}
                          value={row.model}
                          disabled={locked}
                          aria-label={t(`${K}.col.model`)}
                          onChange={(e) => update(row.key, { model: e.target.value })}
                        >
                          <option value="">—</option>
                          {!MODEL_OPTIONS.includes(row.model) && row.model && <option value={row.model}>{row.model}</option>}
                          {MODEL_OPTIONS.map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-1">
                        <input
                          className={`${inputBase} border-bambu-dark-tertiary focus:border-bambu-green`}
                          value={row.location}
                          disabled={locked}
                          maxLength={100}
                          aria-label={t(`${K}.col.location`)}
                          data-col="location"
                          data-row={index}
                          onChange={(e) => update(row.key, { location: e.target.value })}
                        />
                      </td>
                      <td className="px-2 py-1 text-center">
                        <input
                          type="checkbox"
                          checked={row.autoArchive}
                          disabled={locked}
                          aria-label={t(`${K}.col.autoArchive`)}
                          onChange={(e) => update(row.key, { autoArchive: e.target.checked })}
                        />
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap">{statusCell(row)}</td>
                      <td className="px-2 py-1">
                        {row.status !== 'added' && (
                          <button
                            type="button"
                            disabled={locked}
                            onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                            className="p-1 rounded text-bambu-gray hover:text-red-400 disabled:opacity-40"
                            aria-label={t(`${K}.removeRow`)}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {rows.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <label className="inline-flex items-center gap-2 text-sm text-white" title={t(`${K}.verifyHint`)}>
            <input type="checkbox" checked={verify} disabled={adding} onChange={(e) => setVerify(e.target.checked)} />
            {t(`${K}.verify`)}
          </label>
          <span className="text-sm text-bambu-gray">
            {t(`${K}.summary`, { ready: ready.length, blocked, added: rows.length - pending.length })}
          </span>
          <div className="flex-1" />
          {adding ? (
            <Button variant="secondary" onClick={() => (stopRequested.current = true)}>
              <Square className="w-4 h-4" /> {t(`${K}.stop`)}
            </Button>
          ) : (
            <Button onClick={addAll} disabled={!allowed || probing || ready.length === 0}>
              <Plus className="w-4 h-4" /> {t(`${K}.addAll`, { count: ready.length })}
            </Button>
          )}
        </div>
      )}
      <p className="mt-2 text-xs text-bambu-gray max-w-3xl">{verify ? t(`${K}.verifyHint`) : t(`${K}.skipHint`)}</p>
    </div>
  );
}
