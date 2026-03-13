export type NotificationsAdapter = {
  emit: (entry: Record<string, unknown>) => void;
  notify: (info: string, context?: Record<string, string | number | boolean>) => void;
  notifyError: (err: unknown, context?: Record<string, string | number | boolean>) => void;
};

export function createConsoleNotificationsAdapter(): NotificationsAdapter {
  return {
    emit(entry) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(entry));
    },
    notify(info, context) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ level: 'info', message: info, details: context ?? {} }));
    },
    notifyError(err, context) {
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify({
          level: 'error',
          message: err instanceof Error ? err.message : String(err),
          details: context ?? {},
        }),
      );
    },
  };
}
