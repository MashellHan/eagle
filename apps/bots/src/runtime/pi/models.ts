// The process-wide model access (docs/bots/RUNTIME.md, "Harness construction"): one
// `Models` for every bot, built once from the daemon's configuration.
import { createModels, createProvider, envApiKeyAuth, type Models } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

export type ModelsConfig = {
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly provider: string;
  readonly modelId: string;
};

/** No gateway means an empty registry: a run settles `no_model` until settings exist. */
export const createDaemonModels = (config: ModelsConfig | undefined): Models => {
  const models = createModels();
  if (config === undefined) return models;
  models.setProvider(
    createProvider({
      id: config.provider,
      name: "Bots model endpoint",
      baseUrl: config.baseUrl,
      auth: { apiKey: envApiKeyAuth("Bots model API key", [config.apiKeyEnv]) },
      models: [
        {
          id: config.modelId,
          name: config.modelId,
          provider: config.provider,
          baseUrl: config.baseUrl,
          api: "openai-responses",
          reasoning: true,
          input: ["text"],
          contextWindow: 200_000,
          maxTokens: 8_192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      api: openAIResponsesApi(),
    }),
  );
  return models;
};
