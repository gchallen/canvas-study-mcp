import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { ReviewStore } from "../src/store.js";

const START = new Date("2026-11-19T15:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const item = {
  courseId: 42,
  topic: "Recursion",
  prompt: "Why does a recursive function need a base case?",
  answer: "Without one the calls never stop, so the stack overflows.",
  authoredBy: "student" as const,
};

let path: string;
let store: ReviewStore;

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), "canvas-study-")), "nested", "reviews.json");
  store = new ReviewStore(path, { fuzz: false });
});

describe("ReviewStore", () => {
  it("makes new items due immediately and persists them", () => {
    const [created] = store.add([item], START);
    expect(store.due(START).map((due) => due.id)).toEqual([created?.id]);
    expect(new ReviewStore(path).list()).toHaveLength(1);
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
  });

  it("will not rate an item the student has not attempted", () => {
    const [created] = store.add([item], START);
    expect(() => store.rate(created!.id, "good", START)).toThrow(/answer it first/);
  });

  it("spaces successful reviews further apart and brings failures back soon", () => {
    const [created] = store.add([item], START);
    const id = created!.id;
    let clock = START;
    const intervals: number[] = [];
    for (let round = 0; round < 4; round++) {
      store.attempt(id, "the calls never stop", clock);
      const rated = store.rate(id, "good", clock);
      const due = new Date(rated.card.due);
      intervals.push(due.getTime() - clock.getTime());
      expect(store.due(clock)).toHaveLength(0);
      clock = due;
    }
    expect(intervals[3]!).toBeGreaterThan(intervals[1]!);
    expect(intervals[3]!).toBeGreaterThan(DAY_MS);

    store.attempt(id, "I don't know", clock);
    const lapsed = store.rate(id, "again", clock);
    expect(new Date(lapsed.card.due).getTime() - clock.getTime()).toBeLessThan(DAY_MS);
    expect(lapsed.card.lapses).toBe(1);
    expect(lapsed.history.at(-1)).toMatchObject({ rating: "again", studentAnswer: "I don't know" });
    expect(lapsed.pendingAttempt).toBeUndefined();
  });

  it("forecasts upcoming load with overdue items counted today", () => {
    store.add([item, { ...item, courseId: 7 }], new Date(START.getTime() - 3 * DAY_MS));
    const forecast = store.forecast(START, 3);
    expect(forecast.map((day) => day.due)).toEqual([2, 0, 0]);
    expect(store.forecast(START, 3, { courseId: 7 })[0]?.due).toBe(1);
  });

  it("updates and deletes items", () => {
    const [created] = store.add([item], START);
    expect(store.update(created!.id, { topic: "Recursion Basics" }).topic).toBe("Recursion Basics");
    store.delete(created!.id);
    expect(() => store.get(created!.id)).toThrow(/No review item/);
  });
});

describe("server", () => {
  async function connect() {
    const server = createServer({ canvas: null, canvasProblem: "Canvas is not configured.", store, now: () => START });
    const client = new Client({ name: "test", version: "0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as { text: string }[])[0]!.text;
      return { isError: Boolean(result.isError), text, data: result.isError ? undefined : JSON.parse(text) };
    };
    return { client, call };
  }

  it("offers no tool that writes to Canvas", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("get_due_reviews");
    expect(names.filter((name) => /submit|post|upload|create|send|take_quiz/.test(name))).toEqual([]);
    expect(client.getInstructions()).toMatch(/read-only/);
  });

  it("reveals the answer only after the student attempts", async () => {
    const { call } = await connect();
    const added = await call("add_review_items", {
      course_id: 42,
      items: [{ topic: item.topic, prompt: item.prompt, answer: item.answer, authored_by: "student" }],
    });
    const id = added.data.added[0].id as string;

    const due = await call("get_due_reviews");
    expect(due.data.total_due).toBe(1);
    expect(due.text).not.toContain("stack overflows");
    expect((await call("list_review_items")).text).not.toContain("stack overflows");

    const early = await call("rate_review", { item_id: id, rating: "good" });
    expect(early.isError).toBe(true);

    const attempt = await call("attempt_review", { item_id: id, student_answer: "it would loop forever" });
    expect(attempt.data.reference_answer).toContain("stack overflows");

    const rated = await call("rate_review", { item_id: id, rating: "good" });
    expect(rated.data.remaining_due_now).toBe(0);

    const stats = await call("get_review_stats");
    expect(stats.data).toMatchObject({ total_items: 1, due_now: 0, reviews_last_7_days: 1, days_studied_last_7: 1 });
  });

  it("explains how to set up Canvas when it is not configured", async () => {
    const { call } = await connect();
    const result = await call("list_courses");
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/New Access Token/);
  });
});
