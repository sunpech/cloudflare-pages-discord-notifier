/**
 * Cloudflare Pages → Discord Notifier
 * - Notifies when a deploy STARTS (first time we see a new deployment id)
 * - Notifies when that deploy FINISHES (status transitions to a terminal state)
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
  url?: string | null;
  environment?: "preview" | "production" | string;
  latest_stage?: { name?: StageName; status?: StageStatus } | null;
  stages?: Array<{ name?: StageName; status?: StageStatus }> | null;
  created_on?: string;
  is_skipped?: boolean;
  // ^ the Pages API can include more fields; we only pick what we need.
};

const API = "https://api.cloudflare.com/client/v4";

// Consider these “terminal” (finished) outcomes
const TERMINAL: Record<string, true> = {
  success: true,
  failed: true,
  canceled: true,
  error: true,
  skipped: true,
};

// Consider these “running / starting”
const NON_TERMINAL: Record<string, true> = {
  pending: true,
  active: true,
  in_progress: true,
  idle: true,
};

// Small helper: safe, exact string
const s = (x: unknown) => (typeof x === "string" ? x : "");

// Parse PROJECTS JSON from env
function getProjects(env: Env): string[] {
  try {
    const arr = JSON.parse(env.PROJECTS ?? "[]");
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// KV schema: we persist last-seen id + status per project
type KVState = { id: string; status: string };
const kvKey = (project: string) => `deploy:${project}`;

// Fetch the latest deployment object for a project
async function fetchLatestDeployment(env: Env, project: string): Promise<Deployment | null> {
  const url = `${API}/accounts/${env.ACCOUNT_ID}/pages/projects/${encodeURIComponent(project)}/deployments?per_page=1`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } });
  if (!r.ok) throw new Error(`Pages API ${r.status} for ${project}`);
  const data = await r.json();
  const dep = data?.result?.[0];
  return dep ?? null;
}

// Discord send
async function sendDiscord(env: Env, content: string) {
  const res = await fetch(env.DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  // Discord returns 204 on success
  if (!res.ok && res.status !== 204) {
    console.log("Discord webhook non-204:", res.status);
  }
}

function describe(dep: Deployment) {
  const status = s(dep.latest_stage?.status);
  const stage = s(dep.latest_stage?.name);
  const envName = s(dep.environment);
  const url = s(dep.url);
  return { status, stage, envName, url };
}

// Build nice Discord messages
function startedMessage(project: string, dep: Deployment) {
  const { envName, url, stage } = describe(dep);
  const bits = [
    "🚧 **Deploy STARTED**",
    `**${project}**`,
    envName ? `(${envName})` : "",
    stage ? `stage: \`${stage}\`` : "",
    url ? `\n${url}` : "",
  ].filter(Boolean);
  return bits.join(" ");
}

function finishedMessage(project: string, dep: Deployment) {
  const { status, envName, url } = describe(dep);
  const emoji = status === "success" ? "✅" : status === "skipped" ? "⏭️" : "❌";
  const statusText = status ? status.toUpperCase() : "DONE";
  const bits = [
    `${emoji} **Deploy ${statusText}**`,
    `**${project}**`,
    envName ? `(${envName})` : "",
    url ? `\n${url}` : "",
  ].filter(Boolean);
  return bits.join(" ");
}

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

  // Process projects in parallel
  await Promise.all(
    projects.map(async (project) => {
      try {
        const dep = await fetchLatestDeployment(env, project);
        if (!dep?.id) return;

        const latestId = dep.id;
        const { status: rawStatus } = describe(dep);
        const status = rawStatus.toLowerCase();

        // Load previous state
        const prevJSON = await env.STATE.get(kvKey(project));
        const prev: KVState | null = prevJSON ? JSON.parse(prevJSON) : null;

        // First time ever seeing this project
        if (!prev) {
          // If it's running, send "started"; if it's already finished, send the finished state
          if (NON_TERMINAL[status]) {
            await sendDiscord(env, startedMessage(project, dep));
          } else if (TERMINAL[status]) {
            await sendDiscord(env, finishedMessage(project, dep));
          }
          await env.STATE.put(kvKey(project), JSON.stringify({ id: latestId, status }));
          return;
        }

        // We have previous state
        if (latestId !== prev.id) {
          // New deployment detected → send STARTED if it's not terminal yet
          if (NON_TERMINAL[status]) {
            await sendDiscord(env, startedMessage(project, dep));
          } else if (TERMINAL[status]) {
            // Rare race: new deploy already finished by the time we poll → just send FINISHED
            await sendDiscord(env, finishedMessage(project, dep));
          }
          await env.STATE.put(kvKey(project), JSON.stringify({ id: latestId, status }));
          return;
        }

        // Same deployment id: check for transition to terminal
        if (TERMINAL[status] && !TERMINAL[prev.status]) {
          await sendDiscord(env, finishedMessage(project, dep));
          await env.STATE.put(kvKey(project), JSON.stringify({ id: latestId, status }));
          return;
        }

        // Otherwise: nothing to notify
      } catch (err) {
        console.error(`Project ${project}:`, (err as Error).message);
      }
    })
  );
}