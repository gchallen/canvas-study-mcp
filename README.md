# Canvas Study

Canvas Study connects an AI assistant such as Claude to your own Canvas courses so it can help you study: quizzing you on course material, scheduling reviews so you remember it, planning your week around deadlines, and helping you learn from feedback on graded work.

It is built to help you learn, not to do your work for you.

**This is an early version, shared for feedback.** If something breaks or feels wrong, please [open an issue](https://github.com/gchallen/canvas-study-mcp/issues).

## What It Does

- **Review that sticks.** Save questions about what you are learning, and Canvas Study schedules each one to come back just before you would forget it. You answer first, then see the reference answer, then say how well you recalled it.
- **Planning.** See what is due and overdue across all your courses, alongside the reviews coming up, and work out a plan that starts early instead of the night before.
- **Course material.** The assistant can read your course pages, modules, and syllabus so it can quiz you on what your course actually covers.
- **Feedback.** It can read scores, instructor comments, and rubric results on your graded work to help you see what to practice next.

## What It Will Not Do

- **It cannot change anything in Canvas.** It can only read. It cannot submit assignments, take quizzes, or post to discussions.
- **It is not for writing your assignments.** The assistant is instructed to help you understand and practice, and to leave graded work to you. Your course's own rules on AI use come first: check your syllabus, and ask your instructor if you are unsure.

## Privacy

- **It runs on your computer.** There is no Canvas Study server, and nobody running this project ever sees your token or your data.
- **Your access token works like a password** for everything you can see in Canvas. Keep it private, set an expiry date when you create it, and delete it in Canvas if you stop using this.
- **What the assistant reads goes to your AI provider.** When it reads a course page or your grades, that content is sent to the company behind your assistant, as with anything else you share with it.
- **Your review questions and history** are kept in a file on your computer, in a folder named `.canvas-study-mcp` in your home folder.

## Install

### Step 1: Create a Canvas Access Token

1. In Canvas, click **Account**, then **Settings**.
2. Under **Approved Integrations**, click **New Access Token**.
3. Enter a purpose such as "Canvas Study", choose an expiry date, and generate the token.
4. Copy the token now. Canvas will not show it again.

Some schools do not let students create tokens. If you do not see the button, this tool will not work at your school.

### Step 2: Add It to Your Assistant

**Claude Desktop** (no terminal needed)

1. Download `canvas-study.mcpb` from the [latest release](https://github.com/gchallen/canvas-study-mcp/releases/latest).
2. Open the file. Claude Desktop shows a Canvas Study page: click **Install**, then **Install** again to confirm.
3. Enter your school's Canvas address (such as `canvas.illinois.edu`), paste your token, and click **Save**, then **Save** again to confirm.
4. Turn on the switch at the bottom left of that page so it reads **Enabled**. It starts out disabled.
5. Start a new chat. The first time Claude uses a Canvas Study tool, it asks your permission.

**Claude Code**

```sh
claude mcp add canvas-study \
  --env CANVAS_BASE_URL=canvas.illinois.edu \
  --env CANVAS_API_TOKEN=your-token \
  -- npx -y canvas-study-mcp
```

**Other MCP clients**

You need [Node.js](https://nodejs.org) 20 or newer. Add this to your client's MCP configuration:

```json
{
  "mcpServers": {
    "canvas-study": {
      "command": "npx",
      "args": ["-y", "canvas-study-mcp"],
      "env": {
        "CANVAS_BASE_URL": "canvas.illinois.edu",
        "CANVAS_API_TOKEN": "your-token"
      }
    }
  }
}
```

## Getting Started

Once it is installed, try asking your assistant:

- "What do I have due in the next two weeks? Help me plan."
- "Quiz me on this week's material in my algorithms course."
- "Help me write review questions about recursion, then save them."
- "What reviews do I have due today?"
- "Look at the feedback on my last few assignments. What should I work on?"

A few minutes of review most days works far better than one long session before an exam.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_courses` | Active courses and current scores |
| `get_upcoming_work` | Upcoming and overdue work, plus the review load for each day |
| `get_assignment` | Instructions, rubric, and submission status for one assignment |
| `get_feedback` | Recently graded work with comments and rubric results |
| `list_course_materials` | Modules and their items |
| `read_course_page` | Text of a course page |
| `get_syllabus` | Course syllabus, including any policy on AI use |
| `add_review_items` | Save question-and-answer items to the review schedule |
| `get_due_reviews` | Prompts due for review now, without answers |
| `attempt_review` | Record your answer and reveal the reference answer |
| `rate_review` | Schedule the next review from your recall rating |
| `list_review_items`, `update_review_item`, `delete_review_item` | Manage saved items |
| `get_review_stats` | Review load, recent activity, and most-forgotten items |

Review scheduling uses [FSRS](https://github.com/open-spaced-repetition/ts-fsrs). Set `CANVAS_STUDY_DATA_DIR` to keep review data somewhere else.

## Limits

- It reads Canvas pages, assignments, modules, and the syllabus. It does not yet read uploaded files such as PDFs and slides, or quiz questions.
- It only sees what is in Canvas. Courses that keep material elsewhere will look empty.
- The assistant is guided, not locked down: this tool shapes what it can see and do in Canvas, but how you use an AI assistant is still up to you.

## Development

```sh
npm install
npm run check      # typecheck, test, build
npm run pack:mcpb  # build canvas-study.mcpb for Claude Desktop
```

### Testing Against a Local Canvas

`scripts/seed-local-canvas.mjs` seeds a local development Canvas (it refuses any address that is not `.localhost`) with a test course: a syllabus with an AI policy, pages in a module, a rubric, and graded, overdue, and upcoming assignments. It needs an admin token, existing `teacher` and `student` users, and the student's password, then logs in as the student to create an access token and prints the environment for the server:

```sh
CANVAS_ADMIN_TOKEN=... CANVAS_STUDENT_PASSWORD=... NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" \
  node scripts/seed-local-canvas.mjs --canvas-url=https://canvas.example.localhost > .env
```

If the local Canvas uses an mkcert certificate, the server also needs `NODE_EXTRA_CA_CERTS` set to the mkcert root.

## License

MIT
