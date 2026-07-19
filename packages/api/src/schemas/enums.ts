// @mailmetero/api — enum → JSON-schema helper.
//
// The const-array enums in `@mailmetero/contracts` are the SINGLE source: every schema/OpenAPI enum
// is generated from them, so validation, serialization, and the spec can never drift (P0-13/D16).

export function enumSchema<T extends readonly string[]>(xs: T): { type: 'string'; enum: string[] } {
  return { type: 'string', enum: [...xs] };
}
