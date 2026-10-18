import { list, type Context } from "./repository.ts";
// Length-preserving masks keep source UTF-16 offsets stable. This is deliberately
// conservative filtering, not a claim of comprehensive named-entity detection.
export async function permittedModelText(ctx: Context, text: string) {
  let redactions = 0;
  const mask = (value: string) => {
    redactions++;
    return "█".repeat(value.length);
  };
  let permitted = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, mask);
  permitted = permitted.replace(/\+\d[\d ().-]{6,}\d/g, mask);
  permitted = permitted.replace(
    /((?:phone|contact|mobile|tel)\s*[:=]?\s*)(\d[\d ().-]{6,}\d)/gi,
    (_, label: string, phone: string) => label + mask(phone),
  );
  for (const worker of await list(ctx, "worker")) {
    const identifiers = [String(worker.data.name || ""), worker.id].filter(
      (x) => x.length >= 3,
    );
    for (const value of identifiers) {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      permitted = permitted.replace(new RegExp(escaped, "gi"), mask);
    }
  }
  return { text: permitted, redactions };
}
