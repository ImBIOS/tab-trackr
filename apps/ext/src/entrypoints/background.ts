import { logger } from '../lib/logger';
import { syncService } from '../lib/sync-service';

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
  domains: Record<string, number>; // domain -> total time in ms
  totalTime: number;
  sessions: TabSession[];
}

interface WeeklyStats {
  weekStart: string; // ISO date string for Monday of the week
  totalTime: number;
  dailyBreakdown: Record<string, number>; // date -> total time
  topDomains: Record<string, number>;
  sessionCount: number;
}

interface HistoricalData {
  version: string;
  lastCleanup: string;
  weeklyStats: Record<string, WeeklyStats>; // week start date -> stats
  allTimeTotals: {
    totalTime: number;
    sessionCount: number;
    firstTrackingDate: string;
    topDomains: Record<string, number>;
  };
}

class TabTracker {
  private currentSession: TabSession | null = null;
  private dailyStats: DailyStats | null = null;
  private historicalData: HistoricalData | null = null;
  private isTrackingEnabled = true;
  private contentActivityStatus = new Map<
    number,
    { isActive: boolean; lastActivity: number; isVisible: boolean }
  >();
  private currentTabId: number | null = null;

  private readonly STORAGE_KEY_DAILY = 'daily_stats';
  private readonly STORAGE_KEY_SETTINGS = 'tracker_settings';
  private readonly STORAGE_KEY_HISTORICAL = 'historical_data';
  private readonly DATA_VERSION = '1.0.0';

  private readonly IDLE_THRESHOLD = 30_000; // 30 seconds
  private readonly SAVE_INTERVAL = 10_000; // Save every 10 seconds
  private readonly CLEANUP_INTERVAL_DAYS = 7; // Run cleanup weekly
  private readonly KEEP_WEEKS = 12; // Keep 3 months of weekly data

  private saveTimer: number | null = null;

  constructor() {
    logger.debug('TabTracker instance created', { component: 'TabTracker' });
  }

  async initialize() {
    logger.info('Initializing TabTracker', { component: 'TabTracker' });
    logger.time('TabTracker Initialization');

    try {
      // Load settings, daily stats, and historical data
      await this.loadSettings();
      logger.initializationStep('loadSettings', true, { component: 'TabTracker' });

      await this.loadDailyStats();
      logger.initializationStep('loadDailyStats', true, { component: 'TabTracker' });

      await this.loadHistoricalData();
      logger.initializationStep('loadHistoricalData', true, { component: 'TabTracker' });

      await this.performDataCleanupIfNeeded();
      logger.initializationStep('performDataCleanupIfNeeded', true, { component: 'TabTracker' });

      // Initialize sync service (safe if not configured)
      await syncService.initialize();
      logger.initializationStep('syncService.initialize', true, { component: 'TabTracker' });

      // Get current active tab and start tracking if enabled
      if (this.isTrackingEnabled) {
        const tabs = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (tabs[0]) {
          this.startTracking(tabs[0]);
          logger.debug('Started tracking current active tab', {
            component: 'TabTracker',
            tabId: tabs[0].id,
            url: tabs[0].url,
          });
        } else {
          logger.debug('No active tab found during initialization', { component: 'TabTracker' });
        }
      } else {
        logger.info('Tracking is disabled, skipping initial tab tracking', {
          component: 'TabTracker',
        });
      }

      // Setup periodic saving
      this.startSaveTimer();
      logger.initializationStep('startSaveTimer', true, { component: 'TabTracker' });

      logger.timeEnd('TabTracker Initialization');
      logger.info('TabTracker initialization completed successfully', {
        component: 'TabTracker',
        trackingEnabled: this.isTrackingEnabled,
      });
    } catch (error) {
      logger.timeEnd('TabTracker Initialization');
      logger.fatal('Failed to initialize TabTracker', error as Error, { component: 'TabTracker' });
      // Do not rethrow; keep background alive for message handling
    }
  }

  private async loadSettings() {
    logger.debug('Loading settings', { component: 'TabTracker' });

    try {
      const stored = await browser.storage.local.get(this.STORAGE_KEY_SETTINGS);
      const settings = stored[this.STORAGE_KEY_SETTINGS] as
        | { trackingEnabled?: boolean }
        | undefined;

      // Default to enabled if no setting stored
      this.isTrackingEnabled = settings?.trackingEnabled ?? true;

      logger.info('Settings loaded successfully', {
        component: 'TabTracker',
        trackingEnabled: this.isTrackingEnabled,
        hadStoredSettings: !!settings,
      });
    } catch (error) {
      logger.error('Failed to load settings, using defaults', error as Error, {
        component: 'TabTracker',
      });
      this.isTrackingEnabled = true;
    }
  }

  private async saveSettings() {
    logger.debug('Saving settings', {
      component: 'TabTracker',
      trackingEnabled: this.isTrackingEnabled,
    });

    try {
      await browser.storage.local.set({
        [this.STORAGE_KEY_SETTINGS]: {
          trackingEnabled: this.isTrackingEnabled,
        },
      });
      logger.dataOperation('saveSettings', true, { component: 'TabTracker' });
    } catch (error) {
      logger.error('Failed to save settings', error as Error, { component: 'TabTracker' });
      throw error;
    }
  }

  private async loadDailyStats() {
    const today = new Date().toISOString().split('T')[0] ?? '';
    const stored = await browser.storage.local.get(this.STORAGE_KEY_DAILY);
    const storedStats = stored[this.STORAGE_KEY_DAILY] as DailyStats | undefined;

    if (storedStats?.date === today) {
      this.dailyStats = storedStats ?? null;
    } else {
      // Archive previous day's data if it exists
      if (storedStats && storedStats.date !== today) {
        // Temporarily set old stats to archive them
        const oldDailyStats = this.dailyStats;
        this.dailyStats = storedStats;
        await this.archiveDailyData();
        this.dailyStats = oldDailyStats;
      }

      // Create new daily stats
      this.dailyStats = {
        date: today,
        domains: {},
        totalTime: 0,
        sessions: [],
      };
      await this.saveDailyStats();
    }
  }

  private async saveDailyStats() {
    if (!this.dailyStats) {
      return;
    }

    await browser.storage.local.set({
      [this.STORAGE_KEY_DAILY]: this.dailyStats,
    });
  }

  private async loadHistoricalData() {
    const stored = await browser.storage.local.get(this.STORAGE_KEY_HISTORICAL);
    const storedData = stored[this.STORAGE_KEY_HISTORICAL] as HistoricalData | undefined;

    if (storedData && storedData.version === this.DATA_VERSION) {
      this.historicalData = storedData;
    } else {
      // Initialize new historical data
      const now = new Date().toISOString();
      this.historicalData = {
        version: this.DATA_VERSION,
        lastCleanup: now,
        weeklyStats: {},
        allTimeTotals: {
          totalTime: 0,
          sessionCount: 0,
          firstTrackingDate: now,
          topDomains: {},
        },
      };
      await this.saveHistoricalData();
    }
  }

  private async saveHistoricalData() {
    if (!this.historicalData) {
      return;
    }

    await browser.storage.local.set({
      [this.STORAGE_KEY_HISTORICAL]: this.historicalData,
    });
  }

  private getWeekStart(date: Date): string {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust to get Monday
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d.toISOString().split('T')[0] ?? '';
  }

  private async archiveDailyData() {
    if (!(this.dailyStats && this.historicalData) || this.dailyStats.totalTime === 0) {
      return;
    }

    const weekStart = this.getWeekStart(new Date(this.dailyStats.date));
    const dateKey = this.dailyStats.date;

    // Initialize weekly stats if not exists
    if (!this.historicalData.weeklyStats[weekStart]) {
      this.historicalData.weeklyStats[weekStart] = {
        weekStart,
        totalTime: 0,
        dailyBreakdown: {},
        topDomains: {},
        sessionCount: 0,
      };
    }

    const weeklyStats = this.historicalData.weeklyStats[weekStart];

    // Update weekly stats
    weeklyStats.totalTime += this.dailyStats.totalTime;
    weeklyStats.dailyBreakdown[dateKey] = this.dailyStats.totalTime;
    weeklyStats.sessionCount += this.dailyStats.sessions.length;

    // Merge domain stats
    for (const [domain, time] of Object.entries(this.dailyStats.domains)) {
      weeklyStats.topDomains[domain] = (weeklyStats.topDomains[domain] || 0) + time;
    }

    // Update all-time totals
    this.historicalData.allTimeTotals.totalTime += this.dailyStats.totalTime;
    this.historicalData.allTimeTotals.sessionCount += this.dailyStats.sessions.length;

    // Merge all-time domain stats
    for (const [domain, time] of Object.entries(this.dailyStats.domains)) {
      this.historicalData.allTimeTotals.topDomains[domain] =
        (this.historicalData.allTimeTotals.topDomains[domain] || 0) + time;
    }

    await this.saveHistoricalData();
  }

  private async performDataCleanupIfNeeded() {
    if (!this.historicalData) {
      return;
    }

    const now = new Date();
    const lastCleanup = new Date(this.historicalData.lastCleanup);
    const daysSinceCleanup = Math.floor(
      (now.getTime() - lastCleanup.getTime()) / (1000 * 60 * 60 * 24)
    );

    if (daysSinceCleanup >= this.CLEANUP_INTERVAL_DAYS) {
      await this.cleanupOldData();
      this.historicalData.lastCleanup = now.toISOString();
      await this.saveHistoricalData();
    }
  }

  private async cleanupOldData() {
    if (!this.historicalData) {
      return;
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.KEEP_WEEKS * 7);
    const cutoffWeekStart = this.getWeekStart(cutoffDate);

    // Remove old weekly stats
    const weekKeysToRemove = Object.keys(this.historicalData.weeklyStats).filter(
      (weekStart) => weekStart < cutoffWeekStart
    );

    for (const weekKey of weekKeysToRemove) {
      delete this.historicalData.weeklyStats[weekKey];
    }

    await this.saveHistoricalData();
  }

  private startSaveTimer() {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
    }

    this.saveTimer = setInterval(() => {
      this.updateCurrentSession();
      this.saveDailyStats();
    }, this.SAVE_INTERVAL) as unknown as number;
  }

  private extractDomain(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.hostname;
    } catch {
      return 'unknown';
    }
  }

  private isValidUrl(url: string): boolean {
    const invalidPrefixes = ['chrome://', 'chrome-extension://', 'moz-extension://', 'about:'];

    return Boolean(
      url && !invalidPrefixes.some((prefix) => url.startsWith(prefix)) && url.includes('://')
    );
  }

  startTracking(tab: Browser.tabs.Tab): void {
    logger.debug('Starting tracking attempt', {
      component: 'TabTracker',
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
    });

    // Don't track if tracking is disabled
    if (!this.isTrackingEnabled) {
      logger.debug('Tracking disabled, skipping', { component: 'TabTracker' });
      return;
    }

    if (!tab.url) {
      logger.debug('No URL provided, skipping tracking', {
        component: 'TabTracker',
        tabId: tab.id,
      });
      return;
    }
    if (!tab.id) {
      logger.debug('No tab ID provided, skipping tracking', { component: 'TabTracker' });
      return;
    }
    if (!this.isValidUrl(tab.url)) {
      logger.debug('Invalid URL, skipping tracking', { component: 'TabTracker', url: tab.url });
      return;
    }
    if (!this.dailyStats) {
      logger.warn('Daily stats not initialized, skipping tracking', { component: 'TabTracker' });
      return;
    }

    // End current session if exists
    if (this.currentSession) {
      logger.debug('Ending previous session before starting new one', {
        component: 'TabTracker',
        previousDomain: this.currentSession.domain,
        previousSessionTime: this.currentSession.totalTime,
      });
      this.endCurrentSession();
    }

    // Update current tab ID
    this.currentTabId = tab.id;

    // Start new session
    const now = Date.now();
    const domain = this.extractDomain(tab.url);
    this.currentSession = {
      url: tab.url,
      domain,
      title: tab.title || 'Untitled',
      startTime: now,
      lastActive: now,
      totalTime: 0,
      isActive: true,
    };

    logger.sessionStart(this.currentSession, {
      component: 'TabTracker',
      tabId: tab.id,
    });
  }

  private endCurrentSession() {
    if (!this.currentSession) {
      logger.debug('No current session to end', { component: 'TabTracker' });
      return;
    }
    if (!this.dailyStats) {
      logger.warn('No daily stats available for session end', { component: 'TabTracker' });
      return;
    }

    logger.debug('Ending current session', {
      component: 'TabTracker',
      domain: this.currentSession.domain,
      sessionTime: this.currentSession.totalTime,
    });

    this.updateCurrentSession();

    // Add to daily stats
    const domain = this.currentSession.domain;
    const sessionTime = this.currentSession.totalTime;

    this.dailyStats.domains[domain] = (this.dailyStats.domains[domain] || 0) + sessionTime;
    this.dailyStats.totalTime += sessionTime;
    this.dailyStats.sessions.push({ ...this.currentSession });

    logger.sessionEnd(this.currentSession, {
      component: 'TabTracker',
      totalDailyTime: this.dailyStats.totalTime,
      sessionsCount: this.dailyStats.sessions.length,
    });

    // Sync completed session to backend
    syncService.addPendingSession(this.currentSession);

    this.currentSession = null;
  }

  private updateCurrentSession() {
    if (!this.currentSession) {
      return;
    }

    const now = Date.now();
    const timeDiff = now - this.currentSession.lastActive;

    // Check if we have content script activity data for the current tab
    const currentTabId = this.getCurrentTabId();
    const contentActivity = currentTabId ? this.contentActivityStatus.get(currentTabId) : null;

    // Determine if user was active based on content script data or fallback to time threshold
    const wasActive = contentActivity
      ? contentActivity.isActive && contentActivity.isVisible
      : timeDiff < this.IDLE_THRESHOLD;

    // Only count time if user was active
    if (wasActive) {
      this.currentSession.totalTime += timeDiff;
    }

    this.currentSession.lastActive = now;
  }

  private getCurrentTabId(): number | null {
    return this.currentTabId;
  }

  onContentActivityUpdate(
    tabId: number,
    activityData: {
      type: 'activity' | 'idle' | 'visibility';
      timestamp: number;
      data?: {
        isVisible?: boolean;
        isActive?: boolean;
        activityType?: string;
      };
    }
  ) {
    logger.trace('Content activity update received', {
      component: 'TabTracker',
      tab: tabId,
      activityType: activityData.type,
      timestamp: activityData.timestamp,
      isCurrentTab: this.currentTabId === tabId,
      data: activityData.data,
    });

    const currentStatus = this.contentActivityStatus.get(tabId) || {
      isActive: true,
      lastActivity: Date.now(),
      isVisible: true,
    };

    const oldStatus = { ...currentStatus };

    switch (activityData.type) {
      case 'activity':
        currentStatus.isActive = activityData.data?.isActive ?? true;
        currentStatus.lastActivity = activityData.timestamp;
        logger.activityUpdate(
          activityData.data?.activityType || 'activity',
          currentStatus.isActive,
          { component: 'TabTracker', tab: tabId }
        );
        break;

      case 'idle':
        currentStatus.isActive = false;
        logger.activityUpdate('idle', false, { component: 'TabTracker', tab: tabId });
        break;

      case 'visibility':
        currentStatus.isVisible = activityData.data?.isVisible ?? false;
        if (!currentStatus.isVisible) {
          currentStatus.isActive = false;
        }
        logger.activityUpdate('visibility-change', currentStatus.isVisible, {
          component: 'TabTracker',
          tab: tabId,
          isVisible: currentStatus.isVisible,
        });
        break;

      default:
        logger.warn('Unknown activity type received', {
          component: 'TabTracker',
          activityType: activityData.type,
          tab: tabId,
        });
        return;
    }

    this.contentActivityStatus.set(tabId, currentStatus);

    // Log status changes
    if (
      oldStatus.isActive !== currentStatus.isActive ||
      oldStatus.isVisible !== currentStatus.isVisible
    ) {
      logger.debug('Tab activity status changed', {
        component: 'TabTracker',
        tab: tabId,
        oldStatus,
        newStatus: currentStatus,
        isCurrentTab: this.currentTabId === tabId,
      });
    }

    // Update current session immediately if this is the active tab
    if (this.currentSession && this.currentTabId === tabId) {
      this.updateCurrentSession();
    }
  }

  async onTabActivated(tabId: number): Promise<void> {
    logger.debug('Tab activated', { component: 'TabTracker', tabId });

    try {
      const tab = await browser.tabs.get(tabId);
      logger.debug('Tab details retrieved', {
        component: 'TabTracker',
        tabId,
        url: tab.url,
        title: tab.title,
      });
      this.startTracking(tab);
    } catch (error) {
      logger.error('Failed to get tab details for activation', error as Error, {
        component: 'TabTracker',
        tabId,
      });
    }
  }

  onTabUpdated(
    _tabId: number,
    changeInfo: Browser.tabs.TabChangeInfo,
    tab: Browser.tabs.Tab
  ): void {
    // Only react to URL changes
    if (changeInfo.url && tab.active) {
      this.startTracking(tab);
    }
  }

  onTabRemoved(tabId?: number) {
    if (this.currentSession) {
      this.endCurrentSession();
    }

    // Clean up content activity status for the closed tab
    if (tabId) {
      this.contentActivityStatus.delete(tabId);
    }

    // Clear current tab ID if it was the closed tab
    if (tabId === this.currentTabId) {
      this.currentTabId = null;
    }
  }

  async getDailyStats(): Promise<DailyStats | null> {
    await this.loadDailyStats();
    return this.dailyStats;
  }

  async toggleTracking(): Promise<boolean> {
    this.isTrackingEnabled = !this.isTrackingEnabled;
    await this.saveSettings();

    if (this.isTrackingEnabled) {
      // Start tracking current tab when enabling
      const tabs = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tabs[0]) {
        this.startTracking(tabs[0]);
      }
    } else if (this.currentSession) {
      // End current session when disabling tracking
      this.endCurrentSession();
    }

    return this.isTrackingEnabled;
  }

  getTrackingStatus(): boolean {
    return this.isTrackingEnabled;
  }

  getCurrentSession(): TabSession | null {
    return this.currentSession;
  }

  getHistoricalData(): HistoricalData | null {
    return this.historicalData;
  }

  getWeeklyStats(weeksBack = 0): WeeklyStats | null {
    if (!this.historicalData) {
      return null;
    }

    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - weeksBack * 7);
    const weekStart = this.getWeekStart(targetDate);

    return this.historicalData.weeklyStats[weekStart] || null;
  }

  getRecentWeeksStats(count = 4): WeeklyStats[] {
    if (!this.historicalData) {
      return [];
    }

    const weeks: WeeklyStats[] = [];
    for (let i = 0; i < count; i++) {
      const weekStats = this.getWeeklyStats(i);
      if (weekStats) {
        weeks.push(weekStats);
      }
    }

    return weeks.reverse(); // Return oldest first
  }

  async clearAllData(): Promise<void> {
    // End current session first
    if (this.currentSession) {
      this.endCurrentSession();
    }

    // Clear stored data
    await browser.storage.local.clear();

    // Reset in-memory state
    const today = new Date().toISOString().split('T')[0] ?? '';
    const now = new Date().toISOString();

    this.dailyStats = {
      date: today,
      domains: {},
      totalTime: 0,
      sessions: [],
    };

    this.historicalData = {
      version: this.DATA_VERSION,
      lastCleanup: now,
      weeklyStats: {},
      allTimeTotals: {
        totalTime: 0,
        sessionCount: 0,
        firstTrackingDate: now,
        topDomains: {},
      },
    };

    this.currentSession = null;

    // Save empty data structures
    await this.saveDailyStats();
    await this.saveHistoricalData();
  }

  async exportData(): Promise<Record<string, unknown>> {
    // Get all stored data
    const allData = await browser.storage.local.get(null);

    // Add current session to export if active
    const exportData = {
      ...allData,
      currentSession: this.currentSession,
      exportDate: new Date().toISOString(),
      version: '1.0.0',
    };

    return exportData;
  }

  cleanup() {
    if (this.currentSession) {
      this.endCurrentSession();
    }
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
    }
    this.saveDailyStats();
    syncService.cleanup();
  }
}

export default defineBackground(() => {
  const tracker = new TabTracker();

  logger.info('Background service worker boot', { component: 'Background' });

  // Initialize tracker in a fire-and-forget fashion
  tracker.initialize();

  // Tab event listeners
  browser.tabs.onActivated.addListener(async (activeInfo) => {
    await tracker.onTabActivated(activeInfo.tabId);
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    tracker.onTabUpdated(tabId, changeInfo, tab);
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    tracker.onTabRemoved(tabId);
  });

  // Window focus events - pause tracking when browser loses focus
  browser.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === browser.windows.WINDOW_ID_NONE) {
      // Browser lost focus
      tracker.onTabRemoved();
    } else {
      // Browser gained focus - get active tab
      const tabs = await browser.tabs.query({ active: true, windowId });
      if (tabs[0]?.id) {
        await tracker.onTabActivated(tabs[0].id);
      }
    }
  });

  // Handle extension lifecycle
  browser.runtime.onSuspend?.addListener(() => {
    tracker.cleanup();
  });

  // Message handler for popup communication
  browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    (async () => {
      const msg = message as { action: string };
      const senderInfo = {
        tabId: _sender.tab?.id,
        frameId: _sender.frameId,
        url: _sender.tab?.url,
      };

      logger.trace('Message received', {
        component: 'BackgroundMessageHandler',
        action: msg.action,
        sender: senderInfo,
      });

      try {
        switch (msg.action) {
          case 'GET_DAILY_STATS': {
            const stats = await tracker.getDailyStats();
            logger.messageHandling(msg.action, true, {
              component: 'BackgroundMessageHandler',
              responseSize: stats ? Object.keys(stats.domains).length : 0,
            });
            sendResponse(stats);
            break;
          }

          case 'GET_CURRENT_SESSION': {
            const session = tracker.getCurrentSession();
            logger.messageHandling(msg.action, true, {
              component: 'BackgroundMessageHandler',
              hasSession: !!session,
              sessionDomain: session?.domain,
            });
            sendResponse(session);
            break;
          }

          case 'GET_TRACKING_STATUS': {
            const status = tracker.getTrackingStatus();
            logger.messageHandling(msg.action, true, {
              component: 'BackgroundMessageHandler',
              trackingEnabled: status,
            });
            sendResponse(status);
            break;
          }

          case 'TOGGLE_TRACKING': {
            const newStatus = await tracker.toggleTracking();
            logger.messageHandling(msg.action, true, {
              component: 'BackgroundMessageHandler',
              newStatus,
            });
            sendResponse(newStatus);
            break;
          }

          case 'CLEAR_DATA': {
            await tracker.clearAllData();
            logger.messageHandling(msg.action, true, {
              component: 'BackgroundMessageHandler',
            });
            sendResponse(true);
            break;
          }

          case 'EXPORT_DATA': {
            const exportData = await tracker.exportData();
            logger.messageHandling(msg.action, true, {
              component: 'BackgroundMessageHandler',
              exportSize: JSON.stringify(exportData).length,
            });
            sendResponse(exportData);
            break;
          }

          case 'GET_HISTORICAL_DATA': {
            const data = tracker.getHistoricalData();
            logger.messageHandling(msg.action, true, {
              component: 'BackgroundMessageHandler',
              hasData: !!data,
            });
            sendResponse(data);
            break;
          }

          case 'GET_WEEKLY_STATS': {
            const { weeksBack = 0 } = msg as { weeksBack?: number };
            const stats = tracker.getWeeklyStats(weeksBack);
            logger.messageHandling(msg.action, true, {
              component: 'BackgroundMessageHandler',
              weeksBack,
              hasStats: !!stats,
            });
            sendResponse(stats);
            break;
          }

          case 'GET_RECENT_WEEKS': {
            const { count = 4 } = msg as { count?: number };
            const weeks = tracker.getRecentWeeksStats(count);
            logger.messageHandling(msg.action, true, {
              component: 'BackgroundMessageHandler',
              requestedCount: count,
              returnedCount: weeks.length,
            });
            sendResponse(weeks);
            break;
          }

          case 'AUTHENTICATE_GOOGLE': {
            const success = await syncService.authenticateWithGoogle();
            logger.messageHandling(msg.action, success, {
              component: 'BackgroundMessageHandler',
              success,
            });
            sendResponse(success);
            break;
          }

          case 'SIGN_OUT': {
            await syncService.signOut();
            logger.messageHandling(msg.action, true, {
              component: 'BackgroundMessageHandler',
            });
            sendResponse(true);
            break;
          }

          case 'GET_SYNC_STATUS': {
            const status = await syncService.getSyncStatus();
            logger.messageHandling(msg.action, true, {
              component: 'BackgroundMessageHandler',
              lastSync: status.lastSync,
              isOnline: status.isOnline,
              pendingSessions: status.pendingSessions,
            });
            sendResponse(status);
            break;
          }

          case 'FORCE_SYNC': {
            const success = await syncService.syncData();
            logger.messageHandling(msg.action, success, {
              component: 'BackgroundMessageHandler',
              success,
            });
            sendResponse(success);
            break;
          }

          case 'CONTENT_ACTIVITY_UPDATE': {
            const msgWithData = msg as {
              action: string;
              data: {
                type: 'activity' | 'idle' | 'visibility';
                timestamp: number;
                data?: {
                  isVisible?: boolean;
                  isActive?: boolean;
                  activityType?: string;
                };
              };
            };

            // Get tab ID from sender
            if (_sender.tab?.id && msgWithData.data) {
              tracker.onContentActivityUpdate(_sender.tab.id, msgWithData.data);
              logger.messageHandling(msg.action, true, {
                component: 'BackgroundMessageHandler',
                activityType: msgWithData.data.type,
                tab: _sender.tab.id,
              });
            } else {
              logger.messageHandling(msg.action, false, {
                component: 'BackgroundMessageHandler',
                reason: 'Missing tab ID or activity data',
                sender: senderInfo,
              });
            }
            sendResponse(true);
            break;
          }

          default:
            logger.messageHandling(msg.action, false, {
              component: 'BackgroundMessageHandler',
              reason: 'Unknown action',
            });
            sendResponse(null);
        }
      } catch (error) {
        logger.error(`Failed to handle message: ${msg.action}`, error as Error, {
          component: 'BackgroundMessageHandler',
          action: msg.action,
        });
        sendResponse(null);
      }
    })();
    return true; // Keep the message port open for async response
  });
});
