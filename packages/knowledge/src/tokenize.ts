const TOKEN_PATTERN = /\p{Script=Han}+|[a-z0-9]+(?:[-_][a-z0-9]+)*/gu;

export function tokenize(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const segments = normalized.match(TOKEN_PATTERN) ?? [];
  const tokens: string[] = [];

  for (const segment of segments) {
    if (containsHan(segment)) {
      tokens.push(...tokenizeChineseSegment(segment));
    } else {
      tokens.push(...tokenizeLatinSegment(segment));
    }
  }

  return tokens;
}

function tokenizeChineseSegment(segment: string): string[] {
  const characters = Array.from(segment);
  const tokens: string[] = [];

  if (characters.length > 1) {
    tokens.push(segment);
  }

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (character !== undefined) {
      tokens.push(character);
    }

    const next = characters[index + 1];
    if (character !== undefined && next !== undefined) {
      tokens.push(`${character}${next}`);
    }
  }

  return tokens;
}

function tokenizeLatinSegment(segment: string): string[] {
  const parts = segment.split(/[-_]+/u).filter((part) => part.length > 0);
  if (parts.length <= 1) {
    return parts;
  }

  return [...parts, parts.join('')];
}

function containsHan(segment: string): boolean {
  return /\p{Script=Han}/u.test(segment);
}
