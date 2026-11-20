// Seeds a local development Canvas with a course shaped for testing this server: a syllabus with an
// AI policy, pages in a module, a rubric, and assignments that are graded, upcoming, and overdue.
// It then mints an access token for the student and prints the environment to run the server with.
//
// This is the only code in the repository that writes to Canvas, and it is for a throwaway local
// instance only. It refuses to run against anything that is not a .localhost address.
//
//   CANVAS_ADMIN_TOKEN=... CANVAS_STUDENT_PASSWORD=... NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" \
//     node scripts/seed-local-canvas.mjs --canvas-url=<base> [--student=<login>] [--teacher=<login>]
//
// --canvas-url and --student-password default to CANVAS_URL and CANVAS_STUDENT_PASSWORD.
//
// The teacher and student users must already exist (found by SIS id). Idempotent: the course is
// found by SIS id and its content is only created once.

import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
  options: {
    "canvas-url": { type: "string", default: process.env.CANVAS_URL },
    student: { type: "string", default: "student" },
    teacher: { type: "string", default: "teacher" },
    "student-password": { type: "string", default: process.env.CANVAS_STUDENT_PASSWORD },
  },
});

if (!opts["canvas-url"]) throw new Error("Pass --canvas-url or set CANVAS_URL.");
if (!opts["student-password"]) throw new Error("Pass --student-password or set CANVAS_STUDENT_PASSWORD.");
const CANVAS = new URL(opts["canvas-url"]).origin;
const host = new URL(CANVAS).hostname;
if (host !== "localhost" && !host.endsWith(".localhost")) {
  throw new Error(`Refusing to seed ${CANVAS}: this script only writes to a local .localhost Canvas.`);
}
const TOKEN = process.env.CANVAS_ADMIN_TOKEN;
if (!TOKEN) throw new Error("CANVAS_ADMIN_TOKEN is unset.");

const ACCOUNT = 1;
const COURSE = { sis: "CSM101", code: "CSM101", name: "Canvas Study MCP Test Course" };
const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY_MS).toISOString();
const log = (message) => console.error(message);

async function api(method, path, body) {
  const response = await fetch(`${CANVAS}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 1000)}`);
    error.status = response.status;
    throw error;
  }
  return text ? JSON.parse(text) : null;
}

async function find(path) {
  try {
    return await api("GET", path);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function requireUser(login) {
  const user = await find(`/users/sis_user_id:${login}`);
  if (!user) throw new Error(`User ${login} does not exist. Seed the base users first.`);
  return user;
}

async function ensureEnrollment(courseId, userId, type) {
  const existing = await api("GET", `/courses/${courseId}/enrollments?user_id=${userId}`);
  if (existing.length > 0) return;
  await api("POST", `/courses/${courseId}/enrollments`, {
    enrollment: { user_id: userId, type, enrollment_state: "active" },
  });
}

const teacher = await requireUser(opts.teacher);
const student = await requireUser(opts.student);

let course = await find(`/courses/sis_course_id:${COURSE.sis}`);
if (!course) {
  course = await api("POST", `/accounts/${ACCOUNT}/courses`, {
    course: { name: COURSE.name, course_code: COURSE.code, sis_course_id: COURSE.sis },
    offer: true,
  });
  log(`Created course ${course.id}`);
}
await ensureEnrollment(course.id, teacher.id, "TeacherEnrollment");
await ensureEnrollment(course.id, student.id, "StudentEnrollment");

const existingAssignments = await api("GET", `/courses/${course.id}/assignments`);
if (existingAssignments.length > 0) {
  log(`Course ${course.id} already has content; leaving it as is.`);
} else {
  await api("PUT", `/courses/${course.id}`, {
    course: {
      syllabus_body:
        "<h2>Course Policies</h2><p>This course covers recursion and sorting.</p>" +
        "<h3>AI Policy</h3><p>You may use AI tools to study and to check your understanding. " +
        "You may not submit AI-written text or code for graded work.</p>",
    },
  });

  const pages = [];
  for (const page of [
    {
      title: "Recursion Basics",
      body: "<h2>Recursion</h2><p>A recursive function calls itself on a <b>smaller</b> input.</p><ul><li>A base case stops the recursion.</li><li>A recursive case makes progress toward the base case.</li></ul><p>Without a base case the calls never stop &amp; the stack overflows.</p>",
    },
    {
      title: "Merge Sort",
      body: "<h2>Merge Sort</h2><p>Split the list in half, sort each half recursively, then merge.</p><p>It runs in O(n log n) time because there are log n levels of splitting and each level does O(n) work merging.</p>",
    },
  ]) {
    pages.push(await api("POST", `/courses/${course.id}/pages`, { wiki_page: { ...page, published: true } }));
  }

  const module = await api("POST", `/courses/${course.id}/modules`, { module: { name: "Week 1: Recursion" } });
  for (const page of pages) {
    const item = await api("POST", `/courses/${course.id}/modules/${module.id}/items`, {
      module_item: { type: "Page", page_url: page.url, title: page.title },
    });
    await api("PUT", `/courses/${course.id}/modules/${module.id}/items/${item.id}`, { module_item: { published: true } });
  }
  await api("PUT", `/courses/${course.id}/modules/${module.id}`, { module: { published: true } });

  const assignment = (name, description, dueInDays) =>
    api("POST", `/courses/${course.id}/assignments`, {
      assignment: {
        name,
        description,
        due_at: inDays(dueInDays),
        points_possible: 10,
        submission_types: ["online_text_entry"],
        published: true,
      },
    });

  const graded = await assignment("Recursion Reflection", "<p>Explain in your own words why a recursive function needs a base case.</p>", -7);
  await assignment("Factorial Trace", "<p>Trace <code>factorial(4)</code> call by call.</p>", -3);
  await assignment("Merge Sort Analysis", "<p>Explain why merge sort runs in O(n log n) time.</p>", 5);
  await assignment("Final Project Proposal", "<p>Propose a project that uses recursion.</p>", 20);

  // Rubrics have an awkward form-style API, so this part is best effort.
  let criterionIds = [];
  try {
    const created = await api("POST", `/courses/${course.id}/rubrics`, {
      rubric: {
        title: "Reflection Rubric",
        criteria: {
          0: { description: "Accuracy", points: 6, ratings: { 0: { description: "Correct", points: 6 }, 1: { description: "Incorrect", points: 0 } } },
          1: { description: "Clarity", points: 4, ratings: { 0: { description: "Clear", points: 4 }, 1: { description: "Unclear", points: 0 } } },
        },
      },
      rubric_association: { association_id: graded.id, association_type: "Assignment", purpose: "grading", use_for_grading: false },
    });
    criterionIds = (created.rubric?.data ?? created.rubric?.criteria ?? []).map((criterion) => criterion.id);
  } catch (error) {
    log(`Rubric not created: ${error.message}`);
  }

  // Submit as the student (admin masquerade), then grade it with a comment.
  await api("POST", `/courses/${course.id}/assignments/${graded.id}/submissions?as_user_id=${student.id}`, {
    submission: { submission_type: "online_text_entry", body: "<p>It needs a base case so it eventually stops.</p>" },
  });
  const [accuracy, clarity] = criterionIds;
  await api("PUT", `/courses/${course.id}/assignments/${graded.id}/submissions/${student.id}`, {
    submission: { posted_grade: "7" },
    comment: { text_comment: "Right idea. Say what happens to the call stack when there is no base case." },
    ...(accuracy && clarity
      ? { rubric_assessment: { [accuracy]: { points: 5, comments: "Mention the stack." }, [clarity]: { points: 2, comments: "Too brief." } } }
      : {}),
  });
  log(`Seeded content in course ${course.id}`);
}

// Canvas will not let an admin token create a usable token for another user, even masquerading,
// so do what a student does: log in with a browser-style session and create one. It requires an expiry.
const token = await createTokenAsStudent(opts.student, opts["student-password"]);

async function createTokenAsStudent(login, password) {
  const jar = new Map();
  const request = async (path, init = {}) => {
    const response = await fetch(`${CANVAS}${path}`, {
      redirect: "manual",
      ...init,
      headers: { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "), ...init.headers },
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const index = pair.indexOf("=");
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  };

  const loginPage = await (await request("/login/canvas", { headers: { accept: "text/html" } })).text();
  const authenticity = /name="authenticity_token" value="([^"]+)"/.exec(loginPage)?.[1];
  if (!authenticity) throw new Error("Could not find the login form's authenticity token.");
  const form = new URLSearchParams({
    authenticity_token: authenticity.replaceAll("&#43;", "+").replaceAll("&#x2B;", "+").replaceAll("&amp;", "&"),
    "pseudonym_session[unique_id]": login,
    "pseudonym_session[password]": password,
  });
  const loggedIn = await request("/login/canvas", {
    method: "POST",
    headers: { accept: "text/html", "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (loggedIn.status !== 302) throw new Error(`Login as ${login} failed with status ${loggedIn.status}.`);

  // The lthub dev image's dump holds an admin token whose id the access_tokens sequence has not
  // passed, so the first insert on a fresh database fails with a 500 (duplicate key). Each failure
  // advances the sequence, so retrying gets past it.
  let created;
  let text = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    created = await request("/api/v1/users/self/tokens", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-csrf-token": decodeURIComponent(jar.get("_csrf_token") ?? ""),
      },
      body: JSON.stringify({
        token: { purpose: `canvas-study-mcp local test ${new Date().toISOString()}`, expires_at: inDays(30) },
      }),
    });
    text = await created.text();
    if (created.status !== 500) break;
  }
  if (!created.ok) throw new Error(`Creating the student token failed (${created.status}): ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

console.log(`CANVAS_BASE_URL=${CANVAS}`);
console.log(`CANVAS_API_TOKEN=${token.visible_token}`);
console.log(`CANVAS_TEST_COURSE_ID=${course.id}`);
