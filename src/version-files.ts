import { isMap, isScalar, parseDocument } from 'yaml';
import { z } from 'zod';

export const versionFileSchema = z.object({
  path: z.string().min(1),
  fields: z.array(z.string().regex(/^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*$/)).min(1)
    .refine(fields => new Set(fields).size === fields.length, 'Version fields must be unique'),
}).strict();
export type VersionFile = z.infer<typeof versionFileSchema>;

function versionDocument(content: string, file: VersionFile) {
  const document = parseDocument(content);
  if (document.errors.length) throw new Error(`Invalid version-file YAML: ${file.path}`);
  for (const field of file.fields) {
    const keys = field.split('.');
    let node: unknown = document.contents;
    for (const key of keys) {
      if (!isMap(node) || node.anchor) throw new Error(`Version field must use plain mappings: ${file.path}:${field}`);
      node = node.get(key, true);
    }
    if (!isScalar(node) || typeof node.value !== 'string' || node.anchor) {
      throw new Error(`Version field must be an existing unanchored string: ${file.path}:${field}`);
    }
  }
  return document;
}

export function updateVersionFile(content: string, file: VersionFile, version: string): string {
  const document = versionDocument(content, file);
  for (const field of file.fields) document.setIn(field.split('.'), version);
  return document.toString();
}

export function validateVersionFile(content: string, file: VersionFile, version: string): void {
  const document = versionDocument(content, file);
  for (const field of file.fields) {
    if (document.getIn(field.split('.')) !== version) throw new Error(`Release version mismatch: ${file.path}:${field}; expected ${version}`);
  }
}
