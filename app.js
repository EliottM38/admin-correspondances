// Admin Correspondances : interface. Aucune clé ici : tout passe par /api/admin (voir api/admin.js).

const etat = { moi: null, villes: [], reseaux: [], ville: "grenoble" };

// ---------- Outils ----------

async function appeler(action, params = {}) {
  const reponse = await fetch("/api/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...params }),
  });
  const donnees = await reponse.json().catch(() => ({}));
  if (reponse.status === 401 && action !== "connexion") {
    montrerConnexion();
    throw new Error("Session expirée, reconnectez-vous");
  }
  if (!reponse.ok) throw new Error(donnees.erreur || "Erreur");
  return donnees;
}

// Crée un élément HTML : el("div", { class: "carte" }, "texte", autreElement)
// (le texte est toujours ajouté comme du texte, jamais comme du HTML : pas de faille XSS)
function el(balise, props = {}, ...enfants) {
  const n = document.createElement(balise);
  for (const [cle, valeur] of Object.entries(props)) {
    if (cle.startsWith("on")) n.addEventListener(cle.slice(2), valeur);
    else if (["value", "checked", "disabled"].includes(cle)) n[cle] = valeur;
    else if (valeur != null && valeur !== false) n.setAttribute(cle, valeur);
  }
  for (const e of enfants.flat()) if (e != null && e !== false) n.append(e);
  return n;
}

function dire(texte, erreur = false) {
  const m = document.getElementById("message");
  m.textContent = texte;
  m.className = erreur ? "erreur" : "ok";
  m.hidden = !texte;
  if (texte) setTimeout(() => { if (m.textContent === texte) m.hidden = true; }, 5000);
}

async function essayer(fonction) {
  try { await fonction(); } catch (e) { dire(e.message, true); }
}

function versLocal(iso) {   // date du serveur -> valeur d'un champ datetime-local
  const d = new Date(iso);
  return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function dateCourte(iso) {
  return iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "";
}

// Pastille d'une ligne, avec sa forme et ses couleurs (les codes couleur sont vérifiés)
function pastille(nom, forme, couleur, texte) {
  const ok = (c) => /^[0-9a-f]{6}$/i.test(c || "");
  const style = (ok(couleur) ? `background:#${couleur};` : "") + (ok(texte) ? `color:#${texte};` : "");
  return el("span", { class: "pastille " + (forme || "auto"), style }, nom);
}

// ---------- Formulaire générique ----------
// champs : [{ nom, label, type, options, aide, defaut }]
// types : text, number, select, checkbox, time, datetime, cases, liste (texte séparé par des virgules), reponses, password

function formulaire(champs) {
  const entrees = {};
  const noeud = el("div", { class: "formulaire" });
  for (const c of champs) {
    let champ;
    if (c.type === "select") {
      champ = el("select", {}, c.options.map(([v, t]) => el("option", { value: v }, t)));
    } else if (c.type === "reponses") {
      champ = el("textarea", { rows: 5, placeholder: c.aide || "" });
    } else if (c.type === "cases") {
      champ = el("div", { class: "cases" },
        c.options.map(([v, t]) => el("label", {}, el("input", { type: "checkbox", value: v }), " " + t)));
    } else {
      const type = { checkbox: "checkbox", number: "number", time: "time", datetime: "datetime-local", password: "password" }[c.type] || "text";
      champ = el("input", { type, placeholder: c.aide || "" });
    }
    entrees[c.nom] = champ;
    noeud.append(el(c.type === "cases" ? "div" : "label", { class: "champ" }, el("span", {}, c.label), champ));
  }

  // valeurs venant de l'API -> champs
  function ecrire(v) {
    for (const c of champs) {
      const champ = entrees[c.nom];
      const val = v[c.nom];
      if (c.type === "checkbox") champ.checked = val ?? c.defaut ?? false;
      else if (c.type === "cases") champ.querySelectorAll("input").forEach((i) => { i.checked = (val || []).includes(i.value); });
      else if (c.type === "liste") champ.value = (val || []).join(", ");
      else if (c.type === "reponses") champ.value = (val || []).map((r) => [r.code, r.libelle, r.icone || ""].join(" ; ")).join("\n");
      else if (c.type === "datetime") champ.value = val ? versLocal(val) : "";
      else champ.value = val ?? c.defaut ?? "";
      if (c.type === "select" && champ.selectedIndex < 0) champ.selectedIndex = 0;   // rien de choisi : la 1re option
    }
  }

  // champs -> valeurs pour l'API
  function lire() {
    const sortie = {};
    for (const c of champs) {
      const champ = entrees[c.nom];
      if (c.type === "checkbox") sortie[c.nom] = champ.checked;
      else if (c.type === "cases") sortie[c.nom] = [...champ.querySelectorAll("input:checked")].map((i) => i.value);
      else if (c.type === "liste") sortie[c.nom] = champ.value.split(",").map((s) => s.trim()).filter(Boolean);
      else if (c.type === "reponses") {
        sortie[c.nom] = champ.value.split("\n").map((l) => l.split(";").map((s) => s.trim())).filter((p) => p[0])
          .map((p) => ({ code: p[0], libelle: p[1] || "", icone: p[2] || undefined }));
      } else if (c.type === "number") { if (champ.value !== "") sortie[c.nom] = Number(champ.value); }
      else if (c.type === "datetime") sortie[c.nom] = champ.value ? new Date(champ.value).toISOString() : null;
      else sortie[c.nom] = champ.value.trim();
    }
    return sortie;
  }
  return { noeud, ecrire, lire };
}

// ---------- Page de gestion générique (questions, annonces, styles) ----------
// cfg : ressource, champs, colonnes [[titre, fonction(ligne)]], defauts(), avantEnvoi(valeurs), ordonnable, filtres()

async function pageGestion(zone, cfg) {
  let idEdite = null;
  let lignes = [];
  const f = formulaire(cfg.champs);
  const titreForm = el("h2", {});
  const carteForm = el("div", { class: "carte" });
  const carteListe = el("div", { class: "carte tableau" });

  function nouveau(valeurs, defiler = false) {
    idEdite = valeurs.id || null;
    f.ecrire(valeurs);
    titreForm.textContent = idEdite ? "Modifier" : "Ajouter";
    if (defiler) carteForm.scrollIntoView({ behavior: "smooth" });
  }

  async function recharger() {
    lignes = await appeler(cfg.ressource + ".liste", cfg.filtres ? cfg.filtres() : {});
    const corps = lignes.map((l, i) => el("tr", {},
      cfg.colonnes.map(([, fonction]) => el("td", {}, fonction(l))),
      el("td", { class: "actions" },
        cfg.ordonnable && el("button", { class: "contour petit", onclick: () => essayer(() => deplacer(i, -1)) }, "▲"),
        cfg.ordonnable && el("button", { class: "contour petit", onclick: () => essayer(() => deplacer(i, 1)) }, "▼"),
        el("button", { class: "contour petit", onclick: () => nouveau(l, true) }, "Modifier"),
        el("button", { class: "danger petit", onclick: () => essayer(() => supprimer(l)) }, "Supprimer"))));
    carteListe.replaceChildren(el("table", {},
      el("tr", {}, cfg.colonnes.map(([titre]) => el("th", {}, titre)), el("th", {})), corps));
  }

  async function deplacer(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= lignes.length) return;
    [lignes[i], lignes[j]] = [lignes[j], lignes[i]];
    for (const [k, l] of lignes.entries()) {   // on renumérote de 10 en 10
      if (l.ordre !== (k + 1) * 10) await appeler(cfg.ressource + ".enregistrer", { id: l.id, valeurs: { ordre: (k + 1) * 10 } });
    }
    await recharger();
  }

  async function supprimer(l) {
    if (!confirm("Supprimer cet élément ?")) return;
    await appeler(cfg.ressource + ".supprimer", { id: l.id });
    dire("Supprimé");
    await recharger();
  }

  async function enregistrer() {
    let valeurs = f.lire();
    if (cfg.avantEnvoi) valeurs = cfg.avantEnvoi(valeurs);
    await appeler(cfg.ressource + ".enregistrer", { id: idEdite || undefined, valeurs });
    dire("Enregistré");
    nouveau(cfg.defauts());
    await recharger();
  }

  carteForm.append(titreForm, f.noeud, el("div", { class: "actions" },
    el("button", { onclick: () => essayer(enregistrer) }, "Enregistrer"),
    el("button", { class: "contour", onclick: () => nouveau(cfg.defauts()) }, "Nouveau")));
  zone.append(carteForm, carteListe);
  nouveau(cfg.defauts());
  await recharger();
}

// ---------- Les pages ----------

const OUI_NON = (l) => (l.actif ? "oui" : "non");
const optionsVilles = (avecToutes) => [...(avecToutes ? [["", "Toutes les villes"]] : []), ...etat.villes.map((v) => [v.code, v.nom])];

function pageQuestions(zone) {
  const conditions = (q) => [q.condition, q.lignes && "lignes " + q.lignes.join(","), q.modes && q.modes.join("/"),
    q.heure_debut && q.heure_fin && `${q.heure_debut.slice(0, 5)}–${q.heure_fin.slice(0, 5)}`].filter(Boolean).join(" · ") || "aucune";
  return pageGestion(zone, {
    ressource: "questions", ordonnable: true,
    defauts: () => ({ actif: true, ville: etat.ville }),
    champs: [
      { nom: "code", label: "Code (sans espace, ex. affluence)", type: "text" },
      { nom: "texte", label: "Question posée", type: "text" },
      { nom: "ville", label: "Ville", type: "select", options: optionsVilles(true) },
      { nom: "condition", label: "Météo", type: "select", options: [["", "Toutes"], ["pluie", "Pluie"], ["froid", "Froid"], ["chaud", "Chaud"], ["neige", "Neige"]] },
      { nom: "lignes", label: "Lignes (séparées par des virgules, vide = toutes)", type: "liste" },
      { nom: "modes", label: "Modes (rien coché = tous)", type: "cases", options: [["tram", "Tram"], ["bus", "Bus"], ["metro", "Métro"]] },
      { nom: "heure_debut", label: "Plage horaire : de", type: "time" },
      { nom: "heure_fin", label: "à", type: "time" },
      { nom: "actif", label: "Active", type: "checkbox" },
      { nom: "reponses", label: "Réponses, une par ligne : code ; libellé ; icône (nom SF Symbols)", type: "reponses",
        aide: "peu ; Peu de monde ; person.fill\nbeaucoup ; Beaucoup de monde ; person.3.fill" },
    ],
    colonnes: [["Ordre", (q) => String(q.ordre)], ["Question", (q) => q.texte + " (" + q.code + ")"],
      ["Ville", (q) => q.ville || "toutes"], ["Conditions", conditions], ["Active", OUI_NON]],
  });
}

function pageAnnonces(zone) {
  return pageGestion(zone, {
    ressource: "annonces", filtres: () => ({ ville: etat.ville }),
    defauts: () => ({ actif: true, ville: etat.ville, type: "perturbation", gravite: "moyenne", debut: new Date().toISOString() }),
    champs: [
      { nom: "ligne", label: "Ligne (ex. C1)", type: "text" },
      { nom: "titre", label: "Titre", type: "text" },
      { nom: "texte", label: "Message (français)", type: "text" },
      { nom: "type", label: "Type", type: "select", options: [["perturbation", "Perturbation"], ["travaux", "Travaux"], ["suppression", "Suppression"], ["info", "Information"]] },
      { nom: "gravite", label: "Gravité", type: "select", options: [["info", "Info"], ["moyenne", "Moyenne"], ["grave", "Grave"]] },
      { nom: "ville", label: "Ville", type: "select", options: optionsVilles(false) },
      { nom: "reseau", label: "Réseau", type: "select", options: [["", "Aucun"], ...etat.reseaux.map((r) => [r.code, r.nom])] },
      { nom: "debut", label: "Début", type: "datetime" },
      { nom: "fin", label: "Fin (vide = sans fin)", type: "datetime" },
      { nom: "actif", label: "Active", type: "checkbox" },
    ],
    colonnes: [["Ligne", (a) => a.ligne], ["Annonce", (a) => a.titre], ["Gravité", (a) => a.gravite],
      ["Période", (a) => dateCourte(a.debut) + (a.fin ? " → " + dateCourte(a.fin) : "")],
      ["Source", (a) => a.source], ["Active", OUI_NON]],
  });
}

function pageStyles(zone) {
  return pageGestion(zone, {
    ressource: "styles", filtres: () => ({ ville: etat.ville }),
    defauts: () => ({ ville: etat.ville, forme: "auto" }),
    avantEnvoi: (v) => ({ ...v, couleur: v.couleur.replace("#", ""), couleur_texte: v.couleur_texte.replace("#", "") }),
    champs: [
      { nom: "ligne", label: "Ligne (ex. C1)", type: "text" },
      { nom: "ville", label: "Ville", type: "select", options: optionsVilles(false) },
      { nom: "forme", label: "Forme de la pastille", type: "select", options: [["auto", "Automatique (règle de l'app)"], ["cercle", "Rond"], ["rectangle", "Rectangle arrondi"]] },
      { nom: "couleur", label: "Couleur (code, ex. FFCD00 ; vide = celle de M)", type: "text" },
      { nom: "couleur_texte", label: "Couleur du texte (ex. 14162A)", type: "text" },
    ],
    colonnes: [["Aperçu", (s) => pastille(s.ligne, s.forme, s.couleur, s.couleur_texte)], ["Ligne", (s) => s.ligne], ["Forme", (s) => s.forme]],
  });
}

// Avis : filtres, répartition des réponses, liste, export CSV
async function pageAvis(zone) {
  const ligne = el("input", { placeholder: "ex. C1" });
  const periode = el("select", {}, [[7, "7 derniers jours"], [30, "30 derniers jours"], [90, "90 derniers jours"]].map(([v, t]) => el("option", { value: v }, t)));
  const resultat = el("div");
  let liste = [];

  async function charger() {
    const depuis = new Date(Date.now() - Number(periode.value) * 86400000).toISOString();
    liste = await appeler("avis.liste", { ville: etat.ville, ligne: ligne.value.trim() || undefined, depuis });
    afficher();
  }

  function afficher() {
    // répartition : ligne -> question -> réponse -> nombre
    const arbre = {};
    for (const a of liste) {
      const parLigne = (arbre[a.ligne] ||= {});
      const parQuestion = (parLigne[a.question_code] ||= {});
      parQuestion[a.reponse_code] = (parQuestion[a.reponse_code] || 0) + 1;
    }
    const blocs = Object.entries(arbre).map(([nomLigne, questions]) => el("div", { class: "carte" },
      el("h2", {}, "Ligne " + nomLigne),
      Object.entries(questions).map(([question, reponses]) => {
        const total = Object.values(reponses).reduce((s, n) => s + n, 0);
        return el("div", {}, el("strong", {}, `${question} (${total} avis)`),
          Object.entries(reponses).sort((x, y) => y[1] - x[1]).map(([rep, n]) => el("div", {},
            el("span", { class: "barre" }, el("span", { style: `width:${Math.round((n / total) * 100)}%` })),
            ` ${Math.round((n / total) * 100)} % · ${rep} (${n})`)));
      })));

    const supprimable = (a) => el("button", { class: "danger petit", onclick: () => essayer(async () => {
      if (!confirm("Supprimer cet avis ?")) return;
      await appeler("avis.supprimer", { id: a.id });
      await charger();
    }) }, "Supprimer");
    const tableau = el("div", { class: "carte tableau" }, el("h2", {}, "Derniers avis"),
      el("table", {}, el("tr", {}, ["Date", "Ligne", "Direction", "Question", "Réponse", ""].map((t) => el("th", {}, t))),
        liste.slice(0, 100).map((a) => el("tr", {}, el("td", {}, dateCourte(a.cree)), el("td", {}, a.ligne),
          el("td", {}, a.destination || ""), el("td", {}, a.question_code), el("td", {}, a.reponse_code), el("td", {}, supprimable(a))))));
    resultat.replaceChildren(...(liste.length ? [...blocs, tableau] : [el("p", { class: "discret" }, "Aucun avis sur cette période.")]));
  }

  // Export CSV (séparateur « ; » pour Excel en français). Un texte qui commence par = + - @ est neutralisé
  // (sinon un avis piégé pourrait exécuter une formule dans le tableur).
  function exporter() {
    const colonnes = ["cree", "ville", "ligne", "destination", "question_code", "reponse_code"];
    const cellule = (v) => {
      let t = String(v ?? "");
      if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
      return '"' + t.replace(/"/g, '""') + '"';
    };
    const csv = [colonnes.join(";"), ...liste.map((a) => colonnes.map((c) => cellule(a[c])).join(";"))].join("\r\n");
    const lien = el("a", { href: URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" })), download: "avis.csv" });
    lien.click();
  }

  zone.append(el("div", { class: "carte filtres" },
    el("label", { class: "champ" }, el("span", {}, "Ligne"), ligne),
    el("label", { class: "champ" }, el("span", {}, "Période"), periode),
    el("button", { onclick: () => essayer(charger) }, "Afficher"),
    el("button", { class: "contour", onclick: exporter }, "Exporter en CSV")), resultat);
  await charger();
}

async function pageUtilisateurs(zone) {
  const roles = [["editeur", "Éditeur"], ["moderateur", "Modérateur"], ...(etat.moi.proprietaire ? [["administrateur", "Administrateur"]] : [])];
  const f = formulaire([
    { nom: "email", label: "E-mail", type: "text" },
    { nom: "role", label: "Rôle", type: "select", options: roles },
    { nom: "mot_de_passe", label: "Mot de passe provisoire (12 caractères minimum)", type: "password" },
  ]);
  f.ecrire({});
  const liste = el("div", { class: "carte tableau" });

  async function recharger() {
    const utilisateurs = await appeler("utilisateurs.liste");
    const modifier = (u, valeurs) => essayer(async () => {
      await appeler("utilisateurs.modifier", { id: u.id, ...valeurs });
      dire("Enregistré");
      await recharger();
    });
    liste.replaceChildren(el("table", {}, el("tr", {}, ["E-mail", "Rôle", "Dernière connexion", "Actif", ""].map((t) => el("th", {}, t))),
      utilisateurs.map((u) => el("tr", {},
        el("td", {}, u.email + (u.proprietaire ? " (propriétaire)" : "")),
        el("td", {}, el("select", { onchange: (e) => modifier(u, { role: e.target.value }) },
          [["editeur", "Éditeur"], ["moderateur", "Modérateur"], ["administrateur", "Administrateur"]]
            .map(([v, t]) => el("option", { value: v, selected: u.role === v }, t)))),
        el("td", {}, dateCourte(u.derniere_connexion)),
        el("td", {}, u.actif ? "oui" : "non"),
        el("td", { class: "actions" },
          el("button", { class: "contour petit", onclick: () => modifier(u, { actif: !u.actif }) }, u.actif ? "Désactiver" : "Réactiver"),
          el("button", { class: "contour petit", onclick: () => {
            const mdp = prompt("Nouveau mot de passe (12 caractères minimum) :");
            if (mdp) modifier(u, { mot_de_passe: mdp });
          } }, "Nouveau mot de passe"))))));
  }

  zone.append(el("div", { class: "carte" }, el("h2", {}, "Ajouter un utilisateur"), f.noeud,
    el("button", { onclick: () => essayer(async () => {
      await appeler("utilisateurs.creer", f.lire());
      dire("Utilisateur créé");
      f.ecrire({});
      await recharger();
    }) }, "Créer")), liste);
  await recharger();
}

async function pageJournal(zone) {
  const lignes = await appeler("journal.liste");
  zone.append(el("div", { class: "carte tableau" }, el("h2", {}, "Journal des modifications"),
    el("table", {}, el("tr", {}, ["Quand", "Qui", "Action", "Cible", "Détail"].map((t) => el("th", {}, t))),
      lignes.map((l) => el("tr", {}, el("td", {}, dateCourte(l.quand)), el("td", {}, l.email || ""), el("td", {}, l.action),
        el("td", {}, l.cible || ""), el("td", {}, l.detail ? JSON.stringify(l.detail) : ""))))));
}

// ---------- Navigation et connexion ----------

const PAGES = [
  { id: "questions", titre: "Questions", roles: ["editeur"], afficher: pageQuestions },
  { id: "annonces", titre: "Annonces", roles: ["editeur"], afficher: pageAnnonces },
  { id: "styles", titre: "Formes et couleurs", roles: ["editeur"], afficher: pageStyles },
  { id: "avis", titre: "Avis", roles: ["moderateur"], afficher: pageAvis },
  { id: "utilisateurs", titre: "Utilisateurs", roles: [], afficher: pageUtilisateurs },
  { id: "journal", titre: "Journal", roles: [], afficher: pageJournal },
];

function visible(page) {
  if (page.id === "journal") return etat.moi.proprietaire;
  return etat.moi.role === "administrateur" || page.roles.includes(etat.moi.role);
}

async function ouvrir(page) {
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("actif", b.dataset.page === page.id));
  const contenu = document.getElementById("contenu");
  contenu.replaceChildren();
  await essayer(() => page.afficher(contenu));
}

function montrerConnexion() {
  etat.moi = null;
  document.getElementById("app").hidden = true;
  document.getElementById("connexion").hidden = false;
  document.getElementById("mdp").value = "";
}

async function demarrer() {
  const donnees = await appeler("villes.liste");
  etat.villes = donnees.villes || [];
  etat.reseaux = donnees.reseaux || [];
  etat.ville = etat.villes[0]?.code || "grenoble";

  const choix = document.getElementById("villeChoix");
  choix.replaceChildren(...etat.villes.map((v) => el("option", { value: v.code }, v.nom)));
  document.getElementById("qui").textContent = `${etat.moi.email} · ${etat.moi.role}`;

  const pages = PAGES.filter(visible);
  const actuelle = () => pages.find((p) => document.querySelector(`#nav button.actif`)?.dataset.page === p.id) || pages[0];
  choix.onchange = () => { etat.ville = choix.value; ouvrir(actuelle()); };
  document.getElementById("nav").replaceChildren(...pages.map((p) => el("button", { "data-page": p.id, onclick: () => ouvrir(p) }, p.titre)));

  document.getElementById("connexion").hidden = true;
  document.getElementById("app").hidden = false;
  await ouvrir(pages[0]);
}

document.getElementById("formConnexion").addEventListener("submit", (e) => {
  e.preventDefault();
  essayer(async () => {
    etat.moi = await appeler("connexion", { email: document.getElementById("email").value, mot_de_passe: document.getElementById("mdp").value });
    await demarrer();
  });
});

document.getElementById("deconnexion").addEventListener("click", () => essayer(async () => {
  await appeler("deconnexion");
  montrerConnexion();
}));

// Au chargement : une session est-elle déjà ouverte ?
appeler("moi").then((moi) => { etat.moi = moi; return demarrer(); }).catch(() => montrerConnexion());
