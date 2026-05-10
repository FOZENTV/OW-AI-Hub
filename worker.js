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

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const body = await request.json();
      const { api_key, hero, rank, file_uri, mime_type } = body;

      if (!api_key || !file_uri) {
        return json({ error: "Clé API ou URI fichier manquante" }, 400);
      }

      const prompt = `Tu es un coach Overwatch expert. Analyse cette VOD de gameplay Overwatch 2.
Le joueur joue ${hero} en ranked ${rank}.
Réponds UNIQUEMENT en JSON valide sans markdown ni backticks :
{
  "summary": "résumé global en 3-4 phrases",
  "timestamps": [
    {
      "time": "MM:SS",
      "category": "death|mistake|good|positioning|ulti",
      "title": "titre court",
      "description": "analyse détaillée et conseil concret"
    }
  ],
  "priorities": ["priorité 1", "priorité 2", "priorité 3"]
}
Identifie 6 à 10 moments clés. Sois précis et adapté au niveau ${rank} sur ${hero}.`;

      const analyzeRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${api_key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              parts: [
                { file_data: { mime_type, file_uri } },
                { text: prompt }
              ]
            }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 4096 }
          })
        }
      );

      if (!analyzeRes.ok) {
        const err = await analyzeRes.json();
        return json({ error: err.error?.message || "Erreur analyse" }, 500);
      }

      const analyzeData = await analyzeRes.json();
      const raw = analyzeData.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const clean = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);

      return json(parsed);

    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    }
  });
}
