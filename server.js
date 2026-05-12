/**
 * OW VOD Analyzer — Serveur Node.js pour Render.com
 */

const express  = require("express");
const multer   = require("multer");
const cors     = require("cors");
const path     = require("path");
const fs       = require("fs");
const os       = require("os");
const { execFile } = require("child_process");
const { GoogleGenAI } = require("@google/genai");

// ─────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────

const PORT          = process.env.PORT || 5000;
const GEMINI_MODEL  = "gemini-2.5-flash";
const POLL_MS       = 3000;
const POLL_MAX      = 30;
const MAX_MB_GEMINI = 380;

// ─────────────────────────────────────────
//  COMPRESSION FFMPEG
// ─────────────────────────────────────────

function compress(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", [
      "-i", inputPath,
      "-vf", "scale=1280:-2",
      "-c:v", "libx264",
      "-crf", "28",
      "-preset", "fast",
      "-c:a", "aac",
      "-b:a", "96k",
      "-movflags", "+faststart",
      "-y", outputPath,
    ], (err, stdout, stderr) => {
      if (err) reject(new Error("FFmpeg échoué : " + stderr));
      else resolve();
    });
  });
}

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

function buildPrompt(hero, rank, enemyComp) {
  const rankTips  = RANK_CONTEXT[rank] || "Analyse le gameplay de façon adaptée au niveau du joueur.";
  const heroTips  = HERO_CONTEXT[hero] || `Joue ${hero}. Analyse son kit : cooldowns, positionnement, gestion des ressources et impact sur le teamfight.`;
  const enemyLine = enemyComp
    ? `- Héros ennemis (fournis par le joueur) : ${enemyComp}`
    : "- Héros ennemis : identifie-les uniquement si tu les vois clairement dans la vidéo, sinon écris 'inconnu'";

  return `Tu es ECHO-COACH, une IA experte en analyse tactique Overwatch 2.

CONTEXTE DE LA PARTIE :
- Héros du joueur : ${hero} (${rank})
- Profil du rang : ${rankTips}
${enemyLine}
- Spécificités du héros : ${heroTips}

RÈGLES ABSOLUES — lire avant d'analyser :
1. Ne mentionne JAMAIS un héros qui n'est pas dans la liste ci-dessus
2. Ne mentionne JAMAIS une capacité qui n'appartient pas à ${hero}
3. Chaque timestamp doit correspondre à un moment que tu as réellement vu dans la vidéo
4. Lis l'horodatage à l'écran — si tu n'es pas sûr, écris "~MM:SS"

════════════════════════════════════════
PHASE 1 — OBSERVATION (obligatoire avant tout)
════════════════════════════════════════
Avant d'analyser, tu DOIS identifier ces éléments en regardant la vidéo :
- La map et le mode de jeu visible à l'écran
- Les héros ENNEMIS présents (lis leurs noms dans le kill feed ou sur les modèles 3D)
- Les héros ALLIÉS présents
- La durée totale de la vidéo (lis l'horodatage à la fin)
- Le score ou l'état de la partie

NE MENTIONNE JAMAIS un héros que tu n'as pas vu dans la vidéo.
NE MENTIONNE JAMAIS un moment à un timestamp si tu n'as pas vu l'horodatage à l'écran.

════════════════════════════════════════
PHASE 2 — ANALYSE DES MOMENTS CLÉS
════════════════════════════════════════
Pour chaque moment que tu rapportes :
✓ Tu as vu l'horodatage à l'écran (MM:SS visible dans le coin)
✓ Tu décris l'action exacte du joueur (pas une hypothèse)
✓ Tu nommes uniquement des héros présents dans la partie
✓ Tu décris le résultat concret visible dans la vidéo

CATÉGORIES :
- death : tu as vu le joueur mourir — décris par qui et comment
- mistake : tu as vu une erreur concrète — quel CD, quelle mauvaise cible
- positioning : tu as vu un mauvais placement — où était-il, où aurait-il dû être
- ulti : tu as vu un ulti utilisé — sur combien d'ennemis, quel résultat visible
- good : tu as vu un bon play — décris ce qui s'est passé

Réponds UNIQUEMENT en JSON valide, sans markdown ni backticks :
{
  "summary": "Commence par : 'Sur cette VOD [map] en [mode], le joueur joue [hero] contre [héros ennemis observés]...' puis bilan : niveau constaté, pattern dominant, point fort, erreur principale",
  "timestamps": [
    {
      "time": "MM:SS",
      "category": "death|mistake|positioning|ulti|good",
      "title": "Action concrète et précise observée",
      "description": "Ce que tu as réellement vu : action du joueur, contexte (quels ennemis, quelle situation), résultat visible, conseil concret. Nomme uniquement les héros présents dans la partie."
    }
  ],
  "priorities": [
    "🔧 Priorité mécanique : basée sur les erreurs répétées observées dans cette VOD",
    "🧠 Priorité tactique : basée sur les patterns de décision vus dans cette VOD",
    "⚔️ Conseil matchup : basé sur les héros ennemis réellement présents dans cette VOD"
  ]
}

Identifie 5 à 10 moments. Si tu n'es pas certain d'un timestamp, écris '~MM:SS'. Moins de moments mais vrais vaut mieux que beaucoup d'inventés.`;
}

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
  const apiKey    = (req.body?.api_key    || "").trim();
  const hero      = req.body?.hero        || "Tracer";
  const rank      = req.body?.rank        || "Diamant";
  const enemyComp = (req.body?.enemy_comp || "").trim();
  const video     = req.file;

  console.log(`[ANALYZE] hero=${hero} rank=${rank} fichier=${video?.originalname}`);

  if (!apiKey) return res.status(400).json({ error: "Clé API manquante" });
  if (!video)  return res.status(400).json({ error: "Vidéo manquante" });

  const tmpPath  = video.path;
  const frameDir = tmpPath + "_frames";

  try {
    const ai = new GoogleGenAI({ apiKey });

    // ── Étape 1 : extraire 1 frame/seconde avec FFmpeg ──
    fs.mkdirSync(frameDir, { recursive: true });
    console.log(`[*] Extraction des frames…`);

    await new Promise((resolve, reject) => {
      execFile("ffmpeg", [
        "-i", tmpPath,
        "-vf", "fps=1,scale=1280:-2",   // 1 frame/sec, max 720p
        "-q:v", "3",                     // qualité JPEG (1=best, 31=worst)
        "-f", "image2",
        path.join(frameDir, "frame_%04d.jpg"),
        "-y",
      ], (err, stdout, stderr) => {
        if (err) reject(new Error("FFmpeg frames échoué : " + stderr.slice(-300)));
        else resolve();
      });
    });

    // ── Étape 2 : lire toutes les frames ──
    const frameFiles = fs.readdirSync(frameDir)
      .filter(f => f.endsWith(".jpg"))
      .sort();

    console.log(`[*] ${frameFiles.length} frames extraites`);

    if (frameFiles.length === 0)
      return res.status(500).json({ error: "Aucune frame extraite" });

    // ── Étape 3 : construire les parts Gemini ──
    // Chaque frame = 1 image inline + son timestamp en texte
    const parts = [];

    for (let i = 0; i < frameFiles.length; i++) {
      const sec     = i + 1;
      const mm      = String(Math.floor(sec / 60)).padStart(2, "0");
      const ss      = String(sec % 60).padStart(2, "0");
      const ts      = `${mm}:${ss}`;
      const imgPath = path.join(frameDir, frameFiles[i]);
      const imgData = fs.readFileSync(imgPath).toString("base64");

      parts.push({ text: `[${ts}]` });
      parts.push({
        inlineData: {
          mimeType: "image/jpeg",
          data: imgData,
        },
      });
    }

    // Prompt en dernier
    parts.push({ text: buildPrompt(hero, rank, enemyComp) });

    // ── Étape 4 : appel Gemini ──
    console.log(`[*] Envoi à Gemini (${frameFiles.length} frames)…`);
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [{ role: "user", parts }],
    });

    const raw    = response.text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);

    console.log("[✓] Terminé");
    return res.json(parsed);

  } catch (err) {
    console.error("[ERR]", err.message);
    if (err instanceof SyntaxError)
      return res.status(500).json({ error: "JSON Gemini invalide, réessaie" });
    return res.status(500).json({ error: err.message });
  } finally {
    // Nettoyage
    fs.unlink(tmpPath, () => {});
    if (fs.existsSync(frameDir))
      fs.rmSync(frameDir, { recursive: true, force: true });
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
