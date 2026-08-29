import { getStore, getDeployStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

const MAX_MESSAGES = 30;
const MAX_TOKENS = 2000;

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function cohortStore() {
  const opts = { name: "rifada-cohort", consistency: "strong" as const };
  return (Netlify as any).context?.deploy?.context === "production"
    ? getStore(opts)
    : getDeployStore(opts);
}

async function claude(req: Request) {
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);

  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== (req.headers.get("host") || ""))
        return reply({ error: "origin not allowed" }, 403);
    } catch {
      return reply({ error: "invalid origin" }, 403);
    }
  }

  const key = Netlify.env.get("ANTHROPIC_API_KEY");
  const base = Netlify.env.get("ANTHROPIC_BASE_URL") || "https://api.anthropic.com";
  if (!key)
    return reply(
      { error: "AI Gateway not active. Deploy to production once, then retry." },
      500
    );

  let body: any;
  try {
    body = await req.json();
  } catch {
    return reply({ error: "invalid JSON" }, 400);
  }

  const { messages, system, max_tokens } = body || {};
  if (!Array.isArray(messages) || messages.length === 0)
    return reply({ error: "messages required" }, 400);

  const payload: Record<string, unknown> = {
    model: Netlify.env.get("CLAUDE_MODEL") || "claude-haiku-4-5",
    max_tokens: Math.min(Number(max_tokens) || 800, MAX_TOKENS),
    messages: messages.slice(-MAX_MESSAGES).map((m: any) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content ?? "").slice(0, 8000),
    })),
  };
  if (typeof system === "string" && system.trim())
    payload.system = system.slice(0, 12000);

  try {
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });
    const data: any = await r.json();
    if (!r.ok)
      return reply(
        { error: data?.error?.message || `upstream error (${r.status})` },
        r.status
      );
    return reply(data);
  } catch (e: any) {
    return reply({ error: "gateway unreachable: " + e.message }, 502);
  }
}

async function cohort(req: Request) {
  const store = cohortStore();

  if (req.method === "GET") {
    try {
      const { blobs } = await store.list();
      const participants: any[] = [];
      for (const b of blobs) {
        const v = await store.get(b.key, { type: "json" });
        if (v && v.name) participants.push(v);
      }
      participants.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      return reply({ participants });
    } catch (e: any) {
      return reply({ error: "read failed: " + e.message }, 500);
    }
  }

  if (req.method === "POST") {
    let rec: any;
    try {
      rec = await req.json();
    } catch {
      return reply({ error: "invalid JSON" }, 400);
    }
    if (!rec?.uid || !rec?.name) return reply({ error: "uid and name required" }, 400);
    try {
      await store.setJSON(String(rec.uid).slice(0, 40), {
        uid: String(rec.uid).slice(0, 40),
        name: String(rec.name).slice(0, 40),
        ts: Number(rec.ts) || Date.now(),
        baseline: rec.baseline || null,
        modules: Array.isArray(rec.modules) ? rec.modules.slice(0, 10) : [],
        sim: rec.sim || null,
        badge: rec.badge ? String(rec.badge).slice(0, 40) : null,
      });
      return reply({ ok: true });
    } catch (e: any) {
      return reply({ error: "write failed: " + e.message }, 500);
    }
  }

  return reply({ error: "GET or POST only" }, 405);
}

export default async (req: Request, _context: Context) => {
  const path = new URL(req.url).pathname;
  if (path.endsWith("/claude")) return claude(req);
  if (path.endsWith("/cohort")) return cohort(req);
  return reply({ error: "unknown path" }, 404);
};

export const config: Config = { path: ["/api/claude", "/api/cohort"] };
