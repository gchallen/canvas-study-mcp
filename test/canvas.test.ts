import { describe, expect, it } from "vitest";
import { CanvasClient, nextLink } from "../src/canvas.js";
import { loadConfig, normalizeBaseUrl } from "../src/config.js";
import { htmlToText } from "../src/html.js";

function fakeFetch(pages: Record<string, { body: unknown; link?: string; status?: number }>) {
  const calls: { url: string; method: string; auth?: string }[] = [];
  const fetchImpl = async (url: string, init: { method: "GET"; headers: Record<string, string> }) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization });
    const page = pages[url];
    if (!page) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(page.body), {
      status: page.status ?? 200,
      headers: page.link ? { link: page.link } : {},
    });
  };
  return { calls, fetchImpl };
}

describe("CanvasClient", () => {
  it("follows pagination and sends the token as a bearer header", async () => {
    const first = "https://canvas.test/api/v1/courses?per_page=100&enrollment_state=active";
    const second = "https://canvas.test/api/v1/courses?page=2&per_page=100";
    const { calls, fetchImpl } = fakeFetch({
      [first]: { body: [{ id: 1 }], link: `<${second}>; rel="next", <${first}>; rel="first"` },
      [second]: { body: [{ id: 2 }] },
    });
    const client = new CanvasClient("https://canvas.test", "secret", fetchImpl);
    expect(await client.getAll("/courses", { enrollment_state: "active" })).toEqual([{ id: 1 }, { id: 2 }]);
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
    expect(calls[0]?.auth).toBe("Bearer secret");
  });

  it("refuses to follow a pagination link to another host", async () => {
    const first = "https://canvas.test/api/v1/courses?per_page=100";
    const { calls, fetchImpl } = fakeFetch({
      [first]: { body: [{ id: 1 }], link: '<https://evil.test/api/v1/courses?page=2>; rel="next"' },
    });
    const client = new CanvasClient("https://canvas.test", "secret", fetchImpl);
    await expect(client.getAll("/courses")).rejects.toThrow(/different host/);
    expect(calls).toHaveLength(1);
  });

  it("encodes array parameters the way Canvas expects", async () => {
    const url = "https://canvas.test/api/v1/courses/7/assignments?include%5B%5D=submission";
    const { fetchImpl } = fakeFetch({ [url]: { body: { id: 3 } } });
    const client = new CanvasClient("https://canvas.test", "secret", fetchImpl);
    expect(await client.get("/courses/7/assignments", { include: ["submission"] })).toEqual({ id: 3 });
  });

  it("explains a rejected token", async () => {
    const { fetchImpl } = fakeFetch({ "https://canvas.test/api/v1/courses": { body: {}, status: 401 } });
    const client = new CanvasClient("https://canvas.test", "bad", fetchImpl);
    await expect(client.get("/courses")).rejects.toThrow(/rejected the access token/);
  });

  it("exposes no way to write to Canvas", () => {
    const methods = Object.getOwnPropertyNames(CanvasClient.prototype);
    expect(methods.sort()).toEqual(["buildUrl", "constructor", "get", "getAll", "request"]);
  });
});

describe("nextLink", () => {
  it("returns undefined on the last page", () => {
    expect(nextLink('<https://canvas.test/x?page=1>; rel="first"')).toBeUndefined();
    expect(nextLink(null)).toBeUndefined();
  });
});

describe("config", () => {
  it("normalizes the Canvas URL to an https origin", () => {
    expect(normalizeBaseUrl("canvas.illinois.edu")).toBe("https://canvas.illinois.edu");
    expect(normalizeBaseUrl("https://canvas.illinois.edu/courses/1/")).toBe("https://canvas.illinois.edu");
    expect(() => normalizeBaseUrl("http://canvas.illinois.edu")).toThrow(/https/);
  });

  it("reports missing settings instead of throwing", () => {
    const config = loadConfig({ CANVAS_BASE_URL: "canvas.test" });
    expect(config.problem).toMatch(/CANVAS_API_TOKEN/);
    expect(config.baseUrl).toBeUndefined();
  });
});

describe("htmlToText", () => {
  it("keeps structure and drops markup", () => {
    const html = "<h2>Goals</h2><p>Learn &amp; apply <b>recursion</b>.</p><ul><li>One</li><li>Two&nbsp;more</li></ul><script>x()</script>";
    expect(htmlToText(html)).toBe("Goals\nLearn & apply recursion.\n\n- One\n- Two more");
  });
});
