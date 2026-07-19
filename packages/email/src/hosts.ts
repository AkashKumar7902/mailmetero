// @mailmetero/email — the ESP egress host reference constant.
//
// This is a REFERENCE constant only. `@mailmetero/config.buildEgressPolicy` derives the
// real allowlist from env (`ESP_API_BASE_URL`'s host), NOT by importing this package —
// doing so would create a config→email cycle in the §6 DAG. The Postmark backend uses
// this list purely for defense-in-depth (refusing a mis-configured baseUrl host).
export const EMAIL_EGRESS_HOSTS: readonly string[] = ['api.postmarkapp.com'];
