// Outils communs à l'API de l'admin.
// La clé secrète Supabase reste ici, côté serveur : elle n'est jamais envoyée au navigateur.
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

// Mot de passe -> "sel:empreinte" (scrypt est intégré à Node, rien à installer)
function hacher(motDePasse) {
  const sel = crypto.randomBytes(16).toString("hex");
  const empreinte = crypto.scryptSync(motDePasse, sel, 64).toString("hex");
  return sel + ":" + empreinte;
}

function verifier(motDePasse, stocke) {
  const [sel, empreinte] = String(stocke || "").split(":");
  if (!sel || !empreinte) return false;
  const calcule = crypto.scryptSync(motDePasse, sel, 64);
  const attendu = Buffer.from(empreinte, "hex");
  return attendu.length === calcule.length && crypto.timingSafeEqual(calcule, attendu);
}

// Empreinte factice : on calcule toujours un hash, même si l'e-mail n'existe pas
// (sinon le temps de réponse révèle quels e-mails existent)
const FAUX = hacher("empreinte-factice");

// Le jeton de session vit dans le cookie ; en base on ne garde que son empreinte
function empreinteJeton(jeton) {
  return crypto.createHash("sha256").update(jeton).digest("hex");
}

module.exports = { supabase, hacher, verifier, empreinteJeton, crypto, FAUX };
