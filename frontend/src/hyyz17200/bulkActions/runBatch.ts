export interface BatchResult<P, R> {
  ok: { printer: P; result: R }[];
  failed: { printer: P; error: string }[];
}

/** Runs `task` for every printer, a few at a time so a large farm does not
 *  open dozens of printer commands at once. Never throws. */
export async function runBatch<P, R>(
  printers: P[],
  task: (printer: P) => Promise<R>,
  limit = 4,
): Promise<BatchResult<P, R>> {
  const result: BatchResult<P, R> = { ok: [], failed: [] };
  let next = 0;
  const worker = async () => {
    while (next < printers.length) {
      const printer = printers[next++];
      try {
        result.ok.push({ printer, result: await task(printer) });
      } catch (error) {
        result.failed.push({ printer, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, printers.length) }, worker));
  // Keep the caller's order regardless of which finished first.
  const order = new Map(printers.map((p, i) => [p, i]));
  result.ok.sort((a, b) => order.get(a.printer)! - order.get(b.printer)!);
  result.failed.sort((a, b) => order.get(a.printer)! - order.get(b.printer)!);
  return result;
}
