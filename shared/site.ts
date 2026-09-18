export function baseSiteKey(host: string): string {
  return host.replace(/^www\./, "");
}

export function siteMatches(host: string, key: string): boolean {
  return host === key || host.endsWith(`.${key}`);
}

export function matchingSiteKey(host: string, sites: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(sites)) {
    if (sites[key] === true && siteMatches(host, key)) return key;
  }
  return undefined;
}
