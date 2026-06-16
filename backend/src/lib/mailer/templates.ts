/**
 * lib/mailer/templates.ts — Branded HTML email templates for CartCrft.
 *
 * Renderer approach: pure TypeScript tagged-template strings, no external deps.
 *
 * XSS safety: ALL user-supplied values (order numbers, names, amounts, links,
 * store names, etc.) are passed through `esc()` before interpolation into HTML.
 * `esc()` replaces &, <, >, ", ' with their HTML entities. URLs used in href/src
 * attributes additionally validate the scheme to prevent javascript: injection.
 *
 * Template set:
 *   Commerce (store-event notification emails):
 *     - order.created          → orderConfirmation()
 *     - payment.captured       → paymentReceived()
 *     - shipment.created       → shipmentDispatched()
 *     - shipment.delivered     → shipmentDelivered()
 *     - payment.refunded       → refundIssued()
 *
 *   Customer-auth:
 *     - customer.email_verify  → emailVerify()
 *     - customer.password_reset→ passwordReset()
 *     - customer.magic_link    → magicLink()
 *     - customer.invite        → invite()
 *     - customer.welcome       → welcome()
 *
 * renderEventEmail(eventType, vars) — used by notifications/service.ts
 * renderAuthEmail(templateName, vars) — replaces renderAuthEmailTemplate() in customer-auth/service.ts
 *
 * Both return { subject, bodyHtml, bodyText } — the caller wraps into MailMessage.
 */

// ── XSS escaping ────────────────────────────────────────────────────────────

/** Escape user-controlled text for safe inline HTML insertion. */
export function esc(val: string | undefined | null): string {
  if (!val) return "";
  return String(val)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * Sanitise a value for use in plain-text contexts (email subjects, bodyText).
 * Strips angle brackets and other characters that would look odd or be
 * misinterpreted in a plain-text header.
 */
function plain(val: string | undefined | null): string {
  if (!val) return "";
  return String(val).replace(/[<>"']/g, "").trim();
}

/**
 * Validate a URL for use in href/src attributes.
 * Only allows http:, https:, and mailto: schemes.
 * Falls back to "#" on invalid input so HTML remains structurally valid.
 */
export function safeUrl(val: string | undefined | null): string {
  if (!val) return "#";
  const s = String(val).trim();
  if (/^(https?:|mailto:)/i.test(s)) return esc(s);
  return "#";
}

// ── Layout / chrome ─────────────────────────────────────────────────────────

interface BrandVars {
  storeName?: string | undefined;
  brandColor?: string | undefined;
  logoUrl?: string | undefined;
}

const DEFAULT_BRAND_COLOR = "#4F46E5";

/** Wraps a rendered body segment in the full branded email chrome. */
function wrap(content: string, brand: BrandVars, preview?: string): string {
  const storeName = esc(brand.storeName ?? "CartCrft");
  const color = /^#[0-9A-Fa-f]{3,6}$/.test(brand.brandColor ?? "")
    ? brand.brandColor!
    : DEFAULT_BRAND_COLOR;
  const logoSection = brand.logoUrl
    ? `<tr><td align="center" style="padding:24px 0 8px;">
         <img src="${safeUrl(brand.logoUrl)}" alt="${storeName}" height="40"
              style="display:block;max-height:40px;border:0;" />
       </td></tr>`
    : "";
  const previewText = preview
    ? `<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#ffffff;">
         ${esc(preview.slice(0, 140))}
       </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${storeName}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
${previewText}
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;padding:32px 16px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
      ${logoSection}
      <tr><td style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;padding:32px;">
        ${content}
      </td></tr>
      <tr><td style="padding:24px 0 0;text-align:center;">
        <p style="margin:0;font-size:12px;color:#9ca3af;">
          Sent by <strong>${storeName}</strong> via CartCrft &middot;
          <a href="https://cartcrft.com" style="color:#9ca3af;text-decoration:none;">cartcrft.com</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/** Render a CTA button. */
function btn(label: string, url: string, color: string): string {
  return `<p style="margin:28px 0;">
    <a href="${safeUrl(url)}"
       style="display:inline-block;background:${color};color:#ffffff;font-size:15px;
              font-weight:600;text-decoration:none;padding:13px 28px;border-radius:7px;
              letter-spacing:0.02em;">
      ${esc(label)}
    </a>
  </p>`;
}

/** Render a bordered data table (label/value rows). */
function dataTable(rows: Array<[string, string]>): string {
  const rowsHtml = rows
    .map(
      ([label, value]) =>
        `<tr>
          <td style="padding:10px 14px;background:#f8fafc;color:#6b7280;font-size:13px;
                     border-top:1px solid #e5e7eb;white-space:nowrap;">${esc(label)}</td>
          <td style="padding:10px 14px;color:#111827;font-size:13px;border-top:1px solid #e5e7eb;
                     text-align:right;">${value}</td>
        </tr>`
    )
    .join("");
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0"
           style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin:20px 0;">
    ${rowsHtml}
  </table>`;
}

// ── Heading helpers ──────────────────────────────────────────────────────────

function heading(text: string, color: string): string {
  return `<h1 style="margin:0 0 8px;font-size:22px;line-height:1.25;color:${color};font-weight:700;">
    ${esc(text)}
  </h1>`;
}

/**
 * Wrap already-safe HTML content in a subheading paragraph.
 * Callers must have already called esc() on any user-controlled portions.
 */
function subheading(safeHtml: string): string {
  return `<p style="margin:0 0 20px;font-size:14px;color:#4b5563;line-height:1.6;">${safeHtml}</p>`;
}

function body(text: string): string {
  return `<p style="margin:12px 0;font-size:14px;color:#374151;line-height:1.7;">${text}</p>`;
}

// ── Commerce templates ───────────────────────────────────────────────────────

export interface OrderConfirmationVars extends BrandVars {
  orderNumber?: string | undefined;
  customerName?: string | undefined;
  customerEmail?: string | undefined;
  orderTotal?: string | undefined;
  currency?: string | undefined;
  linesSummary?: string | undefined;    // plain-text product summary
  storeFrontUrl?: string | undefined;   // e.g. https://mystore.com/orders/123
}

export function renderOrderConfirmation(vars: OrderConfirmationVars): { subject: string; bodyHtml: string; bodyText: string } {
  const color = /^#[0-9A-Fa-f]{3,6}$/.test(vars.brandColor ?? "") ? vars.brandColor! : DEFAULT_BRAND_COLOR;
  const storeNamePlain = plain(vars.storeName ?? "CartCrft");
  // Raw values are HTML-escaped inside dataTable/subheading; plain() is used for subjects/bodyText
  const orderNum = vars.orderNumber ?? "";
  const customerName = vars.customerName ?? "";
  const total = vars.orderTotal ?? "";
  const currency = vars.currency ?? "";
  const link = vars.storeFrontUrl ?? "#";
  const lines = vars.linesSummary ?? "";

  const subject = `Order confirmed${orderNum ? " #" + plain(orderNum) : ""} — ${storeNamePlain}`;

  const html = wrap(
    `${heading("Order confirmed!", color)}
     ${subheading(customerName ? `Hi ${esc(customerName)}, thanks for your order.` : "Thanks for your order.")}
     ${dataTable([
       ...(orderNum ? [["Order #", esc(orderNum)] as [string, string]] : []),
       ...(total ? [[`Total`, esc(`${total}${currency ? " " + currency : ""}`)] as [string, string]] : []),
       ...(vars.customerEmail ? [["Email", esc(vars.customerEmail)] as [string, string]] : []),
     ])}
     ${lines ? body(`<strong>Items:</strong> ${esc(lines)}`) : ""}
     ${link !== "#" ? btn("View order", link, color) : ""}
     ${body("We'll send you an update when your order ships.")}`,
    vars,
    `Order confirmed${orderNum ? " #" + plain(orderNum) : ""} — thanks for your purchase.`
  );

  const text = [
    `Order confirmed! — ${storeNamePlain}`,
    orderNum ? `Order: #${plain(orderNum)}` : "",
    customerName ? `Hi ${plain(customerName)},` : "",
    "Thank you for your order.",
    total ? `Total: ${plain(total)}${currency ? " " + plain(currency) : ""}` : "",
    lines ? `Items: ${plain(lines)}` : "",
    link !== "#" ? `View your order: ${link}` : "",
    "We'll send an update when your order ships.",
  ]
    .filter(Boolean)
    .join("\n");

  return { subject, bodyHtml: html, bodyText: text };
}

// ─────────────────────────────────────────────────────────────────────────────

export interface PaymentReceivedVars extends BrandVars {
  orderNumber?: string | undefined;
  customerName?: string | undefined;
  amount?: string | undefined;
  currency?: string | undefined;
  paymentMethod?: string | undefined;
  storeFrontUrl?: string | undefined;
}

export function renderPaymentReceived(vars: PaymentReceivedVars): { subject: string; bodyHtml: string; bodyText: string } {
  const color = /^#[0-9A-Fa-f]{3,6}$/.test(vars.brandColor ?? "") ? vars.brandColor! : DEFAULT_BRAND_COLOR;
  const storeNamePlain = plain(vars.storeName ?? "CartCrft");
  const orderNum = vars.orderNumber ?? "";
  const amount = vars.amount ?? "";
  const currency = vars.currency ?? "";
  const link = vars.storeFrontUrl ?? "#";

  const subject = `Payment received${orderNum ? " — Order #" + plain(orderNum) : ""} — ${storeNamePlain}`;

  const html = wrap(
    `${heading("Payment received", color)}
     ${subheading(vars.customerName ? `Hi ${esc(vars.customerName)}, we've received your payment.` : "We've received your payment.")}
     ${dataTable([
       ...(orderNum ? [["Order #", esc(orderNum)] as [string, string]] : []),
       ...(amount ? [[`Amount`, esc(`${amount}${currency ? " " + currency : ""}`)] as [string, string]] : []),
       ...(vars.paymentMethod ? [["Method", esc(vars.paymentMethod)] as [string, string]] : []),
     ])}
     ${link !== "#" ? btn("View order", link, color) : ""}`,
    vars,
    `Payment of ${plain(amount)}${currency ? " " + plain(currency) : ""} received for order${orderNum ? " #" + plain(orderNum) : ""}.`
  );

  const text = [
    `Payment received — ${storeNamePlain}`,
    vars.customerName ? `Hi ${plain(vars.customerName)},` : "",
    "We've received your payment.",
    orderNum ? `Order: #${plain(orderNum)}` : "",
    amount ? `Amount: ${plain(amount)}${currency ? " " + plain(currency) : ""}` : "",
    vars.paymentMethod ? `Method: ${plain(vars.paymentMethod)}` : "",
    link !== "#" ? `View order: ${link}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return { subject, bodyHtml: html, bodyText: text };
}

// ─────────────────────────────────────────────────────────────────────────────

export interface ShipmentVars extends BrandVars {
  orderNumber?: string | undefined;
  customerName?: string | undefined;
  trackingNumber?: string | undefined;
  carrier?: string | undefined;
  trackingUrl?: string | undefined;
  deliveredAt?: string | undefined;
}

export function renderShipmentDispatched(vars: ShipmentVars): { subject: string; bodyHtml: string; bodyText: string } {
  const color = /^#[0-9A-Fa-f]{3,6}$/.test(vars.brandColor ?? "") ? vars.brandColor! : DEFAULT_BRAND_COLOR;
  const storeNamePlain = plain(vars.storeName ?? "CartCrft");
  const orderNum = vars.orderNumber ?? "";
  const trackUrl = vars.trackingUrl ?? "#";

  const subject = `Your order${orderNum ? " #" + plain(orderNum) : ""} has shipped — ${storeNamePlain}`;

  const html = wrap(
    `${heading("Your order is on its way!", color)}
     ${subheading(vars.customerName ? `Hi ${esc(vars.customerName)}, great news — your order has shipped!` : "Great news — your order has shipped!")}
     ${dataTable([
       ...(orderNum ? [["Order #", esc(orderNum)] as [string, string]] : []),
       ...(vars.carrier ? [["Carrier", esc(vars.carrier)] as [string, string]] : []),
       ...(vars.trackingNumber ? [["Tracking #", esc(vars.trackingNumber)] as [string, string]] : []),
     ])}
     ${trackUrl !== "#" ? btn("Track shipment", trackUrl, color) : ""}
     ${body("You'll receive another notification when your order is delivered.")}`,
    vars,
    `Your order${orderNum ? " #" + plain(orderNum) : ""} has shipped${vars.carrier ? " via " + plain(vars.carrier) : ""}.`
  );

  const text = [
    `Your order has shipped — ${storeNamePlain}`,
    vars.customerName ? `Hi ${plain(vars.customerName)},` : "",
    `Great news — your order is on its way!`,
    orderNum ? `Order: #${plain(orderNum)}` : "",
    vars.carrier ? `Carrier: ${plain(vars.carrier)}` : "",
    vars.trackingNumber ? `Tracking #: ${plain(vars.trackingNumber)}` : "",
    trackUrl !== "#" ? `Track your shipment: ${trackUrl}` : "",
    "You'll receive another notification when your order is delivered.",
  ]
    .filter(Boolean)
    .join("\n");

  return { subject, bodyHtml: html, bodyText: text };
}

export function renderShipmentDelivered(vars: ShipmentVars): { subject: string; bodyHtml: string; bodyText: string } {
  const color = /^#[0-9A-Fa-f]{3,6}$/.test(vars.brandColor ?? "") ? vars.brandColor! : DEFAULT_BRAND_COLOR;
  const storeNamePlain = plain(vars.storeName ?? "CartCrft");
  const orderNum = vars.orderNumber ?? "";
  const trackUrl = vars.trackingUrl ?? "#";

  const subject = `Your order${orderNum ? " #" + plain(orderNum) : ""} has been delivered — ${storeNamePlain}`;

  const html = wrap(
    `${heading("Order delivered!", color)}
     ${subheading(vars.customerName ? `Hi ${esc(vars.customerName)}, your order has been delivered.` : "Your order has been delivered.")}
     ${dataTable([
       ...(orderNum ? [["Order #", esc(orderNum)] as [string, string]] : []),
       ...(vars.carrier ? [["Carrier", esc(vars.carrier)] as [string, string]] : []),
       ...(vars.deliveredAt ? [["Delivered", esc(vars.deliveredAt)] as [string, string]] : []),
     ])}
     ${trackUrl !== "#" ? btn("View details", trackUrl, color) : ""}
     ${body("Thank you for shopping with us. Enjoy your purchase!")}`,
    vars,
    `Your order${orderNum ? " #" + plain(orderNum) : ""} has been delivered.`
  );

  const text = [
    `Order delivered — ${storeNamePlain}`,
    vars.customerName ? `Hi ${plain(vars.customerName)},` : "",
    "Your order has been delivered.",
    orderNum ? `Order: #${plain(orderNum)}` : "",
    vars.carrier ? `Carrier: ${plain(vars.carrier)}` : "",
    vars.deliveredAt ? `Delivered at: ${plain(vars.deliveredAt)}` : "",
    trackUrl !== "#" ? `View details: ${trackUrl}` : "",
    "Thank you for shopping with us. Enjoy your purchase!",
  ]
    .filter(Boolean)
    .join("\n");

  return { subject, bodyHtml: html, bodyText: text };
}

// ─────────────────────────────────────────────────────────────────────────────

export interface RefundVars extends BrandVars {
  orderNumber?: string | undefined;
  customerName?: string | undefined;
  refundAmount?: string | undefined;
  currency?: string | undefined;
  reason?: string | undefined;
  storeFrontUrl?: string | undefined;
}

export function renderRefundIssued(vars: RefundVars): { subject: string; bodyHtml: string; bodyText: string } {
  const color = /^#[0-9A-Fa-f]{3,6}$/.test(vars.brandColor ?? "") ? vars.brandColor! : DEFAULT_BRAND_COLOR;
  const storeNamePlain = plain(vars.storeName ?? "CartCrft");
  const orderNum = vars.orderNumber ?? "";
  const amount = vars.refundAmount ?? "";
  const currency = vars.currency ?? "";
  const link = vars.storeFrontUrl ?? "#";

  const subject = `Refund issued${orderNum ? " — Order #" + plain(orderNum) : ""} — ${storeNamePlain}`;

  const html = wrap(
    `${heading("Refund issued", color)}
     ${subheading(vars.customerName ? `Hi ${esc(vars.customerName)}, a refund has been issued for your order.` : "A refund has been issued for your order.")}
     ${dataTable([
       ...(orderNum ? [["Order #", esc(orderNum)] as [string, string]] : []),
       ...(amount ? [[`Refund amount`, esc(`${amount}${currency ? " " + currency : ""}`)] as [string, string]] : []),
       ...(vars.reason ? [["Reason", esc(vars.reason)] as [string, string]] : []),
     ])}
     ${body("Refunds typically appear on your statement within 5–10 business days depending on your bank.")}
     ${link !== "#" ? btn("View order", link, color) : ""}`,
    vars,
    `A refund of ${plain(amount)}${currency ? " " + plain(currency) : ""} has been issued for order${orderNum ? " #" + plain(orderNum) : ""}.`
  );

  const text = [
    `Refund issued — ${storeNamePlain}`,
    vars.customerName ? `Hi ${plain(vars.customerName)},` : "",
    "A refund has been issued for your order.",
    orderNum ? `Order: #${plain(orderNum)}` : "",
    amount ? `Refund amount: ${plain(amount)}${currency ? " " + plain(currency) : ""}` : "",
    vars.reason ? `Reason: ${plain(vars.reason)}` : "",
    "Refunds typically appear within 5–10 business days.",
    link !== "#" ? `View your order: ${link}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return { subject, bodyHtml: html, bodyText: text };
}

// ── Customer-auth templates ──────────────────────────────────────────────────

export interface AuthEmailVars extends BrandVars {
  link?: string | undefined;
  token?: string | undefined;
  email?: string | undefined;
  name?: string | undefined;
  redirectUrl?: string | undefined;
}

export function renderEmailVerify(vars: AuthEmailVars): { subject: string; bodyHtml: string; bodyText: string } {
  const color = /^#[0-9A-Fa-f]{3,6}$/.test(vars.brandColor ?? "") ? vars.brandColor! : DEFAULT_BRAND_COLOR;
  const storeNamePlain = plain(vars.storeName ?? "CartCrft");
  const link = vars.link ?? vars.token ?? "#";

  const subject = `Verify your email — ${storeNamePlain}`;
  const html = wrap(
    `${heading("Verify your email", color)}
     ${subheading("Click the button below to verify your email address and activate your account.")}
     ${btn("Verify Email", link, color)}
     ${body('<span style="color:#9ca3af;font-size:13px;">This link expires in 24 hours. If you didn\'t create an account, you can ignore this email.</span>')}`,
    vars,
    "Please verify your email address to activate your account."
  );
  const text = [
    `Verify your email — ${storeNamePlain}`,
    "Click the link below to verify your email address:",
    link,
    "This link expires in 24 hours.",
    "If you didn't create an account, you can ignore this email.",
  ].join("\n\n");

  return { subject, bodyHtml: html, bodyText: text };
}

export function renderPasswordReset(vars: AuthEmailVars): { subject: string; bodyHtml: string; bodyText: string } {
  const color = /^#[0-9A-Fa-f]{3,6}$/.test(vars.brandColor ?? "") ? vars.brandColor! : DEFAULT_BRAND_COLOR;
  const storeNamePlain = plain(vars.storeName ?? "CartCrft");
  const link = vars.link ?? vars.token ?? "#";

  const subject = `Reset your password — ${storeNamePlain}`;
  const html = wrap(
    `${heading("Reset your password", color)}
     ${subheading("We received a request to reset the password for your account.")}
     ${btn("Reset Password", link, color)}
     ${body('<span style="color:#9ca3af;font-size:13px;">This link expires in 1 hour. If you didn\'t request a password reset, you can safely ignore this email.</span>')}`,
    vars,
    "Click the link to reset your password."
  );
  const text = [
    `Reset your password — ${storeNamePlain}`,
    "We received a request to reset your password.",
    "Click the link below to set a new password:",
    link,
    "This link expires in 1 hour.",
    "If you didn't request this, you can safely ignore this email.",
  ].join("\n\n");

  return { subject, bodyHtml: html, bodyText: text };
}

export function renderMagicLink(vars: AuthEmailVars): { subject: string; bodyHtml: string; bodyText: string } {
  const color = /^#[0-9A-Fa-f]{3,6}$/.test(vars.brandColor ?? "") ? vars.brandColor! : DEFAULT_BRAND_COLOR;
  const storeNamePlain = plain(vars.storeName ?? "CartCrft");
  const link = vars.link ?? vars.token ?? "#";

  const subject = `Sign in to ${storeNamePlain}`;
  const html = wrap(
    `${heading(`Sign in to ${esc(storeNamePlain)}`, color)}
     ${subheading("Use the button below to sign in to your account. This link can only be used once.")}
     ${btn("Sign In", link, color)}
     ${body('<span style="color:#9ca3af;font-size:13px;">This link expires in 15 minutes. If you didn\'t request this, you can ignore this email.</span>')}`,
    vars,
    `Click to sign in to ${storeNamePlain}.`
  );
  const text = [
    `Sign in to ${storeNamePlain}`,
    "Click the link below to sign in (expires in 15 minutes):",
    link,
    "If you didn't request this, you can safely ignore this email.",
  ].join("\n\n");

  return { subject, bodyHtml: html, bodyText: text };
}

export function renderInvite(vars: AuthEmailVars): { subject: string; bodyHtml: string; bodyText: string } {
  const color = /^#[0-9A-Fa-f]{3,6}$/.test(vars.brandColor ?? "") ? vars.brandColor! : DEFAULT_BRAND_COLOR;
  const storeNamePlain = plain(vars.storeName ?? "CartCrft");
  const link = vars.link ?? vars.token ?? "#";

  const subject = `You've been invited to ${storeNamePlain}`;
  const html = wrap(
    `${heading(`You're invited to ${esc(storeNamePlain)}`, color)}
     ${subheading(`You've been invited to create an account at ${esc(storeNamePlain)}.`)}
     ${btn("Accept Invitation", link, color)}
     ${body('<span style="color:#9ca3af;font-size:13px;">This invitation expires in 7 days.</span>')}`,
    vars,
    `You've been invited to create an account at ${storeNamePlain}.`
  );
  const text = [
    `You're invited to ${storeNamePlain}`,
    `You've been invited to create an account. Click to accept:`,
    link,
    "This invitation expires in 7 days.",
  ].join("\n\n");

  return { subject, bodyHtml: html, bodyText: text };
}

export function renderWelcome(vars: AuthEmailVars): { subject: string; bodyHtml: string; bodyText: string } {
  const color = /^#[0-9A-Fa-f]{3,6}$/.test(vars.brandColor ?? "") ? vars.brandColor! : DEFAULT_BRAND_COLOR;
  const storeNamePlain = plain(vars.storeName ?? "CartCrft");
  const redirectUrl = vars.redirectUrl ?? vars.link ?? "#";
  const name = plain(vars.name ?? vars.email ?? "");

  const subject = `Welcome to ${storeNamePlain}!`;
  const html = wrap(
    `${heading(`Welcome${name ? ", " + esc(name) + "!" : "!"}`, color)}
     ${subheading(`Your account at ${esc(storeNamePlain)} is ready to go.`)}
     ${redirectUrl !== "#" ? btn("Go to your account", redirectUrl, color) : ""}
     ${body("If you have any questions, just reply to this email.")}`,
    vars,
    `Welcome to ${storeNamePlain}! Your account is ready.`
  );
  const text = [
    `Welcome to ${storeNamePlain}!`,
    name ? `Hi ${name},` : "",
    `Your account is ready to go.`,
    redirectUrl !== "#" ? `Visit your account: ${redirectUrl}` : "",
    "If you have any questions, just reply to this email.",
  ]
    .filter(Boolean)
    .join("\n");

  return { subject, bodyHtml: html, bodyText: text };
}

// ── Unified dispatch routers ─────────────────────────────────────────────────

/**
 * Render a store-event notification email for the given eventType.
 *
 * Used by notifications/service.ts deliverEmail().
 * Payload fields are mapped to template vars; all values go through esc().
 *
 * Returns null for event types that don't have a customer-facing HTML template
 * (e.g. order.updated, inventory.low) — caller falls back to JSON body.
 */
export function renderEventEmail(
  eventType: string,
  payload: Record<string, unknown>,
  brand: BrandVars = {}
): { subject: string; bodyHtml: string; bodyText: string } | null {
  const str = (key: string): string | undefined =>
    typeof payload[key] === "string" ? (payload[key] as string) : undefined;

  switch (eventType) {
    case "order.created":
      return renderOrderConfirmation({
        ...brand,
        orderNumber: str("order_number"),
        customerName: str("customer_name"),
        customerEmail: str("customer_email") ?? str("email"),
        orderTotal: str("total"),
        currency: str("currency"),
        linesSummary: str("lines_summary"),
        storeFrontUrl: str("order_url"),
      });

    case "payment.captured":
      return renderPaymentReceived({
        ...brand,
        orderNumber: str("order_number"),
        customerName: str("customer_name"),
        amount: str("amount"),
        currency: str("currency"),
        paymentMethod: str("payment_method"),
        storeFrontUrl: str("order_url"),
      });

    case "shipment.created":
      return renderShipmentDispatched({
        ...brand,
        orderNumber: str("order_number"),
        customerName: str("customer_name"),
        trackingNumber: str("tracking_number"),
        carrier: str("carrier"),
        trackingUrl: str("tracking_url"),
      });

    case "shipment.delivered":
      return renderShipmentDelivered({
        ...brand,
        orderNumber: str("order_number"),
        customerName: str("customer_name"),
        trackingNumber: str("tracking_number"),
        carrier: str("carrier"),
        trackingUrl: str("tracking_url"),
        deliveredAt: str("delivered_at"),
      });

    case "payment.refunded":
      return renderRefundIssued({
        ...brand,
        orderNumber: str("order_number"),
        customerName: str("customer_name"),
        refundAmount: str("refund_amount"),
        currency: str("currency"),
        reason: str("reason"),
        storeFrontUrl: str("order_url"),
      });

    default:
      return null;
  }
}

/**
 * Render a customer-auth HTML email by template name.
 *
 * Drop-in replacement for the inline renderAuthEmailTemplate() in
 * customer-auth/service.ts — same interface, richer branded output.
 */
export function renderAuthEmail(
  name: string,
  vars: AuthEmailVars
): { subject: string; bodyHtml: string; bodyText: string } {
  switch (name) {
    case "customer.email_verify":
      return renderEmailVerify(vars);
    case "customer.password_reset":
      return renderPasswordReset(vars);
    case "customer.magic_link":
      return renderMagicLink(vars);
    case "customer.invite":
      return renderInvite(vars);
    case "customer.welcome":
      return renderWelcome(vars);
    default:
      // Fallback: plain notification
      return {
        subject: `${esc(vars.storeName ?? "CartCrft")} notification`,
        bodyHtml: wrap(body(vars.link ? `<a href="${safeUrl(vars.link)}">${safeUrl(vars.link)}</a>` : ""), vars),
        bodyText: vars.link ?? "",
      };
  }
}
