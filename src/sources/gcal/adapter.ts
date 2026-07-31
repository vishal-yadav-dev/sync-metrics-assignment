import { google, type calendar_v3 } from 'googleapis';
import { requireEnv } from '../../config/env';
import type { NormalizedRecord } from '../../core/normalized';
import { type FetchResult, type SourceAdapter, StaleCursorError } from '../types';
import { mapEvent } from './map';

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

// A syncToken is only valid for requests carrying the same parameters as the original call,
// so incremental and full must share these exactly or Google rejects the token.
const LIST_PARAMS = {
  singleEvents: true,
  showDeleted: true, // cancelled events must arrive, or deletions never propagate
  maxResults: 250,
} as const;

// googleapis surfaces the HTTP status differently across error shapes; check all of them.
function httpStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const candidate of [e.status, e.response?.status, e.code]) {
    if (typeof candidate === 'number') return candidate;
    if (typeof candidate === 'string' && /^\d+$/.test(candidate)) return Number(candidate);
  }
  return null;
}

export class GcalAdapter implements SourceAdapter {
  readonly source = 'gcal' as const;
  readonly record_type = 'event' as const;
  readonly cursor_kind = 'token' as const; // Google syncToken

  private calendar: calendar_v3.Calendar | null = null;

  // A service account's own 'primary' calendar is empty; real data needs the id of a
  // calendar shared with it (GOOGLE_CALENDAR_ID).
  constructor(private readonly calendarId: string = 'primary') {}

  // Built lazily: the Google credentials are optional env vars, so constructing this at
  // import time would break any process that never touches gcal.
  private client(): calendar_v3.Calendar {
    if (this.calendar === null) {
      const auth = new google.auth.JWT({
        email: requireEnv('GOOGLE_CLIENT_EMAIL'),
        key: requireEnv('GOOGLE_PRIVATE_KEY'), // env.ts already un-escaped the \n sequences
        scopes: SCOPES,
      });
      this.calendar = google.calendar({ version: 'v3', auth });
    }
    return this.calendar;
  }

  // A null cursor bootstraps: no syncToken is sent, so this behaves like a full fetch and
  // still comes back with a syncToken for next time.
  async fetchIncremental(cursor: string | null): Promise<FetchResult> {
    return this.drain(cursor === null ? {} : { syncToken: cursor }, true);
  }

  async fetchFull(_cursor: string | null): Promise<FetchResult> {
    return this.drain({}, false);
  }

  // Drains every page in one call and returns the nextSyncToken, so next_cursor is always a
  // syncToken and the runner never sees pagination. Sample data is small enough to hold in
  // memory; a production version against large calendars would stream and checkpoint pages.
  private async drain(
    params: calendar_v3.Params$Resource$Events$List,
    incremental: boolean,
  ): Promise<FetchResult> {
    const calendar = this.client();
    const records: NormalizedRecord[] = [];
    let pageToken: string | undefined;
    let syncToken: string | null = null;

    do {
      let page: calendar_v3.Schema$Events;
      try {
        const response = await calendar.events.list({
          ...LIST_PARAMS,
          calendarId: this.calendarId,
          ...params,
          pageToken,
        });
        page = response.data;
      } catch (err) {
        // 410 Gone = expired syncToken. Thrown immediately, discarding records collected so
        // far, so the runner does a clean full backfill instead of persisting a half sync.
        if (incremental && httpStatus(err) === 410) {
          throw new StaleCursorError('gcal', 'syncToken expired (410 Gone)');
        }
        throw err;
      }

      // Record-level isolation lives here, not in the runner: mapping happens at this layer,
      // so one unmappable event must not take down the whole page.
      for (const event of page.items ?? []) {
        try {
          records.push(mapEvent(event));
        } catch (err) {
          console.warn(`[gcal] skipped event ${event.id ?? '(no id)'}:`, (err as Error).message);
        }
      }

      pageToken = page.nextPageToken ?? undefined;
      // Google only sends nextSyncToken on the final page; capture it whenever it appears.
      if (page.nextSyncToken) syncToken = page.nextSyncToken;
    } while (pageToken);

    return { records, next_cursor: syncToken };
  }
}
