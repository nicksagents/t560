export function cleanSchemaForGemini<T>(schema: T): T {
  // Recovery build: keep schema as-is.
  return schema;
}
