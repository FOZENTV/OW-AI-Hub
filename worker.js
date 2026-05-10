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
      const formData = await request.formData();
      const apiKey = formData.get("api_key");
      const hero = formData.get("hero") || "Tracer";
      const rank = formData.get("rank") || "Diamant";
      const video = formData.get("video");

      if (!apiKey || !video) {
        return json({ error: "Clé API ou vidéo manquante" }, 400);
      }

      // Upload vers Gemini Files API
      const videoBuffer = await video.arrayBuffer();
      const uploadRes = await fetch(
        `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
        {
          method: "POST",
          headers: {
            "X-Goog-Upload-Command": "start, upload, finalize",
            "X-Goog-Upload-Header-Content-Length": videoBuffer.byteLength,
            "X-Goog-Upload-Header-Content-Type": video.type,
            "Content-Type": video.type,
          },
          body: videoBuffer,
        }
      );

      if (!uploadRes.ok) {
        const err = await uploadRes.json();
        return json({ error: err.error?.message || "Erreur upload" }, 500);
      }

      const uploadData = await uploadRes.json();
      const fileUri = uploadData.file?.uri;
      const fileName = uploadData.file?.name;

      // Attendre que le fichier soit prêt
      for (let i = 0; i < 20; i++) {
        await sleep(3000);
        const fileRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`
        );
        const fileData = await fileRes.json();
        if (fileData.state === "ACTIVE") break;
        if (fileData.state === "FAILED") return json({ error: "Traitement vidéo échoué" }, 500);
      }

      // Analyse avec Gemini
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
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              parts: [
                { file_data: { mime_type: video.type, file_uri: fileUri } },
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

      // Nettoyage
      try {
        await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`, { method: "DELETE" });
      } catch {}

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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
