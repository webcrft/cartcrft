/**
 * lib/mailer/index.ts — Mailer interface.
 *
 * Implementations: ConsoleMailer (dev/test), SesMailer (production).
 */

export interface MailMessage {
  to: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}
