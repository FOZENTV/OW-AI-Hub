/**
 * OW VOD Analyzer — Serveur Node.js pour Render.com
 * Features: Gemini 2.5 Pro, screenshots auto via ffmpeg, prompt amélioré
 */

const express  = require("express");
const multer   = require("multer");
const cors     = require("cors");
const path     = require("path");
const fs       = require("fs");
const os       = require("os");
const { execFile } = require("child_process");
const { GoogleGenAI } = require("@google/genai");

const PORT         = process.env.PORT || 5000;
const GEMINI_MODEL = "gemini-2.5-pro";
const POLL_MS      = 3000;
const POLL_MAX     = 40;

// ── HEROES ──────────────────────────────────────────────────────────────────

const HEROES = {
  "Damage": [
    "Anran","Ashe","Bastion","Cassidy","Echo","Emre","Freja",
    "Genji","Hanzo","Junkrat","Mei","Pharah","Reaper","Sierra",
    "Sojourn","Soldier: 76","Sombra","Symmetra","Torbjörn",
    "Tracer","Vendetta","Venture","Widowmaker"
  ].sort(),
  "Support": [
    "Ana","Baptiste","Brigitte","Illari","Jetpack Cat","Juno",
    "Kiriko","Lifeweaver","Lúcio","Mercy","Mizuki","Moira",
    "Wuyang","Zenyatta"
  ].sort(),
  "Tank": [
    "D.Va","Domina","Doomfist","Hazard","Junker Queen","Mauga",
    "Orisa","Ramattra","Reinhardt","Roadhog","Sigma","Winston",
    "Wrecking Ball","Zarya"
  ].sort(),
};

const HEROES_FLAT = Object.values(HEROES).flat();

// ── PROMPT ──────────────────────────────────────────────────────────────────

const RANK_CONTEXT = {
  "Bronze":       "Lacunes fondamentales : mécanique de base, awareness minimal, décisions hasardeuses. Focus sur les erreurs les plus impactantes.",
  "Argent":       "Comprend les bases mais manque de régularité. Erreurs répétitives d'habitude.",
  "Or":           "Niveau correct mais mauvaises décisions de positioning et timing.",
  "Platine":      "Bon mécanisme mais manque d'impact, mauvais timing d'ulti.",
  "Diamant":      "Solide mécaniquement. Erreurs surtout sur le macro-jeu et la prise de risque.",
  "Maître":       "Très bon niveau individuel. Erreurs subtiles : resource management, cooldown tracking.",
  "Grand Maître": "Quasi-optimal. Analyse les micro-décisions et l'adaptation aux matchups.",
};

const HERO_CONTEXT = {
  "Tracer":      "Flanker agressive. Focus : gestion recalls, blink usage, overextension, target prioritization, pulse bomb placement.",
  "Genji":       "Flanker. Focus : dash reset, ulti combo, engagement/disengage timing, blade targets prioritization.",
  "Widowmaker":  "Sniper. Focus : angle selection, repositionnement après kill, headshots consistency, grapple usage.",
  "Reinhardt":   "Tank anchor. Focus : shield management, fire strike usage, charge decisions, shatter setup.",
  "Ana":         "Support sniper. Focus : sleep dart sur ulti ennemis, nano boost timing, anti-heal placement.",
  "Mercy":       "Support. Focus : GA mobility, rez timing, damage boost vs heal decision, pistol usage.",
  "Lúcio":       "Support mobile. Focus : speed vs heal switch timing, boop usage, sound barrier timing.",
  "Zarya":       "Tank off. Focus : bubble timing sur alliés, energy management, combo ulti avec AoE.",
  "Moira":       "Support. Focus : orb placement, fade usage, resource orb management, kill pressure.",
  "Kiriko":      "Support. Focus : suzu timing (anti-CC/anti-ulti), kunai precision, teleport usage.",
  "Zenyatta":    "Support. Focus : discord/harmony orb placement, positionnement safe, ulti défensif.",
  "D.Va":        "Tank mobile. Focus : boosters usage, defense matrix timing, bomb setup, remech positioning.",
  "Sigma":       "Tank. Focus : flux timing, accretion precision, shield placement, ulti combo setup.",
  "Winston":     "Tank dive. Focus : leap targets, barrier placement, primal rage usage, dive/escape timing.",
  "Sombra":      "Flanker utility. Focus : hack targets priority, translocator placement, EMP timing, stealth usage.",
  "Genji":       "Flanker. Focus : dash reset on kills, deflect usage contre projectiles, ulti target priority.",
  "Reaper":      "Close-range DPS. Focus : wraith form escape timing, shadow step positioning, death blossom setup.",
  "Sojourn":     "DPS hybrid. Focus : charged railgun usage, slide pour repositionnement, ulti gestion.",
};

function buildPrompt(hero, rank) {
  const rankCtx = RANK_CONTEXT[rank] || "Adapte l'analyse au niveau du joueur.";
  const heroCtx = HERO_CONTEXT[hero] || `Héros ${hero}. Analyse son kit : cooldowns, positionnement, ressources et impact teamfight.`;

  return `Tu es un coach Overwatch 2 professionnel de haut niveau. Ton rôle est d'analyser cette VOD et fournir un coaching précis, actionnable et adapté.

═══ CONTEXTE ═══
Héros joué : ${hero}
Rang actuel : ${rank}
Profil rang : ${rankCtx}
Focus héros : ${heroCtx}

═══ MISSION ═══
Analyse cette VOD avec l'œil d'un coach professionnel. Pour chaque moment identifié :
1. Décris PRÉCISÉMENT ce qui se passe (persos impliqués, situation, décision prise)
2. Explique POURQUOI c'est une erreur ou un bon play (cause profonde, pas juste le symptôme)
3. Donne UN conseil CONCRET et immédiatement applicable

═══ PRIORITÉS D'ANALYSE ═══
- Décisions à fort impact (fights gagnés/perdus, picks importants)
- Gestion des ressources (ulti, cooldowns, PV)
- Positionnement et angles
- Timing d'engagement et de désengagement
- Gestion des situations de 1v1 et trades

═══ CATÉGORIES ═══
- "death"       : mort évitable (surextension, mauvais positioning, mauvais recall)
- "mistake"     : erreur sans mort (ulti gaspillé, mauvaise cible, cooldown raté)
- "positioning" : problème de placement, angle, distance de combat
- "ulti"        : gestion d'ulti (bon ou mauvais timing, mauvaise cible)
- "good"        : bon moment à identifier, comprendre et reproduire

═══ FORMAT DE RÉPONSE ═══
Réponds UNIQUEMENT en JSON valide, sans markdown ni backticks. Timestamps au format MM:SS.

{
  "summary": "Bilan global de 5-6 phrases : niveau général observé, principaux points forts, axes d'amélioration prioritaires, pattern récurrent identifié",
  "timestamps": [
    {
      "time": "MM:SS",
      "category": "death|mistake|positioning|ulti|good",
      "title": "Titre court et précis",
      "description": "Description détaillée : situation exacte, décision prise, pourquoi c'est bien ou mal, conseil concret et applicable"
    }
  ],
  "priorities": [
    "Point #1 le plus impactant avec conseil concret et exercice possible",
    "Point #2 avec conseil concret",
    "Point #3 avec conseil concret"
  ]
}

Identifie entre 8 et 14 moments clés significatifs, répartis sur toute la durée de la VOD.`;
}

// ── FFMPEG SCREENSHOT ────────────────────────────────────────────────────────

function extractFrame(videoPath, timeStr, outputPath) {
  return new Promise((resolve) => {
    // Convertir MM:SS en secondes
    const parts = timeStr.split(":").map(Number);
    const secs = parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0];
    execFile("ffmpeg", [
      "-ss", String(secs),
      "-i", videoPath,
      "-frames:v", "1",
      "-q:v", "3",
      "-y",
      outputPath
    ], { timeout: 15000 }, (err) => {
      if (err) { console.warn(`[!] ffmpeg erreur pour ${timeStr}:`, err.message); resolve(null); }
      else resolve(outputPath);
    });
  });
}

// ── APP ──────────────────────────────────────────────────────────────────────

const app = express();
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json());
app.use((req, res, next) => { console.log(`[REQ] ${req.method} ${req.path}`); next(); });
app.use(express.static(__dirname));

app.get("/ping",   (req, res) => res.json({ ok: true, model: GEMINI_MODEL }));
app.get("/heroes", (req, res) => res.json(HEROES));

// ── ANALYZE ──────────────────────────────────────────────────────────────────

app.post("/analyze", upload.single("video"), async (req, res) => {
  const apiKey = (req.body?.api_key || "").trim();
  const hero   = req.body?.hero  || "Tracer";
  const rank   = req.body?.rank  || "Diamant";
  const video  = req.file;

  console.log(`[ANALYZE] hero=${hero} rank=${rank} fichier=${video?.originalname}`);

  if (!apiKey) return res.status(400).json({ error: "Clé API manquante" });
  if (!video)  return res.status(400).json({ error: "Vidéo manquante" });

  const tmpPath      = video.path;
  const screenshotsDir = path.join(os.tmpdir(), `screenshots_${Date.now()}`);
  fs.mkdirSync(screenshotsDir, { recursive: true });

  try {
    const ai = new GoogleGenAI({ apiKey });
    const sizeMb = (video.size / 1024 / 1024).toFixed(1);
    console.log(`[*] Upload vers Gemini (${sizeMb} Mo)…`);

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
      console.log(`[*] État : ${f.state} (${i * POLL_MS / 1000}s)`);
      if (f.state === "ACTIVE") { fileReady = true; break; }
      if (f.state === "FAILED") return res.status(500).json({ error: "Traitement vidéo échoué par Gemini" });
      await new Promise(r => setTimeout(r, POLL_MS));
    }

    if (!fileReady) return res.status(500).json({ error: "Timeout — Gemini n'a pas traité la vidéo à temps" });

    // Analyse
    console.log("[*] Analyse avec", GEMINI_MODEL, "…");
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [{
        role: "user",
        parts: [
          { fileData: { fileUri: uploaded.uri, mimeType: video.mimetype || "video/mp4" } },
          { text: buildPrompt(hero, rank) },
        ],
      }],
      config: { temperature: 0.3, maxOutputTokens: 8192 },
    });

    const raw = response.text.replace(/```json|```/g, "").trim();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch(e) { return res.status(500).json({ error: "JSON Gemini invalide, réessaie" }); }

    // Nettoyage Gemini
    try { await ai.files.delete({ name: uploaded.name }); } catch {}

    // Extraire les screenshots pour chaque timestamp
    console.log("[*] Extraction des screenshots…");
    const screenshotPromises = (parsed.timestamps || []).map(async (ts, i) => {
      const outPath = path.join(screenshotsDir, `frame_${i}.jpg`);
      const result = await extractFrame(tmpPath, ts.time, outPath);
      if (result && fs.existsSync(outPath)) {
        const imgData = fs.readFileSync(outPath);
        ts.screenshot = "data:image/jpeg;base64," + imgData.toString("base64");
        fs.unlinkSync(outPath);
      }
    });
    await Promise.all(screenshotPromises);

    console.log("[✓] Analyse terminée");
    return res.json(parsed);

  } catch (err) {
    console.error("[ERR]", err.message);
    return res.status(500).json({ error: err.message });
  } finally {
    fs.unlink(tmpPath, () => {});
    fs.rm(screenshotsDir, { recursive: true, force: true }, () => {});
  }
});

// ── START ────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log("=".repeat(50));
  console.log(`  OW VOD Analyzer — Port ${PORT} — ${GEMINI_MODEL}`);
  console.log("=".repeat(50));
});
server.timeout = 900000; // 15 minutes
