export interface GitHubContext {
  token: string;
  owner: string;
  repo: string;
  apiUrl: string;
  fetcher: typeof fetch;
}

interface PullPayload {
  number: number;
  html_url: string;
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

async function failure(response: Response, action: string): Promise<Error> {
  const body = await response.text().catch(() => "");
  const detail = body ? `: ${body}` : "";
  return new Error(`Failed to ${action}: ${response.status} ${response.statusText}${detail}`);
}

export interface PullRequestInput {
  head: string;
  base: string;
  title: string;
  body: string;
}

/** Creates the pull request, or updates the open one for the same branch. */
export async function upsertPullRequest(
  context: GitHubContext,
  input: PullRequestInput,
): Promise<{ url: string; created: boolean }> {
  const repoUrl = `${context.apiUrl}/repos/${context.owner}/${context.repo}`;
  const head = `${context.owner}:${input.head}`;

  const list = await context.fetcher(
    `${repoUrl}/pulls?state=open&head=${encodeURIComponent(head)}&base=${encodeURIComponent(input.base)}`,
    { headers: headers(context.token) },
  );
  if (!list.ok) {
    throw await failure(list, "list pull requests");
  }
  const [existing] = (await list.json()) as PullPayload[];

  if (existing) {
    const response = await context.fetcher(`${repoUrl}/pulls/${existing.number}`, {
      method: "PATCH",
      headers: headers(context.token),
      body: JSON.stringify({ title: input.title, body: input.body }),
    });
    if (!response.ok) {
      throw await failure(response, `update pull request #${existing.number}`);
    }
    return { url: existing.html_url, created: false };
  }

  const response = await context.fetcher(`${repoUrl}/pulls`, {
    method: "POST",
    headers: headers(context.token),
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw await failure(response, "create pull request");
  }
  const created = (await response.json()) as PullPayload;
  return { url: created.html_url, created: true };
}
