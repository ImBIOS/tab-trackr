import { logger } from './logger';
import { supabase } from './supabase';
import type { DailyStats, TabSession } from './types';

interface SyncStatus {
  lastSync: string | null;
  isOnline: boolean;
  pendingSessions: number;
}

class DataSyncService {
  private syncInterval: number | null = null;
  private readonly SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  private readonly STORAGE_KEY_SYNC_STATUS = 'sync_status';
  private readonly STORAGE_KEY_PENDING_SESSIONS = 'pending_sessions';
  private readonly RETRY_DELAY_MS = 30_000; // 30 seconds

  async initialize() {
    logger.info('Initializing DataSyncService', { component: 'DataSyncService' });

    if (!supabase) {
      logger.info('Supabase client not available, skipping sync initialization', {
        component: 'DataSyncService',
      });
      return;
    }

    // Check if user is authenticated
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      logger.info('No authenticated session, sync disabled', { component: 'DataSyncService' });
      return;
    }

    // Start periodic sync
    this.startPeriodicSync();

    // Listen for auth changes
    supabase.auth.onAuthStateChange((event, stateChangeSession) => {
      if (event === 'SIGNED_IN' && stateChangeSession) {
        logger.info('User signed in, starting sync', { component: 'DataSyncService' });
        this.startPeriodicSync();
      } else if (event === 'SIGNED_OUT') {
        logger.info('User signed out, stopping sync', { component: 'DataSyncService' });
        this.stopPeriodicSync();
      }
    });

    logger.info('DataSyncService initialized', { component: 'DataSyncService' });
  }

  private startPeriodicSync() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }

    // Initial sync
    this.syncData();

    // Periodic sync
    this.syncInterval = setInterval(() => {
      this.syncData();
    }, this.SYNC_INTERVAL_MS) as unknown as number;
  }

  private stopPeriodicSync() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  async syncData(): Promise<boolean> {
    if (!supabase) {
      logger.debug('Supabase not configured; skipping syncData()', {
        component: 'DataSyncService',
      });
      await this.updateSyncStatus({ isOnline: false });
      return false;
    }

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        logger.debug('No user authenticated for sync', { component: 'DataSyncService' });
        return false;
      }

      logger.debug('Starting data sync', { component: 'DataSyncService' });

      // Sync pending sessions first
      await this.syncPendingSessions(user.id);

      // Sync daily stats
      await this.syncDailyStats(user.id);

      await this.updateSyncStatus({
        lastSync: new Date().toISOString(),
        isOnline: true,
        pendingSessions: 0,
      });

      logger.info('Data sync completed successfully', { component: 'DataSyncService' });
      return true;
    } catch (error) {
      logger.error('Data sync failed', error as Error, { component: 'DataSyncService' });

      await this.updateSyncStatus({
        lastSync: null,
        isOnline: false,
        pendingSessions: await this.getPendingSessionsCount(),
      });

      // Retry after delay
      setTimeout(() => {
        this.syncData();
      }, this.RETRY_DELAY_MS);

      return false;
    }
  }

  private async syncPendingSessions(userId: string) {
    const pendingSessions = await this.getPendingSessions();

    if (pendingSessions.length === 0 || !supabase) {
      return;
    }

    logger.debug('Syncing pending sessions', {
      component: 'DataSyncService',
      count: pendingSessions.length,
    });

    // Convert TabSession to database format
    const sessionsToInsert = pendingSessions.map((session) => ({
      user_id: userId,
      url: session.url,
      domain: session.domain,
      title: session.title,
      start_time: new Date(session.startTime).toISOString(),
      end_time: new Date(session.startTime + session.totalTime).toISOString(),
      duration_ms: session.totalTime,
      date: new Date(session.startTime).toISOString().split('T')[0] ?? '',
      is_active: false, // These are completed sessions
    }));

    const { error } = await supabase.from('browsing_sessions').insert(sessionsToInsert);

    if (error) {
      logger.error('Failed to sync pending sessions', error, { component: 'DataSyncService' });
      throw error;
    }

    // Clear pending sessions after successful sync
    await this.clearPendingSessions();

    logger.info('Pending sessions synced successfully', {
      component: 'DataSyncService',
      syncedCount: pendingSessions.length,
    });
  }

  private async syncDailyStats(userId: string) {
    // Get local daily stats
    const stored = await browser.storage.local.get('daily_stats');
    const dailyStats = stored.daily_stats as DailyStats | undefined;

    if (!dailyStats || dailyStats.totalTime === 0 || !supabase) {
      return;
    }

    logger.debug('Syncing daily stats', {
      component: 'DataSyncService',
      date: dailyStats.date,
      totalTime: dailyStats.totalTime,
    });

    // Check if daily stats already exist for today
    const { data: existingStats, error: fetchError } = await supabase
      .from('daily_stats')
      .select('*')
      .eq('user_id', userId)
      .eq('date', dailyStats.date)
      .maybeSingle();

    if (fetchError && fetchError.code !== 'PGRST116') {
      // PGRST116 = no rows returned
      logger.error('Failed to fetch existing daily stats', fetchError, {
        component: 'DataSyncService',
      });
      throw fetchError;
    }

    const statsData = {
      user_id: userId,
      date: dailyStats.date,
      total_time_ms: dailyStats.totalTime,
      session_count: dailyStats.sessions.length,
      top_domains: dailyStats.domains,
    };

    if (existingStats) {
      // Update existing stats
      const { error } = await supabase
        .from('daily_stats')
        .update({
          total_time_ms: statsData.total_time_ms,
          session_count: statsData.session_count,
          top_domains: statsData.top_domains,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingStats?.id);

      if (error) {
        logger.error('Failed to update daily stats', error, { component: 'DataSyncService' });
        throw error;
      }
    } else {
      // Insert new stats
      const { error } = await supabase.from('daily_stats').insert(statsData);

      if (error) {
        logger.error('Failed to insert daily stats', error, { component: 'DataSyncService' });
        throw error;
      }
    }

    logger.info('Daily stats synced successfully', {
      component: 'DataSyncService',
      date: dailyStats.date,
      totalTime: dailyStats.totalTime,
      isUpdate: !!existingStats,
    });
  }

  async addPendingSession(session: TabSession) {
    const pendingSessions = await this.getPendingSessions();
    pendingSessions.push(session);

    await browser.storage.local.set({
      [this.STORAGE_KEY_PENDING_SESSIONS]: pendingSessions,
    });

    logger.debug('Added pending session', {
      component: 'DataSyncService',
      domain: session.domain,
      duration: session.totalTime,
      totalPending: pendingSessions.length,
    });

    // Update sync status
    await this.updateSyncStatus({
      lastSync: null,
      isOnline: false,
      pendingSessions: pendingSessions.length,
    });

    // Try to sync immediately if online
    if (navigator.onLine) {
      this.syncData();
    }
  }

  private async getPendingSessions(): Promise<TabSession[]> {
    const stored = await browser.storage.local.get(this.STORAGE_KEY_PENDING_SESSIONS);
    return stored[this.STORAGE_KEY_PENDING_SESSIONS] || [];
  }

  private async clearPendingSessions() {
    await browser.storage.local.remove(this.STORAGE_KEY_PENDING_SESSIONS);
  }

  private async getPendingSessionsCount(): Promise<number> {
    const sessions = await this.getPendingSessions();
    return sessions.length;
  }

  private async updateSyncStatus(status: Partial<SyncStatus>) {
    const currentStatus = await this.getSyncStatus();
    const updatedStatus = { ...currentStatus, ...status };

    await browser.storage.local.set({
      [this.STORAGE_KEY_SYNC_STATUS]: updatedStatus,
    });
  }

  async getSyncStatus(): Promise<SyncStatus> {
    const stored = await browser.storage.local.get(this.STORAGE_KEY_SYNC_STATUS);
    return (
      stored[this.STORAGE_KEY_SYNC_STATUS] || {
        lastSync: null,
        isOnline: false,
        pendingSessions: 0,
      }
    );
  }

  async authenticateWithGoogle(): Promise<boolean> {
    if (!supabase) {
      logger.warn('Supabase not configured; cannot authenticate', { component: 'DataSyncService' });
      return false;
    }
    try {
      logger.info('Starting Google authentication', { component: 'DataSyncService' });

      // Use Chrome Identity API to get Google OAuth token
      const authToken = await new Promise<string>((resolve, reject) => {
        browser.identity.getAuthToken({ interactive: true }, (result) => {
          if (browser.runtime.lastError) {
            reject(new Error(browser.runtime.lastError.message));
          } else {
            resolve(result.token || '');
          }
        });
      });

      if (!authToken) {
        throw new Error('No token received from Chrome Identity API');
      }

      // Sign in to Supabase with the token
      const { error } = await supabase.auth.signInWithIdToken({
        provider: 'google',
        token: authToken,
      });

      if (error) {
        logger.error('Supabase authentication failed', error, { component: 'DataSyncService' });
        return false;
      }

      logger.info('Google authentication successful', { component: 'DataSyncService' });
      return true;
    } catch (error) {
      logger.error('Google authentication failed', error as Error, {
        component: 'DataSyncService',
      });
      return false;
    }
  }

  async signOut(): Promise<void> {
    try {
      if (supabase) {
        // Sign out from Supabase
        await supabase.auth.signOut();
      }

      // Remove Chrome Identity token
      const cachedToken = await new Promise<string>((resolve) => {
        browser.identity.getAuthToken({ interactive: false }, (result) => {
          resolve(result.token || '');
        });
      });

      if (cachedToken) {
        browser.identity.removeCachedAuthToken({ token: cachedToken }, () => {
          logger.debug('Chrome Identity token removed', { component: 'DataSyncService' });
        });
      }

      // Reset sync status
      await this.updateSyncStatus({
        lastSync: null,
        isOnline: false,
        pendingSessions: 0,
      });

      logger.info('Signed out successfully', { component: 'DataSyncService' });
    } catch (error) {
      logger.error('Sign out failed', error as Error, { component: 'DataSyncService' });
    }
  }

  cleanup() {
    this.stopPeriodicSync();
  }
}

export const syncService = new DataSyncService();
