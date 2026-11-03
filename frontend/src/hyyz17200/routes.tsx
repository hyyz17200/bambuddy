import type { ReactElement } from 'react';
import { Navigate, Route } from 'react-router-dom';
import { lazyPage } from '../utils/lazyPage';

const EnhancedSettingsPage = lazyPage(() => import('./EnhancedSettingsPage'), 'EnhancedSettingsPage');

/** The fork's pages, as `<Route>` elements inside the main layout. Give each a
 *  `key`, and load pages with lazyPage as App.tsx does. */
export const hyyz17200Routes: ReactElement[] = [
  <Route key="settings" path="hyyz17200/settings" element={<EnhancedSettingsPage />} />,
  // Hidden faults had a page of their own before Enhanced Settings.
  <Route
    key="hidden-faults"
    path="hyyz17200/hidden-faults"
    element={<Navigate to="/hyyz17200/settings?tab=hidden-faults" replace />}
  />,
];
