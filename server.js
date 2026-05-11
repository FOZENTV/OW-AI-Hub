/**
 * OW VOD Analyzer — Serveur Node.js pour Render.com
 */

const express  = require("express");
const multer   = require("multer");
const cors     = require("cors");
const path     = require("path");
const fs       = require("fs");
const os       = require("os");
const { GoogleGenAI } = require("@google/genai");

// ─────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────

const PORT         = process.env.PORT || 5000;
const GEMINI_MODEL = "gemini-2.5-flash";
const POLL_MS      = 3000;
const POLL_MAX     = 30;

// ─────────────────────────────────────────
//  HEROES
// ─────────────────────────────────────────

function loadHeroes() {
  const p = path.join(__dirname, "heroes.json");
  if (!fs.existsSync(p)) { console.warn("[!] heroes.json introuvable"); return {}; }
  const data = JSON.parse(fs.readFileSync(p, "utf-8"));
  console.log(`[✓] ${Object.values(data).flat().length} héros chargés`);
  return data;
}

const HEROES      = loadHeroes();
const HEROES_FLAT = Object.values(HEROES).flat();

// ─────────────────────────────────────────
//  PROMPT
// ─────────────────────────────────────────

const RANK_CONTEXT = {
  "Bronze":        "Le joueur a des lacunes fondamentales : mécanique de base, awareness minimal, décisions hasardeuses.",
  "Argent":        "Le joueur comprend les bases mais manque de régularité et fait des erreurs d'habitude.",
  "Or":            "Niveau correct mais mauvaises décisions de positioning et de timing.",
  "Platine":       "Bon mécanisme mais manque d'impact, mauvais timing d'ulti.",
  "Diamant":       "Solide mécaniquement, erreurs surtout sur le macro-jeu et la prise de risque.",
  "Maître":        "Très bon niveau individuel, erreurs subtiles : resource management, cooldown tracking.",
  "Grand Maître":  "Quasi-optimal. Analyse les micro-décisions et l'adaptation aux matchups.",
  "Champion":      "Niveau élite. Analyse la position exacte, le timing, la lecture des ennemis.",
  "Top 500":       "Niveau professionnel. Identifie uniquement les erreurs les plus subtiles.",
};

const HERO_CONTEXT = {
  "Tracer":      "Flanker agressive. Analyser : gestion des recalls, blink usage, target prioritization, overextension.",
  "Genji":       "Flanker. Analyser : dash reset, ulti combo, engagement/disengage, blade targets.",
  "Widowmaker":  "Sniper. Analyser : angle selection, repositionnement après kill, headshots.",
  "Reinhardt":   "Tank anchor. Analyser : shield management, fire strike, charge decisions, shatter setup.",
  "Ana":         "Support sniper. Analyser : sleep dart sur ulti ennemis, nano boost timing, anti-heal.",
  "Mercy":       "Support. Analyser : GA mobility, rez timing, damage boost vs heal, pistol usage.",
  "Lucio":       "Support mobile. Analyser : speed vs heal switch, boop usage, sound barrier timing.",
  "Zarya":       "Tank off. Analyser : bubble timing, energy management, combo ulti.",
  "Moira":       "Support. Analyser : orb placement, fade usage, resource management, kill pressure.",
  "Kiriko":      "Support. Analyser : suzu timing, kunai precision, teleport usage, ult timing.",
  "Zenyatta":    "Support. Analyser : discord/harmony orb placement, positionnement safe, ulti defensif.",
  "D.Va":        "Tank mobile. Analyser : boosters usage, defense matrix timing, bomb setup, remech timing.",
  "Sigma":       "Tank. Analyser : flux timing, accretion precision, shield placement, ulti combo.",
  "Winston":     "Tank dive. Analyser : leap targets, barrier placement, primal rage usage, dive timing.",
};

function buildPrompt(hero, rank) {
    return `Tu es l'unité tactique "ARCHITECTE OW", coach Top 500. Analyse cette VOD de ${hero} au rang ${rank}.

STRICTE DISCIPLINE VISUELLE (ANTI-HALLUCINATION) :
1. ANALYSE DU TAB : Au début de la vidéo, identifie précisément les 5 héros ennemis. NE PARLE JAMAIS d'un héros qui n'est pas présent dans la partie (ex: ne parle pas de Zenyatta s'il n'est pas là).
2. VÉRIFICATION DU KILL FEED : Avant de noter une mort ou un kill, vérifie le journal en haut à droite.
3. LECTURE DU HUD : Regarde tes propres cooldowns en bas à droite pour confirmer si une capacité était réellement disponible ou non.

CADRE D'ANALYSE :
- FOCUS MÉCANIQUE : Analyse l'utilisation du kit de ${hero} (timing, précision, gestion des ressources).
- POSITIONNEMENT : Analyse les angles de tir et l'utilisation des couvertures naturelles.
- ERREURS DE RANG : Adapte la sévérité au niveau ${rank}.

RÉPONDS UNIQUEMENT EN JSON VALIDE :
{
  "summary": "Diagnostic global honnête basé uniquement sur ce qui est visible.",
  "timestamps": [
    {
      "time": "MM:SS",
      "category": "death|mistake|positioning|ulti|good",
      "title": "[ACTION] - Verdict",
      "description": "Analyse technique REELLEMENT visible à l'écran. Si rien de spécial ne se passe à ce timing, ne crée pas d'entrée bidon."
    }
  ],
  "priorities": [
    "Priorité 1 basée sur une erreur répétée dans la vidéo.",
    "Priorité 2",
    "Priorité 3"
  ]
}

IMPORTANT : Ne dépasse pas 6 à 8 moments si la vidéo est courte. Mieux vaut 4 moments vrais que 10 moments inventés. Sois froid et factuel.`;
  }

Identifie 7 à 12 moments clés significatifs.`;

// ─────────────────────────────────────────
//  APP
// ─────────────────────────────────────────

const app = express();

// Multer écrit sur disque temporaire (évite la limite RAM de Render)
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // 4 Go max
});

app.use(cors());
app.use(express.json());

// Log toutes les requêtes
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

app.use(express.static(__dirname));
app.get("/ping", (req, res) => res.json({ ok: true }));
app.get("/heroes", (req, res) => res.json(HEROES_FLAT));

// ─────────────────────────────────────────
//  ANALYZE
// ─────────────────────────────────────────

app.post("/analyze", upload.single("video"), async (req, res) => {
  const apiKey = (req.body?.api_key || "").trim();
  const hero   = req.body?.hero  || "Tracer";
  const rank   = req.body?.rank  || "Diamant";
  const video  = req.file;

  console.log(`[ANALYZE] hero=${hero} rank=${rank} fichier=${video?.originalname} apiKey=${!!apiKey}`);

  if (!apiKey) return res.status(400).json({ error: "Clé API manquante" });
  if (!video)  return res.status(400).json({ error: "Vidéo manquante" });

  const tmpPath = video.path;

  try {
    const ai = new GoogleGenAI({ apiKey });
    const sizeMb = (video.size / 1024 / 1024).toFixed(1);
    console.log(`[*] Upload vers Gemini (${sizeMb} Mo)…`);

    // Upload depuis le fichier temporaire sur disque
    const fileStream = fs.createReadStream(tmpPath);
    const uploaded = await ai.files.upload({
      file: fileStream,
      config: {
        mimeType: video.mimetype || "video/mp4",
        displayName: video.originalname,
      },
    });

    console.log(`[*] Fichier uploadé : ${uploaded.name}`);

    // Attendre ACTIVE
    let fileReady = false;
    for (let i = 0; i < POLL_MAX; i++) {
      const f = await ai.files.get({ name: uploaded.name });
      console.log(`[*] État : ${f.state}`);
      if (f.state === "ACTIVE") { fileReady = true; break; }
      if (f.state === "FAILED") return res.status(500).json({ error: "Traitement vidéo échoué" });
      await new Promise(r => setTimeout(r, POLL_MS));
    }

    if (!fileReady) return res.status(500).json({ error: "Timeout Gemini" });

    // Analyse
    console.log("[*] Génération…");
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [{
        role: "user",
        parts: [
          { fileData: { fileUri: uploaded.uri, mimeType: video.mimetype || "video/mp4" } },
          { text: buildPrompt(hero, rank) },
        ],
      }],
    });

    const raw    = response.text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);

    try { await ai.files.delete({ name: uploaded.name }); } catch {}

    console.log("[✓] Terminé");
    return res.json(parsed);

  } catch (err) {
    console.error("[ERR]", err.message);
    if (err instanceof SyntaxError)
      return res.status(500).json({ error: "JSON Gemini invalide, réessaie" });
    return res.status(500).json({ error: err.message });
  } finally {
    // Toujours supprimer le fichier temporaire
    fs.unlink(tmpPath, () => {});
  }
});

// ─────────────────────────────────────────
//  START
// ─────────────────────────────────────────

app.listen(PORT, () => {
  console.log("=".repeat(50));
  console.log(`  OW VOD Analyzer — Port ${PORT}`);
  console.log("=".repeat(50));
});
