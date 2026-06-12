/**
 * lib/mailer/ses.ts — AWS SES mailer using raw AWS Sig v4 + node:https.
 *
 * No SDK dependency required — uses node:crypto for signing and node:https
 * for the SendEmail API call.
 *
 * Config vars (from config.ts):
 *   AWS_SES_REGION           e.g. "us-east-1"
 *   AWS_SES_ACCESS_KEY_ID
 *   AWS_SES_SECRET_ACCESS_KEY
 *   EMAIL_FROM               e.g. "Cartcrft <noreply@example.com>"
 */

import { createHmac, createHash } from "node:crypto";
import https from "node:https";
import type { Mailer, MailMessage } from "./index.js";

function sha256hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function signingKey(
  secretKey: string,
  date: string,
  region: string,
  service: string
): Buffer {
  const kDate = hmacSha256(`AWS4${secretKey}`, date);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

function toQueryString(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]!)}`)
    .join("&");
}

async function httpsPost(
  hostname: string,
  path: string,
  headers: Record<string, string>,
  body: string
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path,
        method: "POST",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export interface SesConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  fromAddress: string; // e.g. "Name <email@example.com>" or "email@example.com"
}

export class SesMailer implements Mailer {
  private cfg: SesConfig;

  constructor(cfg: SesConfig) {
    this.cfg = cfg;
  }

  async send(msg: MailMessage): Promise<void> {
    const { region, accessKeyId, secretAccessKey, fromAddress } = this.cfg;
    const service = "email";
    const host = `email.${region}.amazonaws.com`;

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]/g, "").replace(/\.\d+Z/, "Z");
    const dateStamp = amzDate.slice(0, 8);

    // SES SendEmail uses query-string parameters (POST with form body)
    const from = msg.fromName
      ? `${msg.fromName} <${msg.fromEmail}>`
      : msg.fromEmail;

    const params: Record<string, string> = {
      Action: "SendEmail",
      Source: from,
      "Destination.ToAddresses.member.1": msg.to,
      "Message.Subject.Data": msg.subject,
      "Message.Subject.Charset": "UTF-8",
      "Message.Body.Html.Data": msg.bodyHtml,
      "Message.Body.Html.Charset": "UTF-8",
    };
    if (msg.bodyText) {
      params["Message.Body.Text.Data"] = msg.bodyText;
      params["Message.Body.Text.Charset"] = "UTF-8";
    }
    if (msg.replyTo) {
      params["ReplyToAddresses.member.1"] = msg.replyTo;
    }
    // Use fromAddress as fallback source if different
    if (fromAddress && fromAddress !== from) {
      params["Source"] = fromAddress;
    }

    const body = toQueryString(params);
    const bodyHash = sha256hex(body);

    const canonicalHeaders =
      `content-type:application/x-www-form-urlencoded\n` +
      `host:${host}\n` +
      `x-amz-date:${amzDate}\n`;
    const signedHeaders = "content-type;host;x-amz-date";

    const canonicalRequest = [
      "POST",
      "/",
      "",
      canonicalHeaders,
      signedHeaders,
      bodyHash,
    ].join("\n");

    const credScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credScope,
      sha256hex(canonicalRequest),
    ].join("\n");

    const key = signingKey(secretAccessKey, dateStamp, region, service);
    const signature = createHmac("sha256", key)
      .update(stringToSign)
      .digest("hex");

    const authorizationHeader =
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      "Host": host,
      "X-Amz-Date": amzDate,
      "Authorization": authorizationHeader,
      "Content-Length": String(Buffer.byteLength(body, "utf8")),
    };

    const result = await httpsPost(host, "/", headers, body);
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(
        `SES SendEmail failed: HTTP ${result.statusCode} — ${result.body.slice(0, 500)}`
      );
    }
  }
}
