
/
index.ts


import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { GoogleGenAI } from "https://esm.sh/@google/genai";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

serve(async (req) => {
    // CORS Headers for browser requests
    if (req.method === "OPTIONS") {
        return new Response("ok", {
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
            },
        });
    }

    try {
        const { question, prompt, userCourses, chatHistory } = await req.json();
        const userQuestion = String(prompt || question || "").trim();
        if (!userQuestion) {
            return new Response(JSON.stringify({ error: "A question or prompt is required." }), {
                status: 400,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            });
        }

        // 1. Format user's registered courses into a clear system context
        const courseContext = userCourses && userCourses.length > 0
            ? userCourses.map((c: any) => `- ${c.title} (${c.code || 'N/A'}): ${c.description || 'No description'}`).join("\n")
            : "No specific courses registered yet.";

        const systemInstruction = `
You are an AI Academic Companion integrated into the Digital Study Companion app.
Your job is to clarify concepts and answer questions strictly tailored to the user's registered courses.

User's Enrolled Courses:
${courseContext}

Guidelines:
- Give clear, concise, and simple explanations suitable for a university student.
- Use bullet points or code snippets where necessary for clarity.
`;

        // 2. Build conversation contents for Gemini
        const contents = [
            ...(chatHistory || []).map((msg: any) => ({
                role: msg.role === "user" ? "user" : "model",
                parts: [{ text: msg.text }]
            })),
            { role: "user", parts: [{ text: userQuestion }] }
        ];

        // 3. Call Gemini API
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: contents,
            config: {
                systemInstruction: systemInstruction,
                temperature: 0.4,
            }
        });

        return new Response(JSON.stringify({ text: response.text }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
    } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
    }
});