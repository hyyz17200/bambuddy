import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const CHANNELS = ['r', 'g', 'b'] as const;

const isHex6 = (value: string) => /^[0-9A-Fa-f]{6}$/.test(value);

function toChannels(hex: string): string[] {
  return CHANNELS.map((_, i) => String(parseInt(hex.slice(i * 2, i * 2 + 2), 16)));
}

const toHex = (channels: string[]) =>
  channels.map((value) => Number(value).toString(16).padStart(2, '0')).join('').toUpperCase();

/** Three 0–255 boxes under a colour field, another view of the same `hex`.
 *  A valid `hex` from anywhere (typed, a swatch, a colour name) shows here at
 *  once; an empty one empties the boxes. Once all three are filled in, an edit
 *  here reports the new hex. A half-typed box only stays here, so the colour
 *  never clears while someone retypes a value. `placeholderHex` (the colour
 *  shown when `hex` is empty) goes into the empty boxes as a hint. */
export function Hyyz17200RgbInputs({
  hex,
  placeholderHex,
  onChange,
}: {
  hex: string;
  placeholderHex?: string;
  onChange: (hex: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string[]>(() => (isHex6(hex) ? toChannels(hex) : ['', '', '']));

  useEffect(() => {
    if (isHex6(hex)) {
      setDraft((old) => (old.every((v) => v !== '') && toHex(old) === hex.toUpperCase() ? old : toChannels(hex)));
    } else if (hex === '') {
      setDraft(['', '', '']);
    }
  }, [hex]);

  const hint = placeholderHex && isHex6(placeholderHex.slice(0, 6)) ? toChannels(placeholderHex.slice(0, 6)) : null;

  const edit = (index: number, raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 3);
    const value = digits === '' ? '' : String(Math.min(255, Number(digits)));
    const next = draft.map((old, i) => (i === index ? value : old));
    setDraft(next);
    if (next.every((v) => v !== '')) {
      const nextHex = toHex(next);
      if (nextHex !== hex.toUpperCase()) onChange(nextHex);
    }
  };

  return (
    <div className="flex items-center gap-2 mt-2" data-testid="hyyz17200-rgb-inputs">
      {CHANNELS.map((channel, i) => (
        <label key={channel} className="flex items-center gap-1 text-xs text-bambu-gray">
          <span className="w-3 font-mono uppercase">{channel}</span>
          <input
            type="text"
            inputMode="numeric"
            value={draft[i]}
            placeholder={hint?.[i]}
            onChange={(e) => edit(i, e.target.value)}
            onFocus={(e) => e.target.select()}
            aria-label={t(`hyyz17200.rgbInputs.${channel}`)}
            className="w-14 px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded-md text-white text-sm font-mono text-right placeholder:text-bambu-gray/50 focus:border-bambu-green focus:outline-none"
          />
        </label>
      ))}
    </div>
  );
}
