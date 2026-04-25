import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  AllowlistConfig,
  AllowlistConfigSchema,
  GroupsConfig,
  GroupsConfigSchema,
  SettingsConfig,
  SettingsConfigSchema,
  TemplatesConfig,
  TemplatesConfigSchema,
  ToursConfig,
  ToursConfigSchema,
} from './schemas';
import { z } from 'zod';

export interface AppConfig {
  groups: GroupsConfig;
  tours: ToursConfig;
  templates: TemplatesConfig;
  allowlist: AllowlistConfig;
  settings: SettingsConfig;
}

function readYaml<T>(filePath: string, schema: z.ZodType<T>): T {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = yaml.load(raw);
  try {
    return schema.parse(parsed);
  } catch (err) {
    throw new Error(`Invalid config at ${filePath}: ${(err as Error).message}`);
  }
}

export function loadConfig(configDir: string): AppConfig {
  const p = (name: string) => path.join(configDir, name);
  return {
    groups: readYaml(p('groups.yaml'), GroupsConfigSchema),
    tours: readYaml(p('tours.yaml'), ToursConfigSchema),
    templates: readYaml(p('templates.yaml'), TemplatesConfigSchema),
    allowlist: readYaml(p('allowlist.yaml'), AllowlistConfigSchema),
    settings: readYaml(p('settings.yaml'), SettingsConfigSchema),
  };
}
