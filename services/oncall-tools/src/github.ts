import { Octokit } from "@octokit/rest";
import { config, isGithubEnabled, warnOnce } from "./config.js";
import { logger } from "./log.js";

let client: Octokit | undefined;
function getClient(): Octokit | undefined {
  if (!isGithubEnabled()) {
    warnOnce("github-disabled", "GitHub integration disabled: GITHUB_TOKEN not set", logger);
    return undefined;
  }
  if (!client) client = new Octokit({ auth: config.githubToken });
  return client;
}

export function getClientOrThrow(): Octokit {
  const c = getClient();
  if (!c) throw new Error("github_disabled");
  return c;
}

const [owner, repo] = config.githubRepo.split("/");

/**
 * Replaces the exact line `image: <from>` (any leading whitespace preserved) with
 * `image: <to>` inside `yaml`. Returns undefined if the from-image line is not present
 * (caller maps this to 409 file_drifted per SPEC 2.4).
 */
export function replaceImageLine(yaml: string, fromImage: string, toImage: string): string | undefined {
  const escaped = fromImage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^([ \\t]*image:[ \\t]*)${escaped}[ \\t]*$`, "m");
  if (!re.test(yaml)) return undefined;
  return yaml.replace(re, (_match, prefix: string) => `${prefix}${toImage}`);
}

/** Extracts the image reference from the first `image: <ref>` line found. */
export function extractImageLine(yaml: string): string | undefined {
  const m = yaml.match(/^[ \t]*image:[ \t]*(\S+)[ \t]*$/m);
  return m?.[1];
}

export type CommitResult = {
  sha: string;
  short_sha: string;
  url: string;
  message: string;
};

export class FileDriftedError extends Error {
  constructor() {
    super("file_drifted");
  }
}

/**
 * Reads GITOPS_FILE at GITHUB_BRANCH, replaces the exact `image: <fromImage>` line with
 * `image: <toImage>`, and commits the change (SPEC 2.4 step 1-2, 2.5 drill/reset).
 */
export async function commitImageChange(params: {
  fromImage: string;
  toImage: string;
  message: string;
  authorName: string;
  authorEmail: string;
}): Promise<CommitResult> {
  const octokit = getClientOrThrow();
  const { data: fileData } = await octokit.repos.getContent({
    owner: owner!,
    repo: repo!,
    path: config.gitopsFile,
    ref: config.githubBranch,
  });
  if (Array.isArray(fileData) || fileData.type !== "file" || !fileData.content) {
    throw new Error(`${config.gitopsFile} is not a regular file`);
  }
  const currentYaml = Buffer.from(fileData.content, "base64").toString("utf8");
  const nextYaml = replaceImageLine(currentYaml, params.fromImage, params.toImage);
  if (nextYaml === undefined) {
    throw new FileDriftedError();
  }

  const { data: commitData } = await octokit.repos.createOrUpdateFileContents({
    owner: owner!,
    repo: repo!,
    path: config.gitopsFile,
    message: params.message,
    content: Buffer.from(nextYaml, "utf8").toString("base64"),
    sha: fileData.sha,
    branch: config.githubBranch,
    committer: { name: "oncall-copilot", email: "oncall-copilot@rosenvall.se" },
    author: { name: params.authorName, email: params.authorEmail },
  });

  const sha = commitData.commit.sha ?? "";
  return {
    sha,
    short_sha: sha.slice(0, 7),
    url: commitData.commit.html_url ?? `https://github.com/${config.githubRepo}/commit/${sha}`,
    message: params.message,
  };
}

export type CommitHistoryEntry = {
  sha: string;
  short_sha: string;
  author: string;
  date: string;
  message: string;
  image_before?: string;
  image_after?: string;
  url: string;
};

/** Last `count` commits touching GITOPS_FILE, with the image line before/after each commit. */
export async function listRecentImageCommits(count: number): Promise<CommitHistoryEntry[]> {
  const octokit = getClientOrThrow();
  const { data: commits } = await octokit.repos.listCommits({
    owner: owner!,
    repo: repo!,
    path: config.gitopsFile,
    sha: config.githubBranch,
    per_page: count,
  });

  const entries: CommitHistoryEntry[] = [];
  for (const commit of commits) {
    const sha = commit.sha;
    const parentSha = commit.parents?.[0]?.sha;
    const [afterYaml, beforeYaml] = await Promise.all([
      getFileAtRef(octokit, sha),
      parentSha ? getFileAtRef(octokit, parentSha) : Promise.resolve(undefined),
    ]);
    entries.push({
      sha,
      short_sha: sha.slice(0, 7),
      author: commit.commit.author?.name ?? "unknown",
      date: commit.commit.author?.date ?? "",
      message: (commit.commit.message ?? "").split("\n")[0] ?? "",
      image_after: afterYaml ? extractImageLine(afterYaml) : undefined,
      image_before: beforeYaml ? extractImageLine(beforeYaml) : undefined,
      url: commit.html_url,
    });
  }
  return entries;
}

/**
 * Opens a postmortem issue in POSTMORTEM_REPO. Returns undefined (and logs) when GitHub is
 * disabled or the token lacks Issues permission, so the call flow never depends on it.
 */
export async function createPostmortemIssue(params: { title: string; body: string; labels?: string[] }): Promise<{ number: number; url: string } | undefined> {
  const octokit = getClient();
  if (!octokit || !config.postmortemEnabled) return undefined;
  const [pmOwner, pmRepo] = config.postmortemRepo.split("/");
  try {
    const { data } = await octokit.issues.create({
      owner: pmOwner!,
      repo: pmRepo!,
      title: params.title,
      body: params.body,
      labels: params.labels ?? ["postmortem", "oncall-copilot"],
    });
    return { number: data.number, url: data.html_url };
  } catch (err) {
    logger.warn({ err: (err as Error).message, repo: config.postmortemRepo }, "postmortem issue not created (token may lack Issues: write)");
    return undefined;
  }
}

async function getFileAtRef(octokit: Octokit, ref: string): Promise<string | undefined> {
  try {
    const { data } = await octokit.repos.getContent({ owner: owner!, repo: repo!, path: config.gitopsFile, ref });
    if (Array.isArray(data) || data.type !== "file" || !data.content) return undefined;
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (err) {
    // Expected for the commit that created the file (no parent version); not worth a warning.
    logger.debug({ err: (err as Error).message, ref }, "GITOPS_FILE not readable at ref");
    return undefined;
  }
}
