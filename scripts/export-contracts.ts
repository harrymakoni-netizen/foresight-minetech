import { zodToJsonSchema } from "zod-to-json-schema";
import { writeFileSync } from "node:fs";
import { scenarioSchema } from "../lib/domain/scenario.ts";
import {
  extractionSchema,
  visionEventSchema,
} from "../lib/domain/contracts.ts";
for (const [name, schema] of [
  ["scenario-1.0", scenarioSchema],
  ["extraction-1.0", extractionSchema],
  ["vision-event-1.0", visionEventSchema],
] as const)
  writeFileSync(
    `contracts/${name}.schema.json`,
    JSON.stringify(
      zodToJsonSchema(schema, { name, $refStrategy: "none" }),
      null,
      2,
    ) + "\n",
  );
