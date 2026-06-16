import { Link } from 'react-router-dom'
import LegalLayout from '../LegalLayout'

/**
 * Privacy Policy — /legal/privacy
 * Grounded in real CartCrft data flows: Neon Postgres, Paystack, AWS SES,
 * Bunny CDN, Backblaze B2, analytics pixels (GA4, Meta, TikTok, etc.),
 * exchange-rate API, BYO LLM keys, multi-tenant controller/processor split.
 */
export default function Privacy() {
  return (
    <LegalLayout
      title="Privacy Policy"
      description="Privacy Policy for CartCrft Cloud — how WebCrft collects, uses, and protects personal information."
      lastUpdated="2026-06-14"
    >
      <div className="notice-box">
        <strong>Notice:</strong> This document is a template provided for transparency and must be reviewed and adapted by qualified legal counsel before you rely on it. It is not legal advice.
      </div>

      <h2>1. Who We Are</h2>
      <p>
        <strong>Webcrft Systems (Pty) Ltd</strong> is the company behind CartCrft Cloud, a managed
        headless commerce platform, registered in the Republic of South Africa. We are the
        {' '}<strong>Responsible Party</strong> under POPIA and the <strong>Data Controller</strong> under
        GDPR in respect of the personal information described in this Policy.
      </p>
      <p>Contact our Information Officer at <a href="mailto:privacy@webcrft.io">privacy@webcrft.io</a>.</p>

      <h2>2. Scope</h2>

      <h3>2.1 Cloud Account and Billing Data (WebCrft as Controller)</h3>
      <p>
        This Policy covers personal information that WebCrft collects about you (the merchant
        or developer) when you create an account, subscribe, or interact with CartCrft Cloud.
      </p>

      <h3>2.2 Your Store's End-Customer Data (You as Controller, WebCrft as Processor)</h3>
      <p>
        When you use CartCrft Cloud to operate your store, your end-customers' personal information
        is stored in your tenant's Postgres database on Neon.
        {' '}<strong>You are the data controller for that data; WebCrft processes it solely on
        your instructions.</strong> We do not access, sell, or use your end-customers' data for our
        own purposes. End-customers should contact the store operator directly about their rights.
      </p>

      <h3>2.3 Self-Hosted Deployments</h3>
      <p>
        If you self-host the MIT-licensed core, all data stays in your own infrastructure. WebCrft
        receives no personal information and this Policy does not apply.
      </p>

      <h2>3. Information We Collect</h2>

      <h3>3.1 Account Information</h3>
      <ul>
        <li>Name and email address</li>
        <li>Company name and country (optional, for invoicing)</li>
        <li>Authentication credentials (password hash, OAuth tokens)</li>
        <li>API key identifiers (<code>cc_pub_</code> / <code>cc_prv_</code> — IDs only, never secret values in logs)</li>
      </ul>

      <h3>3.2 Billing Information</h3>
      <ul>
        <li>Subscription plan, billing cycle, and payment history (referenced in our database; full card data held exclusively by Paystack)</li>
        <li>Invoice records including USD-priced / ZAR-charged amounts and exchange-rate snapshots from exchangerate-api.com</li>
      </ul>

      <h3>3.3 Usage and Technical Data</h3>
      <ul>
        <li>API request logs (timestamp, endpoint, method, response code) — for security, debugging, and rate-limiting</li>
        <li>IP addresses (rate limiting at configurable requests/minute, security monitoring)</li>
        <li>Browser type and OS (dashboard access)</li>
        <li>Webhook delivery logs and payment webhook event IDs (replay protection via <code>webhook_replay_guard</code>)</li>
        <li>Embedding-worker job logs (when semantic search is enabled)</li>
      </ul>

      <h3>3.4 Store Configuration Data</h3>
      <ul>
        <li>Payment-provider configuration (provider type, webhook secrets — AES-256-GCM encrypted; unreadable by WebCrft staff)</li>
        <li>BYO LLM provider API key (stored encrypted in <code>stores.metadata</code>; transmitted only to your configured embedding endpoint)</li>
        <li>Tracking pixel configuration (<code>store_tracking_pixels</code> table — pixel type, tracking ID, API secret)</li>
        <li>Shipping provider configuration (BobGo live rates, PUDO collection points)</li>
      </ul>

      <h3>3.5 Communications</h3>
      <ul>
        <li>Support tickets and email correspondence</li>
        <li>Transactional emails sent via AWS SES (verification, password reset, billing notices)</li>
      </ul>

      <h2>4. How We Use Your Information</h2>

      <table>
        <thead>
          <tr><th>Purpose</th><th>Lawful Basis (POPIA)</th><th>Lawful Basis (GDPR Art. 6)</th></tr>
        </thead>
        <tbody>
          <tr><td>Providing and operating the Service</td><td>Contractual necessity (s.11(1)(b))</td><td>Contract (Art. 6(1)(b))</td></tr>
          <tr><td>Billing and subscription management via Paystack</td><td>Contractual necessity (s.11(1)(b))</td><td>Contract (Art. 6(1)(b))</td></tr>
          <tr><td>Transactional emails via AWS SES</td><td>Contractual necessity (s.11(1)(b))</td><td>Contract (Art. 6(1)(b))</td></tr>
          <tr><td>Security monitoring, rate limiting, fraud prevention</td><td>Legitimate interest (s.11(1)(f))</td><td>Legitimate interests (Art. 6(1)(f))</td></tr>
          <tr><td>Legal obligations (tax records, FICA)</td><td>Legal obligation (s.11(1)(c))</td><td>Legal obligation (Art. 6(1)(c))</td></tr>
          <tr><td>Product analytics and improvement (aggregated)</td><td>Legitimate interest (s.11(1)(f))</td><td>Legitimate interests (Art. 6(1)(f))</td></tr>
          <tr><td>Marketing communications (opt-in only)</td><td>Consent (s.11(1)(a))</td><td>Consent (Art. 6(1)(a))</td></tr>
        </tbody>
      </table>

      <h2>5. Subprocessors and Data Sharing</h2>
      <p>We do not sell your personal information. We share it only with the following subprocessors, each under a written data-processing agreement:</p>

      <table>
        <thead>
          <tr><th>Subprocessor</th><th>Purpose</th><th>Data Category</th><th>Primary Region</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Neon (Neon Inc.)</strong></td>
            <td>Managed Postgres database hosting — all structured store and account data; pgvector for semantic search embeddings</td>
            <td>All database data: account records, store config, end-customer data on your behalf</td>
            <td>US-East-1 (default); region selectable at provisioning</td>
          </tr>
          <tr>
            <td><strong>Paystack (Paystack Payments Ltd)</strong></td>
            <td>Cloud subscription billing — processes card payments for CartCrft Cloud subscriptions; holds card data on PCI-DSS certified systems</td>
            <td>Account email, subscription details; payment card data held by Paystack only</td>
            <td>Nigeria / South Africa / Ireland (EU)</td>
          </tr>
          <tr>
            <td><strong>AWS Simple Email Service (Amazon Web Services Inc.)</strong></td>
            <td>Transactional email delivery: verification, password reset, magic links, billing notices</td>
            <td>Account email address, email content</td>
            <td>Configurable via <code>AWS_SES_REGION</code>; default us-east-1</td>
          </tr>
          <tr>
            <td><strong>Bunny CDN (BunnyWay d.o.o.)</strong></td>
            <td>Content delivery network for static assets (marketing site, dashboard, store media)</td>
            <td>IP address in transit, CDN request logs</td>
            <td>Global PoP network; EU-incorporated (Slovenia)</td>
          </tr>
          <tr>
            <td><strong>Backblaze B2 (Backblaze Inc.)</strong></td>
            <td>Object storage for uploaded store media and assets</td>
            <td>Files you upload; no directly identifying data beyond file content</td>
            <td>United States (primary); EU optional</td>
          </tr>
          <tr>
            <td><strong>exchangerate-api.com</strong></td>
            <td>Live USD/ZAR exchange-rate data for billing invoices</td>
            <td>No personal data — API key and rate data only</td>
            <td>United States</td>
          </tr>
        </tbody>
      </table>

      <h3>5.1 Merchant-Configured Subprocessors</h3>
      <p>When you enable optional integrations for your store, additional subprocessors are involved under your direction as data controller:</p>
      <ul>
        <li><strong>Payment providers (Stripe, Paystack merchant mode, Razorpay, Xendit):</strong> BYO credentials stored encrypted by us; you are responsible for compliance with their terms.</li>
        <li><strong>LLM / embedding providers (OpenAI-compatible endpoints):</strong> Product titles and descriptions sent to your configured endpoint for pgvector search embeddings. API key stored AES-256-GCM encrypted.</li>
        <li><strong>Analytics pixels</strong> (per-store, configured via dashboard): if you enable Google Analytics 4, Google Tag Manager, Meta Pixel, TikTok Pixel, Snapchat Pixel, Pinterest Tag, or Twitter Pixel, the vendor's SDK operates client-side on your storefront pages. You are the data controller for that pixel data and must provide consent mechanisms to your end-customers.</li>
        <li><strong>Shipping providers (BobGo, PUDO):</strong> Shipping addresses shared as needed for rate quotes and tracking.</li>
      </ul>

      <h2>6. International Data Transfers</h2>
      <p>
        WebCrft is based in South Africa. Personal data is transferred to subprocessors in
        the US and other jurisdictions under EU Standard Contractual Clauses (for EU data subjects)
        and POPIA section 72 conditions (substantially similar data-protection obligations, or transfer
        necessary for performance of a contract).
      </p>
      <p>See our <Link to="/legal/gdpr">GDPR disclosure</Link> and <Link to="/legal/popia">POPIA disclosure</Link> for jurisdiction-specific details.</p>

      <h2>7. Cookies and Analytics</h2>

      <h3>7.1 Dashboard and Marketing Site</h3>
      <ul>
        <li><strong>Strictly necessary cookies:</strong> Session authentication; cannot be opted out without losing account access.</li>
        <li><strong>Analytics:</strong> Where third-party analytics cookies are placed on the marketing site, we will obtain your consent via a cookie banner first.</li>
      </ul>

      <h3>7.2 Your Storefront (Merchant Responsibility)</h3>
      <p>
        If you configure tracking pixels for your store, those pixels run client-side on your customers'
        browsers. As store operator and data controller, you are responsible for: obtaining valid consent
        from end-customers before setting tracking cookies; maintaining a cookie notice and privacy policy
        for your storefront; and complying with POPIA, GDPR, ePrivacy, and other applicable laws.
      </p>
      <p>
        CartCrft's GA4 server-side Measurement Protocol integration fires a <code>purchase</code> event
        on payment capture using your configured GA4 API secret. No additional end-customer data is shared
        with Google beyond what you have already configured in your GA4 pixel.
      </p>

      <h2>8. Data Retention</h2>

      <table>
        <thead>
          <tr><th>Data Category</th><th>Retention Period</th></tr>
        </thead>
        <tbody>
          <tr><td>Account data (active accounts)</td><td>Duration of account, plus 30 days post-closure</td></tr>
          <tr><td>Billing records and invoices</td><td>5 years after end of relevant tax year (SARS requirements)</td></tr>
          <tr><td>API request logs</td><td>90 days (rolling)</td></tr>
          <tr><td>Webhook event logs and replay-guard records</td><td>90 days rolling; replay-guard dedup window 7 days</td></tr>
          <tr><td>Support correspondence</td><td>3 years from ticket closure</td></tr>
          <tr><td>Store end-customer data (processed on your behalf)</td><td>As instructed by you; deleted on account closure + 30 days</td></tr>
          <tr><td>Encrypted provider API keys</td><td>Deleted immediately on configuration removal or account closure</td></tr>
        </tbody>
      </table>

      <h2>9. Security</h2>
      <ul>
        <li><strong>Encryption at rest:</strong> Provider secrets encrypted using AES-256-GCM with 12-byte nonce; layout: <code>base64(nonce_12B || ciphertext || tag_16B)</code>. See <a href="/docs/security">security documentation</a>.</li>
        <li><strong>Encryption in transit:</strong> All connections use TLS.</li>
        <li><strong>Database isolation:</strong> App-layer ownership checks (JWT <code>org</code> claim on every request) plus PostgreSQL RLS via a <code>NOBYPASSRLS</code> role (<code>cartcrft_app</code>) enforced inside every authenticated transaction.</li>
        <li><strong>Rate limiting:</strong> IP-based rate limiting on all API endpoints.</li>
        <li><strong>Webhook verification:</strong> HMAC-SHA256 (Stripe/Razorpay), HMAC-SHA512 (Paystack), with replay protection.</li>
        <li><strong>Scoped API keys:</strong> <code>cc_pub_</code> (read-only) and <code>cc_prv_</code> (write/admin) tiers.</li>
      </ul>
      <p>Report security vulnerabilities to <a href="mailto:security@webcrft.io">security@webcrft.io</a>.</p>

      <h2>10. Your Rights</h2>
      <p>
        Email <a href="mailto:privacy@webcrft.io">privacy@webcrft.io</a> to exercise any of these rights.
        We will respond within 30 days (1 month for GDPR requests).
      </p>
      <ul>
        <li><strong>Access:</strong> Request a copy of personal information we hold about you.</li>
        <li><strong>Correction:</strong> Request correction of inaccurate information (or update in the dashboard).</li>
        <li><strong>Deletion / Erasure:</strong> Request deletion subject to legal retention obligations.</li>
        <li><strong>Objection:</strong> Object to processing based on legitimate interests.</li>
        <li><strong>Restriction:</strong> Request restriction of processing in certain circumstances.</li>
        <li><strong>Portability:</strong> Receive your account data in a machine-readable format (GDPR Art. 20).</li>
        <li><strong>Withdraw consent:</strong> Withdraw at any time via the unsubscribe link or by emailing us.</li>
      </ul>
      <p>
        For POPIA-specific rights see <Link to="/legal/popia">POPIA disclosure</Link>.
        For GDPR-specific rights see <Link to="/legal/gdpr">GDPR disclosure</Link>.
      </p>

      <h2>11. Children</h2>
      <p>The Service is not directed at children under 18. Contact us at <a href="mailto:privacy@webcrft.io">privacy@webcrft.io</a> if you become aware that a child has provided personal information.</p>

      <h2>12. Changes to This Policy</h2>
      <p>Material changes will be communicated to the email on your account at least 30 days before they take effect.</p>

      <h2>13. Contact</h2>
      <p>
        <strong>Webcrft Systems (Pty) Ltd</strong><br />
        Information Officer: <strong>[PLACEHOLDER: name of Information Officer]</strong><br />
        Registration number: <strong>[PLACEHOLDER: company registration number]</strong><br />
        Registered address: <strong>[PLACEHOLDER: registered office address, South Africa]</strong><br />
        Privacy enquiries: <a href="mailto:privacy@webcrft.io">privacy@webcrft.io</a>
      </p>

      <p>
        See also: <Link to="/legal/terms">Terms of Service</Link> &middot;
        {' '}<Link to="/legal/popia">POPIA Disclosure</Link> &middot;
        {' '}<Link to="/legal/gdpr">GDPR Disclosure</Link>
      </p>
    </LegalLayout>
  )
}
