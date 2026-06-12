/**
 * feeds/xml.ts — XML generation helpers for product feeds.
 *
 * Faithfully ports the RSS 2.0 + Google Merchant namespace (xmlns:g) structure
 * from commerce_feeds.go. Both Google Shopping and Facebook Catalog feeds use
 * the same RSS 2.0 / g: namespace envelope; Facebook adds g:product_type.
 */

import type { FeedItem } from "./types.js";

/** Strip HTML tags from a string (port of Go stripHTMLTags). */
export function stripHtml(s: string): string {
  let out = "";
  let inTag = false;
  for (const ch of s) {
    if (ch === "<") {
      inTag = true;
    } else if (ch === ">") {
      inTag = false;
    } else if (!inTag) {
      out += ch;
    }
  }
  return out.trim();
}

/** Escape special XML characters. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Wrap non-empty value in an XML element, or return empty string. */
function el(tag: string, value: string | null | undefined): string {
  if (!value) return "";
  return `    <${tag}>${xmlEscape(value)}</${tag}>\n`;
}

/** Build the XML header + RSS envelope for a product feed. */
export function buildFeedXml(opts: {
  storeName: string;
  storeUrl: string;
  description: string;
  items: string[];
}): string {
  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">`);
  lines.push(`  <channel>`);
  lines.push(`    <title>${xmlEscape(opts.storeName)}</title>`);
  lines.push(`    <link>${xmlEscape(opts.storeUrl)}</link>`);
  lines.push(`    <description>${xmlEscape(opts.description)}</description>`);
  for (const item of opts.items) {
    lines.push(item);
  }
  lines.push(`  </channel>`);
  lines.push(`</rss>`);
  return lines.join("\n");
}

/**
 * Render a Google Shopping feed item.
 *
 * Fields: g:id, g:title, g:description, g:link, g:image_link (omitempty),
 * g:condition, g:availability, g:price, g:brand (omitempty), g:gtin (omitempty),
 * g:mpn (omitempty), g:google_product_category (omitempty),
 * g:age_group (omitempty), g:gender (omitempty).
 *
 * Price format: "12.99 USD" (Go: "%.2f %s" price, strings.ToUpper(currency)).
 * Availability: "in_stock" | "out_of_stock" (Go source uses underscore form).
 */
export function renderGoogleItem(item: FeedItem, storeUrl: string, currency: string): string {
  const link = `${storeUrl}/products/${item.slug}`;
  const priceStr = `${parseFloat(item.price).toFixed(2)} ${currency.toUpperCase()}`;
  const desc = item.description.length > 5000 ? item.description.slice(0, 5000) : item.description;

  let out = "    <item>\n";
  out += `      <g:id>${xmlEscape(item.id)}</g:id>\n`;
  out += `      <g:title>${xmlEscape(item.title)}</g:title>\n`;
  out += `      <g:description>${xmlEscape(desc)}</g:description>\n`;
  out += `      <g:link>${xmlEscape(link)}</g:link>\n`;
  if (item.imageUrl) out += `      <g:image_link>${xmlEscape(item.imageUrl)}</g:image_link>\n`;
  out += `      <g:condition>${xmlEscape(item.condition || "new")}</g:condition>\n`;
  out += `      <g:availability>${xmlEscape(item.availability)}</g:availability>\n`;
  out += `      <g:price>${xmlEscape(priceStr)}</g:price>\n`;
  if (item.brand) out += `      <g:brand>${xmlEscape(item.brand)}</g:brand>\n`;
  if (item.gtin) out += `      <g:gtin>${xmlEscape(item.gtin)}</g:gtin>\n`;
  if (item.mpn) out += `      <g:mpn>${xmlEscape(item.mpn)}</g:mpn>\n`;
  if (item.googleProductCategory) out += `      <g:google_product_category>${xmlEscape(item.googleProductCategory)}</g:google_product_category>\n`;
  if (item.ageGroup) out += `      <g:age_group>${xmlEscape(item.ageGroup)}</g:age_group>\n`;
  if (item.gender) out += `      <g:gender>${xmlEscape(item.gender)}</g:gender>\n`;
  out += "    </item>";
  return out;
}

/**
 * Render a Facebook Catalog feed item.
 *
 * Identical envelope to Google Shopping but uses "in stock" / "out of stock"
 * (space-separated, per Go source) and adds g:product_type instead of
 * individual shopping fields.
 */
export function renderFacebookItem(item: FeedItem, storeUrl: string, currency: string, productType: string): string {
  const link = `${storeUrl}/products/${item.slug}`;
  const priceStr = `${parseFloat(item.price).toFixed(2)} ${currency.toUpperCase()}`;
  const desc = item.description.length > 5000 ? item.description.slice(0, 5000) : item.description;

  let out = "    <item>\n";
  out += `      <g:id>${xmlEscape(item.id)}</g:id>\n`;
  out += `      <g:title>${xmlEscape(item.title)}</g:title>\n`;
  out += `      <g:description>${xmlEscape(desc)}</g:description>\n`;
  out += `      <g:link>${xmlEscape(link)}</g:link>\n`;
  if (item.imageUrl) out += `      <g:image_link>${xmlEscape(item.imageUrl)}</g:image_link>\n`;
  out += `      <g:condition>${xmlEscape(item.condition || "new")}</g:condition>\n`;
  out += `      <g:availability>${xmlEscape(item.availability)}</g:availability>\n`;
  out += `      <g:price>${xmlEscape(priceStr)}</g:price>\n`;
  if (item.brand) out += `      <g:brand>${xmlEscape(item.brand)}</g:brand>\n`;
  if (item.gtin) out += `      <g:gtin>${xmlEscape(item.gtin)}</g:gtin>\n`;
  if (productType) out += `      <g:product_type>${xmlEscape(productType)}</g:product_type>\n`;
  out += "    </item>";
  return out;
}

// Re-export for external usage
export { el };
