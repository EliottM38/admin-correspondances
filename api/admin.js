// API de l'admin : un seul point d'entrée, comme la fonction « partage » (POST { action, ... }).
const { supabase, hacher, verifier, empreinteJeton, crypto, FAUX } = require("./_lib");

const DUREE_SESSION_H = 12;
const MAX_ECHECS = 10;   // par tranche de 10 minutes, par adresse IP et par e-mail
const ROLES = ["administrateur", "moderateur", "editeur"];

// Les contenus gérés : table, rôles autorisés (l'administrateur a toujours accès), champs modifiables
const RESSOURCES = {
  questions: {
    table: "questions", roles: ["editeur"], tri: "ordre", filtres: ["ville"],
    champs: ["code", "texte", "reponses", "ville", "condition", "lignes", "modes", "heure_debut", "heure_fin", "actif", "ordre"],
  },
  annonces: {
    table: "annonces_lignes", roles: ["editeur"], tri: "debut", descendant: true, filtres: ["ville", "ligne"],
    champs: ["ligne", "type", "titre", "texte", "debut", "fin", "actif", "ville", "reseau", "gravite"],
  },
  styles: {
    table: "styles_lignes", roles: ["editeur"], tri: "ligne", filtres: ["ville", "ligne"],
    champs: ["ville", "ligne", "forme", "couleur", "couleur_texte"], unique: "ville,ligne",
  },
  avis: {
    table: "avis", roles: ["moderateur"], tri: "cree", descendant: true, filtres: ["ville", "ligne"],
    champs: [], lectureSeule: true,
  },
};

// ---------- Petits outils ----------

function lireCookie(req, nom) {
  for (const morceau of String(req.headers.cookie || "").split(";")) {
    const [cle, ...reste] = morceau.trim().split("=");
    if (cle === nom) return reste.join("=");
  }
  return null;
}

function repondre(res, donnees, erreur) {
  if (erreur) return res.status(400).json({ erreur: erreur.message });
  return res.status(200).json(donnees);
}

function autorise(u, roles) {
  return u.role === "administrateur" || roles.includes(u.role);
}

async function journaliser(u, action, cible, detail) {
  const { error } = await supabase.from("admin_journal").insert({
    utilisateur: u.id, email: u.email, action,
    cible: cible == null ? null : String(cible), detail: detail || null,
  });
  if (error) console.error("Journal :", error.message);
}

function garderChamps(objet, champs) {
  const sortie = {};
  for (const c of champs) if (objet && c in objet) sortie[c] = objet[c];
  return sortie;
}

// Texte vide ou liste vide -> null (= « pas de condition »), sauf les réponses d'une question
function nettoyer(ligne) {
  for (const [cle, valeur] of Object.entries(ligne)) {
    if (typeof valeur === "string" && valeur.trim() === "") ligne[cle] = null;
    else if (Array.isArray(valeur) && valeur.length === 0 && cle !== "reponses") ligne[cle] = null;
  }
  return ligne;
}

function reponsesValides(liste) {
  return Array.isArray(liste) && liste.length >= 2 &&
    liste.every((r) => r && typeof r.code === "string" && r.code && typeof r.libelle === "string" && r.libelle);
}

// ---------- Session ----------

async function utilisateurConnecte(req) {
  const jeton = lireCookie(req, "session");
  if (!jeton) return null;
  const { data: session } = await supabase.from("admin_sessions")
    .select("utilisateur, expire").eq("empreinte", empreinteJeton(jeton)).maybeSingle();
  if (!session || new Date(session.expire) < new Date()) return null;
  const { data: u } = await supabase.from("admin_utilisateurs")
    .select("id, email, role, proprietaire, actif").eq("id", session.utilisateur).maybeSingle();
  return u && u.actif ? u : null;
}

async function tropDEssais(cles) {
  const depuis = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  for (const cle of cles) {
    const { data } = await supabase.from("admin_tentatives").select("n").eq("cle", cle).gte("minute", depuis);
    if ((data || []).reduce((somme, l) => somme + l.n, 0) >= MAX_ECHECS) return true;
  }
  return false;
}

async function noterEchec(cles) {
  const minute = new Date();
  minute.setSeconds(0, 0);
  for (const cle of cles) {
    const { data } = await supabase.from("admin_tentatives").select("n")
      .eq("cle", cle).eq("minute", minute.toISOString()).maybeSingle();
    await supabase.from("admin_tentatives").upsert({ cle, minute: minute.toISOString(), n: (data ? data.n : 0) + 1 });
  }
  await supabase.from("admin_tentatives").delete().lt("minute", new Date(Date.now() - 3600 * 1000).toISOString());
}

async function connexion(req, res, p) {
  const email = String(p.email || "").trim().toLowerCase();
  const motDePasse = String(p.mot_de_passe || "");
  const ip = String(req.headers["x-forwarded-for"] || "inconnue").split(",")[0].trim();
  const cles = ["ip:" + ip, "mail:" + email];

  if (await tropDEssais(cles)) return res.status(429).json({ erreur: "Trop d'essais, réessayez dans 10 minutes" });

  const { data: u } = await supabase.from("admin_utilisateurs").select("*").eq("email", email).maybeSingle();
  const bon = verifier(motDePasse, u ? u.mot_de_passe : FAUX);
  if (!u || !u.actif || !bon) {
    await noterEchec(cles);
    return res.status(401).json({ erreur: "E-mail ou mot de passe incorrect" });
  }

  const jeton = crypto.randomBytes(32).toString("hex");
  await supabase.from("admin_sessions").delete().lt("expire", new Date().toISOString());
  await supabase.from("admin_sessions").insert({
    empreinte: empreinteJeton(jeton), utilisateur: u.id,
    expire: new Date(Date.now() + DUREE_SESSION_H * 3600 * 1000).toISOString(),
  });
  await supabase.from("admin_utilisateurs").update({ derniere_connexion: new Date().toISOString() }).eq("id", u.id);
  await journaliser(u, "connexion", u.email, null);

  // Cookie invisible pour le JavaScript de la page (HttpOnly), envoyé seulement à ce site
  res.setHeader("Set-Cookie",
    `session=${jeton}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${DUREE_SESSION_H * 3600}`);
  return res.status(200).json({ email: u.email, role: u.role, proprietaire: u.proprietaire });
}

async function deconnexion(req, res) {
  await supabase.from("admin_sessions").delete().eq("empreinte", empreinteJeton(lireCookie(req, "session")));
  res.setHeader("Set-Cookie", "session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0");
  return res.status(200).json({ ok: true });
}

// ---------- Contenus (questions, annonces, styles, avis) ----------

async function lister(res, r, p) {
  let requete = supabase.from(r.table).select("*")
    .order(r.tri, { ascending: !r.descendant })
    .limit(Math.min(Number(p.limite) || 1000, 5000));
  for (const f of r.filtres) if (p[f]) requete = requete.eq(f, p[f]);
  if (r.table === "avis" && p.depuis) requete = requete.gte("cree", p.depuis);
  const { data, error } = await requete;
  return repondre(res, data, error);
}

async function enregistrer(res, u, nom, r, p) {
  if (r.lectureSeule) return res.status(403).json({ erreur: "Lecture seule" });
  const ligne = nettoyer(garderChamps(p.valeurs, r.champs));
  if (nom === "questions" && (!p.id || "reponses" in ligne) && !reponsesValides(ligne.reponses)) {
    return res.status(400).json({ erreur: "Une question a besoin d'au moins 2 réponses (code et libellé)" });
  }
  if (nom === "styles") ligne.maj = new Date().toISOString();
  if (nom === "annonces" && !p.id) ligne.source = "manuel";

  let requete;
  if (p.id) requete = supabase.from(r.table).update(ligne).eq("id", p.id);
  else if (r.unique) requete = supabase.from(r.table).upsert(ligne, { onConflict: r.unique });
  else requete = supabase.from(r.table).insert(ligne);
  const { data, error } = await requete.select().single();
  if (!error) await journaliser(u, nom + ".enregistrer", data.id, ligne);
  return repondre(res, data, error);
}

async function supprimer(res, u, nom, r, p) {
  if (!p.id) return res.status(400).json({ erreur: "id manquant" });
  const { error } = await supabase.from(r.table).delete().eq("id", p.id);
  if (!error) await journaliser(u, nom + ".supprimer", p.id, null);
  return repondre(res, { ok: true }, error);
}

// ---------- Utilisateurs de l'admin ----------

async function utilisateurs(res, u, verbe, p) {
  if (u.role !== "administrateur") return res.status(403).json({ erreur: "Réservé aux administrateurs" });

  if (verbe === "liste") {
    const { data, error } = await supabase.from("admin_utilisateurs")
      .select("id, email, role, proprietaire, actif, cree, derniere_connexion").order("email");
    return repondre(res, data, error);
  }

  if (verbe === "creer") {
    const email = String(p.email || "").trim().toLowerCase();
    if (!email.includes("@") || !ROLES.includes(p.role)) return res.status(400).json({ erreur: "E-mail ou rôle invalide" });
    if (String(p.mot_de_passe || "").length < 12) return res.status(400).json({ erreur: "Mot de passe : 12 caractères minimum" });
    if (p.role === "administrateur" && !u.proprietaire) return res.status(403).json({ erreur: "Seul le propriétaire crée des administrateurs" });
    const { error } = await supabase.from("admin_utilisateurs").insert({ email, role: p.role, mot_de_passe: hacher(p.mot_de_passe) });
    if (!error) await journaliser(u, "utilisateurs.creer", email, { role: p.role });
    return repondre(res, { ok: true }, error);
  }

  if (verbe === "modifier") {
    const { data: cible } = await supabase.from("admin_utilisateurs").select("id, email, role, proprietaire").eq("id", p.id).maybeSingle();
    if (!cible) return res.status(404).json({ erreur: "Utilisateur introuvable" });
    // Seul le propriétaire touche aux comptes administrateurs des autres
    const toucheUnAdmin = (cible.role === "administrateur" && cible.id !== u.id) || p.role === "administrateur";
    if (toucheUnAdmin && !u.proprietaire) return res.status(403).json({ erreur: "Réservé au propriétaire" });
    if (cible.id === u.id && p.actif === false) return res.status(400).json({ erreur: "Vous ne pouvez pas désactiver votre compte" });
    if (cible.proprietaire && p.role && p.role !== "administrateur") return res.status(400).json({ erreur: "Le propriétaire reste administrateur" });

    const modif = {};
    if (ROLES.includes(p.role)) modif.role = p.role;
    if (typeof p.actif === "boolean") modif.actif = p.actif;
    if (p.mot_de_passe) {
      if (String(p.mot_de_passe).length < 12) return res.status(400).json({ erreur: "Mot de passe : 12 caractères minimum" });
      modif.mot_de_passe = hacher(p.mot_de_passe);
    }
    const { error } = await supabase.from("admin_utilisateurs").update(modif).eq("id", cible.id);
    if (!error) {
      // Nouveau mot de passe ou compte désactivé : on coupe ses sessions ouvertes
      if (modif.mot_de_passe || modif.actif === false) await supabase.from("admin_sessions").delete().eq("utilisateur", cible.id);
      await journaliser(u, "utilisateurs.modifier", cible.email,
        { role: modif.role, actif: modif.actif, mot_de_passe: modif.mot_de_passe ? "changé" : undefined });
    }
    return repondre(res, { ok: true }, error);
  }
  return res.status(400).json({ erreur: "Action inconnue" });
}

// ---------- Point d'entrée ----------

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST" || !String(req.headers["content-type"] || "").includes("application/json")) {
    return res.status(405).json({ erreur: "POST JSON uniquement" });
  }
  const { action, ...p } = req.body || {};
  try {
    if (action === "connexion") return await connexion(req, res, p);

    const u = await utilisateurConnecte(req);
    if (!u) return res.status(401).json({ erreur: "Non connecté" });

    if (action === "moi") return res.status(200).json({ email: u.email, role: u.role, proprietaire: u.proprietaire });
    if (action === "deconnexion") return await deconnexion(req, res);

    const [nom, verbe] = String(action).split(".");

    if (nom === "villes" && verbe === "liste") {
      const villes = await supabase.from("villes").select("*").order("nom");
      const reseaux = await supabase.from("reseaux").select("*").order("nom");
      return repondre(res, { villes: villes.data, reseaux: reseaux.data }, villes.error || reseaux.error);
    }
    if (nom === "utilisateurs") return await utilisateurs(res, u, verbe, p);
    if (nom === "journal" && verbe === "liste") {
      if (!u.proprietaire) return res.status(403).json({ erreur: "Journal réservé au propriétaire" });
      const { data, error } = await supabase.from("admin_journal").select("*").order("quand", { ascending: false }).limit(300);
      return repondre(res, data, error);
    }

    const r = RESSOURCES[nom];
    if (!r) return res.status(400).json({ erreur: "Action inconnue" });
    if (!autorise(u, r.roles)) return res.status(403).json({ erreur: "Droits insuffisants" });
    if (verbe === "liste") return await lister(res, r, p);
    if (verbe === "enregistrer") return await enregistrer(res, u, nom, r, p);
    if (verbe === "supprimer") return await supprimer(res, u, nom, r, p);
    return res.status(400).json({ erreur: "Action inconnue" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erreur: "Erreur du serveur" });
  }
};
