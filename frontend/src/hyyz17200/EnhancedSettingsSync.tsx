import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { ENHANCED_SETTINGS_QUERY_KEY, getEnhancedSettings } from './enhancedSettingsApi';
import { applyCamWall } from './camWallSettings';
import { applyQuickColors } from './quickColors';
import { applyWideGrid } from './wideGrid';

const REFRESH_MS = 60_000;

/** Applies the Enhanced Settings that take effect outside their page. Saving on
 *  the page updates the same query, so a change shows at once. Like
 *  HiddenFaultsSync, a kiosk wall with auth on has no user and never fetches. */
export function EnhancedSettingsSync() {
  const { authEnabled, loading, user } = useAuth();
  const { data } = useQuery({
    queryKey: ENHANCED_SETTINGS_QUERY_KEY,
    queryFn: getEnhancedSettings,
    enabled: !loading && (!authEnabled || user !== null),
    refetchInterval: REFRESH_MS,
  });

  useEffect(() => {
    if (!data) return;
    applyWideGrid(data.wide_grid);
    applyQuickColors(data.quick_colors);
    applyCamWall(data.cam_wall);
  }, [data]);

  return null;
}
