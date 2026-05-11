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
const GEMINI_MODEL = "gemini-2.5-pro";
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

const HERO_ABILITIES = {
  "Tracer": `Rôle : Damage (Flanker)
Capacités :
- Arme : Pulse Pistols (DPS élevé à courte portée, 2 chargeurs de 40)
- Shift : Blink (dash rapide dans la direction visée, 3 charges, recharge ~3s chacune)
- E : Recall (retour en arrière de 3 secondes dans le temps, restaure la vie et les munitions)
- Ulti : Pulse Bomb (bombe collante à dépose manuelle, gros dégâts de zone)
Points d'analyse : timing des Blinks (ne pas tous les utiliser d'un coup), Recall pour éviter la mort ou récupérer de la vie, ciblage des cibles isolées/squishy, gestion des munitions, placement de la Pulse Bomb (coller à un ennemi, pas jeter au sol).`,

  "Genji": `Rôle : Damage (Flanker)
Capacités :
- Arme : Shurikens (3 en rafale ou éventail, + katana en mêlée)
- Shift : Swift Strike (dash vers la cible, reset si kill ou assist)
- E : Deflect (renvoie les projectiles, bloque les tirs frontaux)
- Ulti : Dragonblade (katana pendant 6s, Swift Strike reset à chaque kill)
Points d'analyse : reset du dash sur les kills, combo Dragonblade avec Nano Boost d'Ana, usage du Deflect (pas en panique mais préventif), engagement/disengage, ciblage des supports en priorité.`,

  "Widowmaker": `Rôle : Damage (Sniper)
Capacités :
- Arme : Widow's Kiss (sniper chargeable, ou mitrailleuse en mode ADS non chargé)
- Shift : Grappling Hook (grappin vers une surface, recharge 12s)
- E : Venom Mine (mine au sol, révèle et empoisonne les ennemis)
- Ulti : Infra-Sight (vision de tous les ennemis à travers les murs pour toute l'équipe)
Points d'analyse : sélection d'angle (hauteur, lignes de fuite), repositionnement après chaque kill pour ne pas être prévisible, chargement du tir avant d'exposer la tête, headshots vs body shots, usage du grappin pour l'escape.`,

  "Reinhardt": `Rôle : Tank (Anchor)
Capacités :
- Arme : Rocket Hammer (mêlée large, 75 dégâts, frappe en arc)
- Shift : Charge (sprint vers l'avant, pin le premier ennemi touché contre un mur)
- E : Fire Strike (projectile en ligne qui traverse les boucliers, 100 dégâts, 2 charges)
- Capacité passive : Steadfast (réduit les knockbacks)
- Ulti : Earthshatter (frappe au sol, stun tous les ennemis devant lui)
Points d'analyse : gestion du bouclier (5000 PV, ne pas le garder levé inutilement), Fire Strike pour harceler et charger l'ulti, Charge calculée (ne pas charger seul), setup Earthshatter (attendre que les ennemis soient groupés et non en hauteur).`,

  "Ana": `Rôle : Support (Sniper)
Capacités :
- Arme : Biotic Rifle (soigne les alliés, blesse les ennemis à distance, scope dispo)
- Shift : Sleep Dart (endort un ennemi, annule les ultis en cours)
- E : Biotic Grenade (zone qui soigne les alliés et bloque les soins ennemis 4s)
- Ulti : Nano Boost (boost un allié : +50% dégâts, -50% dégâts reçus)
Points d'analyse : Sleep Dart sur les ultis ennemis (Reinhardt qui charge, Roadhog qui hook, Genji en blade), Biotic Grenade sur plusieurs cibles en même temps, Nano Boost sur le bon allié (Genji blade, Reaper, Soldier), positionnement safe en hauteur, ne pas soigner des alliés à pleine vie.`,

  "Mercy": `Rôle : Support
Capacités :
- Arme : Caduceus Staff (heal beam 55/s ou damage boost beam +30% dégâts) + Pistol
- Shift : Guardian Angel (vol vers un allié ciblé, momentum conservable avec Superjump)
- E : Resurrect (res un allié mort, 30s cooldown)
- Ulti : Valkyrie (vol libre, beam en chaîne, res sans canal, durée 20s)
Points d'analyse : Superjump (sauter + GA pour gagner de la hauteur et être imprévisible), priorité damage boost sur les gros DPS plutôt que heal constant, timing du Rez (pas en plein combat, attendre un moment safe), pistol usage quand les alliés sont en sécurité.`,

  "Lucio": `Rôle : Support (Mobile)
Capacités :
- Arme : Sonic Amplifier (projectiles en rafale + Boop knockback)
- Shift : Crossfade (switch entre Heal Aura et Speed Aura pour toute l'équipe)
- E : Amp It Up (amplifie l'aura active pendant 3s)
- Capacité passive : Wall Ride (courir sur les murs)
- Ulti : Sound Barrier (bouclier temporaire massif pour toute l'équipe)
Points d'analyse : switch Speed/Heal au bon moment (Speed pour s'approcher d'un objectif, Heal en teamfight), Boop pour pousser les ennemis dans le vide ou interrompre un ulti, Sound Barrier AVANT les ultis ennemis (pas après), utilisation du Wall Ride pour rester en mouvement constant.`,

  "Zarya": `Rôle : Tank (Off-tank)
Capacités :
- Arme : Particle Cannon (beam court à haute énergie + grenades à charge)
- Shift : Particle Barrier (bouclier sur soi-même, absorbe les dégâts = +énergie)
- E : Projected Barrier (bouclier sur un allié, même effet)
- Ulti : Graviton Surge (blackhole qui aspire les ennemis)
Points d'analyse : buller au bon moment (quand un ennemi vise, pas après avoir pris les dégâts), gérer l'énergie (rester au-dessus de 50% en combat), combo Graviton Surge avec Hanzo Dragon, Reaper Death Blossom ou autre ulti de zone, buller les alliés qui vont prendre des gros dégâts (Reinhardt qui charge, allié ciblé par Roadhog).`,

  "Moira": `Rôle : Support
Capacités :
- Arme : Biotic Grasp (heal beam continu en main gauche consommant des ressources, ou damage orbe consommant des ressources différentes)
- Shift : Fade (dash rapide, invincibilité courte, recharge les ressources de soin)
- E : Biotic Orb (orbe rebondissant, version soin ou version dégâts)
- Ulti : Coalescence (rayon long qui soigne les alliés et blesse les ennemis simultanément, traverse les barrières)
Points d'analyse : gestion des ressources de soin (ne pas les gaspiller sur des alliés qui n'en ont pas besoin), Fade pour échapper à la mort ET pour recharger (pas seulement en panique), Orb de dégâts pour harceler + recharger les ressources de heal, positionnement intermédiaire (ni trop en avant ni trop en arrière).`,

  "Kiriko": `Rôle : Support
Capacités :
- Arme : Healing Ofuda (papiers à lancer qui soignent les alliés) + Kunai (dégâts, headshot x2.5)
- Shift : Swift Step (téléportation vers un allié à travers les murs)
- E : Protection Suzu (zone qui rend les alliés invincibles 0.85s et enlève les debuffs)
- Ulti : Kitsune Rush (renard qui boost vitesse de déplacement, vitesse d'attaque et cooldowns de l'équipe)
Points d'analyse : Suzu timing (contre Sleep Dart, Anti-Nade d'Ana, Earthshatter, Graviton), Swift Step pour escape ou pour soigner un allié en danger derrière un mur, Kunai headshots pour pression, ne pas gaspiller le Suzu sur des dégâts normaux.`,

  "Zenyatta": `Rôle : Support
Capacités :
- Arme : Orbes (tir normal ou chargé x5 orbes)
- Shift : Orbe de Discord (amplifie les dégâts reçus par la cible de 30%)
- E : Orbe d'Harmonie (heal passif sur un allié)
- Ulti : Transcendance (invincibilité + gros heal en zone autour de lui)
Points d'analyse : Discord sur la cible prioritaire (le plus dangereux ou le plus facile à tuer), ne pas mettre Harmony sur quelqu'un à pleine vie, Transcendance CONTRE les ultis ennemis (Reaper, Moira, Pharah), positionnement safe (Zenyatta a peu de mobilité), dégâts actifs avec les orbes chargés.`,

  "D.Va": `Rôle : Tank (Mobile)
Capacités :
- Arme : Fusion Cannons (DPS moyen à courte portée, réduit la vitesse de déplacement)
- Shift : Boosters (dash dans une direction, annule les projectiles)
- E : Defense Matrix (absorbe les projectiles ennemis dans un cône, ressource limitée)
- Capacité 2 : Micro Missiles (missiles AoE)
- Ulti : Self-Destruct (éjecte du mech, bombe massive) + Call Mech (rappel du mech)
Points d'analyse : Defense Matrix sur les gros projectiles (Pharah roquettes, Junkrat grenades, Zarya Graviton), Boosters pour initier ou pour escape, ne pas rester en pied-bot trop longtemps (fragile), Self-Destruct dans des espaces fermés ou pour forcer les ennemis à bouger.`,

  "Sigma": `Rôle : Tank
Capacités :
- Arme : Hypersphères (2 orbes gravitationnels qui rebondissent)
- Shift : Experimental Barrier (bouclier flottant repositionnable, peut être rappelé)
- E : Kinetic Grasp (absorbe les projectiles entrants, convertit en armure)
- Capacité 2 : Accretion (lancer un rocher, gros dégâts + stun court)
- Ulti : Gravitic Flux (soulève les ennemis en l'air puis les écraser au sol)
Points d'analyse : placement du bouclier (pas devant soi mais en projection vers l'ennemi), Kinetic Grasp contre les gros ultis de zone (Reaper, Moira), Accretion sur des cibles isolées ou pour interrompre, Gravitic Flux pour isoler les cibles faibles et combo avec les alliés.`,

  "Winston": `Rôle : Tank (Dive)
Capacités :
- Arme : Tesla Cannon (dégâts en zone à courte portée, ignore la distance précise)
- Shift : Jump Pack (saut vers une zone cible, dégâts à l'atterrissage)
- E : Barrier Projector (dôme de bouclier temporaire, 700 PV)
- Ulti : Primal Rage (grande forme, bonus de PV, Jump Pack reset, dégâts mêlée++, knockback)
Points d'analyse : cibler les supports en priorité (pas les tanks), Barrier Projector pour protéger l'équipe OU pour s'isoler avec une cible, Jump Pack pour disengage si la dive tourne mal, Primal Rage pour survivre quand on est à faible vie ou pour split l'équipe ennemie.`,

  "Roadhog": `Rôle : Tank (Off-tank)
Capacités :
- Arme : Scrap Gun (shotgun à courte portée, ou tir secondaire en boule de zone)
- Shift : Chain Hook (crochet qui ramène un ennemi + combo headshot pour one-shot)
- E : Take a Breather (soin massif sur soi-même, 350 PV, peut se faire pendant le mouvement)
- Ulti : Whole Hog (mitrailleuse massive qui knockback les ennemis)
Points d'analyse : hook + headshot + mêlée = one-shot combo sur les cibles fragiles, ne pas hooker derrière un bouclier allié (la cible revient au milieu), Take a Breather en couverture pas à découvert, Whole Hog dans des couloirs étroits ou pour repousser une poussée.`,

  "Junker Queen": `Rôle : Tank (Aggressive)
Capacités :
- Arme : Scattergun (shotgun) + Jagged Blade (couteau à lancer et rappeler)
- Shift : Commanding Shout (boost PV temporaires + speed pour l'équipe)
- E : Carnage (hache large devant, inflige Wound = bleed damage)
- Ulti : Rampage (charge vers l'avant, inflige Wound à tous les ennemis touchés et bloque leurs soins)
Points d'analyse : gestion du Wound (bleed) pour empêcher les soins ennemis, Commanding Shout avant une poussée (pas pendant), Rampage pour bloquer les soins dans un teamfight, ne pas overextend sans les PV temporaires actifs.`,

  "Hanzo": `Rôle : Damage (Sniper)
Capacités :
- Arme : Storm Bow (tir chargé, headshot possible)
- Shift : Lunge (double saut latéral)
- E : Sonic Arrow (flèche de détection, révèle les ennemis dans une zone)
- Capacité 2 : Storm Arrows (6 flèches rapides non chargées en rafale)
- Ulti : Dragonstrike (dragon spectral qui traverse les murs)
Points d'analyse : Sonic Arrow pour détecter les ennemis derrière un angle avant d'avancer, Storm Arrows à courte portée pour burst, Dragonstrike dans des couloirs ou combo avec Zarya Graviton, Lunge pour changer de niveau et rendre les positions imprévisibles.`,

  "Pharah": `Rôle : Damage (Aerial)
Capacités :
- Arme : Rocket Launcher (roquettes à impact direct + splash)
- Shift : Jump Jet (propulsion vers le haut)
- E : Concussive Blast (explosion qui knockback)
- Capacité passive : Hover Jets (maintien de la hauteur en l'air)
- Ulti : Barrage (pluie de roquettes pendant quelques secondes)
Points d'analyse : rester en l'air (difficile à toucher pour beaucoup), Concussive Blast pour se propulser ou pour pousser les ennemis dans le vide, combo avec Mercy (pocket Mercy = très fort), Barrage dans des espaces fermés ou sur des ennemis groupés, attention aux hitscan (Soldier, Widowmaker, Ashe).`,

  "Soldier: 76": `Rôle : Damage
Capacités :
- Arme : Heavy Pulse Rifle (rafale automatique, recul à gérer)
- Shift : Sprint (course rapide)
- E : Biotic Field (zone de soin au sol pour lui et ses alliés)
- Capacité 2 : Helix Rockets (roquette rapide, splash dégâts)
- Ulti : Tactical Visor (auto-aim sur les cibles visibles, 6s)
Points d'analyse : Helix Rockets en combo avec le tir normal pour burst, Biotic Field derrière une couverture (pas à découvert), Tactical Visor cibler les supports en priorité (pas les tanks), gestion du recul (tirs courts pour garder la précision).`,

  "Junkrat": `Rôle : Damage
Capacités :
- Arme : Frag Launcher (grenades rebondissantes)
- Shift : Concussion Mine (mine à détonation manuelle qui knockback, 2 charges)
- E : Steel Trap (piège au sol qui immobilise)
- Ulti : RIP-Tire (pneu explosif télécommandé)
Points d'analyse : rebonds des grenades (tirer sur les murs pour toucher derrière les angles), Concussion Mine pour se propulser en hauteur ou pour échapper, Steel Trap sur les angles d'accès (pas au milieu du champ de bataille), RIP-Tire dans des couloirs ou sous des ennemis groupés.`,

  "Reaper": `Rôle : Damage (Flanker)
Capacités :
- Arme : Hellfire Shotguns (dégâts massifs à courte portée)
- Shift : Shadow Step (téléportation vers un point marqué, animation visible)
- E : Wraith Form (invincibilité + speed, ne peut pas tirer, drain les soins)
- Capacité passive : The Reaping (vole des PV aux ennemis touchés)
- Ulti : Death Blossom (dégâts en zone autour de lui pendant 3s)
Points d'analyse : ne jamais s'engager à moyenne/longue portée (inefficace), Shadow Step pour flanker par derrière (utiliser hors ligne de vue), Wraith Form pour escape si mal engagé, Death Blossom dans des espaces fermés avec des ennemis groupés, combo avec Zarya Graviton.`,

  "Cassidy": `Rôle : Damage
Capacités :
- Arme : Peacekeeper (revolver à tir unique précis, ou tir en éventail en fan the hammer)
- Shift : Combat Roll (roulade qui recharge le revolver)
- E : Magnetic Grenade (grenade qui colle à l'ennemi visé)
- Ulti : Deadeye (charge puis tire simultanément sur tous les ennemis dans le champ de vision)
Points d'analyse : headshots avec le tir simple (très efficace), Magnetic Grenade pour finir une cible affaiblie ou forcer un movement, Combat Roll pour recharger rapidement en combat, Deadeye derrière une ligne de tanks ennemis ou sur des cibles isolées (très vulnérable pendant le channel).`,

  "Ashe": `Rôle : Damage
Capacités :
- Arme : The Viper (carabine, tir hip ou ADS précis)
- Shift : Coach Gun (tir de fusil à pompe qui knockback les ennemis et propulse Ashe en arrière)
- E : Dynamite (bâton de dynamite à détonation manuelle ou par tir, flammes persistantes)
- Ulti : B.O.B. (robot allié qui charge puis mitraille)
Points d'analyse : ADS pour la précision à longue portée, Coach Gun pour s'élever et avoir de la hauteur, Dynamite sur des groupes ou des ennemis derrière des angles (les flammes continuent), B.O.B. comme un 7ème membre (bloque les angles, focus fire).`,

  "Sombra": `Rôle : Damage (Support disrupteur)
Capacités :
- Arme : Machine Pistol (DPS moyen, efficace à courte portée)
- Shift : Hack (désactive les capacités d'un ennemi 1.5s, révèle les PV en continu)
- E : Translocator (beacon téléportation, peut être lancé loin)
- Capacité passive : Opportunist (voit les ennemis à moins de 50% PV à travers les murs)
- Ulti : EMP (hack tous les ennemis dans une large zone, détruit les boucliers)
Points d'analyse : Hack les supports en priorité, EMP pour nettoyer les boucliers avant une poussée (combo avec Graviton), Translocator pour escape, ne pas engager les tanks (inefficace), timing du hack (quand l'ennemi ne peut pas esquiver).`,

  "Symmetra": `Rôle : Damage (Utilitaire)
Capacités :
- Arme : Photon Projector (beam qui monte en puissance au contact) + boules chargées
- Shift : Sentry Turret (3 mini-tourelles à placer, ralentissent les ennemis)
- E : Teleporter (téléporteur pour toute l'équipe entre deux points)
- Ulti : Photon Barrier (grand mur de bouclier traversable par les alliés)
Points d'analyse : placement des tourelles (angles, sur les murs en hauteur pour être difficiles à voir), Teleporter pour repositionner rapidement l'équipe sur le point, Photon Barrier pour bloquer une ligne de vue ou séparer les ennemis, beam à courte portée pour les duels (Monte en puissance = létal).`,

  "Torbjörn": `Rôle : Damage (Défensif)
Capacités :
- Arme : Rivet Gun (tir précis ou tir alternatif à courte portée) + Forge Hammer
- Shift : Deploy Turret (tourelle niveau 2 automatique, 1 seule à la fois)
- Ulti : Molten Core (surcharge les armures et fait des flaques de lave)
Points d'analyse : placement de la tourelle (angle difficile à atteindre, derrière une couverture), Molten Core pour contenir une poussée (flaques au sol forcent les ennemis à bouger), réparer la tourelle au marteau plutôt que de la redéployer, ne pas rester à côté de la tourelle (prévisible).`,

  "Mei": `Rôle : Damage (Contrôle)
Capacités :
- Arme : Endothermic Blaster (freeze progressif à courte portée) + projectile à longue portée
- Shift : Cryo-Freeze (bloque dans un bloc de glace, invincibilité + soin)
- E : Ice Wall (mur de piques de glace qui bloque le passage)
- Ulti : Blizzard (drone qui gèle et stun tous les ennemis dans une zone)
Points d'analyse : Cryo-Freeze pour survivre (pas seulement quand elle est déjà morte), Ice Wall pour couper une retraite ennemie ou séparer un ennemi de son équipe, Blizzard combo avec Zarya Graviton ou Hanzo Dragonstrike, freeze + headshot = one-shot sur les cibles fragiles.`,

  "Echo": `Rôle : Damage (Flexible)
Capacités :
- Arme : Tri-Shot (3 projectiles) + Sticky Bombs (bouquet de bombes adhésives)
- Shift : Focusing Beam (rayon puissant sur les cibles à moins de 50% PV)
- E : Glide (ralentit la chute) + Flight (vol libre)
- Ulti : Duplicate (copie un ennemi avec ses capacités + ulti chargé plus vite)
Points d'analyse : Focusing Beam uniquement sous 50% PV (inefficace sinon), Duplicate les bons héros (Roadhog pour hook, Zarya pour Graviton, Reaper dans une poussée), Sticky Bombs pour burst une cible ou détruire une tourelle, utiliser le vol pour les hauteurs et les repositionnements.`,

  "Sojourn": `Rôle : Damage (Sniper mobile)
Capacités :
- Arme : Railgun (tir rapide qui charge une jauge + tir chargé = one-shot si plein)
- Shift : Power Slide (glissade rapide, peut sauter pendant)
- E : Disruptor Shot (zone ralentissante + dégâts)
- Ulti : Overclock (le tir chargé se charge automatiquement et perfore pendant 8s)
Points d'analyse : gestion de la charge du Railgun (utiliser le tir chargé quand la jauge est pleine = very high damage), Power Slide pour gap closer ou escape, Disruptor Shot pour ralentir un groupe et faciliter les kills, Overclock sur des cibles groupées.`,

  "Venture": `Rôle : Damage (Dive/Bruiser)
Capacités :
- Arme : Smart Excavator (projectiles à arc)
- Shift : Burrow (plonge sous terre rapidement, repositionnement)
- E : Drill Dash (dash vers l'avant en perçant)
- Ulti : Tectonic Shock (séisme de zone)
Points d'analyse : Burrow pour approach ou pour escape, Drill Dash comme engage ou disengage, Tectonic Shock sur des ennemis groupés ou dans des espaces confinés, gestion de la portée (hero de mêlée/courte portée).`,

  "Freja": `Rôle : Damage
Capacités : héroïne récente. Analyser le positionnement général, la gestion des cooldowns, l'impact sur les teamfights, et les décisions d'engagement/disengage.`,

  "Hazard": `Rôle : Tank
Capacités : tank récent. Analyser la protection de l'équipe, la gestion de l'espace, les décisions d'engagement et l'utilisation des capacités défensives/offensives.`,

  "Mauga": `Rôle : Tank (Aggressive)
Capacités :
- Arme : Chainguns Ignis & Eos (deux mitrailleuses, l'une enflamme l'autre soigne sur les ennemis en feu)
- Shift : Cardiac Overdrive (zone qui rend l'équipe partiellement invincible et soigne sur les dégâts)
- E : Overrun (charge qui knockback et saute)
- Ulti : Cage Fight (arène emprisonnant les ennemis proches, il est invincible dedans)
Points d'analyse : alterner les deux mitrailleuses correctement (enflammer puis soigner), Cardiac Overdrive pour tenir sous les dégâts, Cage Fight dans un groupe ennemi dense (pas sur des ennemis dispersés).`,

  "Ramattra": `Rôle : Tank
Capacités :
- Forme Omnic : Void Accelerator (projectiles rapides) + Void Barrier (bouclier placé devant)
- Shift : Nemesis Form (basculement vers une forme mêlée, bras blocants, Pummel)
- E : Ravenous Vortex (zone qui ralentit et attire vers le bas les ennemis)
- Ulti : Annihilation (aura de dégâts continus autour de lui, durée illimitée si des ennemis sont dans l'aura)
Points d'analyse : switch Nemesis Form pour tanker ou pour dégâts mêlée, Ravenous Vortex pour empêcher les ennemis de sauter ou de fuir, Annihilation sur des ennemis groupés (dure très longtemps si bien utilisé).`,

  "Orisa": `Rôle : Tank (Anchor)
Capacités :
- Arme : Augmented Fusion Driver (tir continu, pas de recharge)
- Shift : Energy Javelin (lance un javelot qui stun si contre un mur)
- E : Fortify (invincibilité aux CC + réduction dégâts, ralentit)
- Capacité 2 : Javelin Spin (tourne le javelot, dévie les projectiles + pousse)
- Ulti : Terra Surge (charge puis libère une explosion de zone massive)
Points d'analyse : Energy Javelin contre un mur pour le stun (ne pas lancer en champ ouvert), Fortify pour absorber les gros ultis (Graviton, Earthshatter), Javelin Spin pour pousser les ennemis ou dévier les projectiles, Terra Surge sur des ennemis groupés.`,

  "Wrecking Ball": `Rôle : Tank (Dive/Disrupteur)
Capacités :
- Shift : Grappling Claw (grappin pour pivoter à grande vitesse)
- E : Roll (mode boule rapide)
- Capacité 2 : Piledriver (plonge vers le bas, knockback à l'atterrissage)
- Capacité 3 : Adaptive Shield (bouclier qui croît avec le nombre d'ennemis proches)
- Ulti : Minefield (déploie des mines magnétiques)
Points d'analyse : Adaptive Shield au milieu des ennemis (plus il y en a, plus le bouclier est gros), Piledriver pour disperser un groupe, Minefield sur l'objectif ou pour zone denial, gestion de la vitesse (danger si trop lent).`,

  "Doomfist": `Rôle : Tank (Dive)
Capacités :
- Arme : Hand Cannon (shotgun rapide)
- Shift : Rocket Punch (dash + punch, stun si contre un mur)
- E : Seismic Slam (plonge vers le bas, attire les ennemis)
- Capacité 2 : Rising Uppercut (uppercut en l'air)
- Ulti : Meteor Strike (saut + plonge massif, gros dégâts zone)
Points d'analyse : Rocket Punch contre un mur = stun + gros dégâts, combo Rising Uppercut + Seismic Slam + Rocket Punch, Meteor Strike pour revenir en combat ou pour zone denial, Empowered Punch (chargé) pour maximiser les dégâts.`,

  "Ana": `Rôle : Support (Sniper)
Capacités :
- Arme : Biotic Rifle (soigne les alliés, blesse les ennemis, scope disponible)
- Shift : Sleep Dart (endort un ennemi, annule les ultis en cours)
- E : Biotic Grenade (zone qui soigne les alliés et bloque les soins ennemis 4s)
- Ulti : Nano Boost (boost un allié : +50% dégâts, -50% dégâts reçus)
Points d'analyse : Sleep Dart sur les ultis ennemis (Reinhardt qui charge, Roadhog qui hook, Genji en blade), Biotic Grenade sur plusieurs cibles en même temps, Nano Boost sur le bon allié (Genji blade, Reaper, Soldier), positionnement safe en hauteur, ne pas soigner des alliés à pleine vie.`,

  "Baptiste": `Rôle : Support
Capacités :
- Arme : Biotic Launcher (tir à 3 balles + grenades de soin au sol)
- Shift : Exo Boots (charge + saut très haut)
- E : Regenerative Burst (soin en zone autour de lui + lui-même)
- Capacité 2 : Immortality Field (drone qui empêche les alliés de mourir)
- Ulti : Amplification Matrix (fenêtre qui double les dégâts et soins des projectiles qui la traversent)
Points d'analyse : Immortality Field timing (contre les gros burst ou les ultis létaux), placement de l'Amplification Matrix (aligné avec les DPS alliés), Exo Boots pour accéder aux hauteurs, Regenerative Burst sur lui-même d'abord si faible vie.`,

  "Brigitte": `Rôle : Support (Bruiser)
Capacités :
- Arme : Rocket Flail (mêlée) + Shield Bash
- Shift : Shield Bash (dash qui stun)
- E : Repair Pack (soin ciblé sur un allié, excès = armure temporaire)
- Capacité : Whip Shot (coup longue portée qui knockback)
- Ulti : Rally (armure pour toute l'équipe + speed aura)
Points d'analyse : Shield Bash pour interrompre (Roadhog hook, Reaper, flankers), Repair Pack sur les alliés qui combattent (pas seulement ceux qui fuient), Rally avant une poussée (pas réactif), Whip Shot pour knockback ou poke à distance.`,

  "Illari": `Rôle : Support (Hybrid)
Capacités :
- Arme : Solar Rifle (tir précis longue portée)
- Shift : Outburst (dash + knockback)
- E : Healing Pylon (tourelle de soin à placer)
- Ulti : Captive Sun (orbe solaire qui explose les ennemis touchant plusieurs dégâts)
Points d'analyse : placement du Healing Pylon (hauteur, angle difficile à détruire), Outburst pour escape ou repositionnement, Captive Sun sur des ennemis groupés, équilibre entre snipe ennemis et heal alliés.`,

  "Juno": `Rôle : Support (Mobile)
Capacités : support récente avec kit mobile. Analyser la mobilité, le soutien à l'équipe, et le timing des capacités de contrôle.`,

  "Lifeweaver": `Rôle : Support
Capacités :
- Arme : Thorn Volley (projectiles) + Healing Blossom (chargeable, soin ciblé)
- Shift : Rejuvenating Dash (dash + soin sur soi)
- E : Life Grip (tire un allié vers soi, invincible pendant le trajet)
- Capacité 2 : Petal Platform (plateforme qui monte)
- Ulti : Tree of Life (arbre qui soigne en zone, dure longtemps)
Points d'analyse : Life Grip sur un allié en danger (pas sur quelqu'un qui joue bien), Petal Platform pour créer des hauteurs ou faire monter l'équipe, Tree of Life en soutien d'une poussée ou en zone défensive, équilibre Healing Blossom chargé vs tirs rapides.`,

  "Sigma": `Rôle : Tank
Capacités :
- Arme : Hypersphères (2 orbes gravitationnels qui rebondissent)
- Shift : Experimental Barrier (bouclier flottant repositionnable)
- E : Kinetic Grasp (absorbe les projectiles, convertit en armure)
- Capacité 2 : Accretion (lancer un rocher, gros dégâts + stun court)
- Ulti : Gravitic Flux (soulève les ennemis en l'air puis les écrase)
Points d'analyse : placement du bouclier en projection, Kinetic Grasp contre les gros ultis, Accretion sur des cibles isolées, Gravitic Flux combo avec les alliés.`,

  "Wuyang": `Rôle : Support
Capacités : support récent. Analyser le positionnement, le soutien à l'équipe, et la gestion des cooldowns.`,

  "Mizuki": `Rôle : Support
Capacités : support récente. Analyser le positionnement, le soutien à l'équipe, et la gestion des cooldowns.`,

  "Jetpack Cat": `Rôle : Support
Capacités : support récent. Analyser le positionnement, la mobilité, le soutien à l'équipe, et la gestion des cooldowns.`,

  "Domina": `Rôle : Tank
Capacités : tank récente. Analyser la protection de l'équipe, la gestion de l'espace, et les décisions d'engagement.`,

  "Anran": `Rôle : Damage
Capacités : héros récent. Analyser le positionnement, l'impact sur les teamfights et la gestion des cooldowns.`,

  "Emre": `Rôle : Damage
Capacités : héros récent. Analyser le positionnement, l'impact sur les teamfights et la gestion des cooldowns.`,

  "Vendetta": `Rôle : Damage
Capacités : héros récent. Analyser le positionnement, l'impact sur les teamfights et la gestion des cooldowns.`,

  "Sierra": `Rôle : Damage
Capacités : héroïne récente (sortie avril 2026), cheffe de la sécurité de Watchpoint Grand Mesa. Analyser le positionnement, la gestion des cooldowns, l'impact sur les teamfights et les décisions d'engagement/disengage.`,
};

function buildPrompt(hero, rank) {
  const rankTips = RANK_CONTEXT[rank] || "Analyse le gameplay de façon adaptée au niveau du joueur.";
  const heroTips = HERO_CONTEXT[hero] || `Joue ${hero}. Analyse son kit : cooldowns, positionnement, gestion des ressources et impact sur le teamfight.`;

  return `Tu es un coach Overwatch 2 professionnel.

CONTEXTE :
- Héros : ${hero} | Rang : ${rank}
- Profil rang : ${rankTips}
- Focus héros : ${heroTips}

MISSION : Analyse cette VOD et fournis un coaching détaillé et actionnable.

RÈGLES :
- Explique POURQUOI c'est une erreur ou un bon play, pas juste QUOI
- Donne un conseil CONCRET applicable dès la prochaine partie
- Adapte la profondeur au rang ${rank}
- Sois direct et honnête

CATÉGORIES :
- death : mort évitable (mauvais positioning, overextension)
- mistake : erreur sans mort (ulti gaspillé, mauvaise cible)
- positioning : problème de placement ou d'angle
- ulti : gestion d'ulti bonne ou mauvaise
- good : bon moment à reproduire

Réponds UNIQUEMENT en JSON valide, sans markdown ni backticks :
{
  "summary": "Bilan global de 4-5 phrases : niveau général, points forts, axes d'amélioration",
  "timestamps": [
    {
      "time": "MM:SS",
      "category": "death|mistake|positioning|ulti|good",
      "title": "Titre court du moment",
      "description": "Ce qui s'est passé, pourquoi c'est bien/mal, conseil concret"
    }
  ],
  "priorities": [
    "Point #1 le plus important avec conseil concret",
    "Point #2 avec conseil concret",
    "Point #3 avec conseil concret"
  ]
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
app.get("/heroes", (req, res) => res.json(HEROES)); // objet complet groupé par rôle

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
