export class IgnoreFilter {
  private patterns: RegExp[] = [];

  constructor(patterns: string[]) {
    this.setPatterns(patterns);
  }

  setPatterns(patterns: string[]) {
    this.patterns = patterns.map(p => globToRegex(p));
  }

  shouldIgnore(relativePath: string): boolean {
    const parts = relativePath.split('/');
    return this.patterns.some(re =>
      parts.some(part => re.test(part)) || re.test(relativePath)
    );
  }
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}
