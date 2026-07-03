import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  AllowlistConfig,
  AllowlistConfigSchema,
  GroupsConfig,
  GroupsConfigSchema,
  GuidesConfig,
  GuidesConfigSchema,
  SettingsConfig,
  SettingsConfigSchema,
  TemplatesConfig,
  TemplatesConfigSchema,
  ToursConfig,
  ToursConfigSchema,
} from './schemas.js';
import { z } from 'zod';

export interface AppConfig {
  groups: GroupsConfig;
  tours: ToursConfig;
  templates: TemplatesConfig;
  allowlist: AllowlistConfig;
  settings: SettingsConfig;
  guides: GuidesConfig;
}

function readYaml<S extends z.ZodTypeAny>(filePath: string, schema: S): z.output<S> {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = yaml.load(raw);
  try {
    return schema.parse(parsed);
  } catch (err) {
    throw new Error(`Invalid config at ${filePath}: ${(err as Error).message}`);
  }
}

export interface LoadConfigOpts {
  /**
   * Optional overlay directory (typically the Railway persistent volume).
   * When present, any *.yaml here is loaded INSTEAD of the bundled file
   * with the same name. Lets operators edit tours.yaml at runtime without
   * a redeploy.
   */
  overlayDir?: string;
}

export function loadConfig(configDir: string, opts: LoadConfigOpts = {}): AppConfig {
  const resolve = (name: string): string => {
    if (opts.overlayDir) {
      const overlayed = path.join(opts.overlayDir, name);
      if (fs.existsSync(overlayed)) return overlayed;
    }
    return path.join(configDir, name);
  };
  // guides.yaml is optional: older deployments / test fixtures may not ship it.
  // Fall back to an empty roster so the guide-notify job simply finds no
  // targets rather than crashing config load.
  const guidesPath = resolve('guides.yaml');
  const guides = fs.existsSync(guidesPath)
    ? readYaml(guidesPath, GuidesConfigSchema)
    : { guides: [] };

  return {
    groups: readYaml(resolve('groups.yaml'), GroupsConfigSchema),
    tours: readYaml(resolve('tours.yaml'), ToursConfigSchema),
    templates: readYaml(resolve('templates.yaml'), TemplatesConfigSchema),
    allowlist: readYaml(resolve('allowlist.yaml'), AllowlistConfigSchema),
    settings: readYaml(resolve('settings.yaml'), SettingsConfigSchema),
    guides,
  };
}
