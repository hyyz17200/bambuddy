import type { ReactElement } from 'react';
import { Route } from 'react-router-dom';
import { lazyPage } from '../utils/lazyPage';

const HiddenFaultsPage = lazyPage(() => import('./HiddenFaultsPage'), 'HiddenFaultsPage');

/** The fork's pages, as `<Route>` elements inside the main layout. Give each a
 *  `key`, and load pages with lazyPage as App.tsx does. */
export const hyyz17200Routes: ReactElement[] = [
  <Route key="hidden-faults" path="hyyz17200/hidden-faults" element={<HiddenFaultsPage />} />,
];
