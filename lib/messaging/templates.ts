// Every message Foresight sends is a keyed template (spec §6.2). English is
// complete; Shona ("sn") and Ndebele ("nd") are added in phase 11 by
// supplying the same keys. A missing translation falls back to English and
// the message record notes the fallback.
export type Lang = "en" | "sn" | "nd";
type Vars = Record<string, string | number>;
const en = {
  "consent.request":
    "Foresight records your name, phone number, shaft, times and buddy so someone notices if you do not come back. Supervisors and administrators of {mine} can see it. Reply YES to agree, or STOP to be removed.",
  "consent.recorded": "Thank you. Consent recorded. Send IN to check in.",
  "consent.required": "Reply YES to agree before checking in, or STOP to be removed.",
  "consent.removed":
    "You will not receive further messages. Your removal request was sent to the mine administrator.",
  "unknown.number":
    "This number is not registered with Foresight at {mine}. Please contact your supervisor.",
  help: "Check in: IN <shaft> <HHMM> <buddy>, e.g. IN 1 1430 TENDAI. Or send IN and answer the questions. Check out: OUT. Shafts: {shafts}",
  "ask.shaft": "Which shaft? {shafts}",
  "ask.return": "When will you be back up? Reply like 14:30",
  "ask.return.format": "Please send the time like 14:30.",
  "ask.return.past": "That time has passed. When will you be back up? Reply like 14:30",
  "ask.return.too-far":
    "That is more than {maxHours} hours away. When will you be back up? Reply like 14:30",
  "ask.buddy": "Who is your buddy? {options}",
  "ask.buddy.number": "Send your buddy's number, e.g. +263771234567",
  "ask.buddy.unknown": "Buddy not found. {options}",
  "ask.shaft.unknown": "Shaft not found. {shafts}",
  "checkin.registered":
    "Registered: {shaft}, back by {time}, buddy {buddy}. Ref {ref}. Reply OUT when you are back up.",
  "checkin.already":
    "You are already declared underground at {shaft} (Ref {ref}). Reply OUT when you are back up.",
  "checkout.done": "Welcome back. Checked out {time}.",
  "checkout.none": "You are not checked in. Send IN to check in.",
  "team.registered": "Team registered at {shaft}, back by {time}. {count} people. Ref {refs}.{skipped}",
  "team.not-authorised": "Only a registered shift boss can check in a team.",
  "reminder.miner":
    "Foresight: your return time {time} at {shaft} has passed. Reply OUT when you are back up.",
  "overdue.buddy":
    "Foresight: {name} has not checked out from {shaft}. Expected back {time}. Please check on them and tell the supervisor.",
  "overdue.supervisor":
    "Foresight: {name} is overdue at {shaft} (expected {time}). Buddy {buddy} was alerted {buddyAt}. A muster is open for {shaft}.",
  "unknown.supervisor": "Foresight: an unregistered number messaged the check-in line at {at}.",
  "gateway.offline": "Foresight: SMS gateway {gateway} is offline ({reason}). Overdue alerts by SMS may not be sent.",
  "emergency.buddy":
    "Foresight: an emergency ({type}) was declared at {shaft}. {name} was declared underground there. Rescue teams have the roll. Do not go underground.",
  "emergency.kin":
    "Foresight: an emergency ({type}) was declared at {shaft} where {name} was declared underground. The mine will contact you with news.",
} as const;
export type TemplateKey = keyof typeof en;
export const templates: Record<Lang, Partial<Record<TemplateKey, string>>> = {
  en,
  sn: {},
  nd: {},
};
export function render(key: TemplateKey, vars: Vars = {}, lang: Lang = "en") {
  const source = templates[lang][key] ?? en[key];
  const text = source.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in vars ? String(vars[name]) : `{${name}}`,
  );
  if (/\{\w+\}/.test(text)) throw new Error(`Template ${key} is missing a value`);
  return { key, text, lang: templates[lang][key] ? lang : "en", fallback: !templates[lang][key] };
}
