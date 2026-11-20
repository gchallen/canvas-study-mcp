import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createEmptyCard, fsrs, Rating, type Card, type FSRS, type Grade } from "ts-fsrs";

export type RatingName = "again" | "hard" | "good" | "easy";

const RATINGS: Record<RatingName, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

const MAX_HISTORY = 30;

export interface Attempt {
  at: string;
  rating: RatingName;
  studentAnswer: string;
}

export interface ReviewItem {
  id: string;
  courseId?: number;
  courseName?: string;
  topic: string;
  prompt: string;
  answer: string;
  source?: string;
  authoredBy: "student" | "assistant";
  createdAt: string;
  /** FSRS scheduling state, stored as plain JSON. */
  card: Card;
  history: Attempt[];
  /** Set when the student has answered but not yet rated their recall. */
  pendingAttempt?: { at: string; studentAnswer: string };
}

export interface NewItem {
  courseId?: number;
  courseName?: string;
  topic: string;
  prompt: string;
  answer: string;
  source?: string;
  authoredBy: "student" | "assistant";
}

interface StoreFile {
  version: 1;
  items: ReviewItem[];
}

export class StoreError extends Error {}

/** Local spaced-repetition state, kept in a single JSON file on the student's machine. */
export class ReviewStore {
  private readonly scheduler: FSRS;
  private items: ReviewItem[];

  constructor(
    private readonly path: string,
    options: { fuzz?: boolean } = {},
  ) {
    this.scheduler = fsrs({ enable_fuzz: options.fuzz ?? true });
    this.items = this.load();
  }

  private load(): ReviewItem[] {
    if (!existsSync(this.path)) return [];
    const data = JSON.parse(readFileSync(this.path, "utf8")) as StoreFile;
    return data.items ?? [];
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    const data: StoreFile = { version: 1, items: this.items };
    writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(temp, this.path);
  }

  add(newItems: NewItem[], now: Date): ReviewItem[] {
    const created = newItems.map((item): ReviewItem => ({
      id: `r_${randomBytes(4).toString("hex")}`,
      ...item,
      createdAt: now.toISOString(),
      card: toJson(createEmptyCard(now)),
      history: [],
    }));
    this.items.push(...created);
    this.save();
    return created;
  }

  get(id: string): ReviewItem {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) throw new StoreError(`No review item with id ${id}.`);
    return item;
  }

  list(filter: { courseId?: number; topic?: string } = {}): ReviewItem[] {
    const topic = filter.topic?.toLowerCase();
    return this.items.filter(
      (item) =>
        (filter.courseId === undefined || item.courseId === filter.courseId) &&
        (topic === undefined || item.topic.toLowerCase().includes(topic)),
    );
  }

  /** Items due at or before `now`, most overdue first. */
  due(now: Date, filter: { courseId?: number } = {}): ReviewItem[] {
    return this.list(filter)
      .filter((item) => dueAt(item) <= now.getTime())
      .sort((a, b) => dueAt(a) - dueAt(b));
  }

  /** Records the student's answer, which is what unlocks the reference answer and rating. */
  attempt(id: string, studentAnswer: string, now: Date): ReviewItem {
    const item = this.get(id);
    item.pendingAttempt = { at: now.toISOString(), studentAnswer };
    this.save();
    return item;
  }

  rate(id: string, rating: RatingName, now: Date): ReviewItem {
    const item = this.get(id);
    if (!item.pendingAttempt) {
      throw new StoreError(
        "This item has no recorded attempt. The student must answer it first (attempt_review) before their recall can be rated.",
      );
    }
    const result = this.scheduler.next(item.card, now, RATINGS[rating]);
    item.card = toJson(result.card);
    item.history = [...item.history, { at: now.toISOString(), rating, studentAnswer: item.pendingAttempt.studentAnswer }].slice(
      -MAX_HISTORY,
    );
    delete item.pendingAttempt;
    this.save();
    return item;
  }

  update(id: string, changes: Partial<Pick<ReviewItem, "topic" | "prompt" | "answer" | "source">>): ReviewItem {
    const item = this.get(id);
    for (const [key, value] of Object.entries(changes)) {
      if (value !== undefined) (item as unknown as Record<string, unknown>)[key] = value;
    }
    this.save();
    return item;
  }

  delete(id: string): ReviewItem {
    const item = this.get(id);
    this.items = this.items.filter((candidate) => candidate.id !== id);
    this.save();
    return item;
  }

  /** Number of items coming due on each of the next `days` local days; anything overdue counts as today. */
  forecast(now: Date, days: number, filter: { courseId?: number } = {}): { date: string; due: number }[] {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const buckets = Array.from({ length: days }, (_, offset) => {
      const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
      return { date: localDate(day), end: day.getTime() + 24 * 60 * 60 * 1000, due: 0 };
    });
    for (const item of this.list(filter)) {
      const bucket = buckets.find((candidate) => dueAt(item) < candidate.end);
      if (bucket) bucket.due += 1;
    }
    return buckets.map(({ date, due }) => ({ date, due }));
  }
}

export function dueAt(item: ReviewItem): number {
  return new Date(item.card.due).getTime();
}

export function localDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toJson(card: Card): Card {
  return JSON.parse(JSON.stringify(card)) as Card;
}
