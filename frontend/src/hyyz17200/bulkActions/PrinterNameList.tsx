/** The printers an action is about to touch, for a confirm dialog. */
export function PrinterNameList({ printers }: { printers: { id: number; name: string }[] }) {
  if (!printers.length) return null;
  return (
    <ul className="mt-3 max-h-40 overflow-y-auto rounded-lg bg-bambu-dark px-3 py-2 text-sm text-bambu-gray-light space-y-0.5">
      {printers.map((p) => (
        <li key={p.id} className="truncate">{p.name}</li>
      ))}
    </ul>
  );
}
