/**
 * mailer-templates.test.ts — Unit tests for lib/mailer/templates.ts (C-10c).
 *
 * Tests:
 *  1. esc() XSS-escapes &, <, >, ", '
 *  2. safeUrl() blocks javascript: and data: schemes; passes http/https/mailto
 *  3. order.created renders non-empty HTML + correct subject + plain-text fallback
 *  4. payment.captured renders non-empty HTML + subject contains "Payment received"
 *  5. shipment.created / shipment.delivered render correct subjects + tracking data
 *  6. payment.refunded renders non-empty HTML + correct subject
 *  7. customer.email_verify — subject, HTML non-empty, link in HTML, plain-text fallback
 *  8. customer.password_reset — same checks
 *  9. customer.magic_link — same checks
 * 10. customer.invite — same checks
 * 11. customer.welcome — subject + redirect link
 * 12. renderEventEmail routes all 5 event types correctly
 * 13. renderEventEmail returns null for unknown event types
 * 14. renderAuthEmail routes all 5 template names correctly
 * 15. XSS: user data injected into order fields is escaped in HTML output
 * 16. XSS: user data injected into auth template vars is escaped in HTML output
 * 17. brand color validation — rejects non-hex, falls back to default
 * 18. ConsoleMailer captures subject + bodyHtml when called with rendered output
 * 19. Missing optional fields produce valid HTML (no undefined/null leaking into output)
 * 20. Plain-text fallback is always a non-empty string for every template
 */

import { describe, it, expect } from "vitest";
import {
  esc,
  safeUrl,
  renderOrderConfirmation,
  renderPaymentReceived,
  renderShipmentDispatched,
  renderShipmentDelivered,
  renderRefundIssued,
  renderEmailVerify,
  renderPasswordReset,
  renderMagicLink,
  renderInvite,
  renderWelcome,
  renderEventEmail,
  renderAuthEmail,
} from "../../src/lib/mailer/templates.js";
import { ConsoleMailer } from "../../src/lib/mailer/console.js";

// ── 1. esc() ─────────────────────────────────────────────────────────────────

describe("esc()", () => {
  it("escapes &", () => expect(esc("Tom & Jerry")).toBe("Tom &amp; Jerry"));
  it("escapes <", () => expect(esc("<script>")).toBe("&lt;script&gt;"));
  it("escapes >", () => expect(esc("a > b")).toBe("a &gt; b"));
  it('escapes "', () => expect(esc('"hello"')).toBe("&quot;hello&quot;"));
  it("escapes '", () => expect(esc("it's")).toBe("it&#x27;s"));
  it("handles empty string", () => expect(esc("")).toBe(""));
  it("handles undefined", () => expect(esc(undefined)).toBe(""));
  it("handles null", () => expect(esc(null)).toBe(""));
  it("does not alter safe text", () => expect(esc("hello world")).toBe("hello world"));
});

// ── 2. safeUrl() ──────────────────────────────────────────────────────────────

describe("safeUrl()", () => {
  it("allows https://", () =>
    expect(safeUrl("https://example.com/path")).toContain("https://"));
  it("allows http://", () =>
    expect(safeUrl("http://example.com")).toContain("http://"));
  it("allows mailto:", () =>
    expect(safeUrl("mailto:test@test.com")).toContain("mailto:"));
  it("blocks javascript:", () =>
    expect(safeUrl("javascript:alert(1)")).toBe("#"));
  it("blocks data:", () =>
    expect(safeUrl("data:text/html,<h1>")).toBe("#"));
  it("returns # for empty string", () => expect(safeUrl("")).toBe("#"));
  it("returns # for null", () => expect(safeUrl(null)).toBe("#"));
  it("escapes special chars in URL", () =>
    expect(safeUrl('https://example.com/?a="b"')).not.toContain('"'));
});

// ── 3. Order confirmation ────────────────────────────────────────────────────

describe("renderOrderConfirmation()", () => {
  const vars = {
    storeName: "My Store",
    brandColor: "#1a1a2e",
    orderNumber: "1001",
    customerName: "Alice",
    customerEmail: "alice@example.com",
    orderTotal: "250.00",
    currency: "USD",
    linesSummary: "Widget x2",
    storeFrontUrl: "https://mystore.com/orders/1001",
  };

  it("returns non-empty bodyHtml", () => {
    const { bodyHtml } = renderOrderConfirmation(vars);
    expect(bodyHtml.length).toBeGreaterThan(200);
    expect(bodyHtml).toContain("<!DOCTYPE html>");
  });

  it("contains order number in HTML", () => {
    const { bodyHtml } = renderOrderConfirmation(vars);
    expect(bodyHtml).toContain("1001");
  });

  it("subject contains order number and store name", () => {
    const { subject } = renderOrderConfirmation(vars);
    expect(subject).toContain("#1001");
    expect(subject).toContain("My Store");
  });

  it("bodyText is non-empty", () => {
    const { bodyText } = renderOrderConfirmation(vars);
    expect(bodyText.length).toBeGreaterThan(10);
  });

  it("bodyText contains order total", () => {
    const { bodyText } = renderOrderConfirmation(vars);
    expect(bodyText).toContain("250.00");
  });

  it("HTML contains CTA link", () => {
    const { bodyHtml } = renderOrderConfirmation(vars);
    expect(bodyHtml).toContain("https://mystore.com/orders/1001");
  });
});

// ── 4. Payment received ──────────────────────────────────────────────────────

describe("renderPaymentReceived()", () => {
  const vars = {
    storeName: "My Store",
    orderNumber: "2002",
    customerName: "Bob",
    amount: "99.00",
    currency: "ZAR",
    paymentMethod: "Card",
    storeFrontUrl: "https://mystore.com/orders/2002",
  };

  it("bodyHtml is non-empty", () => {
    const { bodyHtml } = renderPaymentReceived(vars);
    expect(bodyHtml.length).toBeGreaterThan(200);
  });

  it("subject contains Payment received", () => {
    const { subject } = renderPaymentReceived(vars);
    expect(subject.toLowerCase()).toContain("payment received");
  });

  it("subject contains order number", () => {
    const { subject } = renderPaymentReceived(vars);
    expect(subject).toContain("2002");
  });

  it("bodyText has amount", () => {
    const { bodyText } = renderPaymentReceived(vars);
    expect(bodyText).toContain("99.00");
  });
});

// ── 5. Shipment dispatched / delivered ──────────────────────────────────────

describe("renderShipmentDispatched()", () => {
  const vars = {
    storeName: "My Store",
    orderNumber: "3003",
    carrier: "DHL",
    trackingNumber: "TRK-12345",
    trackingUrl: "https://dhl.com/track/TRK-12345",
  };

  it("bodyHtml is non-empty", () => {
    const { bodyHtml } = renderShipmentDispatched(vars);
    expect(bodyHtml.length).toBeGreaterThan(200);
  });

  it("subject contains 'shipped'", () => {
    const { subject } = renderShipmentDispatched(vars);
    expect(subject.toLowerCase()).toContain("ship");
  });

  it("HTML contains tracking number", () => {
    const { bodyHtml } = renderShipmentDispatched(vars);
    expect(bodyHtml).toContain("TRK-12345");
  });

  it("HTML contains carrier name", () => {
    const { bodyHtml } = renderShipmentDispatched(vars);
    expect(bodyHtml).toContain("DHL");
  });

  it("bodyText has tracking link", () => {
    const { bodyText } = renderShipmentDispatched(vars);
    expect(bodyText).toContain("https://dhl.com/track/TRK-12345");
  });
});

describe("renderShipmentDelivered()", () => {
  const vars = {
    storeName: "My Store",
    orderNumber: "4004",
    carrier: "UPS",
    deliveredAt: "2026-06-14T10:00:00Z",
  };

  it("subject contains 'delivered'", () => {
    const { subject } = renderShipmentDelivered(vars);
    expect(subject.toLowerCase()).toContain("delivered");
  });

  it("HTML contains delivered date", () => {
    const { bodyHtml } = renderShipmentDelivered(vars);
    expect(bodyHtml).toContain("2026-06-14");
  });

  it("bodyText is non-empty", () => {
    const { bodyText } = renderShipmentDelivered(vars);
    expect(bodyText.length).toBeGreaterThan(10);
  });
});

// ── 6. Refund ────────────────────────────────────────────────────────────────

describe("renderRefundIssued()", () => {
  const vars = {
    storeName: "My Store",
    orderNumber: "5005",
    refundAmount: "30.00",
    currency: "USD",
    reason: "customer_request",
  };

  it("subject contains 'Refund'", () => {
    const { subject } = renderRefundIssued(vars);
    expect(subject.toLowerCase()).toContain("refund");
  });

  it("bodyHtml contains refund amount", () => {
    const { bodyHtml } = renderRefundIssued(vars);
    expect(bodyHtml).toContain("30.00");
  });

  it("bodyText has reason", () => {
    const { bodyText } = renderRefundIssued(vars);
    expect(bodyText).toContain("customer_request");
  });
});

// ── 7–11. Auth templates ─────────────────────────────────────────────────────

describe("renderEmailVerify()", () => {
  const vars = {
    storeName: "Cool Store",
    brandColor: "#6366f1",
    link: "https://coolstore.com/auth/verify-email?token=abc123",
  };

  it("subject contains 'Verify'", () => {
    expect(renderEmailVerify(vars).subject.toLowerCase()).toContain("verify");
  });

  it("bodyHtml is non-empty and valid HTML", () => {
    const { bodyHtml } = renderEmailVerify(vars);
    expect(bodyHtml).toContain("<!DOCTYPE html>");
    expect(bodyHtml.length).toBeGreaterThan(300);
  });

  it("bodyHtml contains verify link as href", () => {
    const { bodyHtml } = renderEmailVerify(vars);
    expect(bodyHtml).toContain("verify-email?token=abc123");
  });

  it("bodyText is non-empty", () => {
    const { bodyText } = renderEmailVerify(vars);
    expect(bodyText.length).toBeGreaterThan(10);
  });

  it("bodyText contains the link", () => {
    const { bodyText } = renderEmailVerify(vars);
    expect(bodyText).toContain("verify-email?token=abc123");
  });
});

describe("renderPasswordReset()", () => {
  const vars = {
    storeName: "Cool Store",
    link: "https://coolstore.com/auth/reset-password?token=xyz789",
  };

  it("subject contains 'Reset'", () => {
    expect(renderPasswordReset(vars).subject.toLowerCase()).toContain("reset");
  });

  it("bodyHtml contains reset link", () => {
    expect(renderPasswordReset(vars).bodyHtml).toContain("reset-password?token=xyz789");
  });

  it("bodyText contains the link", () => {
    expect(renderPasswordReset(vars).bodyText).toContain("reset-password?token=xyz789");
  });
});

describe("renderMagicLink()", () => {
  const vars = {
    storeName: "Cool Store",
    link: "https://coolstore.com/auth/magic?token=ml99",
  };

  it("subject contains store name", () => {
    expect(renderMagicLink(vars).subject).toContain("Cool Store");
  });

  it("bodyHtml contains magic link href", () => {
    expect(renderMagicLink(vars).bodyHtml).toContain("magic?token=ml99");
  });

  it("bodyText is non-empty", () => {
    expect(renderMagicLink(vars).bodyText.length).toBeGreaterThan(10);
  });
});

describe("renderInvite()", () => {
  const vars = {
    storeName: "My Shop",
    link: "https://myshop.com/auth/invite?token=inv001",
  };

  it("subject mentions 'invited'", () => {
    expect(renderInvite(vars).subject.toLowerCase()).toContain("invited");
  });

  it("bodyHtml contains invite link", () => {
    expect(renderInvite(vars).bodyHtml).toContain("invite?token=inv001");
  });

  it("bodyText contains invite link", () => {
    expect(renderInvite(vars).bodyText).toContain("invite?token=inv001");
  });
});

describe("renderWelcome()", () => {
  const vars = {
    storeName: "My Shop",
    redirectUrl: "https://myshop.com/account",
    name: "Charlie",
  };

  it("subject contains 'Welcome'", () => {
    expect(renderWelcome(vars).subject.toLowerCase()).toContain("welcome");
  });

  it("bodyHtml contains the redirect link", () => {
    expect(renderWelcome(vars).bodyHtml).toContain("https://myshop.com/account");
  });

  it("bodyText mentions the name", () => {
    expect(renderWelcome(vars).bodyText).toContain("Charlie");
  });
});

// ── 12. renderEventEmail routing ─────────────────────────────────────────────

describe("renderEventEmail()", () => {
  const brand = { storeName: "Event Store", brandColor: "#2563eb" };

  it("routes order.created → non-null with correct subject", () => {
    const r = renderEventEmail("order.created", { order_number: "100", total: "50.00", currency: "USD" }, brand);
    expect(r).not.toBeNull();
    expect(r!.subject).toContain("#100");
  });

  it("routes payment.captured → non-null with correct subject", () => {
    const r = renderEventEmail("payment.captured", { order_number: "101", amount: "50.00", currency: "USD" }, brand);
    expect(r).not.toBeNull();
    expect(r!.subject.toLowerCase()).toContain("payment");
  });

  it("routes shipment.created → non-null", () => {
    const r = renderEventEmail("shipment.created", { order_number: "102", carrier: "FedEx", tracking_number: "TRK-X" }, brand);
    expect(r).not.toBeNull();
    expect(r!.bodyHtml).toContain("FedEx");
  });

  it("routes shipment.delivered → non-null", () => {
    const r = renderEventEmail("shipment.delivered", { order_number: "103" }, brand);
    expect(r).not.toBeNull();
    expect(r!.subject.toLowerCase()).toContain("delivered");
  });

  it("routes payment.refunded → non-null", () => {
    const r = renderEventEmail("payment.refunded", { refund_amount: "15.00", currency: "USD" }, brand);
    expect(r).not.toBeNull();
    expect(r!.subject.toLowerCase()).toContain("refund");
  });

  // ── 13. Unknown event types ────────────────────────────────────────────────
  it("returns null for unknown event type", () => {
    expect(renderEventEmail("order.updated", {}, brand)).toBeNull();
  });

  it("returns null for inventory.low", () => {
    expect(renderEventEmail("inventory.low", {}, brand)).toBeNull();
  });
});

// ── 14. renderAuthEmail routing ──────────────────────────────────────────────

describe("renderAuthEmail()", () => {
  const base = { storeName: "Auth Store", link: "https://example.com/auth" };

  it("routes customer.email_verify", () => {
    const r = renderAuthEmail("customer.email_verify", base);
    expect(r.subject.toLowerCase()).toContain("verify");
  });

  it("routes customer.password_reset", () => {
    const r = renderAuthEmail("customer.password_reset", base);
    expect(r.subject.toLowerCase()).toContain("reset");
  });

  it("routes customer.magic_link", () => {
    const r = renderAuthEmail("customer.magic_link", base);
    expect(r.subject.toLowerCase()).toContain("sign in");
  });

  it("routes customer.invite", () => {
    const r = renderAuthEmail("customer.invite", base);
    expect(r.subject.toLowerCase()).toContain("invited");
  });

  it("routes customer.welcome", () => {
    const r = renderAuthEmail("customer.welcome", base);
    expect(r.subject.toLowerCase()).toContain("welcome");
  });

  it("falls back gracefully for unknown template name", () => {
    const r = renderAuthEmail("customer.unknown_template", base);
    expect(r.subject).toBeTruthy();
    expect(r.bodyHtml).toContain("<!DOCTYPE html>");
  });
});

// ── 15. XSS: user data in commerce templates ─────────────────────────────────

describe("XSS safety — commerce templates", () => {
  it("order number with HTML injection is escaped in bodyHtml", () => {
    const { bodyHtml } = renderOrderConfirmation({
      storeName: "Store",
      orderNumber: '<script>alert("xss")</script>',
      orderTotal: "100.00",
      currency: "USD",
    });
    expect(bodyHtml).not.toContain("<script>");
    expect(bodyHtml).toContain("&lt;script&gt;");
  });

  it("customer name with HTML injection is escaped", () => {
    const { bodyHtml } = renderOrderConfirmation({
      storeName: "Store",
      customerName: '<img src=x onerror="alert(1)">',
      orderNumber: "999",
    });
    expect(bodyHtml).not.toContain("<img src=x");
    expect(bodyHtml).toContain("&lt;img");
  });

  it("store name with HTML injection is escaped in subject and bodyHtml", () => {
    const { subject, bodyHtml } = renderPaymentReceived({
      storeName: '<b>Evil</b>',
      amount: "5.00",
      currency: "USD",
    });
    expect(subject).not.toContain("<b>");
    expect(bodyHtml).not.toContain("<b>Evil</b>");
    expect(bodyHtml).toContain("&lt;b&gt;");
  });

  it("javascript: URL in storeFrontUrl is blocked (rendered as #)", () => {
    const { bodyHtml } = renderOrderConfirmation({
      storeName: "Store",
      orderNumber: "1",
      storeFrontUrl: "javascript:alert(document.cookie)",
    });
    expect(bodyHtml).not.toContain("javascript:");
  });

  it("tracking number with HTML is escaped", () => {
    const { bodyHtml } = renderShipmentDispatched({
      storeName: "Store",
      trackingNumber: '<img onerror="xss">',
      carrier: "DHL",
    });
    expect(bodyHtml).not.toContain("<img onerror");
    expect(bodyHtml).toContain("&lt;img");
  });

  it("refund reason with HTML is escaped", () => {
    const { bodyHtml } = renderRefundIssued({
      storeName: "Store",
      reason: '<script>evil()</script>',
      refundAmount: "10.00",
      currency: "USD",
    });
    expect(bodyHtml).not.toContain("<script>");
    expect(bodyHtml).toContain("&lt;script&gt;");
  });
});

// ── 16. XSS: user data in auth templates ────────────────────────────────────

describe("XSS safety — auth templates", () => {
  it("store name with HTML is escaped in email verify bodyHtml", () => {
    const { bodyHtml } = renderEmailVerify({
      storeName: '<script>xss</script>',
      link: "https://example.com/verify",
    });
    expect(bodyHtml).not.toContain("<script>xss</script>");
    expect(bodyHtml).toContain("&lt;script&gt;");
  });

  it("javascript: link in email verify is blocked", () => {
    const { bodyHtml } = renderEmailVerify({
      storeName: "Store",
      link: "javascript:void(0)",
    });
    expect(bodyHtml).not.toContain("javascript:");
  });

  it("data: link in invite is blocked", () => {
    const { bodyHtml } = renderInvite({
      storeName: "Store",
      link: "data:text/html,<h1>hacked</h1>",
    });
    expect(bodyHtml).not.toContain("data:text");
  });
});

// ── 17. Brand color validation ───────────────────────────────────────────────

describe("brand color validation", () => {
  it("accepts valid hex color", () => {
    const { bodyHtml } = renderEmailVerify({
      storeName: "Store",
      brandColor: "#ff6600",
      link: "https://example.com",
    });
    expect(bodyHtml).toContain("#ff6600");
  });

  it("rejects invalid color (falls back to default #4F46E5)", () => {
    const { bodyHtml } = renderEmailVerify({
      storeName: "Store",
      brandColor: "expression(alert(1))",
      link: "https://example.com",
    });
    expect(bodyHtml).not.toContain("expression(");
    expect(bodyHtml).toContain("#4F46E5");
  });

  it("rejects color with semicolon injection", () => {
    const { bodyHtml } = renderEmailVerify({
      storeName: "Store",
      brandColor: "#abc;background:url(evil)",
      link: "https://example.com",
    });
    expect(bodyHtml).not.toContain("background:url");
    expect(bodyHtml).toContain("#4F46E5");
  });
});

// ── 18. ConsoleMailer captures rendered output ───────────────────────────────

describe("ConsoleMailer + rendered templates", () => {
  it("captures subject and bodyHtml when sent rendered order confirmation", async () => {
    const mailer = new ConsoleMailer();
    const rendered = renderOrderConfirmation({
      storeName: "Console Store",
      orderNumber: "7777",
      orderTotal: "120.00",
      currency: "USD",
    });

    await mailer.send({
      to: "customer@example.com",
      fromName: "Console Store",
      fromEmail: "noreply@consolestore.com",
      subject: rendered.subject,
      bodyHtml: rendered.bodyHtml,
      bodyText: rendered.bodyText,
    });

    expect(mailer.sentMessages).toHaveLength(1);
    const msg = mailer.sentMessages[0]!;
    expect(msg.subject).toContain("#7777");
    expect(msg.bodyHtml).toContain("<!DOCTYPE html>");
    expect(msg.bodyHtml.length).toBeGreaterThan(300);
    expect(msg.bodyText).toBeTruthy();
  });

  it("captures magic link email with HTML body via ConsoleMailer", async () => {
    const mailer = new ConsoleMailer();
    const rendered = renderAuthEmail("customer.magic_link", {
      storeName: "Magic Store",
      link: "https://magicstore.com/auth/magic?token=tok42",
    });

    await mailer.send({
      to: "user@example.com",
      fromName: "Magic Store",
      fromEmail: "noreply@magicstore.com",
      subject: rendered.subject,
      bodyHtml: rendered.bodyHtml,
      bodyText: rendered.bodyText,
    });

    expect(mailer.sentMessages).toHaveLength(1);
    const msg = mailer.sentMessages[0]!;
    expect(msg.subject).toContain("Magic Store");
    expect(msg.bodyHtml).toContain("<!DOCTYPE html>");
    expect(msg.bodyHtml).toContain("magic?token=tok42");
    expect(msg.bodyText).toContain("magic?token=tok42");
  });
});

// ── 19. Missing optional fields ──────────────────────────────────────────────

describe("Missing optional fields produce valid HTML", () => {
  it("order confirmation with no optional fields produces valid HTML", () => {
    const { bodyHtml, bodyText, subject } = renderOrderConfirmation({
      storeName: "Minimal Store",
    });
    expect(bodyHtml).toContain("<!DOCTYPE html>");
    expect(bodyHtml).not.toContain("undefined");
    expect(bodyHtml).not.toContain("[object Object]");
    expect(bodyText).not.toContain("undefined");
    expect(subject).toBeTruthy();
  });

  it("payment received with no optional fields produces valid HTML", () => {
    const { bodyHtml } = renderPaymentReceived({ storeName: "Store" });
    expect(bodyHtml).toContain("<!DOCTYPE html>");
    expect(bodyHtml).not.toContain("undefined");
  });

  it("shipment dispatched with no optional fields produces valid HTML", () => {
    const { bodyHtml } = renderShipmentDispatched({ storeName: "Store" });
    expect(bodyHtml).toContain("<!DOCTYPE html>");
    expect(bodyHtml).not.toContain("undefined");
  });

  it("auth template with no link produces valid HTML", () => {
    const { bodyHtml } = renderEmailVerify({ storeName: "Store" });
    expect(bodyHtml).toContain("<!DOCTYPE html>");
    expect(bodyHtml).not.toContain("undefined");
  });
});

// ── 20. Plain-text fallback is always non-empty ───────────────────────────────

describe("Plain-text fallback always present", () => {
  const link = "https://example.com/auth";
  const brand = { storeName: "Test Store", link };

  const cases: Array<[string, () => { bodyText: string }]> = [
    ["renderOrderConfirmation", () => renderOrderConfirmation({ storeName: "S", orderNumber: "1", orderTotal: "10.00", currency: "USD" })],
    ["renderPaymentReceived", () => renderPaymentReceived({ storeName: "S", amount: "10.00", currency: "USD" })],
    ["renderShipmentDispatched", () => renderShipmentDispatched({ storeName: "S", carrier: "DHL" })],
    ["renderShipmentDelivered", () => renderShipmentDelivered({ storeName: "S" })],
    ["renderRefundIssued", () => renderRefundIssued({ storeName: "S", refundAmount: "5.00", currency: "USD" })],
    ["renderEmailVerify", () => renderEmailVerify(brand)],
    ["renderPasswordReset", () => renderPasswordReset(brand)],
    ["renderMagicLink", () => renderMagicLink(brand)],
    ["renderInvite", () => renderInvite(brand)],
    ["renderWelcome", () => renderWelcome({ storeName: "S", redirectUrl: link })],
  ];

  for (const [name, fn] of cases) {
    it(`${name} has non-empty bodyText`, () => {
      const { bodyText } = fn();
      expect(bodyText.trim().length).toBeGreaterThan(5);
    });
  }
});
