/**
 * providers/notifications/twilio.ts — Twilio Messages API client (SMS + WhatsApp).
 *
 * Twilio Messages API:
 *   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
 *   Auth:  HTTP Basic — Authorization: Basic base64(AccountSid:AuthToken)
 *   Body:  application/x-www-form-urlencoded (URLSearchParams) with
 *          To, From (or MessagingServiceSid), Body.
 *
 * WhatsApp uses the same endpoint but with `whatsapp:` prefixed To/From values.
 *
 * No new dependencies — uses global fetch.
 */

const BASE_URL = "https://api.twilio.com/2010-04-01";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TwilioMessageResult {
  sid: string;
  status: string;
  to: string;
  from?: string | undefined;
  error_code?: number | null | undefined;
  error_message?: string | null | undefined;
}

export class TwilioAPIError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(`twilio: status ${status}: ${message}`);
    this.name = "TwilioAPIError";
  }
}

// ── Client ────────────────────────────────────────────────────────────────────

export class TwilioClient {
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly fromNumber?: string | undefined;
  private readonly messagingServiceSid?: string | undefined;

  constructor(opts: {
    accountSid: string;
    authToken: string;
    fromNumber?: string | undefined;
    messagingServiceSid?: string | undefined;
  }) {
    this.accountSid = opts.accountSid;
    this.authToken = opts.authToken;
    this.fromNumber = opts.fromNumber;
    this.messagingServiceSid = opts.messagingServiceSid;
  }

  /**
   * Send an SMS message via Twilio.
   */
  async sendSms(
    params: { to: string; body: string },
    signal?: AbortSignal
  ): Promise<TwilioMessageResult> {
    const from = this.messagingServiceSid ? undefined : this.fromNumber;
    return this._send(params.to, from, params.body, signal);
  }

  /**
   * Send a WhatsApp message via Twilio. Both To and From are prefixed with
   * `whatsapp:` (the prefix is only added when not already present).
   */
  async sendWhatsapp(
    params: { to: string; body: string },
    signal?: AbortSignal
  ): Promise<TwilioMessageResult> {
    const to = withWhatsappPrefix(params.to);
    const from =
      this.messagingServiceSid || !this.fromNumber
        ? undefined
        : withWhatsappPrefix(this.fromNumber);
    return this._send(to, from, params.body, signal);
  }

  private async _send(
    to: string,
    from: string | undefined,
    body: string,
    signal?: AbortSignal
  ): Promise<TwilioMessageResult> {
    const form = new URLSearchParams();
    form.set("To", to);
    if (this.messagingServiceSid) {
      form.set("MessagingServiceSid", this.messagingServiceSid);
    } else if (from) {
      form.set("From", from);
    }
    form.set("Body", body);

    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");
    const headers: Record<string, string> = {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };

    const res = await fetch(
      `${BASE_URL}/Accounts/${this.accountSid}/Messages.json`,
      {
        method: "POST",
        headers,
        body: form.toString(),
        ...(signal !== undefined ? { signal } : {}),
      }
    );

    const text = await res.text();
    if (res.status >= 400) {
      throw new TwilioAPIError(res.status, text);
    }

    let data: TwilioMessageResult;
    try {
      data = JSON.parse(text) as TwilioMessageResult;
    } catch {
      throw new Error(`twilio: could not parse response: ${text.slice(0, 200)}`);
    }
    return data;
  }
}

/** Prefix a value with `whatsapp:` unless it already carries the prefix. */
function withWhatsappPrefix(value: string): string {
  return value.startsWith("whatsapp:") ? value : `whatsapp:${value}`;
}

/**
 * Convenience factory — mirrors Go-style `twilio.New(opts)`.
 */
export function newTwilioClient(opts: {
  accountSid: string;
  authToken: string;
  fromNumber?: string | undefined;
  messagingServiceSid?: string | undefined;
}): TwilioClient {
  return new TwilioClient(opts);
}
