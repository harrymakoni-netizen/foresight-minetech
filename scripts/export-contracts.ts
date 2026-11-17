import { zodToJsonSchema } from "zod-to-json-schema";
import { writeFileSync } from "node:fs";
import { scenarioSchema } from "../lib/domain/scenario.ts";
import {
  mineModelSchema,
  toEscapeNetwork,
  trainingMineModel,
} from "../lib/domain/mine-model.ts";
import {
  messagingConfigSchema,
  personSchema,
  manualCheckInSchema,
} from "../lib/domain/checkin.ts";
import { incidentSchema } from "../lib/domain/contracts.ts";
import {
  extractionSchema,
  visionEventSchema,
} from "../lib/domain/contracts.ts";
for (const [name, schema] of [
  ["scenario-1.0", scenarioSchema],
  ["extraction-1.0", extractionSchema],
  ["vision-event-1.0", visionEventSchema],
  ["mine-model-1", mineModelSchema],
  ["messaging-config-1", messagingConfigSchema],
  ["person-1", personSchema],
  ["manual-check-in-1", manualCheckInSchema],
  ["incident-1", incidentSchema],
] as const)
  writeFileSync(
    `contracts/${name}.schema.json`,
    JSON.stringify(
      zodToJsonSchema(schema, { name, $refStrategy: "none" }),
      null,
      2,
    ) + "\n",
  );
// Shared fixture: the training template and its escape-engine network, read by
// the Python tests so both languages exercise the same model.
const template = trainingMineModel();
writeFileSync(
  "fixtures/mine/training-template.json",
  JSON.stringify({ model: template, escapeNetwork: toEscapeNetwork(template) }, null, 2) + "\n",
);
