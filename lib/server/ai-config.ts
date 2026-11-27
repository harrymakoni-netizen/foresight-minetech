import { createGateway, type LanguageModel } from "ai";
import { createGoogle } from "@ai-sdk/google";

// This module is imported only by server routes. Never return credentials in status.
export function aiConfiguration() {
  const provider =
    process.env.FORESIGHT_AI_PROVIDER ||
    (process.env.FORESIGHT_AI_MODEL
      ? "gateway"
      : process.env.GEMINI_MODEL
        ? "google"
        : "gateway");
  const modelId = (
    process.env.FORESIGHT_AI_MODEL ||
    (provider === "google" ? process.env.GEMINI_MODEL : "") ||
    ""
  ).trim();
  const key = (
    provider === "google"
      ? process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
        process.env.GEMINI_API_KEY ||
        ""
      : process.env.AI_GATEWAY_API_KEY || ""
  ).trim();
  const validProvider = provider === "gateway" || provider === "google";
  const validModel =
    provider === "gateway"
      ? /^[a-z0-9-]+\/[a-zA-Z0-9._:/-]+$/.test(modelId)
      : /^[a-zA-Z0-9._-]+$/.test(modelId);
  const configured =
    validProvider &&
    validModel &&
    key.length >= 16 &&
    !/^(SET_|YOUR_|REPLACE)/i.test(key);
  return {
    configured,
    provider,
    modelId,
    // Presence and syntax checks do not establish provider authorization. Generation checks that.
    message: configured
      ? "Model configured. Proposed facts still require supervisor review."
      : "AI extraction is not set up. Your report can be saved and reviewed manually.",
    model(): LanguageModel {
      if (!configured)
        throw new Error("AI configuration is incomplete or invalid");
      return provider === "google"
        ? createGoogle({ apiKey: key })(modelId)
        : createGateway({ apiKey: key })(modelId);
    },
  };
}
export function aiStatus() {
  const { configured, message } = aiConfiguration();
  return { configured, message };
}
