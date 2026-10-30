import { describe, expect, it } from 'vitest';
import { i18nReady, localeBackend } from '../../i18n';
import i18n from '../../i18n';

describe('hyyz17200 mount points', () => {
  it('adds the fork strings to the bundled English', async () => {
    await i18nReady;
    expect(i18n.getResource('en', 'translation', 'hyyz17200.inAppUpdateLocked')).toMatch(/disabled on this fork/);
  });

  it('adds the fork strings to a language loaded on demand, keeping upstream strings', async () => {
    const loaded = await new Promise<Record<string, unknown>>((resolve, reject) => {
      localeBackend.read('zh-CN', 'translation', (error, data) => {
        if (error) reject(error);
        else resolve(data as Record<string, unknown>);
      });
    });

    expect(loaded.nav).toBeDefined();
    expect(loaded.hyyz17200).toMatchObject({ inAppUpdateLocked: expect.stringContaining('fork') });
  });
});
