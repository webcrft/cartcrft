import { Link } from 'react-router-dom'
import LegalLayout from '../LegalLayout'

/**
 * Terms of Service — /legal/terms
 * Grounded in the actual Cartcrft product: headless commerce backend, BYO-keys,
 * multi-tenant cloud layer (cloud/), MIT core, Paystack billing, South African law.
 */
export default function Terms() {
  return (
    <LegalLayout
      title="Terms of Service"
      description="Terms of Service for Cartcrft Cloud — the managed hosting service operated by WebCrft."
      lastUpdated="2026-06-14"
    >
      <div className="notice-box">
        <strong>Notice:</strong> This document is a template provided for transparency and must be reviewed and adapted by qualified legal counsel before you rely on it. It is not legal advice. If you have questions, consult an attorney licensed in the relevant jurisdiction.
      </div>

      <h2>1. Introduction and Acceptance</h2>
      <p>
        These Terms of Service ("Terms") govern your access to and use of <strong>Cartcrft Cloud</strong>,
        the managed commerce-backend service at <a href="https://cartcrft.com">cartcrft.com</a>
        {' '}("Service"), operated by <strong>Webcrft Systems (Pty) Ltd</strong>, a company registered in
        the Republic of South Africa ("WebCrft", "we", "us", or "our").
      </p>
      <p>
        By creating an account, accessing the dashboard, or making any API call against the Service
        you confirm that you have read, understood, and agreed to these Terms. If you do not agree,
        do not use the Service. If you are accepting on behalf of a legal entity, you represent that
        you have authority to bind that entity and "you" refers to that entity.
      </p>

      <h2>2. Service Description</h2>
      <p>Cartcrft Cloud is a multi-tenant, headless commerce platform. It provides:</p>
      <ul>
        <li>A managed instance of the Cartcrft backend (REST API + MCP server), hosted on our infrastructure;</li>
        <li>Tenant provisioning, metering, and billing via the cloud layer;</li>
        <li>Asset delivery via Bunny CDN and object storage via Backblaze B2;</li>
        <li>Transactional email delivery via AWS Simple Email Service (SES);</li>
        <li>Access to the Cartcrft admin dashboard SPA and generated TypeScript SDK (<code>@cartcrft/sdk</code>).</li>
      </ul>
      <p>
        The Service does <strong>not</strong> include payment processing on your behalf. Cartcrft Cloud
        gives you infrastructure to connect your own payment provider credentials (Stripe, Paystack,
        Razorpay, Xendit, or a custom webhook provider). See Section 6.
      </p>

      <h3>2.1 Preview Status</h3>
      <p>
        Cartcrft Cloud is currently in preview. Certain features — including live payment capture,
        agentic checkout via ACP/UCP, and outbound webhooks — are completing production hardening.
        Preview-stage features are provided without service-level commitments (see Section 10).
      </p>

      <h2>3. Open-Source Core vs. Cloud Service</h2>

      <h3>3.1 MIT-Licensed Core</h3>
      <p>
        Everything outside the <code>cloud/</code> directory — the backend, MCP server, TypeScript SDK,
        admin dashboard, and supporting packages — is distributed under the
        {' '}<strong>MIT License</strong>
        {' '}(see <a href="https://github.com/webcrftsystems/cartcrft/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">LICENSE</a>).
        Self-hosting the MIT core requires no agreement with WebCrft. Nothing in these Terms
        restricts your use of the MIT-licensed software.
      </p>

      <h3>3.2 Cartcrft Cloud License</h3>
      <p>
        The <code>cloud/</code> directory is distributed under the
        {' '}<strong>Cartcrft Cloud License v1.0</strong>
        {' '}(<a href="https://github.com/webcrftsystems/cartcrft/blob/main/cloud/LICENSE" target="_blank" rel="noopener noreferrer">cloud/LICENSE</a>):
        source-visible; viewing and development/testing use permitted; production or commercial
        deployment requires a separate written agreement with WebCrft.
      </p>

      <h3>3.3 These Terms</h3>
      <p>
        These Terms govern your use of <em>Cartcrft Cloud as a hosted service</em>. They supplement,
        and in case of conflict override, the Cartcrft Cloud License.
      </p>

      <h2>4. Accounts</h2>
      <ul>
        <li>You must provide accurate registration information and keep it up to date.</li>
        <li>You are responsible for maintaining the confidentiality of your credentials, API keys
            (<code>cc_pub_</code> and <code>cc_prv_</code>), and JWT secrets.</li>
        <li>Notify us immediately at <a href="mailto:security@webcrft.io">security@webcrft.io</a>
            {' '}of any suspected unauthorised access.</li>
        <li>One person or legal entity may not maintain more than one free-tier account without
            prior written consent.</li>
        <li>You are responsible for all activity under your account, including by agents operating
            with your API keys.</li>
      </ul>

      <h2>5. Acceptable Use</h2>
      <p>You agree <strong>not</strong> to use the Service to:</p>
      <ul>
        <li>Violate any applicable law, regulation, or enforceable third-party right;</li>
        <li>Process transactions for prohibited goods or services under your payment provider's terms
            or applicable South African law (including the Consumer Protection Act 68 of 2008 and the
            Financial Intelligence Centre Act);</li>
        <li>Upload, transmit, or store malware, spam, or content facilitating phishing or fraud;</li>
        <li>Conduct security testing or load testing against shared infrastructure without prior
            written approval;</li>
        <li>Circumvent the multi-tenant isolation mechanisms (app-layer auth checks and PostgreSQL
            row-level security);</li>
        <li>Resell access to the Service or operate a competing managed-hosting product using the
            {' '}<code>cloud/</code> layer without a written commercial agreement;</li>
        <li>Use the MCP server or agent-mandate system to execute transactions exceeding configured
            spend limits, or to defraud end-customers.</li>
      </ul>

      <h2>6. BYO Keys and Merchant Responsibilities</h2>
      <p>Cartcrft operates on a <strong>bring-your-own-keys</strong> (BYO) model:</p>
      <ul>
        <li><strong>Payment providers:</strong> You configure your own credentials for Stripe,
            Paystack, Razorpay, or Xendit. WebCrft stores them AES-256-GCM encrypted and
            does not use them for any purpose beyond routing your transactions.</li>
        <li><strong>LLM/embeddings key:</strong> If you enable semantic search, you supply an
            OpenAI-compatible API key stored encrypted per-store; transmitted only to the endpoint
            you configure.</li>
        <li><strong>Merchant of record:</strong> For your store's end-customer transactions, you are
            the merchant of record. WebCrft is not a payment processor in respect of your
            store's transactions.</li>
        <li><strong>Compliance:</strong> You are solely responsible for ensuring use of BYO payment
            providers complies with their terms, applicable financial regulations, and KYC/AML
            obligations.</li>
        <li><strong>Agent mandates:</strong> If you deploy the signed agent-mandate system
            (ed25519-signed intent-to-cart-to-payment chains), you are responsible for configuring
            appropriate scope limits and spend caps for each registered agent.</li>
      </ul>

      <h2>7. Billing and Payment</h2>

      <h3>7.1 Payment Processor</h3>
      <p>
        Cartcrft Cloud subscriptions are billed through <strong>Paystack</strong>. By subscribing you
        also agree to
        {' '}<a href="https://paystack.com/terms" target="_blank" rel="noopener noreferrer">Paystack's Terms of Service</a>.
        WebCrft is the merchant of record for cloud subscription fees.
      </p>

      <h3>7.2 Currency and Exchange Rate</h3>
      <p>
        Plans are <strong>priced in USD</strong> and <strong>charged in ZAR</strong> at the rate
        obtained from exchangerate-api.com at the time of each billing cycle. Exchange-rate
        fluctuations are a known characteristic of ZAR billing and do not constitute a price change
        entitling you to a refund.
      </p>

      <h3>7.3 Subscription Lifecycle</h3>
      <ul>
        <li>Subscriptions renew automatically at the end of each billing period unless cancelled
            before the renewal date.</li>
        <li>You may cancel at any time from the dashboard; cancellation takes effect at the end
            of the current paid period.</li>
        <li>Downgrading mid-cycle does not entitle you to a pro-rata refund.</li>
      </ul>

      <h3>7.4 Refunds</h3>
      <p>
        Refund requests must be submitted to <a href="mailto:billing@webcrft.io">billing@webcrft.io</a>
        {' '}within <strong>14 days</strong> of the charge. We evaluate requests case-by-case; no refund
        is guaranteed except as required by the Consumer Protection Act 68 of 2008 where applicable.
      </p>

      <h3>7.5 Late Payment and Suspension</h3>
      <p>
        If a charge fails, we retry per Paystack's retry schedule. Accounts with outstanding balances
        after 7 days may be suspended; after 30 days they may be terminated and data deleted subject
        to our retention obligations.
      </p>

      <h2>8. Data, Privacy, and Security</h2>

      <h3>8.1 Controller / Processor Split</h3>
      <p>
        For data about <strong>your Cartcrft Cloud account and billing</strong>, WebCrft is the
        data controller. For <strong>your store's end-customer data</strong> processed through the API
        on your behalf, you are the data controller and WebCrft acts as a data processor.
        See our <Link to="/legal/privacy">Privacy Policy</Link>,
        {' '}<Link to="/legal/popia">POPIA disclosure</Link>, and <Link to="/legal/gdpr">GDPR disclosure</Link>.
      </p>

      <h3>8.2 Security</h3>
      <p>
        We maintain AES-256-GCM encryption of secrets at rest, PostgreSQL row-level security via a
        {' '}<code>NOBYPASSRLS</code> role enforced in every authenticated transaction, IP-based rate
        limiting, HMAC webhook signature verification with replay protection, and TLS in transit.
        See <a href="/docs/security">docs/security.md</a>. You are responsible for securing your own
        API keys and payment-provider webhook secrets.
      </p>

      <h2>9. Intellectual Property</h2>
      <ul>
        <li>The Cartcrft name, logo, and brand are trademarks of WebCrft.</li>
        <li>The MIT-licensed core is available under the MIT License; you retain all rights in
            your own code built on top of it.</li>
        <li>Your store data remains yours. You grant WebCrft a limited right to process
            it solely to provide the Service.</li>
        <li>Feedback you provide may be used by WebCrft without obligation.</li>
      </ul>

      <h2>10. Uptime and Service Levels</h2>
      <p>
        During the current preview period the Service is provided on a <strong>best-effort basis</strong>
        {' '}with no uptime SLA. Planned maintenance will be announced at
        {' '}<a href="https://status.cartcrft.com" target="_blank" rel="noopener noreferrer">status.cartcrft.com</a>.
        Formal SLA tiers will be introduced post-general-availability.
      </p>

      <h2>11. Warranties and Disclaimers</h2>
      <p>
        TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE SERVICE IS PROVIDED "AS IS" WITHOUT
        WARRANTY OF ANY KIND, EXPRESS OR IMPLIED. WEBCRFT DOES NOT WARRANT UNINTERRUPTED
        OR ERROR-FREE OPERATION. Nothing in these Terms excludes liability that cannot lawfully be
        excluded under South African law.
      </p>

      <h2>12. Limitation of Liability</h2>
      <p>TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW:</p>
      <ul>
        <li>Neither party is liable for indirect, incidental, or consequential damages, including
            loss of revenue, data, or profits;</li>
        <li>WebCrft's aggregate liability for any claim shall not exceed the greater of
            (a) fees you paid in the <strong>three months preceding the event</strong> giving rise to
            the claim, or (b) ZAR 1,000.</li>
      </ul>
      <p>
        This limitation does not apply to liability from wilful misconduct, gross negligence, or
        data-protection obligations to the extent prohibited by applicable law.
      </p>

      <h2>13. Termination</h2>
      <ul>
        <li><strong>By you:</strong> Close your account from the dashboard at any time; data export
            is available for 30 days post-closure.</li>
        <li><strong>By us:</strong> We may suspend or terminate immediately for material breach, or
            on 30 days' notice for convenience.</li>
        <li><strong>Effect:</strong> Your data will be deleted per our Privacy Policy retention schedule.</li>
      </ul>

      <h2>14. Governing Law and Dispute Resolution</h2>
      <p>
        These Terms are governed by the laws of the <strong>Republic of South Africa</strong>.
        The parties consent to the jurisdiction of the courts of
        {' '}<strong>[PLACEHOLDER: Gauteng / Western Cape — confirm with counsel]</strong>.
      </p>

      <h2>15. Changes to These Terms</h2>
      <p>
        Material changes will be notified to the email address on your account at least
        {' '}<strong>30 days</strong> before they take effect. Continued use after the effective date
        constitutes acceptance.
      </p>

      <h2>16. General</h2>
      <ul>
        <li><strong>Entire agreement:</strong> These Terms, together with our Privacy Policy, POPIA, and GDPR disclosures, constitute the entire agreement for the Service.</li>
        <li><strong>Severability:</strong> If any provision is found unenforceable, the remainder continues in force.</li>
        <li><strong>No waiver:</strong> Failure to enforce a provision is not a waiver of future enforcement.</li>
        <li><strong>Assignment:</strong> You may not assign your rights without our prior written consent.</li>
      </ul>

      <h2>17. Contact</h2>
      <p>
        <strong>Webcrft Systems (Pty) Ltd</strong><br />
        Registration number: <strong>[PLACEHOLDER: company registration number]</strong><br />
        Registered address: <strong>[PLACEHOLDER: registered office address, South Africa]</strong><br />
        Legal: <a href="mailto:legal@webcrft.io">legal@webcrft.io</a><br />
        Billing: <a href="mailto:billing@webcrft.io">billing@webcrft.io</a><br />
        Security: <a href="mailto:security@webcrft.io">security@webcrft.io</a>
      </p>

      <p>
        See also: <Link to="/legal/privacy">Privacy Policy</Link> {'&middot;'}
        {' '}<Link to="/legal/popia">POPIA Disclosure</Link> {'&middot;'}
        {' '}<Link to="/legal/gdpr">GDPR Disclosure</Link>
      </p>
    </LegalLayout>
  )
}
