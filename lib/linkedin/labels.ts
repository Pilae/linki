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
  invite: string, more: string | string[], pending: string, send: string | string[],
  invitationSent?: string): ProfileLabels {
  const alternatives = (values: string | string[]) =>
    (Array.isArray(values) ? values : [values]).map(escapeLabel).join("|");
  const exact = (values: string | string[]) => new RegExp(`^(?:${alternatives(values)})$`, "i");
  // LinkedIn inserts directional marks around badges in RTL interfaces.
  const badgePrefix = "^[\\u200e\\u200f]*[·•]?[\\u200e\\u200f]*\\s*";
  return {
    firstDegree: new RegExp(`${badgePrefix}${escapeLabel(first)}\\s*$`, "i"),
    otherDegree: new RegExp(`${badgePrefix}(?:${other.map(escapeLabel).join("|")})\\s*\\+?\\s*$`, "i"),
    connect: exact(connect),
    invite: new RegExp(`^${invite.split("{recipient}").map(escapeLabel).join(".+")}$`, "i"),
    more: exact(more),
    pending: new RegExp(`^${escapeLabel(pending)}(?=$|[\\s,;.–،。！，、؛؟])`, "i"),
    sendWithoutNote: exact(send),
    ...(invitationSent ? { invitationSent: exact(invitationSent) } : {}),
  };
}

export const LINKEDIN_LABELS = {
  en: observedProfileLabels("1st", ["2nd", "3rd"], "Connect", "Invite {recipient} to connect",
    ["More", "More actions", "Open actions overflow menu"], "Pending",
    ["Send now", "Send without a note", "Send invitation"], "Invitation sent"),
  fr: observedProfileLabels("1er", ["2e", "3e"], "Se connecter", "Inviter {recipient} à rejoindre votre réseau",
    ["Plus", "Plus d’actions", "Plus d'actions"], "En attente",
    ["Envoyer sans note", "Envoyer sans ajouter de note"], "Invitation envoyée"),
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
  ar_AE: observedProfileLabels("من الدرجة الأولى", ["من الدرجة الثانية", "من الدرجة الثالثة"], "تواصل", "توجيه الدعوة لـ ‏{recipient}‏ للتواصل", "المزيد", "قيد الانتظار", "إرسال دون ملاحظة"),
  bn_IN: observedProfileLabels("1ম", ["2য়", "3য়"], "সংযোগ করুন", "যোগাযোগ করতে {recipient}-কে আমন্ত্রণ জানান", "আরও", "স্থগিত আছে", "কোনও নোট ছাড়াই পাঠান"),
  fa_IR: observedProfileLabels("اول", ["دوم", "سوم"], "مرتبط کردن", "دعوت از ‏{recipient}‏ برای ارتباط گرفتن", "بیشتر", "معوق", "ارسال بدون یادداشت"),
  hi_IN: observedProfileLabels("लेवल 1", ["लेवल 2", "लेवल 3"], "कनेक्ट करें", "{recipient} को कनेक्ट करने के लिए आमंत्रित करें", "अधिक", "लंबित है", "बिना नोट के भेजें"),
  in_ID: observedProfileLabels("Ke-1", ["2nd", "Ke-2", "3rd", "ke-3"], "Connect", "Invite {recipient} to connect", "Lainnya", "Belum direspons", "Kirim tanpa catatan"),
  iw_IL: observedProfileLabels("הראשון", ["השני", "שלישית"], "להתחבר", "שליחת הזמנה להתחבר אל ‏{recipient}‏", "עוד", "בהמתנה", "שליחה בלי הערה"),
  ja_JP: observedProfileLabels("1次", ["2次", "3次"], "つながる", "{recipient}さんにつながりを申請する", "その他", "承認待ち", "挨拶なしで送信"),
  ko_KR: observedProfileLabels("1촌", ["2촌", "3촌"], "1촌 맺기", "{recipient}님에게 1촌 신청", "더 보기", "대기중", "메모 없이 보내기"),
  mr_IN: observedProfileLabels("1 ले", ["2 रे"], "कनेक्ट करा", "{recipient} यांना कनेक्ट करण्यासाठी आमंत्रित करा", "अधिक", "बाकी", "नोटशिवाय पाठवा"),
  ms_MY: observedProfileLabels("Pertama", ["ke-2", "ke-3"], "Hubung", "Jemput {recipient} untuk berhubung", "Lagi", "Menunggu kelulusan", "Hantar tanpa mesej"),
  pa_IN: observedProfileLabels("ਪਹਿਲੀ", ["ਦੂਜੀ", "ਤੀਜੀ"], "ਕਨੈਕਟ ਕਰੋ", "ਕਨੈਕਟ ਕਰਨ ਲਈ {recipient} ਨੂੰ ਸੱਦਾ ਦਿਓ", "ਹੋਰ", "ਬਾਕੀ ਹੈ", "ਬਿਨਾਂ ਨੋਟ ਦੇ ਭੇਜੋ"),
  te_IN: observedProfileLabels("1వ", ["2వ", "3వ"], "కనెక్ట్ చేయి", "కనెక్ట్ కావడానికి {recipient}‌ని ఆహ్వానించు", "మరిన్ని", "పెండింగ్‌లో ఉంది", "గమనిక లేకుండా పంపు"),
  th_TH: observedProfileLabels("ขั้นที่ 1", ["ขั้นที่ 2", "ขั้นที่ 3"], "ทำความรู้จัก", "เชิญ {recipient} ให้ทำความรู้จัก", "เพิ่มเติม", "รอดำเนินการ", "ส่งโดยไม่ต้องจดบันทึก"),
  tl_PH: observedProfileLabels("1st", ["2nd", "3rd"], "Connect", "Invite {recipient} to connect", "Higit pa", "Nakabinbin", "Magpadala nang walang note"),
  vi_VN: observedProfileLabels("1", ["2", "3"], "Kết nối", "Mời {recipient} để kết nối", "Khác", "Đang chờ", "Gửi mà không cần ghi chú"),
  zh_CN: observedProfileLabels("1 度", ["2 度", "3 度"], "加为好友", "邀请{recipient}加为好友", "更多", "待处理", "发送时不添加备注"),
  zh_TW: observedProfileLabels("1 度", ["2 度", "3 度"], "建立關係", "邀請{recipient}加為好友", "更多", "未回覆", "不附加備註即傳送"),
} satisfies Record<string, ProfileLabels>;

export type LinkedInLocale = keyof typeof LINKEDIN_LABELS;

const labelMatchers = new Map<keyof ProfileLabels, RegExp>();

/** Match supported evidence regardless of browser locale: the account's UI
 * language can differ from the browser's en-US preference. Preserve each
 * label's anchors and prefix rules; never translate or fuzzy-match actions. */
export function linkedinLabel(key: keyof ProfileLabels): RegExp {
  let matcher = labelMatchers.get(key);
  if (!matcher) {
    matcher = new RegExp((Object.values(LINKEDIN_LABELS) as ProfileLabels[])
      .flatMap(labels => labels[key] ? [`(?:${labels[key]!.source})`] : []).join("|"), "i");
    labelMatchers.set(key, matcher);
  }
  return matcher;
}
