export type ParamValue = string | number | boolean | string[] | undefined;
export type Params = Record<string, ParamValue>;

export class CanvasError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CanvasError";
  }
}

type FetchLike = (url: string, init: { method: "GET"; headers: Record<string, string> }) => Promise<Response>;

/**
 * A deliberately read-only Canvas client. It can only issue GET requests: there is no method
 * here that submits work, posts, or changes anything in Canvas, and none should be added.
 */
export class CanvasClient {
  private readonly origin: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.origin = new URL(baseUrl).origin;
  }

  private buildUrl(path: string, params: Params = {}): string {
    const url = new URL(`/api/v1${path}`, this.origin);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const entry of value) url.searchParams.append(`${key}[]`, entry);
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async request(url: string): Promise<Response> {
    // Never send the token anywhere but the configured Canvas origin.
    if (new URL(url).origin !== this.origin) {
      throw new CanvasError("Refusing to send the Canvas token to a different host.");
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
      });
    } catch (error) {
      throw new CanvasError(`Could not reach Canvas at ${this.origin}: ${(error as Error).message}`);
    }
    if (!response.ok) throw new CanvasError(describeStatus(response.status), response.status);
    return response;
  }

  async get<T>(path: string, params?: Params): Promise<T> {
    const response = await this.request(this.buildUrl(path, params));
    return (await response.json()) as T;
  }

  /** Follows Canvas pagination until the list is exhausted or maxItems is reached. */
  async getAll<T>(path: string, params: Params = {}, maxItems = 500): Promise<T[]> {
    const items: T[] = [];
    let url: string | undefined = this.buildUrl(path, { per_page: 100, ...params });
    while (url && items.length < maxItems) {
      const response = await this.request(url);
      const page = (await response.json()) as T[];
      items.push(...page);
      url = nextLink(response.headers.get("link"));
    }
    return items.slice(0, maxItems);
  }
}

export function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) return match[1];
  }
  return undefined;
}

function describeStatus(status: number): string {
  switch (status) {
    case 401:
      return "Canvas rejected the access token (401). It may be mistyped, expired, or revoked. Generate a new one under Account > Settings > Approved Integrations in Canvas.";
    case 403:
      return "Canvas denied access to this (403). Your account may not have permission to view it, or the course may restrict it.";
    case 404:
      return "Canvas could not find this (404). Check the course and item IDs.";
    default:
      return `Canvas returned an error (${status}).`;
  }
}
