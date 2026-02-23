export type NotificationsAdapter = {
  notify: (info: string, context?: Record<string, string | number | boolean>) => void;
  notifyError: (err: unknown, context?: Record<string, string | number | boolean>) => void;
};

export function createConsoleNotificationsAdapter(): NotificationsAdapter {
  return {
    notify(info, context) {
      // eslint-disable-next-line no-console
      console.log(`[M6][INFO] ${info}`, context ?? {});
    },
    notifyError(err, context) {
      // eslint-disable-next-line no-console
      console.error(`[M6][ERROR] ${err instanceof Error ? err.message : String(err)}`, context ?? {});
    },
  };
}
