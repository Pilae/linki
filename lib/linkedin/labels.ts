/** LinkedIn UI evidence, not Linki's own UI translations. Add a locale only with
 * fixtures for its observed labels. Unknown labels must never imply success. */
interface ProfileLabels {
  firstDegree: RegExp;
  otherDegree: RegExp;
  connect: RegExp;
  invite: RegExp;
  more: RegExp;
  pending: RegExp;
  sendWithoutNote: RegExp;
  invitationSent?: RegExp;
}

function escapeLabel(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Exact observed action labels; the recipient is the only variable part.
 * Success toasts are deliberately absent until observed without guessing. */
function observedProfileLabels(first: string, other: string[], connect: string,
  invite: string, more: string, pending: string, send: string): ProfileLabels {
  const exact = (value: string) => new RegExp(`^${escapeLabel(value)}$`, "i");
  return {
    firstDegree: new RegExp(`^[·•]?\\s*${escapeLabel(first)}\\s*$`, "i"),
    otherDegree: new RegExp(`^[·•]?\\s*(?:${other.map(escapeLabel).join("|")})\\s*\\+?\\s*$`, "i"),
    connect: exact(connect),
    invite: new RegExp(`^${invite.split("{recipient}").map(escapeLabel).join(".+")}$`, "i"),
    more: exact(more),
    pending: new RegExp(`^${escapeLabel(pending)}(?:$|[\\s,;.–])`, "i"),
    sendWithoutNote: exact(send),
  };
}

export const LINKEDIN_LABELS = {
  en: {
    firstDegree: /^[·•]?\s*1st\s*$/i,
    otherDegree: /^[·•]?\s*(?:2nd|3rd)\s*\+?\s*$/i,
    connect: /^Connect$/i,
    invite: /Invite.*to connect/i,
    more: /^(?:More|More actions|Open actions overflow menu)$/i,
    pending: /^Pending(?:$|[\s,])/i,
    sendWithoutNote: /^(?:Send now|Send without(?:$|\s)|Send invitation(?!.*note))/i,
    invitationSent: /^Invitation sent$/i,
  },
  fr: {
    firstDegree: /^[·•]?\s*1er\s*$/i,
    otherDegree: /^[·•]?\s*(?:2e|3e)\s*\+?\s*$/i,
    connect: /^Se connecter$/i,
    invite: /^Inviter .+ à rejoindre votre réseau$/i,
    more: /^(?:Plus|Plus d’actions|Plus d'actions)$/i,
    pending: /^En attente(?:$|[\s,])/i,
    sendWithoutNote: /^(?:Envoyer sans note|Envoyer sans ajouter de note)$/i,
    invitationSent: /^Invitation envoyée$/i,
  },
  de_DE: observedProfileLabels("1.", ["2.", "3."], "Vernetzen", "{recipient} als Kontakt einladen", "Mehr", "Ausstehend", "Ohne Notiz senden"),
  es_ES: observedProfileLabels("1er", ["2º", "3er"], "Conectar", "Invita a {recipient} a conectar", "Más", "Pendiente", "Enviar sin nota"),
  it_IT: observedProfileLabels("1°", ["2°", "3°"], "Collegati", "Invita {recipient} a collegarsi", "Altro", "In sospeso", "Invia senza nota"),
  nl_NL: observedProfileLabels("1ste", ["2e", "3de"], "Connectie maken", "Connectieverzoek verzenden naar {recipient}", "Meer", "In behandeling", "Verzenden zonder opmerking"),
  pt_BR: observedProfileLabels("1º", ["2º", "3º"], "Conectar", "Convidar {recipient} para se conectar", "Mais", "Pendente", "Enviar sem nota"),
  pl_PL: observedProfileLabels("1.", ["2.", "3."], "Połącz", "Zaproś użytkownika {recipient} do nawiązania kontaktu", "Więcej", "W toku", "Wyślij bez notatki"),
  cs_CZ: observedProfileLabels("1.", ["2.", "3."], "Navázat spojení", "Pozvat uživatele {recipient} ke spojení", "Více", "Čeká na vyřízení", "Odeslat bez poznámky"),
  da_DK: observedProfileLabels("1.", ["3."], "Opret forbindelse", "Inviter {recipient} til dit netværk", "Mere", "Ventende", "Send uden en note"),
  el_GR: observedProfileLabels("1η", ["2η", "3η"], "Σύνδεση", "Προσκαλέστε τον χρήστη {recipient} για σύνδεση", "Περισσότερα", "Σε εκκρεμότητα", "Αποστολή χωρίς σημείωση"),
  fi_FI: observedProfileLabels("1.", ["2.", "3."], "Muodosta yhteys", "Kutsu {recipient} verkostoitumaan", "Enemmän", "Odottaa", "Lähetä ilman tekstiä"),
  hu_HU: observedProfileLabels("első", ["második", "harmadik"], "Társítom", "{recipient} meghívása, hogy kapcsolódjon Önhöz", "Továbbiak", "Függőben", "Küldés megjegyzés nélkül"),
  no_NO: observedProfileLabels("1.", ["2.", "3."], "Knytt kontakt", "Inviter {recipient} til å knytte kontakt", "Mer", "Venter", "Send uten notat"),
  ro_RO: observedProfileLabels("Gr. 1", ["Gr. 2", "3"], "Conectați-vă", "Invitați pe {recipient} să se conecteze", "Mai multe", "Între timp", "Trimiteți fără notă"),
  ru_RU: observedProfileLabels("1-й", ["2-й", "3-й"], "Установить контакт", "Пригласить участника {recipient} установить контакт", "Еще", "На рассмотрении", "Отправить без заметки"),
  sv_SE: observedProfileLabels("1:a", ["2:a", "3:e"], "Skapa kontakt", "Skicka en kontaktinbjudan till {recipient}", "Mer", "Obesvarad", "Skicka utan meddelande"),
  tr_TR: observedProfileLabels("1.", ["2.", "3. derece"], "Bağlantı kur", "{recipient} adlı kullanıcıyı bağlantı kurmak için davet et", "Daha fazla", "Beklemede", "Not olmadan gönderin"),
  uk_UA: observedProfileLabels("1-й", ["2-й", "3-й"], "Встановити контакт", "Надіслати запрошення учасникові {recipient}, щоб встановити контакт", "Більше", "Розглядається", "Надіслати без примітки"),
} satisfies Record<string, ProfileLabels>;

export type LinkedInLocale = keyof typeof LINKEDIN_LABELS;

/** Match supported evidence regardless of browser locale: the account's UI
 * language can differ from the browser's en-US preference. Preserve each
 * label's anchors and prefix rules; never translate or fuzzy-match actions. */
export function linkedinLabel(key: keyof ProfileLabels): RegExp {
  return new RegExp((Object.values(LINKEDIN_LABELS) as ProfileLabels[])
    .flatMap(labels => labels[key] ? [`(?:${labels[key]!.source})`] : []).join("|"), "i");
}
