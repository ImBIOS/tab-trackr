import { useCallback, useEffect, useRef, useState } from 'react';
import { logger } from '../lib/logger';

interface TabSession {
  url: string;
  domain: string;
  title: string;
  startTime: number;
  lastActive: number;
  totalTime: number;
  isActive: boolean;
}

interface DailyStats {
  date: string;
  domains: Record<string, number>;
  totalTime: number;
  sessions: TabSession[];
}

interface SyncStatus {
  lastSync: string | null;
  isOnline: boolean;
  pendingSessions: number;
}

export interface UseTabTrackingDataReturn {
  dailyStats: DailyStats | null;
  currentSession: TabSession | null;
  isTrackingEnabled: boolean;
  syncStatus: SyncStatus | null;
  isLoading: boolean;
  error: string | null;
  loadData: () => Promise<void>;
}

export function useTabTrackingData(): UseTabTrackingDataReturn {
  const [dailyStats, setDailyStats] = useState<DailyStats | null>(null);
  const [currentSession, setCurrentSession] = useState<TabSession | null>(null);
  const [isTrackingEnabled, setIsTrackingEnabled] = useState(true);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isLoadingRef = useRef(false);
  const hasLoadedOnceRef = useRef(false);
  const intervalRef = useRef<number | null>(null);

  // Wrapper that times out a message call and logs a per-call warning without throwing
  const callWithTimeout = useCallback(
    async <T>(action: string, timeoutMs = 3000): Promise<T | null> => {
      try {
        const responsePromise = browser.runtime.sendMessage({ action }) as Promise<T>;
        const timeoutPromise = new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), timeoutMs);
        });
        const result = (await Promise.race([responsePromise, timeoutPromise])) as T | null;
        if (result === null) {
          logger.warn(
            `Popup data: failed to load ${action.toLowerCase().replace('get_', '').replace(/_/g, ' ')}`,
            {
              component: 'useTabTrackingData',
              reason: `Timed out: ${action}`,
            }
          );
          return null;
        }
        return result;
      } catch (err) {
        logger.warn(
          `Popup data: failed to load ${action.toLowerCase().replace('get_', '').replace(/_/g, ' ')}`,
          {
            component: 'useTabTrackingData',
            reason: err instanceof Error ? err.message : 'Unknown error',
          }
        );
        return null;
      }
    },
    []
  );

  const loadData = useCallback(async () => {
    if (isLoadingRef.current) {
      // Prevent overlapping loads which caused duplicate timers and flicker
      return;
    }
    isLoadingRef.current = true;

    // Only time when not already timing this logical load
    logger.debug('Loading popup data', { component: 'useTabTrackingData' });
    logger.time('TabTrackingData Load');

    try {
      setIsLoading(!hasLoadedOnceRef.current);
      setError(null);

      const [statsResponse, sessionResponse, trackingResponse, syncResponse] = await Promise.all([
        callWithTimeout<DailyStats | null>('GET_DAILY_STATS'),
        callWithTimeout<TabSession | null>('GET_CURRENT_SESSION'),
        callWithTimeout<boolean>('GET_TRACKING_STATUS'),
        callWithTimeout<SyncStatus>('GET_SYNC_STATUS'),
      ]);

      if (statsResponse !== null) {
        setDailyStats(statsResponse);
      }
      if (sessionResponse !== null) {
        setCurrentSession(sessionResponse);
      }
      if (typeof trackingResponse === 'boolean') {
        setIsTrackingEnabled(trackingResponse);
      }
      if (syncResponse !== null) {
        setSyncStatus(syncResponse);
      }

      logger.timeEnd('TabTrackingData Load');
      logger.info('Tab tracking data loaded (partial ok)', {
        component: 'useTabTrackingData',
        hasStats: !!statsResponse,
        hasSession: !!sessionResponse,
        trackingEnabled: (trackingResponse as unknown as boolean) ?? undefined,
      });
    } catch (err) {
      logger.timeEnd('TabTrackingData Load');
      logger.error('Failed to load tab tracking data', err as Error, {
        component: 'useTabTrackingData',
      });
      setError('Failed to load tracking data');
    } finally {
      setIsLoading(false);
      isLoadingRef.current = false;
      hasLoadedOnceRef.current = true;
    }
  }, [callWithTimeout]);

  useEffect(() => {
    loadData();

    // Clear existing interval if any (hot-reloads/StrictMode)
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    intervalRef.current = setInterval(() => {
      logger.trace('Auto-refreshing tab tracking data', { component: 'useTabTrackingData' });
      loadData();
    }, 5000) as unknown as number;

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [loadData]);

  return {
    dailyStats,
    currentSession,
    isTrackingEnabled,
    syncStatus,
    isLoading,
    error,
    loadData,
  };
}
