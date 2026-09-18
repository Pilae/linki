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
  invitationSent: RegExp;
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
} satisfies Record<string, ProfileLabels>;

export type LinkedInLocale = keyof typeof LINKEDIN_LABELS;

/** Match supported evidence regardless of browser locale: the account's UI
 * language can differ from the browser's en-US preference. Preserve each
 * label's anchors and prefix rules; never translate or fuzzy-match actions. */
export function linkedinLabel(key: keyof ProfileLabels): RegExp {
  return new RegExp(Object.values(LINKEDIN_LABELS)
    .map(labels => `(?:${labels[key].source})`).join("|"), "i");
}
