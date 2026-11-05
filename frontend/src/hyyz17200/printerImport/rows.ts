import { mapModelCode } from '../../utils/printerModel';

/** The models upstream's Add Printer dialog offers, in its order. */
export const MODEL_OPTIONS = [
  'A1', 'A1 Mini', 'A2L', 'H2C', 'H2D', 'H2D Pro', 'H2S', 'P1P', 'P1S', 'P2S', 'X1', 'X1C', 'X1E', 'X2D',
];

// The schema's own pattern (PrinterBase.ip_address): an IPv4 address or a host name.
const IP_PATTERN =
  /^(\d{1,3}(\.\d{1,3}){3}|[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)$/;
const SERIAL_PATTERN = /^[0-9A-Z]{8,20}$/;

export type SerialSource = 'csv' | 'manual' | 'ssdp' | 'certificate';

export interface ImportRow {
  key: number;
  name: string;
  ip: string;
  accessCode: string;
  serial: string;
  model: string;
  location: string;
  autoArchive: boolean;
  serialSource: SerialSource | null;
  /** Reading the serial from the IP: in flight, or nothing answered. */
  probe?: 'reading' | 'failed' | 'virtual';
  status: 'draft' | 'adding' | 'added' | 'failed';
  error?: string;
  printerId?: number;
}

let nextKey = 1;

export function emptyRow(fields: Partial<ImportRow> = {}): ImportRow {
  return {
    key: nextKey++,
    name: '',
    ip: '',
    accessCode: '',
    serial: '',
    model: '',
    location: '',
    autoArchive: true,
    serialSource: null,
    status: 'draft',
    ...fields,
  };
}

/** A model as typed or as SSDP reports it ("N2S", "a1 mini", "X1 Carbon")
 *  as one of MODEL_OPTIONS; anything else comes back unchanged. */
export function normalizeModel(value: string | null | undefined): string {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  const squash = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '').replace(/^bambulab/, '');
  const mapped = mapModelCode(raw);
  for (const candidate of [mapped, raw]) {
    const found = MODEL_OPTIONS.find((m) => squash(m) === squash(candidate));
    if (found) return found;
  }
  if (squash(raw) === 'x1carbon') return 'X1C';
  return raw;
}

// --- CSV --------------------------------------------------------------------

const BOM_PREFIX = new RegExp(`^${String.fromCharCode(0xfeff)}`);

/** RFC 4180 CSV, with the delimiter (`,` `;` or tab) guessed from the first line. */
export function parseCsv(text: string): string[][] {
  const body = text.replace(BOM_PREFIX, '');
  const firstLine = body.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best,
  );
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

type Column = 'name' | 'ip' | 'accessCode' | 'serial' | 'model' | 'location' | 'autoArchive';

const HEADER_ALIASES: Record<Column, string[]> = {
  name: ['name', 'printername', '名称', '名字', '打印机', '打印机名称'],
  ip: ['ip', 'ipaddress', 'ip地址', '地址', 'host', 'hostname'],
  accessCode: ['accesscode', 'access', 'code', 'lancode', '访问码', '访问代码', '局域网访问码'],
  serial: ['serial', 'serialnumber', 'sn', '序列号'],
  model: ['model', 'type', '型号', '机型'],
  location: ['location', 'group', '位置', '分组', '位置分组'],
  autoArchive: ['autoarchive', 'archive', '自动归档', '归档'],
};

/** Columns in this order when the file has no header row. */
export const DEFAULT_COLUMNS: Column[] = ['name', 'ip', 'accessCode', 'model', 'location', 'serial'];

function headerColumn(cell: string): Column | null {
  const key = cell
    .toLowerCase()
    .replace(/[(（][^)）]*[)）]/g, '')
    .replace(/[\s_\-.]+/g, '');
  for (const [column, aliases] of Object.entries(HEADER_ALIASES) as [Column, string[]][]) {
    if (aliases.includes(key)) return column;
  }
  return null;
}

function parseBool(value: string): boolean | undefined {
  const v = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on', '是', '开'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'off', '否', '关'].includes(v)) return false;
  return undefined;
}

/** Table rows from a CSV file's text. A header row is recognised by its
 *  names (English or Chinese, any order); without one the columns are
 *  DEFAULT_COLUMNS. */
export function rowsFromCsv(text: string): ImportRow[] {
  const table = parseCsv(text);
  if (table.length === 0) return [];
  const headed = table[0].map(headerColumn);
  const hasHeader = headed.some((c) => c !== null);
  const columns = hasHeader ? headed : DEFAULT_COLUMNS;
  return (hasHeader ? table.slice(1) : table).map((cells) => {
    const row = emptyRow();
    columns.forEach((column, i) => {
      const value = (cells[i] ?? '').trim();
      if (!column || !value) return;
      if (column === 'autoArchive') {
        const flag = parseBool(value);
        if (flag !== undefined) row.autoArchive = flag;
      } else if (column === 'model') {
        row.model = normalizeModel(value);
      } else if (column === 'serial') {
        row.serial = value.toUpperCase();
        row.serialSource = 'csv';
      } else {
        row[column] = value;
      }
    });
    return row;
  });
}

export const CSV_TEMPLATE = 'name,ip,access_code,model,location,serial\nA1-01,192.168.1.101,12345678,A1,Rack 1,\n';

// --- Checks -----------------------------------------------------------------

export interface ExistingPrinter {
  name: string;
  serial_number: string;
  ip_address: string;
}

export type Field = 'name' | 'ip' | 'accessCode' | 'serial' | 'model';

export interface Problem {
  field: Field;
  /** Blocking problems keep the row from being added; warnings do not. */
  level: 'error' | 'warning';
  key: string;
  params?: Record<string, string>;
}

const norm = (s: string) => s.trim().toLowerCase();

/** What is wrong with a row, given the other rows and the printers already in
 *  Bambuddy. Rows already added are not checked. */
export function rowProblems(row: ImportRow, rows: ImportRow[], existing: ExistingPrinter[]): Problem[] {
  if (row.status === 'added') return [];
  const problems: Problem[] = [];
  const others = rows.filter((r) => r.key !== row.key);
  const ip = norm(row.ip);
  const serial = row.serial.trim().toUpperCase();

  if (!row.name.trim()) problems.push({ field: 'name', level: 'error', key: 'required' });
  else if (row.name.trim().length > 100) problems.push({ field: 'name', level: 'error', key: 'tooLong' });
  else if (others.some((r) => norm(r.name) === norm(row.name)) || existing.some((p) => norm(p.name) === norm(row.name)))
    problems.push({ field: 'name', level: 'warning', key: 'duplicateName' });

  if (!ip) problems.push({ field: 'ip', level: 'error', key: 'required' });
  else if (!IP_PATTERN.test(row.ip.trim())) problems.push({ field: 'ip', level: 'error', key: 'badIp' });
  else if (others.some((r) => norm(r.ip) === ip)) problems.push({ field: 'ip', level: 'error', key: 'duplicateInTable' });
  else {
    const taken = existing.find((p) => norm(p.ip_address) === ip);
    if (taken) problems.push({ field: 'ip', level: 'error', key: 'alreadyAdded', params: { name: taken.name } });
  }

  const code = row.accessCode.trim();
  if (!code) problems.push({ field: 'accessCode', level: 'error', key: 'required' });
  else if (code.length > 20) problems.push({ field: 'accessCode', level: 'error', key: 'tooLong' });
  else if (/^\d{1,7}$/.test(code)) problems.push({ field: 'accessCode', level: 'warning', key: 'shortCode' });

  if (!serial) {
    if (row.probe !== 'reading') problems.push({ field: 'serial', level: 'error', key: row.probe ? 'notRead' : 'required' });
  } else if (!SERIAL_PATTERN.test(serial)) problems.push({ field: 'serial', level: 'error', key: 'badSerial' });
  else if (others.some((r) => r.serial.trim().toUpperCase() === serial))
    problems.push({ field: 'serial', level: 'error', key: 'duplicateInTable' });
  else {
    const taken = existing.find((p) => p.serial_number.toUpperCase() === serial);
    if (taken) problems.push({ field: 'serial', level: 'error', key: 'alreadyAdded', params: { name: taken.name } });
  }

  if (!row.model) problems.push({ field: 'model', level: 'warning', key: 'noModel' });
  else if (!MODEL_OPTIONS.includes(row.model)) problems.push({ field: 'model', level: 'warning', key: 'unknownModel' });

  return problems;
}

// --- Merging ----------------------------------------------------------------

export interface Discovered {
  serial: string;
  name: string;
  ip_address: string;
  model: string | null;
}

const ipOrder = (ip: string) =>
  ip.split('.').reduce((n, part) => n * 256 + (Number.parseInt(part, 10) || 0), 0);

/** Rows for printers a network scan found, added to the table. A printer
 *  already in Bambuddy (same IP or serial) or already in the table is left out;
 *  a table row for the same IP only gets the serial, model and name it lacks.
 *  New rows come in IP order. */
export function mergeDiscovered(current: ImportRow[], found: Discovered[], existing: ExistingPrinter[]): ImportRow[] {
  const byIp = new Map(current.map((r) => [norm(r.ip), r]));
  const updated = new Map<number, ImportRow>();
  const added: ImportRow[] = [];
  for (const printer of [...found].sort((a, b) => ipOrder(a.ip_address) - ipOrder(b.ip_address))) {
    const ip = norm(printer.ip_address);
    // Upstream's scan names a printer that did not answer SSDP "unknown-…" / "Printer at …".
    const serial = printer.serial.startsWith('unknown-') ? '' : printer.serial.toUpperCase();
    // No broadcast heard: the serial stands in, as the probe does, so the row is not blocked on a name.
    const name = (printer.name && !printer.name.startsWith('Printer at ') ? printer.name : '') || serial;
    const model = normalizeModel(mapModelCode(printer.model));
    if (existing.some((p) => norm(p.ip_address) === ip || (serial && p.serial_number.toUpperCase() === serial))) continue;
    const row = byIp.get(ip);
    if (row) {
      if (row.status === 'added' || row.status === 'adding') continue;
      const patch: Partial<ImportRow> = {};
      if (!row.serial && serial) Object.assign(patch, { serial, serialSource: 'ssdp', probe: undefined });
      if (!row.model && model) patch.model = model;
      if (!row.name && name) patch.name = name;
      if (Object.keys(patch).length) updated.set(row.key, { ...row, ...patch });
      continue;
    }
    const fresh = emptyRow({ ip: printer.ip_address, serial, serialSource: serial ? 'ssdp' : null, model, name });
    byIp.set(ip, fresh);
    added.push(fresh);
  }
  if (added.length === 0 && updated.size === 0) return current;
  return [...current.map((r) => updated.get(r.key) ?? r), ...added];
}

/** CSV rows merged into the table by IP: a CSV value fills or replaces the
 *  row's, an empty CSV cell keeps it. So a scan can be followed by a CSV that
 *  only carries IPs and access codes. Rows for other IPs are appended. */
export function mergeCsvRows(current: ImportRow[], loaded: ImportRow[]): ImportRow[] {
  const result = [...current];
  for (const row of loaded) {
    const index = row.ip ? result.findIndex((r) => norm(r.ip) === norm(row.ip) && r.status !== 'added') : -1;
    if (index < 0) {
      result.push(row);
      continue;
    }
    const target = { ...result[index] };
    if (row.name) target.name = row.name;
    if (row.accessCode) target.accessCode = row.accessCode;
    if (row.model) target.model = row.model;
    if (row.location) target.location = row.location;
    if (row.serial) Object.assign(target, { serial: row.serial, serialSource: 'csv', probe: undefined });
    target.autoArchive = row.autoArchive;
    if (target.status === 'failed') Object.assign(target, { status: 'draft', error: undefined });
    result[index] = target;
  }
  return result;
}
