// Pre-entry checklist (spec §10): 4-5 yes/no questions configured per mine,
// asked on `CHECK <shaft>` over WhatsApp/SMS. Answers are stored as evidence.
import { z } from "zod";

export const preEntryQuestionSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
    text: z.string().trim().min(5).max(140),
  })
  .strict();
export const preEntryConfigSchema = z
  .object({ questions: z.array(preEntryQuestionSchema).min(1).max(5) })
  .strict();
export type PreEntryConfig = z.infer<typeof preEntryConfigSchema>;
/** Starting list covering the spec's five topics; each mine edits its own. */
export const defaultPreEntry: PreEntryConfig = {
  questions: [
    { key: "supports", text: "Are the roof supports in place and undamaged?" },
    { key: "loose-rock", text: "Is the area free of loose rock?" },
    { key: "water-level", text: "Is the water level at the sump below the danger mark?" },
    { key: "ladders", text: "Are the ladderways clear and in good condition?" },
    { key: "hoist", text: "Is the hoist working and the cage available?" },
  ],
};
export type PreEntryAnswer = { key: string; text: string; answer: "yes" | "no" };
export type PreEntryRecord = { id: string; shaftId: string; shaftName: string; at: string; by: string; answers: PreEntryAnswer[] };

/** Strict yes/no; anything else is asked again, never guessed. */
export function parseYesNo(text: string): "yes" | "no" | null {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (["y", "yes"].includes(t)) return "yes";
  if (["n", "no"].includes(t)) return "no";
  return null;
}
