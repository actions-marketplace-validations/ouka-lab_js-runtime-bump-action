export const SCHEDULE_URL = "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json";
export const INDEX_URL = "https://nodejs.org/dist/index.json";

interface ScheduleEntry {
  start?: string;
  lts?: string;
  maintenance?: string;
  end?: string;
  codename?: string;
}

interface IndexEntry {
  version: string;
  lts: string | false;
}

export interface NodeLine {
  major: number;
  ltsStart: string;
  end: string;
}

export interface NodeStatus {
  /** LTS lines that have not reached end-of-life, oldest first. */
  supported: NodeLine[];
  /** Lines that were LTS at some point and are past end-of-life, oldest first. */
  endOfLife: NodeLine[];
  /** Latest release of the newest supported line, without the leading "v". */
  latestVersion: string;
}

async function getJson<T>(fetcher: typeof fetch, url: string): Promise<T> {
  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

/**
 * A line is added once it enters LTS, not when it is first released. The
 * schedule's own `lts` date decides that, so nothing here assumes that only
 * even majors become LTS — which stops being true from Node.js 27 on.
 */
export async function fetchNodeStatus(fetcher: typeof fetch, today: string): Promise<NodeStatus> {
  const schedule = await getJson<Record<string, ScheduleEntry>>(fetcher, SCHEDULE_URL);

  const supported: NodeLine[] = [];
  const endOfLife: NodeLine[] = [];
  for (const [key, entry] of Object.entries(schedule)) {
    const match = /^v(\d+)$/.exec(key);
    if (!match || !entry.lts || !entry.end) {
      continue;
    }
    const line = { major: Number(match[1]), ltsStart: entry.lts, end: entry.end };
    if (today >= entry.end) {
      endOfLife.push(line);
    } else if (today >= entry.lts) {
      supported.push(line);
    }
  }
  supported.sort((a, b) => a.major - b.major);
  endOfLife.sort((a, b) => a.major - b.major);

  const newest = supported.at(-1);
  if (!newest) {
    throw new Error(`${SCHEDULE_URL} lists no Node.js line in LTS on ${today}`);
  }

  const index = await getJson<IndexEntry[]>(fetcher, INDEX_URL);
  const latest = index.find((entry) => entry.version.startsWith(`v${newest.major}.`));
  if (!latest) {
    throw new Error(`${INDEX_URL} has no release for Node.js ${newest.major}`);
  }

  return { supported, endOfLife, latestVersion: latest.version.replace(/^v/, "") };
}
