/** Parse a displayed integer without silently turning unreadable text into zero.
 * LinkedIn uses Western and local-script digits plus locale-dependent grouping. */
const DIGIT_ZEROES = [0x0030, 0x0660, 0x06f0, 0x0966, 0x09e6, 0x0a66,
  0x0c66, 0x0e50, 0xff10];

function asciiDigits(value: string): string | null {
  let result = "";
  for (const character of value) {
    const point = character.codePointAt(0)!;
    const zero = DIGIT_ZEROES.find(start => point >= start && point < start + 10);
    if (zero === undefined) return null;
    result += String(point - zero);
  }
  return result;
}

export function parseLocalizedInteger(value: string): number | null {
  // Arabic and Hebrew pages wrap numerals in directional formatting marks.
  const text = value.replace(/[\u061c\u200e\u200f]/gu, "").trim();
  if (!text) return null;
  const groups = text.split(/[ ,\.\u00a0\u202f\u066c]/u);
  if (groups.some(group => !group || !/^\p{Nd}+$/u.test(group))) return null;
  if (groups.length > 1 && (groups[0].length > 3 ||
      groups.slice(1).some(group => group.length !== 3))) return null;
  const digits = asciiDigits(groups.join(""));
  if (digits === null) return null;
  const count = Number(digits);
  return Number.isSafeInteger(count) ? count : null;
}

/** The connections-header component starts with its total, then its label. */
export function parseLeadingCount(value: string): number | null {
  const match = value.replace(/[\u061c\u200e\u200f]/gu, "").trim()
    .match(/^([\p{Nd}][\p{Nd} ,\.\u00a0\u202f\u066c]*)/u);
  return match ? parseLocalizedInteger(match[1]) : null;
}

/** The sent/CONNECTION tab displays its count inside final parentheses. */
export function parseParenthesizedCount(value: string): number | null {
  const match = value.match(/[（(]([^()（）]+)[）)]\s*$/u);
  return match ? parseLocalizedInteger(match[1]) : null;
}

export async function readConnectionsCount(page: import("playwright").Page): Promise<number | null> {
  const header = page.locator('[componentkey="ConnectionsPage_ConnectionsListHeader"] p').first();
  const text = await header.textContent({ timeout: 8000 }).catch(() => null);
  return text === null ? null : parseLeadingCount(text);
}

/** Permit destructive reconciliation only with an exact, positive checksum. */
export function isVerifiedCompleteCount(fullPass: boolean, pulled: number,
  declared: number | null): boolean {
  return fullPass && declared !== null && declared > 0 && pulled === declared;
}
