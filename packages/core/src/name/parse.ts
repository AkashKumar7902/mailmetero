// @mailmetero/core — name/parse.ts
//
// The name-pipeline orchestrator: takes raw caller fields (+ a nickname map) and produces
// the fully-parsed, NFKD-folded, variant-expanded `NameInput` the candidate generator consumes.

import type { Domain, NameInput, NameScript } from '@mailmetero/contracts';
import { nfkdAsciiFold, detectScript, isCjkName, CJK_SURNAMES_BUILTIN } from './normalize.ts';
import { germanFoldVariants, isGermanicContext } from './german.ts';
import { expandSurnameVariants } from './surname.ts';
import { expandGivenName } from './nicknames.ts';
import type { NicknameMap, NicknameExpandOptions } from './nicknames.ts';

export interface RawNameFields {
  firstName?: string;
  lastName?: string;
  middleName?: string;
  fullName?: string;
}

export interface NormalizeNameOptions {
  domain?: Domain | null;
  cjkSurnames?: ReadonlySet<string>;
  nickname?: NicknameExpandOptions;
  emitGermanVariants?: boolean;
}

/**
 * Split a free "full name" into first / middle / last.
 *   - 1 token  → first only
 *   - 2 tokens → first + last
 *   - 3+ tokens → first + (joined middle) + last
 */
export function splitFullName(fullName: string): {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
} {
  const parts = fullName.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return { firstName: null, middleName: null, lastName: null };
  if (parts.length === 1) return { firstName: parts[0] as string, middleName: null, lastName: null };
  if (parts.length === 2) {
    return { firstName: parts[0] as string, middleName: null, lastName: parts[1] as string };
  }
  return {
    firstName: parts[0] as string,
    middleName: parts.slice(1, -1).join(' '),
    lastName: parts[parts.length - 1] as string,
  };
}

function foldOrNull(s: string | null): string | null {
  if (s === null) return null;
  const folded = nfkdAsciiFold(s);
  return folded.length > 0 ? folded : null;
}

function pushUnique(list: string[], value: string): void {
  if (value.length > 0 && !list.includes(value)) list.push(value);
}

/**
 * Normalize raw name fields into a `NameInput`. Prefers explicit first/last; falls back to
 * splitting `fullName`. Produces:
 *   - `normalized`  : NFKD ASCII folds of each component
 *   - `script`/`isCjk` : script detection + CJK-name flag (→ cjk_ambiguous_downweight)
 *   - `nicknameExpansions` : bidirectional nickname relatives of the first name
 *   - `surnameVariants` : compound-surname expansions (≤2) + German fold variants
 */
export function normalizeName(
  raw: RawNameFields,
  nicknameMap: NicknameMap,
  opts: NormalizeNameOptions = {},
): NameInput {
  // 1. Resolve first / middle / last, preferring explicit fields.
  let firstName = raw.firstName?.trim() || null;
  let middleName = raw.middleName?.trim() || null;
  let lastName = raw.lastName?.trim() || null;

  if ((firstName === null || lastName === null) && raw.fullName && raw.fullName.trim().length > 0) {
    const split = splitFullName(raw.fullName);
    if (firstName === null) firstName = split.firstName;
    if (middleName === null) middleName = split.middleName;
    if (lastName === null) lastName = split.lastName;
  }

  // 2. Preserve verbatim caller input for provenance/DSAR (omit absent fields —
  //    exactOptionalPropertyTypes forbids assigning undefined to optional props).
  const rawEcho: NameInput['raw'] = {};
  if (raw.firstName !== undefined) rawEcho.firstName = raw.firstName;
  if (raw.lastName !== undefined) rawEcho.lastName = raw.lastName;
  if (raw.middleName !== undefined) rawEcho.middleName = raw.middleName;
  if (raw.fullName !== undefined) rawEcho.fullName = raw.fullName;

  // 3. Script + CJK detection over the ORIGINAL (unfolded) components.
  const cjkSurnames = opts.cjkSurnames ?? CJK_SURNAMES_BUILTIN;
  const isCjk = isCjkName(firstName, lastName, cjkSurnames);
  const script: NameScript = detectScript(`${firstName ?? ''} ${lastName ?? ''}`.trim());

  // 4. Normalized ASCII folds.
  const normalized = {
    firstName: foldOrNull(firstName),
    middleName: foldOrNull(middleName),
    lastName: foldOrNull(lastName),
  };

  // 5. Nickname expansions of the first name (bidirectional).
  const nicknameExpansions: string[] = [];
  if (firstName !== null) {
    for (const nick of expandGivenName(firstName, nicknameMap, opts.nickname)) {
      const folded = nfkdAsciiFold(nick);
      if (folded.length > 0 && folded !== normalized.firstName) pushUnique(nicknameExpansions, folded);
    }
  }

  // 6. Surname variants: compound-surname expansion (≤2) + optional German folds.
  const surnameVariants: string[] = [];
  if (lastName !== null) {
    for (const v of expandSurnameVariants(lastName)) {
      if (v !== normalized.lastName) pushUnique(surnameVariants, v);
    }
    const wantGerman = opts.emitGermanVariants ?? isGermanicContext(lastName, opts.domain ?? null);
    if (wantGerman) {
      for (const v of germanFoldVariants(lastName)) {
        if (v !== normalized.lastName) pushUnique(surnameVariants, v);
      }
    }
  }

  return {
    raw: rawEcho,
    firstName,
    middleName,
    lastName,
    normalized,
    script,
    isCjk,
    nicknameExpansions,
    surnameVariants,
  };
}
