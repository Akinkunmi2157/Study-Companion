// Supabase Edge Function: supabase/functions/gemini-chat/index.ts
// Required secret:
//   supabase secrets set GEMINI_API_KEY=your_key_here
//
// Keep JWT verification enabled for this function so only signed-in users can call it.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ChatMessage = {
  role?: "user" | "assistant" | "model";
  text?: string;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function cleanText(value: unknown, max = 60000) {
  return String(value ?? "").trim().slice(0, max);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Gemini returns 429 (rate limited) or 503 (model overloaded / "high demand")
// for conditions that are almost always transient and resolve within seconds.
// Retry those specific statuses with a short exponential backoff before
// giving up. Everything else (400s like a bad/retired model name, 401/403
// auth issues, etc.) fails immediately, since retrying those just wastes
// 40s of the student's time on an error that will never change.
const RETRYABLE_STATUSES = new Set([429, 503]);
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    return json({ error: "GEMINI_API_KEY is not configured on the server." }, 500);
  }

  try {
    const body = await req.json();
    const prompt = cleanText(body?.prompt, 80000);
    const mode = cleanText(body?.mode, 30);
    const resourceTitle = cleanText(body?.resourceTitle, 500);
    const resourceContext = cleanText(body?.resourceContext, 60000);
    // "resource" = the student explicitly wants the answer grounded in the
    // uploaded resource (e.g. "based on this resource, what is..."); the
    // client only sets this when the student's message actually references
    // the resource/document. "general" (the default) means the tutor should
    // answer like a normal knowledgeable tutor, using its own subject
    // knowledge, with the resource content available only as background
    // context on what the student is currently studying — not a hard limit.
    const groundingMode = cleanText(body?.groundingMode, 20) || "general";
    const chatHistory: ChatMessage[] = Array.isArray(body?.chatHistory)
      ? body.chatHistory.slice(-12)
      : [];

    if (!prompt) {
      return json({ error: "A prompt is required." }, 400);
    }

    const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];

    if (mode === "tutor") {
      const useResourceStrictly = groundingMode === "resource" && Boolean(resourceContext);

      const tutorInstruction = useResourceStrictly
        ? [
            "You are the AI academic tutor inside Digital Study Companion.",
            "The student is asking specifically about the study resource below, so ground your answer primarily in it.",
            "You may draw on general subject knowledge to explain or clarify, but if a detail isn't supported by the resource, say so explicitly rather than presenting it as coming from the resource.",
            "Be concise, clear, and instructional.",
            resourceTitle ? `RESOURCE TITLE: ${resourceTitle}` : "",
            `RESOURCE CONTENT:\n${resourceContext}`,
          ].filter(Boolean).join("\n\n")
        : [
            "You are the AI academic tutor inside Digital Study Companion.",
            "Answer as a normal, knowledgeable tutor would: use your general subject-matter knowledge freely to explain concepts, answer questions, and help the student learn — you are not limited to the resource below.",
            resourceTitle ? `For background, the student currently has this resource open: "${resourceTitle}".` : "",
            resourceContext
              ? `The following is that resource's content, provided only as background context on the topic the student is studying. Treat it as optional context, not a constraint on your answer:\n${resourceContext}`
              : "",
            "If the student explicitly asks you to answer based on this resource/document (e.g. \"based on this resource...\", \"according to the document...\"), then focus specifically on that resource's content for that answer instead.",
            "Be concise, clear, and instructional.",
          ].filter(Boolean).join("\n\n");

      contents.push({
        role: "user",
        parts: [{ text: tutorInstruction }],
      });
      contents.push({
        role: "model",
        parts: [{
          text: useResourceStrictly
            ? "Understood. I will ground my answer in the supplied study resource."
            : "Understood. I will answer as a knowledgeable tutor, using the resource only as background context unless asked to focus on it specifically.",
        }],
      });

      for (const item of chatHistory) {
        const text = cleanText(item?.text, 5000);
        if (!text) continue;
        contents.push({
          role: item?.role === "assistant" || item?.role === "model" ? "model" : "user",
          parts: [{ text }],
        });
      }
    }

    contents.push({
      role: "user",
      parts: [{ text: prompt }],
    });

    // Gemini deprecates/retires specific model snapshots over time — Google
    // returns a 404 with an "... is no longer available ..." message when
    // that happens (rather than a clean version-negotiation error), so this
    // model id occasionally needs to be bumped. If you start seeing 404s
    // from this fetch again, check the error body Gemini returns for the
    // model name it now recommends and update GEMINI_MODEL below.
    const GEMINI_MODEL = "gemini-3.6-flash";
    const GEMINI_URL =
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

    const requestBody = JSON.stringify({
      contents,
      generationConfig: {
        temperature: mode === "assessment" ? 0.15 : 0.35,
        maxOutputTokens: mode === "assessment" ? 3072 : 2048,
      },
    });

    let response: Response | undefined;
    let payload: any = {};

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 40000);

      try {
        response = await fetch(GEMINI_URL, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: requestBody,
        });
      } finally {
        clearTimeout(timer);
      }

      payload = await response.json().catch(() => ({}));

      if (response.ok) break;

      const isRetryable = RETRYABLE_STATUSES.has(response.status);
      const isLastAttempt = attempt === MAX_ATTEMPTS;

      console.error(
        `Gemini API error (attempt ${attempt}/${MAX_ATTEMPTS}):`,
        response.status,
        payload,
      );

      if (!isRetryable || isLastAttempt) break;

      // Exponential backoff: 500ms, 1000ms, ... plus a little jitter so
      // concurrent requests from multiple students don't retry in lockstep.
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 200;
      await sleep(delay);
    }

    if (!response || !response.ok) {
      const status = response?.status ?? 502;
      return json(
        {
          error:
            payload?.error?.message ||
            `Gemini request failed with status ${status}.`,
        },
        status >= 400 && status < 600 ? status : 502,
      );
    }

    const text = payload?.candidates?.[0]?.content?.parts
      ?.map((part: { text?: string }) => part?.text || "")
      .join("")
      .trim();

    if (!text) {
      console.error("Gemini returned no text:", payload);
      return json({ error: "Gemini returned an empty response." }, 502);
    }

    return json({ text });
  } catch (error) {
    console.error("gemini-chat function failed:", error);
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    return json({ error: message }, 500);
  }
});
