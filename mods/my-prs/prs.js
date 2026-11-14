// Pure helpers for the My PRs panel: the GraphQL query and response parsing.
// No Herdr imports, so `node --test` can load this file.

export const QUERY = `query($mine: String!, $review: String!) {
  viewer { login }
  mine: search(query: $mine, type: ISSUE, first: 50) { nodes { ...pr } }
  review: search(query: $review, type: ISSUE, first: 50) { nodes { ...pr } }
}
fragment pr on PullRequest {
  id number title url isDraft updatedAt reviewDecision
  author { login }
  assignees(first: 5) { nodes { login } }
  repository { nameWithOwner viewerDefaultMergeMethod }
  reviews(states: APPROVED) { totalCount }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

export const MINE = "is:pr is:open author:@me archived:false sort:updated-desc";
export const REVIEW = "is:pr is:open review-requested:@me archived:false sort:updated-desc";

// CI rollup state -> { label, color (theme name) }.
const CI = {
  SUCCESS: { label: "CI passing", color: "ansi2" },
  FAILURE: { label: "CI failing", color: "ansi1" },
  ERROR: { label: "CI error", color: "ansi1" },
  PENDING: { label: "CI running", color: "ansi3" },
  EXPECTED: { label: "CI waiting", color: "ansi3" },
};

const REVIEW_LABELS = {
  APPROVED: { label: "Approved", color: "ansi2" },
  CHANGES_REQUESTED: { label: "Changes requested", color: "ansi1" },
  REVIEW_REQUIRED: { label: "Needs review", color: "muted" },
};

function parsePr(n) {
  const ci = n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
  return {
    id: n.id, number: n.number, title: n.title ?? "", url: n.url, draft: Boolean(n.isDraft),
    updatedAt: n.updatedAt, repo: n.repository?.nameWithOwner ?? "", author: n.author?.login ?? "",
    assignees: (n.assignees?.nodes ?? []).map((a) => a?.login).filter(Boolean),
    approvals: n.reviews?.totalCount ?? 0, mergeMethod: n.repository?.viewerDefaultMergeMethod ?? "MERGE",
    ci: ci ? CI[ci] ?? { label: ci.toLowerCase(), color: "dim" } : null,
    review: REVIEW_LABELS[n.reviewDecision] ?? null,
  };
}

export function parseResponse(text) {
  const json = JSON.parse(text);
  const message = json?.errors?.[0]?.message;
  if (message) throw new Error(message);
  const list = (key) => (json?.data?.[key]?.nodes ?? []).filter((n) => n?.url).map(parsePr);
  return { viewer: json?.data?.viewer?.login ?? "", mine: list("mine"), review: list("review") };
}

// Only https links reach the system's opener.
export function safeUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export function ago(iso, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

// Splits `gh pr diff` output into files: { path, add, del, rows }, where rows number each line once
// ({ kind: "@" | "+" | "-" | " " | "", number?, text }) so the view only draws the rows on screen.
export function parseDiff(text) {
  const files = [];
  let file = null, old = 0, next = 0, inHunk = false;
  for (const line of text.split("\n")) {
    const header = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (header) {
      file = { path: header[2], add: 0, del: 0, rows: [] }; files.push(file); inHunk = false;
      continue;
    }
    if (!file) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) { old = +hunk[1]; next = +hunk[2]; inHunk = true; file.rows.push({ kind: "@", text: line }); continue; }
    if (!inHunk) {
      if (line.startsWith("Binary files")) file.rows.push({ kind: "", text: "Binary file changed" });
      else if (line.startsWith("rename from ")) file.from = line.slice(12);
      else if (line.startsWith("deleted file")) file.status = "D";
      else if (line.startsWith("new file")) file.status = "A";
      continue;
    }
    const kind = line[0], body = line.slice(1) || " ";
    if (kind === "+") { file.add++; file.rows.push({ kind, number: next++, text: body }); }
    else if (kind === "-") { file.del++; file.rows.push({ kind, number: old++, text: body }); }
    else if (kind === " ") { old++; file.rows.push({ kind, number: next++, text: body }); }
    else if (line.startsWith("\\")) file.rows.push({ kind: "", text: line });
  }
  for (const f of files) if (!f.rows.length) f.rows.push({ kind: "", text: f.from ? `Renamed from ${f.from}` : "No text changes" });
  return files;
}

export const COMMENTS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    comments(last: 100) { nodes { author { login } body createdAt url } }
    reviews(last: 100) { nodes { author { login } body state submittedAt url } }
    reviewThreads(last: 100) { nodes { isResolved isOutdated path line originalLine
      comments(first: 50) { nodes { author { login } body createdAt url pullRequestReview { state } } } } }
  } }
}`;

const REVIEW_STATES = {
  APPROVED: { label: "Approved", color: "ansi2" },
  CHANGES_REQUESTED: { label: "Changes requested", color: "ansi1" },
  DISMISSED: { label: "Dismissed", color: "dim" },
};

// The PR's conversation, newest first (replies within a thread stay oldest first): { kind: "comment" | "review" | "thread", author, at, body, url,
// state?, path?, line?, resolved?, outdated?, dismissed?, replies? }. dismissed marks a dismissed review
// or a thread started in one. Reviews with no body show only when they
// approve or request changes; their inline comments arrive as threads.
export function parseComments(text) {
  const json = JSON.parse(text);
  const message = json?.errors?.[0]?.message;
  if (message) throw new Error(message);
  const pr = json?.data?.repository?.pullRequest;
  if (!pr) throw new Error("Pull request not found");
  const who = (n) => n?.author?.login ?? "ghost";
  // Bots hide metadata in HTML comments, which would otherwise render as text.
  const clean = (body) => (body ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
  const items = [
    ...(pr.comments?.nodes ?? []).map((n) => ({ kind: "comment", author: who(n), at: n.createdAt, body: clean(n.body), url: n.url })),
    ...(pr.reviews?.nodes ?? []).filter((n) => n.submittedAt && (clean(n.body) || REVIEW_STATES[n.state]))
      .map((n) => ({ kind: "review", author: who(n), at: n.submittedAt, body: clean(n.body), url: n.url, state: REVIEW_STATES[n.state] ?? null, dismissed: n.state === "DISMISSED" })),
    ...(pr.reviewThreads?.nodes ?? []).filter((n) => n.comments?.nodes?.length).map((n) => {
      const [first, ...rest] = n.comments.nodes;
      return {
        kind: "thread", author: who(first), at: first.createdAt, body: clean(first.body), url: first.url,
        path: n.path, line: n.line ?? n.originalLine, resolved: Boolean(n.isResolved), outdated: Boolean(n.isOutdated),
        dismissed: first.pullRequestReview?.state === "DISMISSED",
        replies: rest.map((c) => ({ author: who(c), at: c.createdAt, body: clean(c.body) })),
      };
    }),
  ];
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
