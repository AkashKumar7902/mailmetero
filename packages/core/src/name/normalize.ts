// @mailmetero/core — name/normalize.ts
//
// NFKD ASCII folding, unicode-script detection, and CJK-name recognition. All pure.
// The fold is what turns "José", "Müller", "Łukasz" into the ASCII tokens used to build
// candidate local parts. CJK names get a confidence down-weight (cjk_ambiguous_downweight)
// because Latin-transliterated CJK ordering/parsing is ambiguous.

import type { NameScript } from '@mailmetero/contracts';

/**
 * Ligatures / stroked letters NFKD does NOT decompose to ASCII + combining marks.
 * Applied before the combining-mark strip so they survive as ASCII.
 */
const SPECIAL_FOLDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/ß/g, 'ss'],
  [/æ/g, 'ae'],
  [/œ/g, 'oe'],
  [/ø/g, 'o'],
  [/đ/g, 'd'],
  [/ð/g, 'd'],
  [/þ/g, 'th'],
  [/ł/g, 'l'],
  [/ħ/g, 'h'],
  [/ı/g, 'i'],
  [/ĸ/g, 'k'],
  [/ŀ/g, 'l'],
  [/ŉ/g, 'n'],
];

/**
 * NFKD-normalize, fold special letters, strip combining marks, drop every remaining
 * non-`[a-z0-9]` code point. The result is a lower-case ASCII token safe for local parts.
 * Non-Latin scripts (CJK, Cyrillic) that have no ASCII decomposition collapse to '' —
 * callers detect that and fall back to script-aware handling.
 */
export function nfkdAsciiFold(s: string): string {
  let out = s.toLowerCase();
  for (const [re, rep] of SPECIAL_FOLDS) out = out.replace(re, rep);
  out = out.normalize('NFKD');
  // Strip combining diacritical marks (U+0300–U+036F).
  out = out.replace(/[̀-ͯ]/g, '');
  // Keep only ASCII alphanumerics.
  out = out.replace(/[^a-z0-9]/g, '');
  return out;
}

// Unicode ranges used for cheap script detection.
const RE_CJK =
  /[㐀-䶿一-鿿豈-﫿぀-ゟ゠-ヿ가-힯]/;
const RE_CYRILLIC = /[Ѐ-ӿԀ-ԯ]/;
const RE_LATIN = /[A-Za-zÀ-ɏ]/;

/** Classify the dominant script of a name string. */
export function detectScript(s: string): NameScript {
  if (RE_CJK.test(s)) return 'cjk';
  if (RE_CYRILLIC.test(s)) return 'cyrillic';
  if (RE_LATIN.test(s)) return 'latin';
  // A pure-ASCII digit/punctuation string, or something exotic.
  return /[a-z]/i.test(s) ? 'latin' : 'other';
}

/**
 * Common CJK surnames — both Han characters and their frequent Latin transliterations.
 * Used to flag transliterated CJK names ("Li Wei", "Wang", "Kim") even when the raw
 * string is already romanized (so script detection alone would say 'latin').
 */
export const CJK_SURNAMES_BUILTIN: ReadonlySet<string> = new Set([
  // Han (Chinese)
  '王', '李', '张', '刘', '陈', '杨', '黄', '赵', '吴', '周',
  '徐', '孙', '马', '朱', '胡', '郭', '何', '林', '高', '罗',
  '张', '梁', '宋', '郑', '谢', '韩', '唐', '冯', '于', '董',
  // Han (Korean hanja / common)
  '金', '朴', '崔', '郑', '姜', '曹', '尹', '张',
  // Latin transliterations — Chinese
  'wang', 'li', 'zhang', 'liu', 'chen', 'yang', 'huang', 'zhao', 'wu', 'zhou',
  'xu', 'sun', 'ma', 'zhu', 'hu', 'guo', 'he', 'lin', 'gao', 'luo',
  'liang', 'song', 'zheng', 'xie', 'han', 'tang', 'feng', 'dong', 'cao', 'deng',
  'lee', 'lu', 'jiang', 'fan', 'fang', 'wei', 'ye', 'yao', 'shen', 'peng',
  // Latin transliterations — Korean
  'kim', 'park', 'choi', 'jeong', 'jung', 'kang', 'cho', 'yoon', 'jang', 'lim',
  'shin', 'kwon', 'hwang', 'ahn', 'seo', 'oh',
  // Latin transliterations — Japanese (common surnames)
  'sato', 'suzuki', 'takahashi', 'tanaka', 'watanabe', 'ito', 'yamamoto',
  'nakamura', 'kobayashi', 'kato', 'yoshida', 'yamada', 'sasaki', 'yamaguchi',
  'matsumoto', 'inoue', 'kimura', 'hayashi', 'shimizu', 'saito',
]);

/**
 * Decide whether a (first, last) pair is a CJK name. True when either component is in a
 * CJK script, or a component matches a known CJK surname transliteration.
 */
export function isCjkName(
  first: string | null,
  last: string | null,
  cjkSurnames: ReadonlySet<string> = CJK_SURNAMES_BUILTIN,
): boolean {
  for (const part of [first, last]) {
    if (part === null) continue;
    if (detectScript(part) === 'cjk') return true;
    if (cjkSurnames.has(part.trim().toLowerCase())) return true;
  }
  return false;
}
