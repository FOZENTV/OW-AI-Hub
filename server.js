/**
 * OW VOD Analyzer — Serveur Node.js pour Render.com
 * Variables d'environnement requises sur Render :
 *   GEMINI_API_KEY — ta clé API Gemini
 */

const express    = require("express");
const multer     = require("multer");
const cors       = require("cors");
const path       = require("path");
const fs         = require("fs");
const { GoogleGenAI } = require("@google/genai");

// ─────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────

const PORT         = process.env.PORT || 5000;
const GEMINI_MODEL = "gemini-3-flash-preview";
const POLL_INTERVAL_MS  = 3000;
const POLL_MAX_ATTEMPTS = 30;

// ─────────────────────────────────────────
//  HEROES — chargés depuis heroes.json
// ─────────────────────────────────────────

function loadHeroes() {
  const heroesPath = path.join(__dirname, "heroes.json");
  if (!fs.existsSync(heroesPath)) {
    console.warn("[!] heroes.json introuvable");
    return {};
  }
  const data = JSON.parse(fs.readFileSync(heroesPath, "utf-8"));
  const total = Object.values(data).reduce((acc, arr) => acc + arr.length, 0);
  console.log(`[✓] ${total} héros chargés depuis heroes.json`);
  return data;
}

const HEROES      = loadHeroes();
const HEROES_FLAT = Object.values(HEROES).flat();

// ─────────────────────────────────────────
//  PROMPT
// ─────────────────────────────────────────

function buildPrompt(hero, rank) {
  return `Tu es un coach Overwatch expert. Analyse cette VOD de gameplay Overwatch 2.

Le joueur joue ${hero} en ranked ${rank}.

Réponds UNIQUEMENT en JSON valide sans markdown ni backticks, avec cette structure :
{
  "summary": "résumé global du gameplay en 3-4 phrases, points forts et points faibles",
  "timestamps": [
    {
      "time": "MM:SS",
      "category": "death|mistake|good|positioning|ulti",
      "title": "titre court du moment",
      "description": "analyse détaillée de ce moment et conseil concret adapté au niveau ${rank}"
    }
  ],
  "priorities": ["priorité 1 à travailler", "priorité 2", "priorité 3"]
}

Identifie 6 à 10 moments clés importants. Sois précis, concret et adapté au niveau ${rank} sur ${hero}.`;
}

// ─────────────────────────────────────────
//  APP
// ─────────────────────────────────────────

const app    = express();
// Taille max upload : 2 Go
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Log toutes les requêtes entrantes
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

app.use(express.static(__dirname)); // sert ow_vod_analyzer.html

// Route de test pour vérifier que le serveur répond
app.get('/ping', (req, res) => res.json({ ok: true }));

// ── Routes ──────────────────────────────

app.get("/heroes", (req, res) => {
  res.json(HEROES_FLAT);
});

app.post("/analyze", upload.single("video"), async (req, res) => {
  const apiKey = (req.body.api_key || "").trim();
  const hero   = req.body.hero  || "Tracer";
  const rank   = req.body.rank  || "Diamant";
  const video  = req.file;

  // Validation
  if (!apiKey) return res.status(400).json({ error: "Clé API manquante" });
  if (!video)  return res.status(400).json({ error: "Vidéo manquante" });

  console.log('[ANALYZE] Requête reçue - hero:', hero, '| rank:', rank, '| fichier:', video?.originalname);
  console.log('[ANALYZE] api_key présente:', !!apiKey);

  try {
    const ai = new GoogleGenAI({ apiKey });

    // ── Upload de la vidéo en mémoire ────
    const sizeMb = (video.buffer.length / 1024 / 1024).toFixed(0);
    console.log(`[*] Upload de ${video.originalname} (${sizeMb} Mo) vers Gemini...`);

    const uploaded = await ai.files.upload({
      file: new Blob([video.buffer], { type: video.mimetype }),
      config: { mimeType: video.mimetype, displayName: video.originalname },
    });

    // ── Attendre ACTIVE ──────────────────
    console.log("[*] Traitement en cours...");
    let fileReady = false;
    for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
      const state = (await ai.files.get({ name: uploaded.name })).state;
      if (state === "ACTIVE") { fileReady = true; break; }
      if (state === "FAILED")
        return res.status(500).json({ error: "Traitement vidéo échoué côté Gemini" });
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }

    if (!fileReady)
      return res.status(500).json({ error: "Timeout — la vidéo met trop longtemps à traiter" });

    // ── Analyse ──────────────────────────
    console.log("[*] Analyse IA...");
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        { role: "user", parts: [
          { fileData: { fileUri: uploaded.uri, mimeType: video.mimetype } },
          { text: buildPrompt(hero, rank) },
        ]},
      ],
    });

    const raw    = response.text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);

    // ── Nettoyage ────────────────────────
    try { await ai.files.delete({ name: uploaded.name }); } catch {}

    console.log("[✓] Analyse terminée");
    return res.json(parsed);

  } catch (err) {
    if (err instanceof SyntaxError)
      return res.status(500).json({ error: "Réponse Gemini invalide (JSON mal formé), réessaie" });
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
//  START
// ─────────────────────────────────────────

app.listen(PORT, () => {
  console.log("=".repeat(50));
  console.log("  OW VOD Analyzer — Serveur Node.js");
  console.log(`  Port : ${PORT}`);
  console.log("=".repeat(50));
});
