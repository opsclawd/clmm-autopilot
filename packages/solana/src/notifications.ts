export type NotificationEvent = {
  level: 'info' | 'error';
  message: string;
  context?: Record<string, string | number | boolean>;
};

export type NotificationAdapter = {
  notify: (event: NotificationEvent) => void;
};

export function createConsoleNotificationAdapter(): NotificationAdapter {
  return {
    notify(event) {
      const prefix = event.level === 'error' ? '[M6][ERROR]' : '[M6][INFO]';
      const context = event.context ? ` ${JSON.stringify(event.context)}` : '';
      // eslint-disable-next-line no-console
      console.log(`${prefix} ${event.message}${context}`);
    },
  };
}
