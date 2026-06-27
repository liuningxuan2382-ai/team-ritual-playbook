/* ------------------------------------------------------------------ *
 *  /api/coach  —  Cloudflare Pages Function
 *
 *  This runs on the SERVER (Cloudflare's edge), not in the browser.
 *  That matters for two reasons the assignment cares about:
 *    1. The AI model is called here, so no key/credentials ever reach
 *       the user's browser.
 *    2. This is where we GATE usage to protect the free-tier budget.
 *
 *  Cost reality we're designing around:
 *    Workers AI free tier = ~10,000 neurons / day.
 *    One ~300-token Llama-3.1-8B answer ≈ a few hundred neurons.
 *    So the whole account only affords ~20-ish answers per day for free.
 *    => We cap max_tokens AND cap calls per day (global + per visitor).
 * ------------------------------------------------------------------ */

const MODEL = "@cf/meta/llama-3.1-8b-instruct"; // free-tier text model
const MAX_TOKENS = 300; // keep answers short -> fewer neurons -> cheaper
const DAILY_GLOBAL_CAP = 25; // protects the shared daily budget
const DAILY_IP_CAP = 8; // fairness per visitor

/* The playbook lives here too, so the model answers from IT, not the
   open web. This is "grounding" — the small-scale version of RAG. */
const PLAYBOOK = `
### Retrospective
Purpose: Give the team a safe, recurring space to inspect how they work and commit to a few concrete improvements.
When to use: End of a sprint, project, or milestone — and any time momentum or morale dips. The busier you are, the more you need it.
Agenda: 00:00 Set the stage (Prime Directive + safety check) | 00:05 Gather data via a Rose/Bud/Thorn board (silent first, then share) | 00:20 Generate insight (cluster cards, find themes) | 00:35 Decide what to do (1-3 actions, each with an owner + date) | 00:50 Close (appreciations + plus/delta on the retro)
Tips: Open with the Prime Directive (assume everyone did their best with what they knew). Timebox hard. Every action gets one owner and a date. Start next retro by checking last retro's actions. Rotate the facilitator.
Pitfalls: Blame spirals; vague ownerless actions; the loudest voice dominating; skipping it when busy.
Rose = a win. Bud = an idea/opportunity with potential. Thorn = a challenge or something that hurt.

### 1-on-1
Purpose: Build a trusting relationship with each report and create a reliable channel for blockers, growth, and how they're really doing. It is NOT a status meeting.
When to use: Weekly or biweekly with every direct report. Protect it — a canceled 1-on-1 sends a loud message.
Agenda: 00:00 Check in (how are you, really) | 00:05 Their topics (they drive) | 00:15 Growth & feedback (both directions) | 00:23 Priorities & alignment | 00:28 Actions & close
Tips: It's their meeting — let them own the agenda. Aim 70/30, they talk more. Ask open questions and sit with silence. Take notes and close the loop next week.
Pitfalls: Letting it decay into status reporting; canceling repeatedly; only meeting when something's wrong; doing most of the talking.

### Design Critique
Purpose: Surface diverse, structured feedback that makes the WORK better, anchored to the goals the presenter wants help with. Separate from approval or decisions.
When to use: At meaningful milestones, when a designer wants input, or before a big decision.
Agenda: 00:00 Frame (goal, constraints, what feedback you want) | 00:05 Present (walk the work, no selling) | 00:13 Silent review (note observations vs the goals) | 00:18 Feedback round (observations & questions, not prescriptions) | 00:38 Response & next steps
Tips: Critique the work, not the person. Ask what feedback the presenter wants, then stay on it. Anchor every comment to the stated goal. Use "I observe… / I wonder…" instead of "you should."
Pitfalls: Solutioning instead of observing; feedback unmoored from goals; the senior voice quietly deciding; turning critique into a decision meeting.
`.trim();

const SYSTEM = `You are the Facilitator Coach embedded in a Team Ritual Playbook used by new design managers.

Answer ONLY from the playbook below — it is your source of truth. Tie advice to a specific ritual and, where useful, a specific agenda step. If a question falls outside the playbook, you may add brief general facilitation best-practice, but say plainly that it's outside the playbook.

Be a calm, experienced coach. Keep answers short and usable in the moment — a few sentences, concrete, no preamble. Speak to the facilitator directly.

===== PLAYBOOK =====
${PLAYBOOK}
===== END PLAYBOOK =====`;

function today() {
  return new Date().toISOString().slice(0, 10); // UTC date, resets daily
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Increment a daily counter in KV; returns whether we're still under the cap.
async function bump(kv, key, cap) {
  const cur = parseInt((await kv.get(key)) || "0", 10);
  if (cur >= cap) return { ok: false, remaining: 0 };
  await kv.put(key, String(cur + 1), { expirationTtl: 172800 }); // ~2 days
  return { ok: true, remaining: cap - (cur + 1) };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // ---- the gate (only if the KV binding "RL" is configured) ----
    let remaining = null;
    if (env.RL) {
      const ip = request.headers.get("CF-Connecting-IP") || "anon";
      const d = today();

      const g = await bump(env.RL, `g:${d}`, DAILY_GLOBAL_CAP);
      if (!g.ok) {
        return json(
          { error: "The shared daily AI budget is used up. Try again tomorrow.", remaining: 0 },
          429
        );
      }
      const u = await bump(env.RL, `ip:${d}:${ip}`, DAILY_IP_CAP);
      if (!u.ok) {
        return json(
          { error: "You've reached today's question limit. Try again tomorrow.", remaining: 0 },
          429
        );
      }
      remaining = u.remaining;
    }

    // ---- build the prompt ----
    const body = await request.json().catch(() => ({}));
    const mode = body.mode === "recommend" ? "recommend" : "ask";
    let messages;

    if (mode === "recommend") {
      const situation = String(body.situation || "").slice(0, 500).trim();
      if (!situation) return json({ error: "Describe the situation first." }, 400);
      messages = [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content:
            `Situation: "${situation}"\n\n` +
            `Recommend the single best-fit ritual from the playbook. Reply exactly as:\n` +
            `Ritual: <name>\nWhy: <one line>\nFirst move: <one concrete action>\n` +
            `Backup: <other ritual + one line, only if relevant>`,
        },
      ];
    } else {
      const turns = Array.isArray(body.messages) ? body.messages.slice(-8) : [];
      const clean = turns
        .filter(
          (m) =>
            m &&
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string"
        )
        .map((m) => ({ role: m.role, content: m.content.slice(0, 1200) }));
      if (clean.length === 0) return json({ error: "Ask a question first." }, 400);
      messages = [{ role: "system", content: SYSTEM }, ...clean];
    }

    // ---- call Workers AI ----
    const ai = await env.AI.run(MODEL, {
      messages,
      max_tokens: MAX_TOKENS,
      temperature: 0.4,
    });
    const text = String((ai && ai.response) || "").trim();

    return json({ text: text || "(no answer)", remaining });
  } catch (e) {
    return json({ error: "Coach is unavailable right now. Try again in a moment." }, 500);
  }
}

// Reject non-POST so people can't trigger the model by loading the URL.
export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  return onRequestPost(context);
}
