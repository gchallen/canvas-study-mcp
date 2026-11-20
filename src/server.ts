import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import type { CanvasClient } from "./canvas.js";
import { htmlToText, truncate } from "./html.js";
import { INSTRUCTIONS } from "./instructions.js";
import { dueAt, type ReviewItem, type ReviewStore } from "./store.js";

export interface Dependencies {
  /** Null when Canvas is not configured; review tools still work. */
  canvas: CanvasClient | null;
  canvasProblem?: string;
  store: ReviewStore;
  now?: () => Date;
}

interface Course {
  id: number;
  name?: string;
  course_code?: string;
  term?: { name?: string };
  syllabus_body?: string | null;
  enrollments?: { type?: string; computed_current_score?: number | null; computed_current_grade?: string | null }[];
}

interface Submission {
  submitted_at?: string | null;
  graded_at?: string | null;
  workflow_state?: string;
  score?: number | null;
  grade?: string | null;
  late?: boolean;
  missing?: boolean;
  excused?: boolean | null;
  assignment?: Assignment;
  submission_comments?: { comment?: string; author_name?: string; created_at?: string }[];
  rubric_assessment?: Record<string, { points?: number; comments?: string }>;
}

interface Assignment {
  id: number;
  name?: string;
  description?: string | null;
  due_at?: string | null;
  lock_at?: string | null;
  points_possible?: number | null;
  submission_types?: string[];
  html_url?: string;
  submission?: Submission;
  rubric?: { id: string; description?: string; long_description?: string; points?: number }[];
}

interface Module {
  id: number;
  name?: string;
  items?: { id: number; title?: string; type?: string; page_url?: string; html_url?: string; content_id?: number }[];
}

interface Page {
  title?: string;
  body?: string | null;
  updated_at?: string;
}

const MAX_TEXT = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
const LOCAL_WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

const ratingSchema = z.enum(["again", "hard", "good", "easy"]);

export function createServer(deps: Dependencies): McpServer {
  const now = deps.now ?? (() => new Date());
  const { store } = deps;
  const server = new McpServer({ name: "canvas-study", version: pkg.version }, { instructions: INSTRUCTIONS });

  const canvas = (): CanvasClient => {
    if (!deps.canvas) {
      throw new Error(
        `${deps.canvasProblem ?? "Canvas is not configured."} Set your school's Canvas URL and an access token (Canvas > Account > Settings > New Access Token) in this server's settings.`,
      );
    }
    return deps.canvas;
  };

  const activeCourses = () =>
    canvas().getAll<Course>("/courses", { enrollment_state: "active", include: ["total_scores", "term"] });

  server.registerTool(
    "list_courses",
    {
      title: "List Courses",
      description: "Lists the student's active Canvas courses with their current score in each. Start here to get course IDs.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () =>
      run(async () => ({
        courses: (await activeCourses()).map((course) => ({
          id: course.id,
          name: course.name,
          code: course.course_code,
          term: course.term?.name,
          role: course.enrollments?.[0]?.type,
          current_score: course.enrollments?.[0]?.computed_current_score ?? null,
          current_grade: course.enrollments?.[0]?.computed_current_grade ?? null,
        })),
      })),
  );

  server.registerTool(
    "get_upcoming_work",
    {
      title: "Get Upcoming Work",
      description:
        "Shows what is due soon across courses, what is overdue and unsubmitted, and how many spaced-review items come due each day. Use it to help the student plan backwards from deadlines: spread work across the available days, start large items early, and leave time for reviews.",
      inputSchema: {
        days: z.number().int().min(1).max(60).default(14).describe("How many days ahead to look"),
        course_id: z.number().int().optional().describe("Limit to one course"),
      },
      annotations: READ_ONLY,
    },
    ({ days, course_id }) =>
      run(async () => {
        const current = now();
        const courses: Course[] = course_id === undefined ? await activeCourses() : [{ id: course_id }];
        const perCourse = await Promise.all(
          courses.map(async (course) => ({
            course,
            assignments: await canvas().getAll<Assignment>(`/courses/${course.id}/assignments`, {
              include: ["submission"],
              order_by: "due_at",
            }),
          })),
        );

        const upcoming: object[] = [];
        const overdue: object[] = [];
        for (const { course, assignments } of perCourse) {
          for (const assignment of assignments) {
            if (!assignment.due_at) continue;
            const delta = new Date(assignment.due_at).getTime() - current.getTime();
            const entry = { course_id: course.id, course: course.name, ...summarizeAssignment(assignment, current) };
            if (delta >= 0 && delta <= days * DAY_MS) upcoming.push(entry);
            else if (delta < 0 && delta > -30 * DAY_MS && needsSubmission(assignment)) overdue.push(entry);
          }
        }
        const byDue = (a: object, b: object) =>
          String((a as { due_at: string }).due_at).localeCompare(String((b as { due_at: string }).due_at));
        return {
          now: current.toISOString(),
          upcoming: upcoming.sort(byDue),
          overdue_unsubmitted: overdue.sort(byDue),
          // Days with nothing due are left out.
          reviews_due_by_day: store.forecast(current, Math.min(days, 14), { courseId: course_id }).filter((day) => day.due > 0),
        };
      }),
  );

  server.registerTool(
    "get_assignment",
    {
      title: "Get Assignment",
      description:
        "Reads one assignment: instructions, rubric, due date, and the student's submission status. Use it to help the student understand what is being asked and what the rubric rewards. If the assignment is still open, help them plan and learn the underlying material; the work itself is theirs to write.",
      inputSchema: { course_id: z.number().int(), assignment_id: z.number().int() },
      annotations: READ_ONLY,
    },
    ({ course_id, assignment_id }) =>
      run(async () => {
        const assignment = await canvas().get<Assignment>(`/courses/${course_id}/assignments/${assignment_id}`, {
          include: ["submission"],
        });
        const description = truncate(htmlToText(assignment.description), MAX_TEXT);
        const current = now();
        return {
          ...summarizeAssignment(assignment, current),
          open_for_submission: needsSubmission(assignment) && !isLocked(assignment, current),
          instructions: description.text,
          rubric: assignment.rubric?.map((criterion) => ({
            criterion: criterion.description,
            details: htmlToText(criterion.long_description) || undefined,
            points: criterion.points,
          })),
        };
      }),
  );

  server.registerTool(
    "get_feedback",
    {
      title: "Get Feedback",
      description:
        "Returns the student's recently graded work in a course with scores, instructor comments, and rubric results. Use it to find patterns in what went wrong and turn them into specific things to practice or review.",
      inputSchema: {
        course_id: z.number().int(),
        limit: z.number().int().min(1).max(50).default(10).describe("How many graded items, most recent first"),
      },
      annotations: READ_ONLY,
    },
    ({ course_id, limit }) =>
      run(async () => {
        const submissions = await canvas().getAll<Submission>(
          `/courses/${course_id}/students/submissions`,
          {
            student_ids: ["self"],
            include: ["assignment", "submission_comments", "rubric_assessment"],
            workflow_state: "graded",
            order: "graded_at",
            order_direction: "descending",
          },
          limit,
        );
        return {
          graded: submissions.map((submission) => {
            const criteria = new Map(submission.assignment?.rubric?.map((criterion) => [criterion.id, criterion]));
            return {
              assignment_id: submission.assignment?.id,
              assignment: submission.assignment?.name,
              score: submission.score ?? null,
              points_possible: submission.assignment?.points_possible ?? null,
              grade: submission.grade ?? null,
              graded_at: submission.graded_at,
              late: submission.late || undefined,
              comments: submission.submission_comments?.map((comment) => ({
                from: comment.author_name,
                at: comment.created_at,
                comment: comment.comment,
              })),
              rubric: submission.rubric_assessment
                ? Object.entries(submission.rubric_assessment).map(([id, rating]) => ({
                    criterion: criteria.get(id)?.description ?? id,
                    points: rating.points,
                    points_possible: criteria.get(id)?.points,
                    comments: rating.comments || undefined,
                  }))
                : undefined,
            };
          }),
        };
      }),
  );

  server.registerTool(
    "list_course_materials",
    {
      title: "List Course Materials",
      description:
        "Lists a course's modules and the items in each (pages, assignments, files, links). Use it to find the material for a topic the student wants to study, then read pages with read_course_page.",
      inputSchema: { course_id: z.number().int() },
      annotations: READ_ONLY,
    },
    ({ course_id }) =>
      run(async () => ({
        modules: (await canvas().getAll<Module>(`/courses/${course_id}/modules`, { include: ["items"] })).map((module) => ({
          id: module.id,
          name: module.name,
          items: module.items?.map((item) => ({
            title: item.title,
            type: item.type,
            page_url: item.page_url,
            content_id: item.content_id,
            link: item.html_url,
          })),
        })),
      })),
  );

  server.registerTool(
    "read_course_page",
    {
      title: "Read Course Page",
      description:
        "Reads the text of a Canvas course page. When studying from it, quiz the student on the ideas rather than summarizing the page for them: recalling is what builds memory.",
      inputSchema: {
        course_id: z.number().int(),
        page_url: z.string().min(1).describe("The page_url value from list_course_materials"),
      },
      annotations: READ_ONLY,
    },
    ({ course_id, page_url }) =>
      run(async () => {
        const page = await canvas().get<Page>(`/courses/${course_id}/pages/${encodeURIComponent(page_url)}`);
        const body = truncate(htmlToText(page.body), MAX_TEXT);
        return { title: page.title, updated_at: page.updated_at, text: body.text, truncated: body.truncated };
      }),
  );

  server.registerTool(
    "get_syllabus",
    {
      title: "Get Syllabus",
      description:
        "Reads a course's syllabus. Check it for the course's policy on AI use and collaboration before helping with graded work, and follow that policy.",
      inputSchema: { course_id: z.number().int() },
      annotations: READ_ONLY,
    },
    ({ course_id }) =>
      run(async () => {
        const course = await canvas().get<Course>(`/courses/${course_id}`, { include: ["syllabus_body"] });
        const body = truncate(htmlToText(course.syllabus_body), MAX_TEXT);
        return {
          course: course.name,
          syllabus: body.text || null,
          truncated: body.truncated,
          note: body.text ? undefined : "This course has no syllabus text in Canvas. It may be posted as a file or page instead.",
        };
      }),
  );

  server.registerTool(
    "add_review_items",
    {
      title: "Add Review Items",
      description:
        "Saves question-and-answer items to the student's spaced-review schedule, stored only on their computer. Prefer items the student wrote in their own words; draft items yourself only when asked, and show them to the student first. A good item covers one idea, asks why or how rather than for a bare definition, and can be answered in a sentence or two. New items are due right away.",
      inputSchema: {
        course_id: z.number().int().optional(),
        course_name: z.string().optional(),
        items: z
          .array(
            z.object({
              topic: z.string().min(1).describe("Short topic label, such as 'Recursion' or 'Week 4: Supply and Demand'"),
              prompt: z.string().min(1).describe("The question the student will be asked"),
              answer: z.string().min(1).describe("The reference answer"),
              source: z.string().optional().describe("Where this came from, such as a page title or lecture"),
              authored_by: z.enum(["student", "assistant"]).describe("Who wrote the item"),
            }),
          )
          .min(1)
          .max(25),
      },
      annotations: LOCAL_WRITE,
    },
    ({ course_id, course_name, items }) =>
      run(async () => {
        const created = store.add(
          items.map((item) => ({
            courseId: course_id,
            courseName: course_name,
            topic: item.topic,
            prompt: item.prompt,
            answer: item.answer,
            source: item.source,
            authoredBy: item.authored_by,
          })),
          now(),
        );
        return { added: created.map((item) => ({ id: item.id, topic: item.topic, prompt: item.prompt })) };
      }),
  );

  server.registerTool(
    "get_due_reviews",
    {
      title: "Get Due Reviews",
      description:
        "Returns the review items due now, most overdue first, with prompts only. Ask the student one prompt at a time and wait for their own answer. Do not answer for them or hint at the answer; then call attempt_review with what they said.",
      inputSchema: {
        course_id: z.number().int().optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ course_id, limit }) =>
      run(async () => {
        const current = now();
        const due = store.due(current, { courseId: course_id });
        return {
          total_due: due.length,
          items: due.slice(0, limit).map((item) => ({
            ...publicItem(item),
            days_overdue: Math.max(0, Math.floor((current.getTime() - dueAt(item)) / DAY_MS)),
          })),
        };
      }),
  );

  server.registerTool(
    "attempt_review",
    {
      title: "Attempt Review",
      description:
        "Records the student's own answer to a review prompt and returns the reference answer. Pass what the student actually said, word for word, including 'I don't know'. Never invent or improve their answer. Then compare the two for them honestly and ask them to rate their recall with rate_review.",
      inputSchema: {
        item_id: z.string(),
        student_answer: z.string().min(1).describe("The student's answer in their own words"),
      },
      annotations: LOCAL_WRITE,
    },
    ({ item_id, student_answer }) =>
      run(async () => {
        const item = store.attempt(item_id, student_answer, now());
        return {
          id: item.id,
          prompt: item.prompt,
          student_answer,
          reference_answer: item.answer,
          source: item.source,
          next: "Compare the answers with the student, then have them rate their recall: again (could not recall), hard (recalled with real effort or partly), good (recalled correctly), easy (instant).",
        };
      }),
  );

  server.registerTool(
    "rate_review",
    {
      title: "Rate Review",
      description:
        "Schedules the next review of an item from the student's rating of their recall. The student chooses the rating; if their answer was wrong or missing it must be 'again'. Requires attempt_review first.",
      inputSchema: {
        item_id: z.string(),
        rating: ratingSchema.describe("again = could not recall, hard = partly or with real effort, good = correct, easy = instant"),
      },
      annotations: LOCAL_WRITE,
    },
    ({ item_id, rating }) =>
      run(async () => {
        const current = now();
        const item = store.rate(item_id, rating, current);
        return {
          id: item.id,
          rating,
          next_review: item.card.due,
          next_review_in_days: Math.round(((dueAt(item) - current.getTime()) / DAY_MS) * 10) / 10,
          remaining_due_now: store.due(current).length,
        };
      }),
  );

  server.registerTool(
    "list_review_items",
    {
      title: "List Review Items",
      description:
        "Lists saved review items with their schedule, without answers, so browsing the list does not spoil retrieval practice. Set include_answers only when the student wants to edit or check an item.",
      inputSchema: {
        course_id: z.number().int().optional(),
        topic: z.string().optional().describe("Match topics containing this text"),
        include_answers: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ course_id, topic, include_answers }) =>
      run(async () => ({
        items: store.list({ courseId: course_id, topic }).map((item) => ({
          ...publicItem(item),
          answer: include_answers ? item.answer : undefined,
          next_review: item.card.due,
          reviews: item.card.reps,
          lapses: item.card.lapses,
        })),
      })),
  );

  server.registerTool(
    "update_review_item",
    {
      title: "Update Review Item",
      description: "Edits a saved review item's topic, prompt, answer, or source. Its review schedule is kept.",
      inputSchema: {
        item_id: z.string(),
        topic: z.string().min(1).optional(),
        prompt: z.string().min(1).optional(),
        answer: z.string().min(1).optional(),
        source: z.string().optional(),
      },
      annotations: LOCAL_WRITE,
    },
    ({ item_id, ...changes }) => run(async () => ({ updated: publicItem(store.update(item_id, changes)) })),
  );

  server.registerTool(
    "delete_review_item",
    {
      title: "Delete Review Item",
      description: "Permanently removes a review item and its history. Confirm with the student first.",
      inputSchema: { item_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    ({ item_id }) => run(async () => ({ deleted: publicItem(store.delete(item_id)) })),
  );

  server.registerTool(
    "get_review_stats",
    {
      title: "Get Review Stats",
      description:
        "Summarizes the student's spaced review: how much is due, the next week's load, activity by topic, and the items they forget most often. Use the weak items to decide what to re-study or re-teach, not just re-quiz.",
      inputSchema: { course_id: z.number().int().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ course_id }) =>
      run(async () => {
        const current = now();
        const items = store.list({ courseId: course_id });
        const weekAgo = current.getTime() - 7 * DAY_MS;
        const recent = items.flatMap((item) => item.history).filter((attempt) => new Date(attempt.at).getTime() >= weekAgo);
        const topics = new Map<string, { items: number; due_now: number; lapses: number }>();
        for (const item of items) {
          const entry = topics.get(item.topic) ?? { items: 0, due_now: 0, lapses: 0 };
          entry.items += 1;
          entry.lapses += item.card.lapses;
          if (dueAt(item) <= current.getTime()) entry.due_now += 1;
          topics.set(item.topic, entry);
        }
        return {
          total_items: items.length,
          due_now: store.due(current, { courseId: course_id }).length,
          never_reviewed: items.filter((item) => item.card.reps === 0).length,
          reviews_last_7_days: recent.length,
          recalled_last_7_days: recent.filter((attempt) => attempt.rating !== "again").length,
          days_studied_last_7: new Set(recent.map((attempt) => new Date(attempt.at).toDateString())).size,
          due_by_day: store.forecast(current, 7, { courseId: course_id }),
          by_topic: [...topics].map(([topic, entry]) => ({ topic, ...entry })),
          most_forgotten: items
            .filter((item) => item.card.lapses > 0)
            .sort((a, b) => b.card.lapses - a.card.lapses)
            .slice(0, 5)
            .map((item) => ({ ...publicItem(item), lapses: item.card.lapses })),
        };
      }),
  );

  return server;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function run(action: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await action(), null, 2) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
  }
}

/** A review item as shown before the student has attempted it: no answer. */
function publicItem(item: ReviewItem) {
  return {
    id: item.id,
    course_id: item.courseId,
    course: item.courseName,
    topic: item.topic,
    prompt: item.prompt,
    authored_by: item.authoredBy,
  };
}

function isSubmitted(assignment: Assignment): boolean {
  const submission = assignment.submission;
  if (!submission) return false;
  return Boolean(submission.submitted_at || submission.excused || submission.workflow_state === "graded");
}

function needsSubmission(assignment: Assignment): boolean {
  const types = assignment.submission_types ?? [];
  const nothingToSubmit = types.some((type) => type === "none" || type === "not_graded" || type === "on_paper");
  return !nothingToSubmit && !isSubmitted(assignment);
}

function isLocked(assignment: Assignment, current: Date): boolean {
  return Boolean(assignment.lock_at && new Date(assignment.lock_at).getTime() < current.getTime());
}

function summarizeAssignment(assignment: Assignment, current: Date) {
  const submission = assignment.submission;
  return {
    assignment_id: assignment.id,
    name: assignment.name,
    due_at: assignment.due_at ?? null,
    days_until_due: assignment.due_at
      ? Math.round(((new Date(assignment.due_at).getTime() - current.getTime()) / DAY_MS) * 10) / 10
      : null,
    points_possible: assignment.points_possible ?? null,
    submission_types: assignment.submission_types,
    submitted: isSubmitted(assignment),
    score: submission?.score ?? null,
    link: assignment.html_url,
  };
}
