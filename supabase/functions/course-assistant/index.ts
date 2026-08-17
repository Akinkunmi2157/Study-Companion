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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40000);

    let response: Response;
    try {
      response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            contents,
            generationConfig: {
              temperature: mode === "assessment" ? 0.15 : 0.35,
              maxOutputTokens: mode === "assessment" ? 3072 : 2048,
            },
          }),
        },
      );
    } finally {
      clearTimeout(timer);
    }

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("Gemini API error:", response.status, payload);
      return json(
        {
          error:
            payload?.error?.message ||
            `Gemini request failed with status ${response.status}.`,
        },
        response.status >= 400 && response.status < 600 ? response.status : 502,
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
