export async function modelClientFromEnv(env = process.env) {
  if (env.UNMASK_MODEL === undefined || env.UNMASK_MODEL === "off")
    return undefined;
  if (
    env.UNMASK_MODEL !== "on" ||
    (env.UNMASK_MODEL_QUOTA_VERIFIED !== undefined &&
      !["true", "false"].includes(env.UNMASK_MODEL_QUOTA_VERIFIED))
  )
    throw new TypeError("Invalid model configuration");
  const preferred = env.GEMINI_API_KEY;
  const alias = env.UNMASK_MODEL_KEY;
  if (preferred !== undefined && alias !== undefined && preferred !== alias)
    throw new TypeError("Conflicting model key configuration");
  const apiKey = preferred ?? alias;
  if (env.UNMASK_MODEL_QUOTA_VERIFIED === "false" && apiKey === undefined)
    return undefined;
  if (
    typeof apiKey !== "string" ||
    apiKey.length < 1 ||
    apiKey.length > 4096 ||
    /[\s\x00-\x1f\x7f]/u.test(apiKey)
  )
    throw new TypeError("Invalid model key configuration");
  const quota = (name, fallback) => {
    const value = env[name] ?? fallback;
    if (
      typeof value !== "string" ||
      !/^[1-9][0-9]*$/.test(value) ||
      !Number.isSafeInteger(Number(value))
    )
      throw new TypeError("Invalid model quota configuration");
    return Number(value);
  };
  const provider = env.UNMASK_MODEL_PROVIDER ?? "google";
  if (!["google", "gemini"].includes(provider))
    throw new TypeError("Invalid model provider configuration");
  const legacy =
    env.UNMASK_MODEL_REQUESTS_PER_MINUTE !== undefined ||
    env.UNMASK_MODEL_DAILY_REQUESTS !== undefined;
  if (
    legacy &&
    (env.UNMASK_MODEL_QUOTA_VERIFIED !== "true" ||
      env.UNMASK_MODEL_GENERATIONS_PER_MINUTE !== undefined ||
      env.UNMASK_MODEL_GENERATIONS_PER_DAY !== undefined)
  )
    throw new TypeError("Conflicting model quota configuration");
  const options = {
    apiKey,
    provider,
    quotaVerified: env.UNMASK_MODEL_QUOTA_VERIFIED === "true",
    ...(legacy
      ? {
          requestsPerMinute: quota("UNMASK_MODEL_REQUESTS_PER_MINUTE"),
          inputTokensPerMinute: quota("UNMASK_MODEL_INPUT_TOKENS_PER_MINUTE"),
          dailyRequests: quota("UNMASK_MODEL_DAILY_REQUESTS"),
        }
      : {
          localLimits: {
            generationsPerMinute: quota(
              "UNMASK_MODEL_GENERATIONS_PER_MINUTE",
              "2",
            ),
            inputTokensPerMinute: quota(
              "UNMASK_MODEL_INPUT_TOKENS_PER_MINUTE",
              "8000",
            ),
            generationsPerDay: quota("UNMASK_MODEL_GENERATIONS_PER_DAY", "100"),
          },
        }),
  };
  const { createGemmaClient, DEFAULT_MODEL_ROUTE } =
    await import("./client.mjs");
  if (env.UNMASK_MODEL_ROUTE !== undefined) {
    try {
      if (
        typeof env.UNMASK_MODEL_ROUTE !== "string" ||
        env.UNMASK_MODEL_ROUTE.length > 2048
      )
        throw new Error();
      options.route = JSON.parse(env.UNMASK_MODEL_ROUTE);
    } catch {
      throw new TypeError("Invalid model route configuration");
    }
    if (env.UNMASK_MODEL_ID !== undefined)
      options.modelId = env.UNMASK_MODEL_ID;
  } else if (env.UNMASK_MODEL_ID !== undefined)
    options.modelId = env.UNMASK_MODEL_ID;
  else options.route = DEFAULT_MODEL_ROUTE;
  return createGemmaClient(options);
}
