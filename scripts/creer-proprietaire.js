// Crée le compte propriétaire (le tien). À lancer une seule fois, sur ton ordinateur :
//   npm install
//   node --env-file=.env.local scripts/creer-proprietaire.js eliott.menuge@outlook.fr
// Le fichier .env.local contient SUPABASE_URL et SUPABASE_SECRET_KEY (il n'est jamais publié).
const readline = require("readline");
const { supabase, hacher } = require("../api/_lib");

// Pose une question sans afficher ce qui est tapé (le mot de passe reste invisible)
function demander(question) {
  return new Promise((fini) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let cache = false;
    rl._writeToOutput = (texte) => { if (!cache) process.stdout.write(texte); };
    rl.question(question, (reponse) => { rl.close(); console.log(); fini(reponse); });
    cache = true;
  });
}

async function principal() {
  const email = (process.argv[2] || "").trim().toLowerCase();
  if (!email.includes("@")) {
    console.log("Indiquez l'e-mail : node --env-file=.env.local scripts/creer-proprietaire.js vous@exemple.fr");
    process.exit(1);
  }
  const mdp = await demander("Mot de passe (12 caractères minimum) : ");
  const confirmation = await demander("Confirmez le mot de passe : ");
  if (mdp.length < 12 || mdp !== confirmation) {
    console.log("Mot de passe trop court ou différent. Rien n'a été créé.");
    process.exit(1);
  }
  const { error } = await supabase.from("admin_utilisateurs")
    .insert({ email, mot_de_passe: hacher(mdp), role: "administrateur", proprietaire: true });
  if (error) {
    console.log("Erreur :", error.message);
    process.exit(1);
  }
  console.log("Compte propriétaire créé pour", email);
}

principal();
