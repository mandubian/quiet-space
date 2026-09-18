export const MAX_BLOCKS = 32;
export const MAX_TEXT = 1200;
export const MAX_STATE_CHARS = 18000;
export const DEFAULT_THRESHOLD = 0.95;
export const BACKEND_URL = "http://127.0.0.1:4317";

export interface PageBlock {
  id: string;
  text: string;
  tag: string;
  label: string;
  hints: string;
  context: string;
  linkHosts: string[];
  imageHosts?: string[];
  imageAlts: string[];
}

export interface ScanRequest {
  page: { host: string; title: string };
  blocks: PageBlock[];
}

export interface ScanResult {
  decisions: { id: string; probability: number }[];
}
