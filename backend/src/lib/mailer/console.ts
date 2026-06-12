/**
 * lib/mailer/console.ts — Console mailer for dev / tests.
 *
 * Logs emails to stdout and stores them in sentMessages for test assertions.
 */

import type { Mailer, MailMessage } from "./index.js";

export class ConsoleMailer implements Mailer {
  public sentMessages: MailMessage[] = [];

  async send(msg: MailMessage): Promise<void> {
    this.sentMessages.push(msg);
    console.log("[ConsoleMailer]", msg.to, msg.subject);
  }

  clear(): void {
    this.sentMessages = [];
  }
}
