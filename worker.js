export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        }
      });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    try {
      const { api_key, hero, rank, file_uri, mime_type } = await request.json();
      if (!api_key || !file_uri) return json({ error: "Paramètres manquants" }, 400);
      const prompt = `Tu es un coach Overwatch expert. Analyse cette VOD Overwatch 2. Le joueur joue ${hero} en ranked ${rank}. Réponds UNIQUEMENT en JSON valide sans markdown : {"summary":"résumé 3-4 phrases","timestamps":[{"time":"MM:SS","category":"death|mistake|good|positioning|ulti","title":"titre court","description":"analyse et conseil"}],"priorities":["priorité 1","priorité 2","priorité 3"]}. Identifie 6 à 10 moments clés.`;
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${api_key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ file_data: { mime_type, file_uri } }, { text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 4096 } })
      });
      if (!res.ok) { const e = await res.json(); return json({ error: e.error?.message || "Erreur Gemini" }, 500); }
      const data = await res.json();
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return json(JSON.parse(raw.replace(/```json|```/g, "").trim()));
    } catch(err) { return json({ error: err.message }, 500); }
  }
};
function json(data, status=200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
}
