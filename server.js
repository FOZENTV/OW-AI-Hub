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
const GEMINI_MODEL  = "gemini-3-flash-preview";
const POLL_MS       = 3000;
const POLL_MAX      = 30;
const MAX_MB_GEMINI = 380; // limite safe avant les 400 Mo Gemini

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
//  COMPRESSION FFMPEG
// ─────────────────────────────────────────

function compress(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    // CRF 28 = bonne qualité visuelle, taille réduite
    // scale 1280:-2 = max 720p (suffisant pour l'analyse IA)
    execFile("ffmpeg", [
      "-i", inputPath,
      "-vf", "scale=1280:-2",
      "-c:v", "libx264",
      "-crf", "28",
      "-preset", "fast",
      "-c:a", "aac",
      "-b:a", "96k",
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ], (err, stdout, stderr) => {
      if (err) reject(new Error("FFmpeg échoué : " + stderr));
      else resolve();
    });
  });
}

// ─────────────────────────────────────────
//  PROMPT
// ─────────────────────────────────────────

const RANK_CONTEXT = {
  "Bronze":       "Lacunes fondamentales : mécanique de base, awareness minimal, décisions hasardeuses.",
  "Argent":       "Comprend les bases mais manque de régularité et fait des erreurs d'habitude.",
  "Or":           "Niveau correct mais mauvaises décisions de positioning et de timing.",
  "Platine":      "Bon mécanisme mais manque d'impact, mauvais timing d'ulti.",
  "Diamant":      "Solide mécaniquement, erreurs surtout sur le macro-jeu et la prise de risque.",
  "Maître":       "Très bon niveau individuel, erreurs subtiles : resource management, cooldown tracking.",
  "Grand Maître": "Quasi-optimal. Analyse les micro-décisions et l'adaptation aux matchups.",
  "Champion":     "Niveau élite. Analyse la position exacte, le timing, la lecture des ennemis.",
  "Top 500":      "Niveau professionnel. Identifie uniquement les erreurs les plus subtiles.",
};

const HERO_CONTEXT = {
  "Tracer":       "Flanker agressive. Analyser : gestion des 3 Blinks (ne pas tous les dépenser), Recall pour éviter la mort ou récupérer de la vie, ciblage des squishy en priorité, placement de la Pulse Bomb (coller à l'ennemi, pas jeter au sol).",
  "Genji":        "Flanker. Analyser : reset du Swift Strike sur les kills, combo Dragonblade+Nano Boost, Deflect préventif pas en panique, engagement/disengage, ciblage des supports.",
  "Widowmaker":   "Sniper. Analyser : sélection d'angle (hauteur, lignes de fuite), repositionnement après chaque kill, chargement du tir avant exposition, headshots vs body shots.",
  "Reinhardt":    "Tank anchor. Analyser : shield management (5000 PV, ne pas le garder levé inutilement), Fire Strike pour harceler et charger l'ulti, Charge calculée (ne pas charger seul), setup Earthshatter (ennemis groupés au sol).",
  "Ana":          "Support sniper. Analyser : Sleep Dart sur les ultis ennemis (Reinhardt charge, Genji blade), Biotic Grenade sur plusieurs cibles, Nano Boost sur le bon allié (Genji, Reaper, Soldier), positionnement safe.",
  "Mercy":        "Support. Analyser : Superjump (sauter+GA pour hauteur imprévisible), damage boost sur DPS fort plutôt que heal constant, timing du Rez (moment safe, pas en plein combat).",
  "Lucio":        "Support mobile. Analyser : switch Speed/Heal au bon moment, Boop pour pousser dans le vide ou interrompre un ulti, Sound Barrier AVANT les ultis ennemis.",
  "Zarya":        "Tank off. Analyser : buller au bon moment (quand un ennemi vise, pas après), garder >50% énergie, combo Graviton Surge avec Hanzo Dragon ou Reaper Blossom.",
  "Moira":        "Support. Analyser : gestion ressources heal (ne pas gaspiller), Fade pas seulement en panique mais aussi pour recharger, Orb dmg pour harceler et recharger.",
  "Kiriko":       "Support. Analyser : Suzu timing (contre Sleep, Anti-Nade, Earthshatter, Graviton), Swift Step pour escape ou soigner un allié derrière un mur, Kunai headshots pour pression.",
  "Zenyatta":     "Support. Analyser : Discord sur la cible prioritaire, Harmony pas sur allié full HP, Transcendance CONTRE les ultis AoE ennemis (Reaper, Moira), positionnement safe.",
  "D.Va":         "Tank mobile. Analyser : Defense Matrix sur gros projectiles (Pharah, Graviton), Boosters pour initier ou escape, Self-Destruct dans espaces fermés.",
  "Sigma":        "Tank. Analyser : placement du bouclier en projection, Kinetic Grasp contre les ultis AoE, Accretion sur cibles isolées, Gravitic Flux combo avec alliés.",
  "Winston":      "Tank dive. Analyser : cibler supports en priorité pas les tanks, Barrier pour isoler une cible, Jump Pack pour disengage si dive tourne mal.",
  "Roadhog":      "Tank. Analyser : combo Hook+headshot+mêlée = one-shot squishy, ne pas hooker derrière bouclier allié, Take a Breather en couverture.",
  "Junker Queen": "Tank aggressive. Analyser : Wound pour bloquer les soins ennemis, Commanding Shout avant poussée pas pendant, Rampage sur groupe dense.",
  "Ramattra":     "Tank. Analyser : switch Nemesis Form pour tanker ou dmg mêlée, Ravenous Vortex contre ennemis qui sautent, Annihilation sur groupe groupé.",
  "Orisa":        "Tank. Analyser : Energy Javelin contre un mur pour le stun, Fortify contre Graviton/Earthshatter, Javelin Spin pour dévier projectiles, Terra Surge sur groupe.",
  "Doomfist":     "Tank dive. Analyser : Rocket Punch contre mur = stun+gros dmg, combo Uppercut+Slam+Punch, Empowered Punch pour maximiser.",
  "Wrecking Ball":"Tank. Analyser : Adaptive Shield au milieu des ennemis, Piledriver pour disperser, Minefield sur objectif.",
  "Mauga":        "Tank. Analyser : alterner les deux mitrailleuses (enflammer puis soigner), Cardiac Overdrive avant grosse poussée, Cage Fight sur groupe dense.",
  "Hazard":       "Tank récent. Analyser : protection équipe, gestion de l'espace, décisions d'engagement.",
  "Domina":       "Tank récente. Analyser : protection équipe, gestion de l'espace, décisions d'engagement.",
  "Hanzo":        "Damage. Analyser : Sonic Arrow avant d'avancer dans un angle, Storm Arrows courte portée pour burst, Dragonstrike dans couloirs ou combo Graviton.",
  "Pharah":       "Damage aerial. Analyser : rester en l'air, Concussive pour se propulser ou pousser dans le vide, combo avec Mercy, attention aux hitscan.",
  "Soldier: 76":  "Damage. Analyser : Helix Rockets en combo avec tir normal, Biotic Field en couverture, Tactical Visor sur supports en priorité.",
  "Junkrat":      "Damage. Analyser : rebonds des grenades sur les murs, Concussion Mine pour se propulser en hauteur, RIP-Tire dans couloirs.",
  "Reaper":       "Flanker. Analyser : jamais à moyenne/longue portée, Wraith Form pour escape, Death Blossom dans espaces fermés combo Graviton.",
  "Cassidy":      "Damage. Analyser : headshots tir simple, Magnetic Grenade pour finir cible affaiblie, Deadeye sur cibles isolées loin des tanks.",
  "Ashe":         "Damage. Analyser : ADS longue portée, Coach Gun pour hauteur, Dynamite sur groupes/angles, B.O.B. comme 7ème membre.",
  "Sombra":       "Disrupteur. Analyser : Hack les supports en priorité, EMP avant poussée combo Graviton, Translocator pour escape.",
  "Symmetra":     "Damage utilitaire. Analyser : tourelles en hauteur/angles difficiles, Teleporter pour repositionnement rapide, Photon Barrier pour bloquer ligne de vue.",
  "Torbjörn":     "Damage défensif. Analyser : placement tourelle derrière couverture angle difficile, Molten Core pour contenir une poussée.",
  "Mei":          "Damage contrôle. Analyser : Cryo-Freeze pour survivre pas seulement fuir, Ice Wall pour couper une retraite, Blizzard combo Graviton, freeze+headshot = one-shot squishy.",
  "Echo":         "Damage flexible. Analyser : Focusing Beam UNIQUEMENT sous 50% PV, Duplicate les bons héros, Sticky Bombs pour burst.",
  "Sojourn":      "Damage sniper mobile. Analyser : tir chargé quand jauge pleine, Power Slide gap closer ou escape, Disruptor Shot sur groupe.",
  "Venture":      "Damage. Analyser : Burrow pour approach/escape, Drill Dash engage ou disengage, Tectonic Shock sur groupe.",
  "Genji":        "Flanker. Analyser : reset Swift Strike sur kills, combo blade+Nano, Deflect préventif.",
  "Freja":        "Damage récente. Analyser : positionnement, gestion des cooldowns, impact sur les teamfights.",
  "Anran":        "Damage récent. Analyser : positionnement, gestion des cooldowns, impact sur les teamfights.",
  "Emre":         "Damage récent. Analyser : positionnement, gestion des cooldowns, impact sur les teamfights.",
  "Vendetta":     "Damage récent. Analyser : positionnement, gestion des cooldowns, impact sur les teamfights.",
  "Sierra":       "Damage (sortie avril 2026). Analyser : positionnement, gestion des cooldowns, impact sur les teamfights.",
  "Ana":          "Support sniper. Analyser : Sleep Dart sur ultis ennemis, Biotic Grenade sur groupe, Nano Boost sur bon allié.",
  "Baptiste":     "Support. Analyser : Immortality Field contre burst/ultis létaux, Amplification Matrix aligné avec DPS alliés, Exo Boots pour hauteur.",
  "Brigitte":     "Support bruiser. Analyser : Shield Bash pour interrompre flankers, Repair Pack sur alliés en combat, Rally avant poussée.",
  "Illari":       "Support. Analyser : placement Healing Pylon en hauteur/angle difficile, Outburst pour escape, Captive Sun sur groupe.",
  "Juno":         "Support mobile. Analyser : mobilité, soutien équipe, timing des capacités.",
  "Lifeweaver":   "Support. Analyser : Life Grip sur allié en danger (pas sur quelqu'un qui joue bien), Petal Platform pour créer hauteurs, Tree of Life en soutien de poussée.",
  "Wuyang":       "Support récent. Analyser : positionnement, soutien équipe, gestion des cooldowns.",
  "Mizuki":       "Support récente. Analyser : positionnement, soutien équipe, gestion des cooldowns.",
  "Jetpack Cat":  "Support récent. Analyser : mobilité, soutien équipe, gestion des cooldowns.",
};

function buildPrompt(hero, rank) {
  const rankTips = RANK_CONTEXT[rank] || "Analyse le gameplay de façon adaptée au niveau du joueur.";
  const heroTips = HERO_CONTEXT[hero] || `Joue ${hero}. Analyse son kit : cooldowns, positionnement, gestion des ressources et impact sur le teamfight.`;

  return `Tu es ECHO-COACH, une IA experte en analyse tactique Overwatch 2.

CONTEXTE :
- Héros analysé : ${hero} (${rank})
- Profil du rang : ${rankTips}
- Spécificités du héros : ${heroTips}

ÉTAPE 1 — LECTURE VIDÉO OBLIGATOIRE
Regarde la vidéo entière AVANT de répondre. Lis l'horodatage visible à l'écran à chaque moment important. Ne JAMAIS inventer un timestamp — si tu n'es pas sûr du temps exact, indique "~MM:SS".

ÉTAPE 2 — CE QUE TU DOIS OBSERVER CONCRÈTEMENT
Pour chaque moment que tu rapportes, tu dois avoir réellement vu dans la vidéo :
- L'action exacte du joueur (mouvement, compétence utilisée, cible visée)
- L'état des cooldowns visibles à l'écran
- La position du joueur par rapport aux ennemis et aux alliés
- Le résultat immédiat (kill, mort, teamfight gagné/perdu)

RÈGLE ABSOLUE : Si tu n'as pas réellement vu quelque chose dans la vidéo, ne le mentionne pas. Moins de timestamps mais vrais vaut mieux que beaucoup d'inventés.

CATÉGORIES :
- death : mort que tu as vue — décris exactement comment elle s'est produite
- mistake : erreur que tu as vue — quel CD raté, quelle mauvaise cible
- positioning : mauvais placement que tu as vu — où était le joueur, où il aurait dû être
- ulti : usage d'ulti que tu as vu — quand, sur combien d'ennemis, quel résultat
- good : bon play que tu as vu — ce qui était bien et pourquoi

Réponds UNIQUEMENT en JSON valide, sans markdown ni backticks :
{
  "summary": "Diagnostic basé sur ce que tu as réellement observé : niveau constaté, patterns récurrents, point fort dominant, erreur la plus fréquente",
  "timestamps": [
    {
      "time": "MM:SS",
      "category": "death|mistake|positioning|ulti|good",
      "title": "Action concrète observée à ce moment",
      "description": "Décris exactement ce que tu as vu : l'action, le contexte, pourquoi c'est bien ou mal, conseil concret. Jargon si pertinent : LoS, Peel, Off-angle, Dry Fight, C9, Stagger."
    }
  ],
  "priorities": [
    "🔧 Priorité mécanique : basée sur les erreurs répétées observées",
    "🧠 Priorité tactique : basée sur les patterns de décision observés",
    "⚔️ Conseil matchup : basé sur les adversaires réellement vus dans la vidéo"
  ]
}

Identifie 6 à 12 moments clés que tu as RÉELLEMENT observés. Qualité et honnêteté avant quantité.`;
}

// ─────────────────────────────────────────
//  APP
// ─────────────────────────────────────────

const app = express();

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

app.use(express.static(__dirname));
app.get("/ping",   (req, res) => res.json({ ok: true }));
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
  let   toUpload = tmpPath; // chemin du fichier à envoyer (original ou compressé)
  let   compressed = false;

  try {
    const sizeMb = fs.statSync(tmpPath).size / 1024 / 1024;
    console.log(`[*] Taille reçue : ${sizeMb.toFixed(1)} Mo`);

    // ── Compression si > 380 Mo ──────────
    if (sizeMb > MAX_MB_GEMINI) {
      const compressedPath = tmpPath + "_compressed.mp4";
      console.log(`[*] Compression FFmpeg (${sizeMb.toFixed(0)} Mo → cible <380 Mo)…`);
      try {
        await compress(tmpPath, compressedPath);
        const newSize = fs.statSync(compressedPath).size / 1024 / 1024;
        console.log(`[*] Après compression : ${newSize.toFixed(1)} Mo`);
        toUpload = compressedPath;
        compressed = true;
      } catch (ffmpegErr) {
        console.warn(`[!] FFmpeg indisponible, on tente quand même : ${ffmpegErr.message}`);
      }
    }

    // ── Upload vers Gemini ───────────────
    const ai = new GoogleGenAI({ apiKey });
    console.log(`[*] Upload vers Gemini…`);

    // Upload via REST API (stream sans charger en RAM)
    const fileSize = fs.statSync(toUpload).size;
    console.log(`[*] Upload vers Gemini (${(fileSize/1024/1024).toFixed(1)} Mo)…`);

    // Étape 1 : initier l'upload resumable
    const initRes = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=resumable&key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(fileSize),
          "X-Goog-Upload-Header-Content-Type": "video/mp4",
        },
        body: JSON.stringify({ file: { display_name: video.originalname || "vod.mp4" } }),
      }
    );
    if (!initRes.ok) {
      const err = await initRes.json();
      throw new Error(err.error?.message || "Erreur init upload Gemini");
    }
    const uploadUrl = initRes.headers.get("x-goog-upload-url");
    if (!uploadUrl) throw new Error("URL upload Gemini introuvable");

    // Étape 2 : streamer le fichier
    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Length": String(fileSize),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
      },
      body: fs.createReadStream(toUpload),
      duplex: "half",
    });
    if (!uploadRes.ok) {
      const err = await uploadRes.json();
      throw new Error(err.error?.message || "Erreur upload Gemini");
    }
    const uploadData = await uploadRes.json();
    const uploaded = { name: uploadData.file.name, uri: uploadData.file.uri };

    console.log(`[*] Uploadé : ${uploaded.name}`);

    // ── Attendre ACTIVE ──────────────────
    let fileReady = false;
    for (let i = 0; i < POLL_MAX; i++) {
      const pollRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${uploaded.name}?key=${apiKey}`
      );
      const fileInfo = await pollRes.json();
      const state = fileInfo.state || fileInfo.file?.state;
      console.log(`[*] État : ${state}`);
      if (state === "ACTIVE") { fileReady = true; break; }
      if (state === "FAILED") return res.status(500).json({ error: "Traitement vidéo échoué" });
      await new Promise(r => setTimeout(r, POLL_MS));
    }

    if (!fileReady) return res.status(500).json({ error: "Timeout Gemini" });

    // ── Génération ───────────────────────
    console.log("[*] Analyse IA…");
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [{
        role: "user",
        parts: [
          { fileData: { fileUri: uploaded.uri, mimeType: "video/mp4" } },
          { text: buildPrompt(hero, rank) },
        ],
      }],
    });

    const raw    = response.text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);

    try {
      await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${uploaded.name}?key=${apiKey}`,
        { method: "DELETE" }
      );
    } catch {}

    console.log("[✓] Terminé");
    return res.json(parsed);

  } catch (err) {
    console.error("[ERR]", err.message);
    if (err instanceof SyntaxError)
      return res.status(500).json({ error: "JSON Gemini invalide, réessaie" });
    return res.status(500).json({ error: err.message });
  } finally {
    fs.unlink(tmpPath, () => {});
    if (compressed) fs.unlink(toUpload, () => {});
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
