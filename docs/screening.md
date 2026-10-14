# Sanctions screening

Before PG1 takes any payment, quotes against a named wallet, or runs a paid job, it checks the paying wallet against two public sanctions lists. This covers per-call x402 payments, A2A jobs, Tool Foundry builds and tool calls, and watchlists.

## Sources

| List | Official source | Licence | Update cadence |
|---|---|---|---|
| OFAC Specially Designated Nationals and Blocked Persons (SDN) list, digital currency addresses | https://sanctionslist.ofac.treas.gov/Home/SdnList | US government work (public domain) | Synced into PG1's sanctions table by the existing sanctions sync |
| EU consolidated list of persons, groups and entities subject to EU financial sanctions | https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw (dataset: https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions) | Free reuse, including commercial, with attribution (Commission Decision 2011/833/EU) | Daily; delisted entries are removed at the next sync |

## What happens

- **No match.** The payment goes ahead. The result is cached for 24 hours per wallet, so repeat payments are not slowed down.
- **Match.** PG1 refuses: no quote, no payment request (402), and nothing is charged.
  - PG1 keeps a record holding only a salted hash of the wallet, the list that matched and the list reference. Records are kept for 5 years.
  - The operator is notified.
- **Screening unavailable.** PG1 does not take the payment for now (it fails closed), nothing is charged, and the response asks you to retry shortly.
- **Cost.** Screening is free and never counts against the free tier.

## Wrong matches and appeals

PG1 matches the exact wallet address, after normalising its format, against the addresses the lists publish. A match therefore means the list names that address.

- **OFAC.** If you believe an OFAC listing of your wallet is wrong, the remedy is OFAC's delisting process: https://ofac.treasury.gov/specially-designated-nationals-list-sdn-list/filing-a-petition-for-removal-from-an-ofac-list. PG1 cannot override an OFAC listing.
- **EU.** PG1 reads wallet addresses out of the text of the EU list. If PG1 read an address that the EU entry does not actually name, contact the PG1 operator; the contact is in the refusal message. The operator checks the EU entry and, if PG1 extracted the address in error, dismisses it so it is no longer matched. If the EU listing itself is wrong, the remedy is the EU's review procedure for the measure concerned.
- **After a correction.** Once a list or PG1's copy is corrected, PG1 serves the wallet again within 24 hours (the cache lifetime).

PG1 serves agents and people everywhere. Screening is the one wallet-level restriction, and it applies only to the paying wallet.
