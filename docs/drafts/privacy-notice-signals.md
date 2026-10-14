# DRAFT: privacy notice addition for aggregate threat signals

> Draft for legal review. Not published. Nothing described here is switched on.

## Aggregate threat signals

When you use PG1's checks (for example a wallet, domain or package check), PG1 may record that a check was made and what PG1's answer was (`no_flags`, `flagged` or `unknown`), in order to compute aggregate threat signals that help all users detect fraud and abuse.

**What we record:** a salted, one-way hash of your network identifier (never your IP address), a salted, one-way hash of the item checked (for example the wallet address), the kind of item, PG1's answer and the time.

**What we publish:** only aggregates that at least 10 different callers contributed to, in ranges (for example "25-49 callers") and rounded shares. We never publish or sell who checked what.

**Why (lawful basis):** our legitimate interest, and that of our users, in preventing fraud, scams and malware (Article 6(1)(f) GDPR).

**How long:** observations are deleted after 90 days.

**Your choices:** send the header `X-PG1-Signals: 0` with a request to exclude it; licence holders can opt out for their whole account by contacting us. You have the rights of access, erasure, restriction and objection under the GDPR; because we hold only salted hashes, we may need the original identifier from you to find your records. You can complain to your supervisory authority.

**Controller:** [operator legal name and address]. Contact: [privacy contact].
