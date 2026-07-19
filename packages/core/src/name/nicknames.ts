// @mailmetero/core — name/nicknames.ts
//
// Parser for the carltonnorthern-style nickname CSV (the "TRIPLE" format) and a
// bidirectional given-name expander.
//
// CSV shape (with header):
//     name1,relationship,name2
//     william,has_nickname,bill
//     william,has_nickname,billy
//
// Each row asserts "name1 has_nickname name2" — a DIRECTED edge (canonical → nickname).
// We build BOTH directions:
//   forward:  canonical → [nicknames…]   (william → [bill, billy])
//   reverse:  nickname  → [canonicals…]  (bill → [william], since a nickname may map to
//                                          several canonicals, e.g. bill → [william, robert])

export interface NicknameMap {
  readonly forward: ReadonlyMap<string, readonly string[]>;
  readonly reverse: ReadonlyMap<string, readonly string[]>;
}

const EMPTY_MAP: NicknameMap = { forward: new Map(), reverse: new Map() };

function addEdge(map: Map<string, string[]>, key: string, value: string): void {
  if (key.length === 0 || value.length === 0 || key === value) return;
  let bucket = map.get(key);
  if (bucket === undefined) {
    bucket = [];
    map.set(key, bucket);
  }
  if (!bucket.includes(value)) bucket.push(value);
}

/**
 * Parse the has_nickname triple CSV into a bidirectional map. Pure string → structure
 * (the db seed passes the raw file text). Skips the header row, blank lines, comment
 * lines (`#`), and any row whose relationship column is not `has_nickname`.
 */
export function parseNicknamesCsv(csvText: string): NicknameMap {
  if (csvText.length === 0) return EMPTY_MAP;

  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();

  for (const rawLine of csvText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const cols = line.split(',');
    if (cols.length < 3) continue;

    const name1 = (cols[0] ?? '').trim().toLowerCase();
    const relationship = (cols[1] ?? '').trim().toLowerCase();
    const name2 = (cols[2] ?? '').trim().toLowerCase();

    // Skip the header and any non-has_nickname relationship.
    if (relationship !== 'has_nickname') continue;
    if (name1.length === 0 || name2.length === 0) continue;

    addEdge(forward, name1, name2);
    addEdge(reverse, name2, name1);
  }

  return { forward, reverse };
}

export interface NicknameExpandOptions {
  /** Include the canonical form(s) a nickname maps back to (bill → william). Default true. */
  includeReverseCanonical?: boolean;
  /** Include sibling nicknames that share a canonical (bill → billy, via william). Default false. */
  includeSiblings?: boolean;
  /** Hard cap on the number of expansions returned (excludes the input itself). */
  maxExpansions?: number;
}

const DEFAULT_MAX_EXPANSIONS = 12;

/**
 * Expand a given name into its nickname/canonical relatives using the bidirectional map.
 * The returned list NEVER contains the input name itself and is deduplicated.
 *
 *   expandGivenName('william', map)  → ['bill', 'billy', …]                (forward nicknames)
 *   expandGivenName('bill', map)     → ['william', 'robert', …]            (reverse canonicals)
 *   with includeSiblings             → also 'billy' (sibling under william)
 */
export function expandGivenName(
  name: string,
  map: NicknameMap,
  opts: NicknameExpandOptions = {},
): string[] {
  const key = name.trim().toLowerCase();
  if (key.length === 0) return [];

  const includeReverse = opts.includeReverseCanonical ?? true;
  const includeSiblings = opts.includeSiblings ?? false;
  const max = opts.maxExpansions ?? DEFAULT_MAX_EXPANSIONS;

  const out: string[] = [];
  const seen = new Set<string>([key]);

  const add = (candidate: string): void => {
    if (!seen.has(candidate)) {
      seen.add(candidate);
      out.push(candidate);
    }
  };

  // Forward: name is a canonical → its nicknames.
  for (const nick of map.forward.get(key) ?? []) add(nick);

  // Reverse: name is a nickname → its canonical(s).
  const canonicals = map.reverse.get(key) ?? [];
  if (includeReverse) for (const canon of canonicals) add(canon);

  // Siblings: other nicknames that share one of this name's canonicals.
  if (includeSiblings) {
    for (const canon of canonicals) {
      for (const sib of map.forward.get(canon) ?? []) add(sib);
    }
  }

  return max >= 0 ? out.slice(0, max) : out;
}
