export default {
  async fetch(request, env, ctx) {
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
      const formData = await request.formData();
      const api_key = formData.get("api_key");
      const hero = formData.get("hero") || "Tracer";
      const rank = formData.get("rank") || "Diamant";
      const video = formData.get("video");

      if (!api_key || !video) return json({ error: "Paramètres manquants" }, 400);

      const videoBuffer = await video.arrayBuffer();

      // Upload vers Gemini
      const uploadRes = await fetch(
        `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${api_key}`,
        {
          method: "POST",
          headers: {
            "X-Goog-Upload-Command": "start, upload, finalize",
            "X-Goog-Upload-Header-Content-Length": String(videoBuffer.byteLength),
            "X-Goog-Upload-Header-Content-Type": video.type,
            "Content-Type": video.type,
          },
          body: videoBuffer,
        }
      );

      if (!uploadRes.ok) {
        const e = await uploadRes.json().catch(() => ({}));
        return json({ error: e.error?.message || "Erreur upload" }, 500);
      }

      const uploadData = await uploadRes.json();
      const fileUri = uploadData.file?.uri;
      const fileName = uploadData.file?.name;

      // Attendre ACTIVE
      for (let i = 0; i < 30; i++) {
        await sleep(3000);
        const f = await (await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${api_key}`)).json();
        if (f.state === "ACTIVE") break;
        if (f.state === "FAILED") return json({ error: "Traitement vidéo échoué" }, 500);
      }

      // Analyse
      const prompt = `Tu es un coach Overwatch expert. Analyse cette VOD Overwatch 2. Le joueur joue ${hero} en ranked ${rank}. Réponds UNIQUEMENT en JSON valide sans markdown : {"summary":"résumé 3-4 phrases","timestamps":[{"time":"MM:SS","category":"death|mistake|good|positioning|ulti","title":"titre court","description":"analyse et conseil"}],"priorities":["priorité 1","priorité 2","priorité 3"]}. Identifie 6 à 10 moments clés.`;

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${api_key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ file_data: { mime_type: video.type, file_uri: fileUri } }, { text: prompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 4096 }
          })
        }
      );

      if (!res.ok) { const e = await res.json(); return json({ error: e.error?.message || "Erreur Gemini" }, 500); }
      const data = await res.json();
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return json(JSON.parse(raw.replace(/```json|```/g, "").trim()));

    } catch(err) { return json({ error: err.message }, 500); }
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
