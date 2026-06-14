import { Link } from 'react-router-dom'
import LegalLayout from '../LegalLayout'

/**
 * GDPR Disclosure — /legal/gdpr
 * General Data Protection Regulation (EU) 2016/679.
 */
export default function Gdpr() {
  return (
    <LegalLayout
      title="GDPR Disclosure"
      description="GDPR disclosure for EU/EEA/UK data subjects using Cartcrft Cloud, operated by Webcrft Systems (Pty) Ltd."
      lastUpdated="2026-06-14"
    >
      <div className="notice-box">
        <strong>Notice:</strong> This document is a template provided for transparency and must be reviewed and adapted by qualified legal counsel before you rely on it. It is not legal advice.
      </div>

      <p>
        This disclosure supplements our <Link to="/legal/privacy">Privacy Policy</Link> with information
        required by the <strong>General Data Protection Regulation (EU) 2016/679</strong> (GDPR) for
        data subjects in the EU, EEA, or United Kingdom (UK GDPR as applicable).
      </p>

      <h2>1. Territorial Scope</h2>
      <p>
        The GDPR applies to Webcrft Systems' processing where we offer goods or services to individuals
        in the EU/EEA/UK (Art. 3(2)(a)) or monitor their behaviour (Art. 3(2)(b)). Because Cartcrft
        Cloud is available globally and may be used by EU/EEA/UK merchants or end-customers, we
        maintain full GDPR compliance.
      </p>

      <h2>2. Data Controller and Processor</h2>

      <h3>2.1 Webcrft Systems as Data Controller</h3>
      <p>
        For personal data of <strong>Cartcrft Cloud account holders</strong> (merchants and developers),
        Webcrft Systems is the data controller:
      </p>
      <p>
        <strong>Webcrft Systems (Pty) Ltd</strong><br />
        Registration number: <strong>[PLACEHOLDER: company registration number]</strong><br />
        Registered address: <strong>[PLACEHOLDER: registered office address, South Africa]</strong><br />
        Contact: <a href="mailto:privacy@webcrft.com">privacy@webcrft.com</a>
      </p>

      <h3>2.2 EU/EEA/UK Representative (Art. 27)</h3>
      <p>
        As Webcrft Systems is established outside the EU/EEA/UK, we designate a representative
        under GDPR Article 27:
      </p>
      <p>
        <strong>[PLACEHOLDER: name of EU/EEA or UK representative entity]</strong><br />
        Address: <strong>[PLACEHOLDER: EU/EEA or UK address]</strong><br />
        Contact: <strong>[PLACEHOLDER: representative contact email]</strong>
      </p>

      <h3>2.3 Data Protection Officer (Art. 37)</h3>
      <p>
        <strong>[PLACEHOLDER: confirm whether a DPO is required. A DPO is mandatory if Webcrft Systems
        processes special category data at scale, engages in large-scale systematic monitoring, or is a
        public authority. Review with counsel.]</strong>
      </p>
      <p>DPO contact (if designated): <strong>[PLACEHOLDER: DPO name and email]</strong></p>

      <h3>2.4 Webcrft Systems as Data Processor</h3>
      <p>
        For personal data of a <strong>merchant's end-customers</strong> processed through the Cartcrft
        API, the merchant is the data controller and Webcrft Systems is a data processor (Art. 28).
        A <strong>Data Processing Agreement (DPA)</strong> is available on request:
        {' '}<a href="mailto:legal@webcrft.com">legal@webcrft.com</a>.
      </p>

      <h2>3. Lawful Bases for Processing (Art. 6)</h2>

      <table>
        <thead>
          <tr><th>Processing Activity</th><th>Lawful Basis</th><th>Details</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Account registration and Service delivery</td>
            <td>Contract (Art. 6(1)(b))</td>
            <td>Necessary to perform the Cartcrft Cloud subscription agreement</td>
          </tr>
          <tr>
            <td>Subscription billing via Paystack, including USD/ZAR invoicing</td>
            <td>Contract (Art. 6(1)(b))</td>
            <td>Necessary to execute and administer the subscription contract</td>
          </tr>
          <tr>
            <td>Transactional emails via AWS SES (verification, reset, billing)</td>
            <td>Contract (Art. 6(1)(b))</td>
            <td>Necessary to deliver agreed account management communications</td>
          </tr>
          <tr>
            <td>Multi-tenant database isolation (RLS session variables <code>app.org_id</code>, <code>app.user_id</code>)</td>
            <td>Legitimate interests (Art. 6(1)(f))</td>
            <td>Preventing cross-tenant data access; vital for platform security and other tenants' rights</td>
          </tr>
          <tr>
            <td>Security monitoring: rate limiting, HMAC webhook verification, replay-guard</td>
            <td>Legitimate interests (Art. 6(1)(f))</td>
            <td>Protecting the platform and all users from fraud, abuse, and unauthorised access</td>
          </tr>
          <tr>
            <td>Financial record retention</td>
            <td>Legal obligation (Art. 6(1)(c))</td>
            <td>South African tax law; equivalent EU VAT record-keeping obligations</td>
          </tr>
          <tr>
            <td>Marketing communications</td>
            <td>Consent (Art. 6(1)(a))</td>
            <td>Opt-in only; withdrawable at any time</td>
          </tr>
        </tbody>
      </table>

      <h2>4. Data Subject Rights (Arts. 15–22)</h2>
      <p>
        Submit a <strong>Data Subject Access Request (DSAR)</strong> to
        {' '}<a href="mailto:privacy@webcrft.com">privacy@webcrft.com</a>. We will respond within
        {' '}<strong>one month</strong> (extendable to three months for complex requests, with notice).
        Requests are free of charge for the first instance.
      </p>

      <table>
        <thead>
          <tr><th>Right</th><th>GDPR Article</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Access</td>
            <td>Art. 15</td>
            <td>Obtain confirmation and a copy of your personal data together with supplementary information (purposes, categories, recipients, retention, safeguards)</td>
          </tr>
          <tr>
            <td>Rectification</td>
            <td>Art. 16</td>
            <td>Request correction of inaccurate or incomplete data; account data can also be updated in the dashboard</td>
          </tr>
          <tr>
            <td>Erasure ("right to be forgotten")</td>
            <td>Art. 17</td>
            <td>Request deletion where data is no longer necessary, consent is withdrawn and no other lawful basis applies, or processing is unlawful — subject to legal retention obligations</td>
          </tr>
          <tr>
            <td>Restriction of processing</td>
            <td>Art. 18</td>
            <td>Request restriction while accuracy is contested or pending an objection assessment</td>
          </tr>
          <tr>
            <td>Data portability</td>
            <td>Art. 20</td>
            <td>Receive your personal data in a structured, machine-readable format (JSON) — applies to data processed on the basis of contract or consent</td>
          </tr>
          <tr>
            <td>Object to processing</td>
            <td>Art. 21</td>
            <td>Object at any time to processing based on legitimate interests; we will cease unless we demonstrate compelling legitimate grounds overriding your rights</td>
          </tr>
          <tr>
            <td>Withdraw consent</td>
            <td>Art. 7(3)</td>
            <td>Withdraw at any time where processing is consent-based (marketing emails); withdrawal does not affect prior lawful processing</td>
          </tr>
          <tr>
            <td>Automated decision-making</td>
            <td>Art. 22</td>
            <td>Not to be subject to solely automated decisions with significant legal effects — Cartcrft Cloud does not make such decisions on account holders</td>
          </tr>
        </tbody>
      </table>

      <h2>5. International Data Transfers (Arts. 44–49)</h2>
      <p>
        Personal data may be transferred to countries outside the EEA without an EU adequacy decision
        (including the United States). All such transfers are subject to appropriate safeguards:
      </p>

      <table>
        <thead>
          <tr><th>Recipient / Sub-processor</th><th>Country</th><th>Transfer Mechanism</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Neon Inc.</strong> — Postgres database</td>
            <td>United States</td>
            <td>Standard Contractual Clauses (SCCs, EU Commission 2021/914 or equivalent UK IDTA)</td>
          </tr>
          <tr>
            <td><strong>Amazon Web Services Inc.</strong> (SES) — email</td>
            <td>United States</td>
            <td>SCCs; AWS EU Data Processing Addendum</td>
          </tr>
          <tr>
            <td><strong>Paystack Payments Ltd</strong> — billing</td>
            <td>Nigeria, South Africa, Ireland</td>
            <td>Paystack's EU/EEA processing via Irish entity; SCCs for onward transfers</td>
          </tr>
          <tr>
            <td><strong>BunnyWay d.o.o.</strong> — CDN</td>
            <td>EU (Slovenia) + global PoPs</td>
            <td>EU-incorporated entity (GDPR directly applicable); SCCs for non-EEA PoPs</td>
          </tr>
          <tr>
            <td><strong>Backblaze Inc.</strong> — object storage</td>
            <td>United States</td>
            <td>SCCs</td>
          </tr>
        </tbody>
      </table>

      <p>Copies of applicable SCCs or transfer mechanisms are available on request from <a href="mailto:privacy@webcrft.com">privacy@webcrft.com</a>.</p>

      <h2>6. Data Retention</h2>
      <ul>
        <li><strong>Account data:</strong> Duration of account plus 30 days post-closure.</li>
        <li><strong>Billing records:</strong> 5 years after end of relevant tax year.</li>
        <li><strong>API and webhook logs:</strong> 90 days (rolling).</li>
        <li><strong>Support correspondence:</strong> 3 years from ticket closure.</li>
        <li><strong>Encrypted provider credentials:</strong> Deleted immediately on removal or account closure.</li>
      </ul>

      <h2>7. Sub-processors (Art. 28(4))</h2>
      <p>
        As a data processor for merchants' end-customer data, Webcrft Systems engages the following
        sub-processors, each under a GDPR-equivalent data-processing agreement:
      </p>
      <ul>
        <li><strong>Neon Inc.</strong> — Postgres database hosting (primary data store)</li>
        <li><strong>Amazon Web Services Inc.</strong> — transactional email (SES)</li>
        <li><strong>BunnyWay d.o.o.</strong> — CDN asset delivery</li>
        <li><strong>Backblaze Inc.</strong> — object storage for media</li>
      </ul>
      <p>
        Paystack is engaged only for Cartcrft Cloud subscription billing (Webcrft Systems' own controller
        activity), not as a sub-processor for end-customer data.
      </p>
      <p>We will notify controllers of intended sub-processor changes in advance, giving the controller the opportunity to object.</p>

      <h2>8. Personal Data Breach Notification (Arts. 33–34)</h2>
      <ul>
        <li><strong>Controller obligations (Art. 33):</strong> Webcrft Systems will notify the lead supervisory authority within <strong>72 hours</strong> of becoming aware of a breach likely to result in risk to individuals' rights and freedoms.</li>
        <li><strong>High-risk breaches (Art. 34):</strong> Where the breach is likely to result in high risk, we will also notify affected data subjects without undue delay.</li>
        <li><strong>Processor obligations (Art. 33(2)):</strong> Where acting as a processor for a merchant, we will notify the merchant (controller) of any breach without undue delay.</li>
      </ul>
      <p>Report suspected security incidents to <a href="mailto:security@webcrft.com">security@webcrft.com</a>.</p>

      <h2>9. Right to Lodge a Complaint</h2>
      <p>You have the right to lodge a complaint with the supervisory authority in your EU/EEA member state, place of work, or place of the alleged infringement. Key authorities include:</p>
      <ul>
        <li><strong>Ireland</strong> (Data Protection Commission): <a href="https://www.dataprotection.ie" target="_blank" rel="noopener noreferrer">www.dataprotection.ie</a></li>
        <li><strong>United Kingdom</strong> (ICO): <a href="https://ico.org.uk" target="_blank" rel="noopener noreferrer">ico.org.uk</a></li>
        <li><strong>Germany</strong> (BfDI): <a href="https://www.bfdi.bund.de" target="_blank" rel="noopener noreferrer">www.bfdi.bund.de</a></li>
        <li><strong>[PLACEHOLDER: add the authority for your primary EU market(s)]</strong></li>
      </ul>
      <p>We encourage you to contact us first at <a href="mailto:privacy@webcrft.com">privacy@webcrft.com</a>.</p>

      <h2>10. Automated Decision-Making and Profiling (Art. 22)</h2>
      <p>
        Webcrft Systems does not make solely automated decisions that produce legal or similarly
        significant effects on account holders. No profiling for marketing purposes is performed on
        individual account holders without consent.
      </p>
      <p>
        Merchants who configure analytics pixels (GA4, Meta Pixel, TikTok Pixel, etc.) for their
        storefronts bear responsibility as data controllers for Art. 22 and ePrivacy compliance
        regarding any profiling those pixels perform on end-customers.
      </p>

      <h2>11. Contact</h2>
      <p>
        <strong>Data Controller (Account Data):</strong><br />
        Webcrft Systems (Pty) Ltd — <a href="mailto:privacy@webcrft.com">privacy@webcrft.com</a><br />
        Address: <strong>[PLACEHOLDER: registered office address, South Africa]</strong>
      </p>
      <p>
        <strong>EU/EEA/UK Representative (Art. 27):</strong><br />
        <strong>[PLACEHOLDER: representative name, address, and email]</strong>
      </p>
      <p>
        <strong>Data Protection Officer (if designated):</strong><br />
        <strong>[PLACEHOLDER: DPO name and contact email, or "Not required — see Section 2.3"]</strong>
      </p>

      <p>
        See also: <Link to="/legal/terms">Terms of Service</Link> &middot;
        {' '}<Link to="/legal/privacy">Privacy Policy</Link> &middot;
        {' '}<Link to="/legal/popia">POPIA Disclosure</Link>
      </p>
    </LegalLayout>
  )
}
