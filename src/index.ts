/**
 * Cloudflare Pages → Discord Notifier (Embeds)
 * - Posts Discord EMBEDS for deploy START and FINISH (success/failed/skipped)
 * - Includes git details (branch, commit hash/message/author/link) and deployment URL
 */

interface Env {
  STATE: KVNamespace;          // KV binding
  ACCOUNT_ID: string;          // from [vars]
  PROJECTS?: string;           // JSON array in [vars], e.g. ["site-a","site-b"]
  CF_API_TOKEN: string;        // secret
  DISCORD_WEBHOOK: string;     // secret
}

type StageStatus =
  | "pending" | "active" | "in_progress" | "idle"
  | "success" | "failed" | "canceled" | "error" | "skipped";

type StageName =
  | "queued" | "initialize" | "clone_repo" | "build" | "deploy" | string;

type Deployment = {
  id: string;
  url?: string | null;                  // preview or production URL for this deployment
  environment?: "preview" | "production" | string;
  latest_stage?: { name?: StageName; status?: StageStatus } | null;
  stages?: Array<{ name?: StageName; status?: StageStatus }> | null;
  created_on?: string;
  is_skipped?: boolean;
  deployment_trigger?: {
    type?: string;
    metadata?: {
      branch?: string;
      commit_hash?: string;
      commit_message?: string;
      commit_author?: string;
      commit_url?: string;             // often a link to the commit on GitHub/GitLab
    };
  } | null;
};

const API = "https://api.cloudflare.com/client/v4";

// Terminal vs non-terminal states
const TERMINAL: Record<string, true> = {
  success: true,
  failed: true,
  canceled: true,
  error: true,
  skipped: true,
};
const NON_TERMINAL: Record<string, true> = {
  pending: true,
  active: true,
  in_progress: true,
  idle: true,
};

// Embed colors
const COLORS = {
  started: 0xf1c40f, // gold
  success: 0x2ecc71, // green
  failed: 0xe74c3c,  // red
  skipped: 0x95a5a6, // gray
  default: 0x7289da, // blurple
};

const s = (x: unknown) => (typeof x === "string" ? x : "");

function getProjects(env: Env): string[] {
  try {
    const arr = JSON.parse(env.PROJECTS ?? "[]");
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

type KVState = { id: string; status: string };
const kvKey = (project: string) => `deploy:${project}`;

async function fetchLatestDeployment(env: Env, project: string): Promise<Deployment | null> {
  const url = `${API}/accounts/${env.ACCOUNT_ID}/pages/projects/${encodeURIComponent(project)}/deployments?per_page=1`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } });
  if (!r.ok) throw new Error(`Pages API ${r.status} for ${project}`);
  const data = await r.json();
  return data?.result?.[0] ?? null;
}

// ---------- Discord helpers (embeds) ----------

type Embed = {
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string; // ISO string
};

async function sendDiscordEmbed(env: Env, embed: Embed) {
  const res = await fetch(env.DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // You can also add username/avatar_url here if desired
    body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
  });
  if (!res.ok && res.status !== 204) {
    console.log("Discord webhook non-204:", res.status);
  }
}

function truncate(str: string, max = 180): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "…";
}

function shortHash(hash?: string) {
  const h = s(hash);
  return h ? h.slice(0, 7) : "";
}

function extractGit(dep: Deployment) {
  const md = dep.deployment_trigger?.metadata ?? {};
  const branch = s(md.branch);
  const commitHash = s(md.commit_hash);
  const commitMsg = s(md.commit_message);
  const author = s(md.commit_author);
  const commitUrl = s(md.commit_url);
  return { branch, commitHash, commitMsg, author, commitUrl };
}

function describe(dep: Deployment) {
  const status = s(dep.latest_stage?.status).toLowerCase();
  const stage = s(dep.latest_stage?.name);
  const envName = s(dep.environment);
  const url = s(dep.url);
  const git = extractGit(dep);
  return { status, stage, envName, url, git };
}

function startedEmbed(project: string, dep: Deployment): Embed {
  const { envName, url, stage, git } = describe(dep);
  const title = `🚧 Deploy STARTED — ${project}${envName ? ` (${envName})` : ""}`;
  const fields: Embed["fields"] = [];

  if (git.branch) fields.push({ name: "Branch", value: `\`${git.branch}\``, inline: true });
  if (git.commitHash) {
    const sh = shortHash(git.commitHash);
    const v = git.commitUrl ? `[\`${sh}\`](${git.commitUrl})` : `\`${sh}\``;
    fields.push({ name: "Commit", value: v, inline: true });
  }
  if (git.author) fields.push({ name: "Author", value: git.author, inline: true });
  if (stage) fields.push({ name: "Stage", value: `\`${stage}\``, inline: true });

  const description = git.commitMsg ? `> ${truncate(git.commitMsg, 240)}` : undefined;

  return {
    title,
    url: url || undefined,
    description,
    color: COLORS.started,
    fields,
    footer: { text: `${project}${envName ? ` · ${envName}` : ""}` },
    timestamp: new Date().toISOString(),
  };
}

function finishedEmbed(project: string, dep: Deployment): Embed {
  const { status, envName, url, git } = describe(dep);

  let color = COLORS.default;
  let stateText = (status || "done").toUpperCase();
  let emoji = "✅";
  if (status === "success") { color = COLORS.success; emoji = "✅"; }
  else if (status === "failed" || status === "error" || status === "canceled") { color = COLORS.failed; emoji = "❌"; }
  else if (status === "skipped") { color = COLORS.skipped; emoji = "⏭️"; }

  const title = `${emoji} Deploy ${stateText} — ${project}${envName ? ` (${envName})` : ""}`;
  const fields: Embed["fields"] = [];

  if (git.branch) fields.push({ name: "Branch", value: `\`${git.branch}\``, inline: true });
  if (git.commitHash) {
    const sh = shortHash(git.commitHash);
    const v = git.commitUrl ? `[\`${sh}\`](${git.commitUrl})` : `\`${sh}\``;
    fields.push({ name: "Commit", value: v, inline: true });
  }
  if (git.author) fields.push({ name: "Author", value: git.author, inline: true });

  const description = git.commitMsg ? `> ${truncate(git.commitMsg, 240)}` : undefined;

  return {
    title,
    url: url || undefined,
    description,
    color,
    fields,
    footer: { text: `${project}${envName ? ` · ${envName}` : ""}` },
    timestamp: new Date().toISOString(),
  };
}

// ---------- worker entry ----------

export default {
  async scheduled(_e: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handle(env));
  },
};

async function handle(env: Env) {
  const projects = getProjects(env);
  if (!projects.length) {
    console.log("No projects configured in PROJECTS var");
    return;
  }

  await Promise.all(
    projects.map(async (project) => {
      try {
        const dep = await fetchLatestDeployment(env, project);
        if (!dep?.id) return;

        const latestId = dep.id;
        const statusRaw = s(dep.latest_stage?.status).toLowerCase();
        const status = statusRaw || "unknown";

        const prevJSON = await env.STATE.get(kvKey(project));
        const prev: KVState | null = prevJSON ? JSON.parse(prevJSON) : null;

        if (!prev) {
          // First observation
          if (NON_TERMINAL[status]) {
            await sendDiscordEmbed(env, startedEmbed(project, dep));
          } else if (TERMINAL[status]) {
            await sendDiscordEmbed(env, finishedEmbed(project, dep));
          }
          await env.STATE.put(kvKey(project), JSON.stringify({ id: latestId, status }));
          return;
        }

        if (latestId !== prev.id) {
          // New deployment
          if (NON_TERMINAL[status]) {
            await sendDiscordEmbed(env, startedEmbed(project, dep));
          } else if (TERMINAL[status]) {
            await sendDiscordEmbed(env, finishedEmbed(project, dep));
          }
          await env.STATE.put(kvKey(project), JSON.stringify({ id: latestId, status }));
          return;
        }

        // Same deployment id; check for transition to terminal
        if (TERMINAL[status] && !TERMINAL[prev.status]) {
          await sendDiscordEmbed(env, finishedEmbed(project, dep));
          await env.STATE.put(kvKey(project), JSON.stringify({ id: latestId, status }));
        }
      } catch (err) {
        console.error(`Project ${project}:`, (err as Error).message);
      }
    })
  );
}