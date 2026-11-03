import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { enhancedSettingsSections } from './settingsSections';

/** One page for every setting the fork's patches add, a tab per feature. Laid out
 *  like upstream's Settings page: `?tab=<id>` picks the tab (the first needs none),
 *  tabs run across the top on small screens and down a rail on lg+. */
export function EnhancedSettingsPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [first] = enhancedSettingsSections;
  const active = enhancedSettingsSections.find((section) => section.id === searchParams.get('tab')) ?? first;

  const openTab = (id: string) => {
    if (id === first.id) searchParams.delete('tab');
    else searchParams.set('tab', id);
    setSearchParams(searchParams, { replace: true });
  };

  return (
    <div className="p-4 md:p-8">
      <h1 className="text-2xl font-bold text-white mb-2">{t('hyyz17200.enhancedSettings.title')}</h1>
      <p className="text-sm text-bambu-gray mb-6">{t('hyyz17200.enhancedSettings.description')}</p>

      <div className="flex flex-col lg:flex-row gap-4 lg:gap-6">
        <nav
          aria-label={t('hyyz17200.enhancedSettings.title')}
          className="flex flex-wrap gap-1 border-b border-bambu-dark-tertiary lg:flex-col lg:flex-nowrap lg:gap-0 lg:border-b-0 lg:border-r lg:w-60 lg:flex-shrink-0 lg:self-start lg:sticky lg:top-4"
        >
          {enhancedSettingsSections.map(({ id, icon: Icon, titleKey }) => (
            <button
              key={id}
              type="button"
              aria-current={id === active.id ? 'page' : undefined}
              onClick={() => openTab(id)}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px lg:border-b-0 lg:border-l-2 lg:-ml-px lg:mb-0 lg:justify-start flex items-center gap-2 ${
                id === active.id
                  ? 'text-bambu-green border-bambu-green'
                  : 'text-bambu-gray hover:text-gray-900 dark:hover:text-white border-transparent'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {t(titleKey)}
            </button>
          ))}
        </nav>
        <div className="flex-1 min-w-0 max-w-4xl">
          <h2 className="text-lg font-semibold text-white mb-2">{t(active.titleKey)}</h2>
          <active.Component key={active.id} />
        </div>
      </div>
    </div>
  );
}
