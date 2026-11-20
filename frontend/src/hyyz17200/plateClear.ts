/** A printer's own "Require plate-clear confirmation" (upstream #2860): null follows the app setting. */
export type PlateClearOverride = boolean | null;
export type PlateClearChoice = 'follow' | 'on' | 'off';

export const PLATE_CLEAR_CHOICES: PlateClearChoice[] = ['follow', 'on', 'off'];

export function choiceOf(value: PlateClearOverride | undefined): PlateClearChoice {
  return value === true ? 'on' : value === false ? 'off' : 'follow';
}

export function overrideOf(choice: PlateClearChoice): PlateClearOverride {
  return choice === 'on' ? true : choice === 'off' ? false : null;
}

/** Whether the confirmation holds this printer, as upstream's plate_clear.applies decides. */
export function plateClearApplies(value: PlateClearOverride | undefined, setting: boolean): boolean {
  return value === true || value === false ? value : setting;
}
