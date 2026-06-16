import { Link } from 'react-router-dom'
import LegalLayout from '../LegalLayout'

/**
 * POPIA Disclosure — /legal/popia
 * Protection of Personal Information Act 4 of 2013 (South Africa).
 */
export default function Popia() {
  return (
    <LegalLayout
      title="POPIA Disclosure"
      description="Protection of Personal Information Act (POPIA) disclosure for CartCrft Cloud, operated by Webcrft Systems (Pty) Ltd."
      lastUpdated="2026-06-14"
    >
      <div className="notice-box">
        <strong>Notice:</strong> This document is a template provided for transparency and must be reviewed and adapted by qualified legal counsel before you rely on it. It is not legal advice.
      </div>

      <p>
        This disclosure is made pursuant to the <strong>Protection of Personal Information Act 4 of 2013</strong>
        {' '}(POPIA) and its Regulations, and supplements our <Link to="/legal/privacy">Privacy Policy</Link>.
      </p>

      <h2>1. Responsible Party</h2>
      <p>
        <strong>Webcrft Systems (Pty) Ltd</strong><br />
        Registration number: <strong>[PLACEHOLDER: company registration number]</strong><br />
        Registered address: <strong>[PLACEHOLDER: registered office address, South Africa]</strong><br />
        Email: <a href="mailto:privacy@webcrft.io">privacy@webcrft.io</a>
      </p>

      <h3>1.1 Information Officer (s. 55)</h3>
      <p>
        Name: <strong>[PLACEHOLDER: full name of Information Officer]</strong><br />
        Title: <strong>[PLACEHOLDER: e.g. Director / CTO / General Counsel]</strong><br />
        Email: <a href="mailto:privacy@webcrft.io">privacy@webcrft.io</a><br />
        Postal address: <strong>[PLACEHOLDER]</strong>
      </p>

      <h2>2. Scope of this Disclosure</h2>

      <h3>2.1 CartCrft as Responsible Party (Controller)</h3>
      <p>
        WebCrft determines the purpose and means of processing personal information relating
        to <strong>CartCrft Cloud account holders</strong> (merchants and developers): account
        registration data, billing records via Paystack, and correspondence.
      </p>

      <h3>2.2 CartCrft as Operator (Processor)</h3>
      <p>
        When a merchant uses CartCrft Cloud, their end-customers' personal information is processed
        by WebCrft <em>on behalf of the merchant</em>:
      </p>
      <ul>
        <li>The <strong>merchant is the Responsible Party</strong> for end-customers' data;</li>
        <li>WebCrft is the <strong>Operator</strong> (POPIA s. 1), processing only as
            instructed by the merchant.</li>
      </ul>
      <p>An Operator Agreement is available on request: <a href="mailto:legal@webcrft.io">legal@webcrft.io</a>.</p>

      <h3>2.3 Self-Hosted Deployments</h3>
      <p>If you self-host the MIT-licensed core, all data stays in your own infrastructure. WebCrft is neither Responsible Party nor Operator.</p>

      <h2>3. The Eight POPIA Conditions for Lawful Processing</h2>

      <h3>Condition 1 — Accountability (s. 8)</h3>
      <p>WebCrft is accountable for compliance. The Information Officer (Section 1.1) ensures POPIA obligations are implemented and maintained.</p>

      <h3>Condition 2 — Processing Limitation (ss. 9–12)</h3>
      <p>We collect personal information only where adequate, relevant, and not excessive for the stated purposes. We do not collect personal information in a manner incompatible with those purposes.</p>

      <h3>Condition 3 — Purpose Specification (ss. 13–14)</h3>
      <p>We collect personal information for the following specific, explicitly defined, and lawful purposes:</p>
      <ul>
        <li>Provision and operation of CartCrft Cloud (contractual necessity — s.11(1)(b));</li>
        <li>Subscription billing and invoice generation via Paystack, including USD/ZAR exchange-rate snapshots from exchangerate-api.com (contractual necessity);</li>
        <li>Transactional emails via AWS SES: account verification, password reset, magic links, billing notices (contractual necessity);</li>
        <li>Multi-tenant isolation: the database session variables <code>app.org_id</code> and <code>app.user_id</code> used in PostgreSQL row-level security policies (legitimate interest / contractual necessity);</li>
        <li>Security monitoring: IP-based rate limiting, webhook HMAC signature verification (HMAC-SHA256 for Stripe/Razorpay; HMAC-SHA512 for Paystack), replay-guard event-ID deduplication (legitimate interest — s.11(1)(f));</li>
        <li>Compliance with legal obligations, including SARS financial-record keeping (legal obligation — s.11(1)(c));</li>
        <li>Direct marketing communications (consent only — s.11(1)(a) and s.69).</li>
      </ul>

      <h3>Condition 4 — Further Processing Limitation (s. 15)</h3>
      <p>Personal information is not processed further in a manner incompatible with the purpose collected. We do not sell or rent personal information. Service-improvement analytics are conducted on aggregated, de-identified data only.</p>

      <h3>Condition 5 — Information Quality (s. 16)</h3>
      <p>We take reasonable steps to ensure personal information is complete, accurate, and up to date. Account data can be corrected via the dashboard or by contacting the Information Officer. Billing data is updated automatically on each subscription event via Paystack.</p>

      <h3>Condition 6 — Openness (ss. 17–18)</h3>
      <p>We maintain this disclosure, our Privacy Policy, and GDPR disclosure publicly. We notify data subjects at collection of: the Responsible Party and Information Officer; the purpose of collection; whether collection is voluntary or mandatory; and cross-border transfers and Operators.</p>

      <h3>Condition 7 — Security Safeguards (ss. 19–22)</h3>
      <p>We implement the following technical and organisational security measures:</p>
      <ul>
        <li><strong>AES-256-GCM encryption at rest</strong> for all stored provider secrets — layout: <code>base64(nonce_12B || ciphertext || tag_16B)</code>;</li>
        <li><strong>TLS encryption in transit</strong> for all Service connections;</li>
        <li><strong>PostgreSQL row-level security (RLS)</strong> via a <code>NOBYPASSRLS</code> database role (<code>cartcrft_app</code>), enforced via <code>SET LOCAL ROLE</code> inside every authenticated transaction;</li>
        <li><strong>Application-layer auth middleware</strong> verifying JWT <code>org</code> claims and API-key <code>orgId</code> on every request (defence-in-depth);</li>
        <li><strong>IP-based rate limiting</strong> on all API endpoints;</li>
        <li><strong>HMAC signature verification</strong> for inbound payment webhooks with replay protection;</li>
        <li><strong>Scoped API access</strong> via <code>cc_pub_</code> (read-only) and <code>cc_prv_</code> (write/admin) key tiers.</li>
      </ul>
      <p>We maintain a security-compromise notification procedure and will notify the Information Regulator and affected data subjects per POPIA section 22.</p>

      <h3>Condition 8 — Data Subject Participation (ss. 23–25)</h3>
      <p>Data subjects have the rights set out in Section 5. We respond to requests within 30 days and provide information free of charge on the first request.</p>

      <h2>4. Special Personal Information (ss. 26–32)</h2>
      <p>
        POPIA section 26 prohibits processing special personal information (health, religious beliefs,
        race, sex life, criminal records, etc.) without specific conditions. CartCrft Cloud does not
        intentionally collect special personal information from cloud account holders.
      </p>
      <p>
        Merchants operating stores in sectors that process special personal information bear
        responsibility as Responsible Party for meeting the additional requirements of POPIA
        sections 27–32.
      </p>

      <h2>5. Data Subject Rights under POPIA</h2>

      <table>
        <thead>
          <tr><th>Right</th><th>POPIA Section</th><th>How to Exercise</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Access to personal information</td>
            <td>s. 23</td>
            <td>Email <a href="mailto:privacy@webcrft.io">privacy@webcrft.io</a>; response within 30 days</td>
          </tr>
          <tr>
            <td>Correction or deletion of inaccurate information</td>
            <td>s. 24</td>
            <td>Email <a href="mailto:privacy@webcrft.io">privacy@webcrft.io</a>; account data may also be updated via the dashboard</td>
          </tr>
          <tr>
            <td>Destroy or delete information no longer needed</td>
            <td>s. 24(3)</td>
            <td>Email <a href="mailto:privacy@webcrft.io">privacy@webcrft.io</a>; subject to legal retention obligations</td>
          </tr>
          <tr>
            <td>Object to processing</td>
            <td>s. 11(3)</td>
            <td>Email <a href="mailto:privacy@webcrft.io">privacy@webcrft.io</a> with reasons; we assess and respond within 30 days</td>
          </tr>
          <tr>
            <td>Withdraw consent (where consent-based)</td>
            <td>s. 11(1)(a)</td>
            <td>Unsubscribe link in marketing emails, or email <a href="mailto:privacy@webcrft.io">privacy@webcrft.io</a></td>
          </tr>
          <tr>
            <td>Lodge a complaint with the Information Regulator</td>
            <td>ss. 55, 74–82</td>
            <td>See Section 8 below</td>
          </tr>
        </tbody>
      </table>

      <h2>6. Cross-Border Transfer of Personal Information (s. 72)</h2>

      <table>
        <thead>
          <tr><th>Operator / Recipient</th><th>Destination</th><th>Transfer Basis (s. 72)</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Neon Inc.</strong> — Postgres hosting</td>
            <td>United States (us-east-1 default)</td>
            <td>Operator agreement; necessary for performance of contract with data subject (s. 72(1)(b))</td>
          </tr>
          <tr>
            <td><strong>Paystack Payments Ltd</strong> — cloud billing</td>
            <td>Nigeria, South Africa, Ireland (EU)</td>
            <td>Operator agreement; necessary for performance of the billing contract</td>
          </tr>
          <tr>
            <td><strong>Amazon Web Services Inc.</strong> (SES) — email</td>
            <td>United States (default us-east-1)</td>
            <td>Operator agreement; necessary for performance of contract</td>
          </tr>
          <tr>
            <td><strong>BunnyWay d.o.o.</strong> — CDN</td>
            <td>EU and global PoPs</td>
            <td>Operator agreement; recipient subject to GDPR as EU-incorporated entity</td>
          </tr>
          <tr>
            <td><strong>Backblaze Inc.</strong> — object storage</td>
            <td>United States (primary)</td>
            <td>Operator agreement</td>
          </tr>
        </tbody>
      </table>

      <h2>7. Direct Marketing (s. 69)</h2>
      <p>
        We send direct marketing (newsletters, product updates) only with your prior consent. Withdraw
        at any time via the unsubscribe link in any marketing email, or by emailing
        {' '}<a href="mailto:privacy@webcrft.io">privacy@webcrft.io</a>. Transactional emails are not
        direct marketing and do not require opt-in.
      </p>

      <h2>8. Operator Agreements (s. 21)</h2>
      <p>
        All Operators (sub-processors) listed in Section 6 process personal information under a
        written Operator Agreement requiring security safeguards substantially equivalent to those
        required of WebCrft, and prompt notification of security compromises.
      </p>
      <p>
        Merchants should enter into an Operator Agreement with WebCrft for processing
        end-customer data. Contact <a href="mailto:legal@webcrft.io">legal@webcrft.io</a>.
      </p>

      <h2>9. Records of Processing Activities</h2>
      <p>
        WebCrft maintains an internal record of processing activities per POPIA and its
        Regulations, documenting: purposes, categories of data subjects and information, recipients,
        cross-border transfers, retention periods, and security measures. Available to the Information
        Regulator on request.
      </p>

      <h2>10. Complaints to the Information Regulator</h2>
      <p>
        <strong>The Information Regulator (South Africa)</strong><br />
        Website: <a href="https://www.justice.gov.za/inforeg/" target="_blank" rel="noopener noreferrer">www.justice.gov.za/inforeg</a><br />
        Email: <a href="mailto:inforeg@justice.gov.za">inforeg@justice.gov.za</a><br />
        Physical address: JD House, 27 Stiemens Street, Braamfontein, Johannesburg, 2001<br />
        Postal address: P.O. Box 31533, Braamfontein, Johannesburg, 2017<br />
        Telephone: +27 (0)10 023 5207
      </p>
      <p>We encourage you to contact us first at <a href="mailto:privacy@webcrft.io">privacy@webcrft.io</a>.</p>

      <h2>11. Contact</h2>
      <p>
        Email: <a href="mailto:privacy@webcrft.io">privacy@webcrft.io</a><br />
        Postal address: <strong>[PLACEHOLDER: registered office address]</strong><br />
        Response timeframe: 30 days from receipt of a complete request.
      </p>

      <p>
        See also: <Link to="/legal/terms">Terms of Service</Link> &middot;
        {' '}<Link to="/legal/privacy">Privacy Policy</Link> &middot;
        {' '}<Link to="/legal/gdpr">GDPR Disclosure</Link>
      </p>
    </LegalLayout>
  )
}
