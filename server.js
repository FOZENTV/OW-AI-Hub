/**
 * OW VOD Analyzer — Serveur Node.js pour Render.com
 */

const express = require("express");
const multer  = require("multer");
const cors    = require("cors");
const path    = require("path");
const fs      = require("fs");
const os      = require("os");
const { GoogleGenAI } = require("@google/genai");

// ─────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────

const PORT         = process.env.PORT || 5000;
const GEMINI_MODEL = "gemini-2.5-pro";
const POLL_MS      = 3000;
const POLL_MAX     = 30;

// ─────────────────────────────────────────
//  HEROES — chargés depuis heroes.json
// ─────────────────────────────────────────

function loadHeroes() {
  const p = path.join(__dirname, "heroes.json");
  if (!fs.existsSync(p)) {
    console.warn("[!] heroes.json introuvable");
    return {};
  }
  const data = JSON.parse(fs.readFileSync(p, "utf-8"));
  console.log(`[✓] ${Object.values(data).flat().length} héros chargés`);
  return data;
}

const HEROES = loadHeroes();

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

const HERO_ABILITIES = {
  "Tracer":       "Pulse Pistols (DPS courte portée), Blink x3 (dash directionnel), Recall (retour 3s en arrière + soin), Pulse Bomb (ulti : bombe collante). Analyser : usage des 3 Blinks sans tous les dépenser, Recall pour éviter la mort, ciblage des squishy, placement de la Pulse Bomb.",
  "Genji":        "Shurikens (rafale ou éventail), Swift Strike (dash reset si kill), Deflect (renvoie projectiles), Dragonblade (ulti : katana 6s). Analyser : reset du dash sur les kills, combo blade+Nano, Deflect préventif pas en panique.",
  "Widowmaker":   "Widow's Kiss (sniper chargeable), Grappling Hook (grappin, 12s CD), Venom Mine (révèle+empoisonne), Infra-Sight (ulti : vision des ennemis pour l'équipe). Analyser : angle selection, repositionnement après kill, chargement du tir avant exposition.",
  "Reinhardt":    "Rocket Hammer (mêlée arc 75dmg), Barrier (5000PV bouclier), Charge (pin au mur), Fire Strike x2 (traverse boucliers 100dmg), Earthshatter (ulti : stun devant). Analyser : shield management, Fire Strike pour charger l'ulti, Charge calculée, Shatter sur groupe au sol.",
  "Ana":          "Biotic Rifle (soigne alliés/blesse ennemis scope), Sleep Dart (endort+annule ultis), Biotic Grenade (soigne alliés+bloque soins ennemis 4s), Nano Boost (ulti : +50% dmg -50% dmg reçus). Analyser : Sleep sur les ultis ennemis, Grenade sur groupe, Nano sur le bon allié.",
  "Mercy":        "Caduceus Staff (heal 55/s ou +30% dmg), Guardian Angel (vol vers allié + Superjump), Resurrect (res 30s CD), Valkyrie (ulti : vol libre + beam chaîne). Analyser : Superjump pour imprévisibilité, damage boost sur DPS fort, Rez safe pas en combat.",
  "Lucio":        "Sonic Amplifier (projectiles + Boop knockback), Crossfade (aura Heal ou Speed), Amp It Up (amplifie aura 3s), Wall Ride (passif), Sound Barrier (ulti : gros bouclier temporaire équipe). Analyser : switch Speed/Heal selon situation, Boop pour pousser dans le vide, Sound Barrier AVANT les ultis ennemis.",
  "Zarya":        "Particle Cannon (beam haute énergie + grenades), Particle Barrier (bouclier sur soi → +énergie), Projected Barrier (bouclier sur allié → +énergie), Graviton Surge (ulti : aspire les ennemis). Analyser : buller au bon moment, garder >50% énergie, combo Graviton avec AoE (Hanzo/Reaper).",
  "Moira":        "Biotic Grasp (heal beam gauche / dmg droit, ressources séparées), Fade (dash invincible + recharge ressources), Biotic Orb (heal ou dmg rebondissant), Coalescence (ulti : rayon traverse barrières heal+dmg). Analyser : gestion ressources heal, Fade pas seulement en panique, Orb dmg pour recharger.",
  "Kiriko":       "Healing Ofuda (papiers de soin), Kunai (headshot x2.5), Swift Step (téléport vers allié à travers murs), Protection Suzu (invincibilité 0.85s + enlève debuffs), Kitsune Rush (ulti : boost speed/attack/CD équipe). Analyser : Suzu timing (contre Sleep/Anti/Shatter/Graviton), Swift Step pour escape ou heal derrière mur.",
  "Zenyatta":     "Orbes (tir normal ou x5 chargé), Orbe de Discord (cible prend +30% dmg), Orbe d'Harmonie (heal passif allié), Transcendance (ulti : invincible + gros heal zone). Analyser : Discord sur cible prioritaire, Harmony pas sur allié full HP, Transcendance CONTRE ultis AoE ennemis.",
  "D.Va":         "Fusion Cannons (DPS courte portée, réduit vitesse), Boosters (dash annule projectiles), Defense Matrix (absorbe projectiles ennemis), Micro Missiles (AoE), Self-Destruct (ulti : bombe massive) + Call Mech. Analyser : Defense Matrix sur gros projectiles (Pharah, Zarya Graviton), Boosters pour initier/escape, Self-Destruct espaces fermés.",
  "Sigma":        "Hypersphères x2 (rebondissent), Experimental Barrier (bouclier flottant repositionnable), Kinetic Grasp (absorbe projectiles → armure), Accretion (rocher stun), Gravitic Flux (ulti : soulève+écrase). Analyser : bouclier en projection pas devant soi, Kinetic Grasp contre AoE, Accretion sur cibles isolées.",
  "Winston":      "Tesla Cannon (dmg zone courte portée), Jump Pack (saut vers zone + dmg atterrissage), Barrier Projector (dôme 700PV), Primal Rage (ulti : grande forme, bonus PV, Jump reset, knockback). Analyser : cibler supports pas tanks, Barrier pour isoler une cible, Jump pour disengage si dive mal tourne.",
  "Roadhog":      "Scrap Gun (shotgun), Chain Hook (ramène ennemi pour combo), Take a Breather (350PV soin sur soi), Whole Hog (ulti : mitrailleuse + knockback). Analyser : combo Hook+headshot+mêlée = one-shot, ne pas hooker derrière bouclier allié, Take a Breather en couverture.",
  "Junker Queen": "Scattergun + Jagged Blade (couteau rappelable), Commanding Shout (PV temp + speed équipe), Carnage (hache + Wound = bleed), Rampage (ulti : charge + Wound + bloque soins). Analyser : Wound pour bloquer les soins ennemis, Shout avant poussée pas pendant, Rampage sur groupe dense.",
  "Ramattra":     "Forme Omnic : Void Accelerator + Void Barrier. Nemesis Form (mêlée, bras blocants). Ravenous Vortex (zone ralentit+attire vers le bas), Annihilation (ulti : aura dmg continu illimité si ennemis dans l'aura). Analyser : switch Nemesis pour tanker, Vortex contre ennemis qui sautent, Annihilation sur groupe groupé.",
  "Orisa":        "Augmented Fusion Driver (tir continu sans recharge), Energy Javelin (stun si contre mur), Fortify (invincible aux CC + réduction dmg), Javelin Spin (dévie projectiles + pousse), Terra Surge (ulti : explosion zone massive). Analyser : Javelin contre mur pour stun, Fortify contre Graviton/Shatter, Terra Surge sur groupe.",
  "Doomfist":     "Hand Cannon (shotgun), Rocket Punch (dash+punch, stun si mur), Seismic Slam (attire ennemis), Rising Uppercut (uppercut en l'air), Meteor Strike (ulti : saut+plonge zone). Analyser : Rocket Punch contre mur = stun + gros dmg, combo Uppercut+Slam+Punch, Empowered Punch pour maximiser.",
  "Wrecking Ball": "Grappling Claw (pivot grande vitesse), Roll (boule rapide), Piledriver (plonge → knockback), Adaptive Shield (bouclier croît avec nombre d'ennemis proches), Minefield (ulti : mines magnétiques). Analyser : Adaptive Shield au milieu des ennemis, Piledriver pour disperser, Minefield sur objectif.",
  "Hazard":       "Tank récent. Analyser : protection équipe, gestion de l'espace, décisions d'engagement, utilisation des capacités défensives/offensives.",
  "Mauga":        "Chainguns Ignis (enflamme) & Eos (soigne sur ennemis en feu), Cardiac Overdrive (zone semi-invincibilité équipe + soin sur dmg), Overrun (charge+knockback+saut), Cage Fight (ulti : arène, invincible dedans). Analyser : alterner les deux guns, Cardiac avant grosse poussée, Cage Fight sur groupe dense.",
  "Domina":       "Tank récente. Analyser : protection équipe, gestion de l'espace, décisions d'engagement.",
  "Hanzo":        "Storm Bow (chargeable headshot), Lunge (double saut latéral), Sonic Arrow (détecte ennemis), Storm Arrows x6 (rafale rapide non chargée), Dragonstrike (ulti : dragon traverse murs). Analyser : Sonic Arrow avant d'avancer dans un angle, Storm Arrows courte portée pour burst, Dragonstrike dans couloirs ou combo Graviton.",
  "Pharah":       "Rocket Launcher (impact+splash), Jump Jet (propulsion haut), Concussive Blast (knockback), Hover Jets (maintien en l'air), Barrage (ulti : pluie de roquettes). Analyser : rester en l'air, Concussive pour se propulser ou pousser dans le vide, combo avec Mercy, attention aux hitscan.",
  "Soldier: 76":  "Heavy Pulse Rifle (rafale auto), Sprint, Biotic Field (zone soin sol), Helix Rockets (roquette splash), Tactical Visor (ulti : auto-aim 6s). Analyser : Helix en combo avec tir normal, Biotic Field en couverture, Visor sur supports en priorité.",
  "Junkrat":      "Frag Launcher (grenades rebondissantes), Concussion Mine x2 (knockback manuel), Steel Trap (immobilise), RIP-Tire (ulti : pneu explosif télécommandé). Analyser : rebonds sur murs pour toucher derrière angles, Concussion Mine pour se propulser en hauteur, RIP-Tire dans couloirs.",
  "Reaper":       "Hellfire Shotguns (dmg massif courte portée), Shadow Step (téléport visible), Wraith Form (invincible+speed, pas de tir), The Reaping (passif : vole PV), Death Blossom (ulti : zone AoE 3s). Analyser : jamais à moyenne/longue portée, Wraith pour escape, Blossom dans espaces fermés combo Graviton.",
  "Cassidy":      "Peacekeeper (revolver précis ou fan the hammer), Combat Roll (recharge revolver), Magnetic Grenade (colle à l'ennemi), Deadeye (ulti : vise tous les ennemis visibles). Analyser : headshots tir simple, Grenade pour finir cible affaiblie, Deadeye sur cibles isolées loin des tanks.",
  "Ashe":         "The Viper (carabine hip ou ADS), Coach Gun (knockback + propulse Ashe), Dynamite (flammes persistantes), B.O.B. (ulti : robot allié qui charge+mitraille). Analyser : ADS longue portée, Coach Gun pour hauteur, Dynamite sur groupes/derrière angles, B.O.B. comme 7ème membre.",
  "Sombra":       "Machine Pistol (DPS courte portée), Hack (désactive capacités 1.5s), Translocator (beacon téléport), Opportunist (passif : voit ennemis <50%PV), EMP (ulti : hack zone + détruit boucliers). Analyser : Hack les supports en priorité, EMP avant poussée combo Graviton, Translocator pour escape.",
  "Symmetra":     "Photon Projector (beam montant en puissance + boules chargées), Sentry Turret x3 (ralentissent), Teleporter (téléport équipe), Photon Barrier (ulti : grand mur bouclier). Analyser : tourelles en hauteur/angles difficiles, Teleporter pour repositionnement rapide, Barrier pour bloquer ligne de vue.",
  "Torbjörn":     "Rivet Gun (précis ou courte portée) + Forge Hammer, Deploy Turret (niv2 auto), Molten Core (ulti : flaques de lave). Analyser : placement tourelle derrière couverture angle difficile, Molten Core pour contenir une poussée, réparer au marteau plutôt que redéployer.",
  "Mei":          "Endothermic Blaster (freeze progressif) + projectile longue portée, Cryo-Freeze (invincible+soin dans bloc de glace), Ice Wall (mur de piques), Blizzard (ulti : gèle+stun zone). Analyser : Cryo-Freeze pour survivre pas seulement fuir, Ice Wall pour couper une retraite, Blizzard combo Graviton, freeze+headshot = one-shot squishy.",
  "Echo":         "Tri-Shot x3, Sticky Bombs (bouquet adhésif), Focusing Beam (puissant sur cibles <50%PV), Glide+Flight (vol), Duplicate (ulti : copie ennemi avec capacités). Analyser : Focusing Beam UNIQUEMENT sous 50%, Duplicate bons héros (Roadhog, Zarya, Reaper), Sticky Bombs pour burst.",
  "Sojourn":      "Railgun (tir rapide charge jauge + tir chargé = one-shot plein), Power Slide (glissade + saut), Disruptor Shot (zone ralentit+dmg), Overclock (ulti : charge auto + perfore 8s). Analyser : utiliser tir chargé quand jauge pleine, Power Slide gap closer ou escape, Disruptor sur groupe.",
  "Venture":      "Smart Excavator (arc), Burrow (plonge sous terre), Drill Dash (dash perçant), Tectonic Shock (ulti : séisme zone). Analyser : Burrow pour approach/escape, Drill Dash engage ou disengage, Tectonic Shock sur groupe dans espace confiné.",
  "Freja":        "Damage récente. Analyser : positionnement, gestion des cooldowns, impact sur les teamfights, décisions d'engagement/disengage.",
  "Anran":        "Damage récent. Analyser : positionnement, gestion des cooldowns, impact sur les teamfights.",
  "Emre":         "Damage récent. Analyser : positionnement, gestion des cooldowns, impact sur les teamfights.",
  "Vendetta":     "Damage récent. Analyser : positionnement, gestion des cooldowns, impact sur les teamfights.",
  "Sierra":       "Damage (sortie avril 2026), cheffe sécurité Watchpoint Grand Mesa. Analyser : positionnement, gestion des cooldowns, impact sur les teamfights, engagement/disengage.",
  "Ana":          "Biotic Rifle (soigne alliés/blesse ennemis), Sleep Dart (endort+annule ultis), Biotic Grenade (soigne+bloque soins ennemis), Nano Boost (ulti : +50% dmg -50% dmg reçus). Analyser : Sleep sur les ultis ennemis, Grenade sur groupe, Nano sur bon allié.",
  "Baptiste":     "Biotic Launcher (tir 3 balles + grenades soin sol), Exo Boots (saut haut), Regenerative Burst (soin zone), Immortality Field (drone empêche la mort), Amplification Matrix (ulti : double dmg+soins des projectiles). Analyser : Immortality Field contre burst/ultis létaux, Matrix aligné avec DPS alliés.",
  "Brigitte":     "Rocket Flail (mêlée), Shield Bash (dash stun), Repair Pack (soin + armure temporaire si excès), Whip Shot (knockback longue portée), Rally (ulti : armure équipe + speed). Analyser : Shield Bash pour interrompre flankers, Repair Pack sur alliés en combat, Rally avant poussée.",
  "Illari":       "Solar Rifle (précis longue portée), Outburst (dash+knockback), Healing Pylon (tourelle soin), Captive Sun (ulti : orbe solaire explose les ennemis abîmés). Analyser : placement Pylon en hauteur angle difficile, Outburst pour escape, Captive Sun sur groupe.",
  "Juno":         "Support récente avec kit mobile. Analyser : mobilité, soutien équipe, timing des capacités.",
  "Lifeweaver":   "Thorn Volley (projectiles) + Healing Blossom (soin chargeable ciblé), Rejuvenating Dash (dash+soin soi), Life Grip (tire allié vers soi invincible), Petal Platform (plateforme monte), Tree of Life (ulti : arbre soin zone durable). Analyser : Life Grip sur allié en danger, Petal Platform pour créer hauteurs, Tree en soutien de poussée.",
  "Wuyang":       "Support récent. Analyser : positionnement, soutien équipe, gestion des cooldowns.",
  "Mizuki":       "Support récente. Analyser : positionnement, soutien équipe, gestion des cooldowns.",
  "Jetpack Cat":  "Support récent avec mobilité. Analyser : mobilité, soutien équipe, gestion des cooldowns.",
};

function buildPrompt(hero, rank) {
  const rankTips = RANK_CONTEXT[rank] || "Analyse le gameplay de façon adaptée au niveau du joueur.";
  const heroTips = HERO_ABILITIES[hero] || `Joue ${hero}. Analyse son kit : cooldowns, positionnement, gestion des ressources et impact sur le teamfight.`;

  return `Tu es un coach Overwatch 2 professionnel avec des années d'expérience en coaching ranked et compétitif.

CONTEXTE DU JOUEUR :
- Héros joué : ${hero}
- Rang : ${rank}
- Profil du rang : ${rankTips}

CAPACITÉS DU HÉROS (base-toi UNIQUEMENT sur ces infos, pas sur d'autres sources) :
${heroTips}

MISSION : Regarde attentivement cette VOD et fournis une analyse de coaching détaillée et actionnable.

RÈGLES ABSOLUES :
1. Utilise UNIQUEMENT les capacités listées ci-dessus pour ${hero} — ne mentionne pas d'autres capacités
2. Explique POURQUOI c'est une erreur ou un bon play, pas juste QUOI
3. Donne un conseil CONCRET applicable dès la prochaine partie
4. Adapte la profondeur et le vocabulaire au rang ${rank}
5. Sois direct et honnête, même si c'est critique

CATÉGORIES À UTILISER :
- death : mort évitable (mauvais positioning, overextension, mauvais timing)
- mistake : erreur sans mort (ulti gaspillé, cooldown raté, mauvaise cible)
- positioning : problème de placement ou d'angle
- ulti : gestion d'ulti (bon ou mauvais usage, timing, combo)
- good : bon moment à reproduire

Réponds UNIQUEMENT en JSON valide, sans markdown ni backticks :
{
  "summary": "Bilan global de 4-5 phrases : niveau général, points forts, axes d'amélioration prioritaires",
  "timestamps": [
    {
      "time": "MM:SS",
      "category": "death|mistake|positioning|ulti|good",
      "title": "Titre court et descriptif du moment",
      "description": "Ce qui s'est passé, pourquoi c'est bien/mal, conseil concret applicable"
    }
  ],
  "priorities": [
    "Point #1 le plus important avec conseil concret",
    "Point #2 avec conseil concret",
    "Point #3 avec conseil concret"
  ]
}

Identifie entre 7 et 12 moments clés significatifs. Qualité et précision avant quantité.`;
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
app.get("/heroes", (req, res) => res.json(HEROES));

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
    const mimeType = video.mimetype || "video/mp4";
    console.log(`[*] Upload vers Gemini (${(fs.statSync(tmpPath).size/1024/1024).toFixed(1)} Mo)…`);

    const uploaded = await ai.files.upload({
      file: tmpPath,
      config: {
        mimeType,
        displayName: video.originalname,
      },
    });

    console.log(`[*] Uploadé : ${uploaded.name}`);

    let fileReady = false;
    for (let i = 0; i < POLL_MAX; i++) {
      const f = await ai.files.get({ name: uploaded.name });
      console.log(`[*] État : ${f.state}`);
      if (f.state === "ACTIVE") { fileReady = true; break; }
      if (f.state === "FAILED") return res.status(500).json({ error: "Traitement vidéo échoué" });
      await new Promise(r => setTimeout(r, POLL_MS));
    }

    if (!fileReady) return res.status(500).json({ error: "Timeout Gemini" });

    console.log("[*] Génération…");
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [{
        role: "user",
        parts: [
          { fileData: { fileUri: uploaded.uri, mimeType } },
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
