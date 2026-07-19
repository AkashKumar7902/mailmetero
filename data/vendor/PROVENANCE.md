# Vendor Data Provenance

Reference datasets vendored for mailmetero (email finder/verifier).
All files retrieved **2026-07-19** via `curl` from raw.githubusercontent.com and
verified byte-identical to upstream (git blob SHA compared against the GitHub
contents API on retrieval date).

---

## nicknames.csv

- **Path:** `data/vendor/nicknames.csv`
- **Source URL:** https://raw.githubusercontent.com/carltonnorthern/nicknames/master/names.csv
- **Upstream repo:** https://github.com/carltonnorthern/nicknames (file `names.csv`, branch `master`)
- **License:** Apache License 2.0 (SPDX: `Apache-2.0`) — repo `License.txt`, confirmed via GitHub license API
- **Line count:** 2,692 (1 header row + 2,691 data rows)
- **Last upstream change:** 2025-08-01 (last commit touching `names.csv`)
- **Git blob SHA:** `450d4ad371c8dfe814656cfe24d3b57f386aa1a8`
- **Format:** 3-column CSV with header `name1,relationship,name2`; every data row's
  relationship is `has_nickname` (e.g. `aaron,has_nickname,ron`). Note: this is the
  repo's newer triple format, NOT the older wide format (`canonical,nick1,nick2,...`).
- **mailmetero use:** Build a bidirectional given-name <-> nickname map to expand
  candidate local-parts when generating email permutations (robert -> bob, bobby, rob...).

## disposable_domains.txt

- **Path:** `data/vendor/disposable_domains.txt`
- **Source URL:** https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf
- **Upstream repo:** https://github.com/disposable-email-domains/disposable-email-domains (file `disposable_email_blocklist.conf`)
- **License:** CC0 1.0 Universal (SPDX: `CC0-1.0`) — repo `LICENSE.txt` is the CC0 public-domain dedication
- **Line count:** 8,055 (one lowercase domain per line, no comments)
- **Last upstream change:** 2026-07-18 (actively maintained; consider periodic refresh)
- **Git blob SHA:** `a381adafcc17fb6ae3af705073997ce47033f211`
- **mailmetero use:** Primary disposable-domain blocklist — flag/reject candidate or
  verified addresses whose domain (or registrable parent) is on this list.

## freemail_domains.txt

- **Path:** `data/vendor/freemail_domains.txt`
- **Source URL:** https://raw.githubusercontent.com/willwhite/freemail/master/data/free.txt
- **Upstream repo:** https://github.com/willwhite/freemail (file `data/free.txt`)
- **License:** ISC (SPDX: `ISC`) — per repo `LICENSE` text and `package.json` `"license": "ISC"`.
  (Often cited as MIT; the actual license text is ISC. Both are permissive.)
- **Line count:** 4,466 (one domain per line)
- **Last upstream change:** 2020-07-03 (repo is largely dormant — treat as a static snapshot)
- **Git blob SHA:** `2a040b31e9396e7c992bfbf52014e7983944e148`
- **Known upstream data quirks (verified present in upstream, keep file byte-identical;
  filter at load time):** line 52 is the literal string `404: not found`, plus three
  non-domain tokens: `asean-mail`, `housefancom`, `multiplechoices`.
- **mailmetero use:** Classify a domain as free/webmail (gmail.com, yahoo.*, ...) vs
  corporate — skip first.last-style pattern guessing on freemail domains and score
  freemail hits differently in verification results.

## freemail_disposable.txt

- **Path:** `data/vendor/freemail_disposable.txt`
- **Source URL:** https://raw.githubusercontent.com/willwhite/freemail/master/data/disposable.txt
- **Upstream repo:** https://github.com/willwhite/freemail (file `data/disposable.txt`)
- **License:** ISC (SPDX: `ISC`) — same repo/license as above
- **Line count:** 88,173 (one domain per line; includes internationalized/IDN domains
  with non-ASCII characters, e.g. `instágram.com` — normalize to punycode before matching)
- **Last upstream change:** 2020-07-03 (static snapshot)
- **Git blob SHA:** `d22d6b204716503dcb19e6f9788930ab4211b6c2`
- **mailmetero use:** Supplementary disposable-domain list — union with
  `disposable_domains.txt` after lowercasing and IDN/punycode normalization.

---

## Public Suffix List (NOT vendored)

The Public Suffix List (publicsuffix.org) is deliberately **not** vendored here.
mailmetero should consume it at runtime via the **`tldts`** npm package
(license: MPL-2.0), which bundles and updates the PSL and provides fast
registrable-domain / eTLD+1 extraction. Vendoring the raw PSL would go stale and
duplicate what `tldts` maintains.
