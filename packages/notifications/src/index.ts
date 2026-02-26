export type NotificationsAdapter = {
  notify: (info: string, context?: Record<string, string | number | boolean>) => void;
  notifyError: (err: unknown, context?: Record<string, string | number | boolean>) => void;
};

export function createConsoleNotificationsAdapter(): NotificationsAdapter {
  return {
    notify(info, context) {
      // eslint-disable-next-line no-console
      console.log(`[INFO] ${info}`, context ?? {});
    },
    notifyError(err, context) {
      const message =
        err instanceof Error
          ? err.message
          : (typeof err === 'object' && err && 'message' in err && typeof (err as { message?: unknown }).message === 'string')
            ? ((err as { message: string }).message)
            : String(err);
      // eslint-disable-next-line no-console
      console.error(`[ERROR] ${message}`, context ?? {}, err);
    },
  };
}
