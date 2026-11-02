import { isMap, isScalar, parseDocument } from 'yaml';
import { z } from 'zod';
import semver from 'semver';

const yamlVersionFileSchema = z.object({
  path: z.string().min(1),
  format: z.literal('yaml').optional(),
  fields: z.array(z.string().regex(/^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*$/)).min(1)
    .refine(fields => new Set(fields).size === fields.length, 'Version fields must be unique'),
}).strict();
export const versionFileSchema = z.union([yamlVersionFileSchema, z.object({
  path: z.string().min(1),
  format: z.literal('text'),
}).strict()]);
export type VersionFile = z.infer<typeof versionFileSchema>;

function versionDocument(content: string, file: z.infer<typeof yamlVersionFileSchema>) {
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

function textVersion(content: string, file: VersionFile): string {
  // Only a single version is allowed; never replace arbitrary file contents.
  const version = content.replace(/\r?\n$/, '');
  if (!/^v?\d/.test(version) || /\s/.test(version) || version.includes('+') || !semver.valid(version)) {
    throw new Error(`Version file must contain one SemVer without build metadata: ${file.path}`);
  }
  return version;
}

export function updateVersionFile(content: string, file: VersionFile, version: string): string {
  if (file.format === 'text') {
    textVersion(content, file);
    textVersion(version, file);
    return version + '\n';
  }
  const document = versionDocument(content, file);
  for (const field of file.fields) document.setIn(field.split('.'), version);
  return document.toString();
}

export function validateVersionFile(content: string, file: VersionFile, version: string): void {
  if (file.format === 'text') {
    if (textVersion(content, file) !== version) throw new Error(`Release version mismatch: ${file.path}; expected ${version}`);
    return;
  }
  const document = versionDocument(content, file);
  for (const field of file.fields) {
    if (document.getIn(field.split('.')) !== version) throw new Error(`Release version mismatch: ${file.path}:${field}; expected ${version}`);
  }
}
