import type { calendar_v3 } from 'googleapis';
import type { NormalizedRecord } from '../../core/normalized';

// All-day events carry `date` (YYYY-MM-DD) with no zone; we anchor them at UTC midnight.
function toIso(point: calendar_v3.Schema$EventDateTime | undefined): string | null {
  if (point?.dateTime) return new Date(point.dateTime).toISOString();
  if (point?.date) return new Date(`${point.date}T00:00:00Z`).toISOString();
  return null;
}

function isAllDay(event: calendar_v3.Schema$Event): boolean {
  return event.start?.date != null && event.start.dateTime == null;
}

// Throws on an unusable payload; the runner catches per-record and skips-and-logs.
export function mapEvent(event: calendar_v3.Schema$Event): NormalizedRecord {
  if (!event.id) throw new Error('gcal event has no id');

  return {
    source: 'gcal',
    source_id: event.id,
    record_type: 'event',
    occurred_at: toIso(event.start ?? undefined),
    status_raw: event.status ?? null, // verbatim: 'confirmed' | 'tentative' | 'cancelled'
    amount_cents: null,
    currency: null,
    source_updated_at: event.updated ?? null,
    // Every key is always present (null, never undefined) so JSON.stringify cannot drop
    // one and shift content_hash for what is really the same event.
    data: {
      id: event.id,
      summary: event.summary ?? null,
      description: event.description ?? null,
      location: event.location ?? null,
      status: event.status ?? null,
      start: toIso(event.start ?? undefined),
      end: toIso(event.end ?? undefined),
      all_day: isAllDay(event),
      time_zone: event.start?.timeZone ?? null,
      organizer_email: event.organizer?.email ?? null,
      creator_email: event.creator?.email ?? null,
      attendee_emails: (event.attendees ?? []).map((a) => a.email ?? null),
      recurring_event_id: event.recurringEventId ?? null,
      ical_uid: event.iCalUID ?? null,
      html_link: event.htmlLink ?? null,
      created: event.created ?? null,
      updated: event.updated ?? null,
    },
  };
}
