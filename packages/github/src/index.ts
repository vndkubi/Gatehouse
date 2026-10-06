export interface PullRequest {
  number: number;
  title: string;
  body: string;
  author: string;
  url: string;
  state: string;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
}

export interface ReviewComment {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
}

export interface ExistingReview {
  id: number;
  body: string;
  user: string;
}

export class GitHubError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Minimal GitHub REST client. The token lives in the Gatehouse process (from the SecretStore)
 * and is never handed to an agent. Public repos can be read without a token.
 */
export class GitHubClient {
  constructor(
    private readonly apiUrl: string,
    private readonly token: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getPull(owner: string, repo: string, number: number): Promise<PullRequest> {
    const p = (await this.request('GET', `/repos/${owner}/${repo}/pulls/${number}`)) as Record<string, any>;
    return {
      number: p.number,
      title: p.title ?? '',
      body: p.body ?? '',
      author: p.user?.login ?? '',
      url: p.html_url ?? '',
      state: p.state ?? '',
      base: { ref: p.base?.ref, sha: p.base?.sha },
      head: { ref: p.head?.ref, sha: p.head?.sha },
    };
  }

  async listReviews(owner: string, repo: string, number: number): Promise<ExistingReview[]> {
    const out: ExistingReview[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = (await this.request('GET', `/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100&page=${page}`)) as Array<Record<string, any>>;
      out.push(...batch.map((r) => ({ id: r.id, body: r.body ?? '', user: r.user?.login ?? '' })));
      if (batch.length < 100) break;
    }
    return out;
  }

  async createReview(owner: string, repo: string, number: number, review: { commitId: string; body: string; comments: ReviewComment[] }): Promise<{ id: number; url: string }> {
    const r = (await this.request('POST', `/repos/${owner}/${repo}/pulls/${number}/reviews`, {
      commit_id: review.commitId,
      body: review.body,
      event: 'COMMENT',
      comments: review.comments,
    })) as Record<string, any>;
    return { id: r.id, url: r.html_url ?? '' };
  }

  async listOpenPulls(owner: string, repo: string): Promise<Array<{ number: number; title: string; author: string; url: string; updated: string; draft: boolean; reviewers: string[] }>> {
    const list = (await this.request('GET', `/repos/${owner}/${repo}/pulls?state=open&per_page=50&sort=updated&direction=desc`)) as Array<Record<string, any>>;
    return list.map((p) => ({
      number: p.number,
      title: p.title ?? '',
      author: p.user?.login ?? '',
      url: p.html_url ?? '',
      updated: p.updated_at ?? '',
      draft: !!p.draft,
      reviewers: (p.requested_reviewers ?? []).map((r: { login: string }) => r.login),
    }));
  }

  async me(): Promise<string | null> {
    if (!this.token) return null;
    const u = (await this.request('GET', '/user')) as Record<string, any>;
    return u.login ?? null;
  }

  async findPullByHead(owner: string, repo: string, branch: string): Promise<{ number: number; url: string } | null> {
    const list = (await this.request('GET', `/repos/${owner}/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`)) as Array<Record<string, any>>;
    const p = list[0];
    return p ? { number: p.number, url: p.html_url } : null;
  }

  async createPull(owner: string, repo: string, pr: { title: string; head: string; base: string; body: string; draft: boolean }): Promise<{ number: number; url: string }> {
    const p = (await this.request('POST', `/repos/${owner}/${repo}/pulls`, pr)) as Record<string, any>;
    return { number: p.number, url: p.html_url };
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.apiUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'gatehouse',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        // keep raw text
      }
      throw new GitHubError(res.status, `GitHub ${method} ${path} -> ${res.status}: ${message}`);
    }
    return text ? JSON.parse(text) : null;
  }
}

/** "https://github.com/o/r(.git)" or "git@github.com:o/r.git" -> {owner, repo}. */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}
