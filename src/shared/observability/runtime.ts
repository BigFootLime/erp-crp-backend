const TOKEN_PATTERN = /^[a-zA-Z0-9._:-]{1,64}$/;

function safeToken(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? "";
  return TOKEN_PATTERN.test(trimmed) ? trimmed : fallback;
}

export const runtimeMetadata = Object.freeze({
  service: safeToken(process.env.CERP_SERVICE_NAME, "cerp-api"),
  version: safeToken(
    process.env.CERP_RELEASE_VERSION ?? process.env.npm_package_version,
    "unknown"
  ),
  environment: safeToken(
    process.env.CERP_ENVIRONMENT ?? process.env.NODE_ENV,
    "unknown"
  ),
});

