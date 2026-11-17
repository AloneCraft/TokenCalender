import type { TokenCalendarApi } from '../shared/api.ts';

declare global {
  interface Window {
    tokenCalendar: TokenCalendarApi;
  }
}

export const api = (): TokenCalendarApi => window.tokenCalendar;
