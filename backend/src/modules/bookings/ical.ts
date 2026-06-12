/**
 * bookings/ical.ts — Minimal RFC5545 iCal parser and serializer.
 *
 * No external dependencies. Handles CRLF and LF line endings.
 * Supports DATE-only (allDay) and DATETIME (UTC Z suffix) DTSTART/DTEND values.
 */

export interface ICalEvent {
  uid: string;
  summary: string;
  dtstart: Date;
  dtend: Date;
  allDay: boolean;
}

// ── Parser ─────────────────────────────────────────────────────────────────────

/**
 * RFC5545 minimal parser: extract VEVENT blocks, parse DTSTART/DTEND/UID/SUMMARY.
 *
 * Handles:
 *   - CRLF (\r\n) and LF (\n) line endings
 *   - DTSTART;VALUE=DATE:20260101 (all-day, allDay=true)
 *   - DTSTART:20260101T150000Z (UTC datetime, allDay=false)
 *   - Folded lines (lines starting with space/tab are continuations per RFC5545)
 */
export function parseICalFeed(icalText: string): ICalEvent[] {
  // Normalize line endings to \n
  const text = icalText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Unfold lines (continuation lines start with space or tab)
  const unfolded = text.replace(/\n[ \t]/g, "");

  const lines = unfolded.split("\n");

  const events: ICalEvent[] = [];
  let inVEvent = false;
  let uid = "";
  let summary = "";
  let dtstart: Date | null = null;
  let dtend: Date | null = null;
  let allDay = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line === "BEGIN:VEVENT") {
      inVEvent = true;
      uid = "";
      summary = "";
      dtstart = null;
      dtend = null;
      allDay = false;
      continue;
    }

    if (line === "END:VEVENT") {
      inVEvent = false;
      if (dtstart && dtend) {
        events.push({ uid, summary, dtstart, dtend, allDay });
      }
      continue;
    }

    if (!inVEvent) continue;

    // Split on first colon
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const propFull = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 1);

    // Property name may have parameters (separated by ;)
    const propName = propFull.split(";")[0]?.toUpperCase() ?? "";
    const propParams = propFull.slice(propName.length);

    switch (propName) {
      case "UID":
        uid = value;
        break;
      case "SUMMARY":
        summary = value;
        break;
      case "DTSTART": {
        const isDateOnly = propParams.includes("VALUE=DATE") || /^\d{8}$/.test(value);
        if (isDateOnly) {
          allDay = true;
          dtstart = parseDateOnly(value);
        } else {
          allDay = false;
          dtstart = parseDateTime(value);
        }
        break;
      }
      case "DTEND": {
        const isDateOnly = propParams.includes("VALUE=DATE") || /^\d{8}$/.test(value);
        if (isDateOnly) {
          dtend = parseDateOnly(value);
        } else {
          dtend = parseDateTime(value);
        }
        break;
      }
    }
  }

  return events;
}

// ── Serializer ─────────────────────────────────────────────────────────────────

/**
 * Build VCALENDAR with VEVENTs for confirmed bookings + blocked dates.
 *
 * Outputs RFC5545 with CRLF line endings as required.
 */
export function buildICalFeed(events: ICalEvent[], calName: string): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Cartcrft//Booking Calendar//EN",
    `X-WR-CALNAME:${escapeText(calName)}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];

  for (const evt of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${escapeText(evt.uid)}`);
    lines.push(`SUMMARY:${escapeText(evt.summary)}`);

    if (evt.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${formatDateOnly(evt.dtstart)}`);
      lines.push(`DTEND;VALUE=DATE:${formatDateOnly(evt.dtend)}`);
    } else {
      lines.push(`DTSTART:${formatDateTime(evt.dtstart)}`);
      lines.push(`DTEND:${formatDateTime(evt.dtend)}`);
    }

    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  // RFC5545 requires CRLF line endings
  return lines.join("\r\n") + "\r\n";
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Parse DATE-only value: YYYYMMDD → Date at UTC midnight */
function parseDateOnly(s: string): Date {
  const year = parseInt(s.slice(0, 4), 10);
  const month = parseInt(s.slice(4, 6), 10) - 1;
  const day = parseInt(s.slice(6, 8), 10);
  return new Date(Date.UTC(year, month, day));
}

/** Parse DATETIME value: YYYYMMDDTHHmmssZ → Date */
function parseDateTime(s: string): Date {
  // Handle 20260101T150000Z or 20260101T150000
  const clean = s.replace("Z", "");
  const year = parseInt(clean.slice(0, 4), 10);
  const month = parseInt(clean.slice(4, 6), 10) - 1;
  const day = parseInt(clean.slice(6, 8), 10);
  const hour = parseInt(clean.slice(9, 11), 10);
  const min = parseInt(clean.slice(11, 13), 10);
  const sec = parseInt(clean.slice(13, 15), 10);

  if (s.endsWith("Z")) {
    return new Date(Date.UTC(year, month, day, hour, min, sec));
  }
  return new Date(year, month, day, hour, min, sec);
}

/** Format Date as DATE-only YYYYMMDD */
function formatDateOnly(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}${m}${day}`;
}

/** Format Date as UTC DATETIME YYYYMMDDTHHmmssZ */
function formatDateTime(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const mo = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  const h = d.getUTCHours().toString().padStart(2, "0");
  const mi = d.getUTCMinutes().toString().padStart(2, "0");
  const s = d.getUTCSeconds().toString().padStart(2, "0");
  return `${y}${mo}${day}T${h}${mi}${s}Z`;
}

/** Escape text for iCal: backslash, semicolon, comma, newlines */
function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}
