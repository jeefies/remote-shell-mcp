import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { RemoteShellError } from "./errors.js";
import { normalizeRemoteRoot } from "./util/posixPath.js";
import type { AppConfig, RemoteProfileConfig } from "./types.js";

export const profileSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().default(22),
  username: z.string().min(1),
  password: z.string().optional(),
  privateKeyPath: z.string().optional(),
  tryDefaultPrivateKeys: z.boolean().default(false),
  passphrase: z.string().optional(),
  agent: z.string().optional(),
  agentForward: z.boolean().default(false),
  shell: z.string().min(1).default("sh"),
  initCommand: z.string().min(1).optional(),
  defaultRoot: z.string().min(1),
  roots: z.array(z.string().min(1)).min(1),
  defaultTimeoutMs: z.number().int().positive().default(30_000),
  maxOutputBytes: z.number().int().positive().default(65_536),
  maxReadBytes: z.number().int().positive().default(262_144),
  fileCache: z.object({
    enabled: z.boolean().default(true),
    maxFileBytes: z.number().int().positive().default(65_536),
    ttlMs: z.number().int().nonnegative().default(5_000),
    maxEntries: z.number().int().positive().default(256),
  }).default({}),
});

export const profilePatchSchema = profileSchema.partial();

const configSchema = z.object({
  defaultProfile: z.string().min(1),
  profiles: z.record(profileSchema),
});

export type ProfileInput = z.input<typeof profileSchema>;
export type ProfilePatch = z.input<typeof profilePatchSchema>;

export interface PublicProfile {
  host: string;
  port: number;
  username: string;
  auth: {
    hasPassword: boolean;
    hasPrivateKeyPath: boolean;
    tryDefaultPrivateKeys: boolean;
    hasPassphrase: boolean;
    agent?: string;
    agentForward: boolean;
  };
  defaultRoot: string;
  roots: string[];
  shell: string;
  hasInitCommand: boolean;
  defaultTimeoutMs: number;
  maxOutputBytes: number;
  maxReadBytes: number;
  fileCache: {
    enabled: boolean;
    maxFileBytes: number;
    ttlMs: number;
    maxEntries: number;
  };
}

export interface ProfileListEntry extends PublicProfile {
  name: string;
  isDefault: boolean;
}

export function expandHome(filePath: string): string {
  if (filePath === "~") {
    return os.homedir();
  }

  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  return filePath;
}

export function resolveConfigPath(configPath = process.env.REMOTE_SHELL_CONFIG): string {
  if (!configPath) {
    throw new RemoteShellError(
      "REMOTE_SHELL_CONFIG is required and must point to a JSON config file",
      "ERR_CONFIG_MISSING",
    );
  }

  return path.resolve(expandHome(configPath));
}

export function loadConfig(configPath = process.env.REMOTE_SHELL_CONFIG): AppConfig {
  return loadConfigFromPath(resolveConfigPath(configPath));
}

function loadConfigFromPath(resolvedPath: string): AppConfig {
  const raw = fs.readFileSync(resolvedPath, "utf8");
  return normalizeConfig(configSchema.parse(JSON.parse(raw)));
}

function normalizeConfig(parsed: z.output<typeof configSchema>): AppConfig {
  if (!parsed.profiles[parsed.defaultProfile]) {
    throw new RemoteShellError("defaultProfile must exist in profiles", "ERR_CONFIG_INVALID", {
      defaultProfile: parsed.defaultProfile,
    });
  }

  const profiles: AppConfig["profiles"] = {};
  for (const [name, profile] of Object.entries(parsed.profiles)) {
    profiles[name] = normalizeProfile(profile);
  }

  return {
    defaultProfile: parsed.defaultProfile,
    profiles,
  };
}

export class ConfigStore {
  private config: AppConfig;

  constructor(private readonly configPath = resolveConfigPath()) {
    this.config = loadConfigFromPath(configPath);
  }

  getConfig(): AppConfig {
    return this.config;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  listProfiles(): { defaultProfile: string; profiles: ProfileListEntry[] } {
    return {
      defaultProfile: this.config.defaultProfile,
      profiles: Object.entries(this.config.profiles).map(([name, profile]) => ({
        name,
        isDefault: name === this.config.defaultProfile,
        ...toPublicProfile(profile),
      })),
    };
  }

  getProfile(name: string): PublicProfile {
    const profile = this.config.profiles[name];
    if (!profile) {
      throw new RemoteShellError("Profile does not exist", "ERR_PROFILE_NOT_FOUND", {
        profile: name,
        availableProfiles: Object.keys(this.config.profiles),
      });
    }

    return toPublicProfile(profile);
  }

  createProfile(name: string, profileInput: ProfileInput, makeDefault = false): ProfileListEntry {
    assertProfileName(name);
    if (this.config.profiles[name]) {
      throw new RemoteShellError("Profile already exists", "ERR_PROFILE_EXISTS", { profile: name });
    }

    const profile = normalizeProfile(profileSchema.parse(profileInput));
    this.replaceConfig({
      defaultProfile: makeDefault ? name : this.config.defaultProfile,
      profiles: {
        ...this.config.profiles,
        [name]: profile,
      },
    });

    return {
      name,
      isDefault: this.config.defaultProfile === name,
      ...toPublicProfile(this.config.profiles[name]),
    };
  }

  updateProfile(name: string, patchInput: ProfilePatch): ProfileListEntry {
    assertProfileName(name);
    const current = this.config.profiles[name];
    if (!current) {
      throw new RemoteShellError("Profile does not exist", "ERR_PROFILE_NOT_FOUND", {
        profile: name,
        availableProfiles: Object.keys(this.config.profiles),
      });
    }

    const patch = profilePatchSchema.parse(patchInput);
    const profile = normalizeProfile(profileSchema.parse({ ...current, ...patch }));
    this.replaceConfig({
      defaultProfile: this.config.defaultProfile,
      profiles: {
        ...this.config.profiles,
        [name]: profile,
      },
    });

    return {
      name,
      isDefault: this.config.defaultProfile === name,
      ...toPublicProfile(this.config.profiles[name]),
    };
  }

  deleteProfile(name: string, newDefaultProfile?: string): { deleted: string; defaultProfile: string; profiles: string[] } {
    assertProfileName(name);
    if (!this.config.profiles[name]) {
      throw new RemoteShellError("Profile does not exist", "ERR_PROFILE_NOT_FOUND", {
        profile: name,
        availableProfiles: Object.keys(this.config.profiles),
      });
    }

    const remaining = Object.fromEntries(Object.entries(this.config.profiles).filter(([profileName]) => profileName !== name));
    const remainingNames = Object.keys(remaining);
    if (remainingNames.length === 0) {
      throw new RemoteShellError("Cannot delete the last profile", "ERR_PROFILE_LAST_DELETE", { profile: name });
    }

    let defaultProfile = this.config.defaultProfile;
    if (defaultProfile === name) {
      if (!newDefaultProfile) {
        throw new RemoteShellError("Deleting the default profile requires newDefaultProfile", "ERR_DEFAULT_PROFILE_DELETE", {
          profile: name,
          remainingProfiles: remainingNames,
        });
      }

      if (!remaining[newDefaultProfile]) {
        throw new RemoteShellError("newDefaultProfile does not exist", "ERR_PROFILE_NOT_FOUND", {
          profile: newDefaultProfile,
          availableProfiles: remainingNames,
        });
      }

      defaultProfile = newDefaultProfile;
    }

    this.replaceConfig({
      defaultProfile,
      profiles: remaining,
    });

    return {
      deleted: name,
      defaultProfile: this.config.defaultProfile,
      profiles: Object.keys(this.config.profiles),
    };
  }

  setDefaultProfile(name: string): { defaultProfile: string } {
    assertProfileName(name);
    if (!this.config.profiles[name]) {
      throw new RemoteShellError("Profile does not exist", "ERR_PROFILE_NOT_FOUND", {
        profile: name,
        availableProfiles: Object.keys(this.config.profiles),
      });
    }

    this.replaceConfig({
      defaultProfile: name,
      profiles: this.config.profiles,
    });

    return { defaultProfile: this.config.defaultProfile };
  }

  private replaceConfig(next: AppConfig): void {
    const normalized = normalizeConfig(configSchema.parse(next));
    writeConfigAtomically(this.configPath, normalized);
    this.config = normalized;
  }
}

function normalizeProfile(profile: z.output<typeof profileSchema>): RemoteProfileConfig {
  const roots = profile.roots.map(normalizeRemoteRoot);
  const defaultRoot = normalizeRemoteRoot(profile.defaultRoot);

  return {
    ...profile,
    privateKeyPath: profile.privateKeyPath ? path.resolve(expandHome(profile.privateKeyPath)) : undefined,
    defaultRoot,
    roots,
  };
}

function writeConfigAtomically(configPath: string, config: AppConfig): void {
  const tmpPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, configPath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Best effort cleanup only.
    }
    throw new RemoteShellError("Failed to write config file", "ERR_CONFIG_WRITE", {
      configPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function assertProfileName(name: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new RemoteShellError("Profile name may only contain letters, numbers, dots, underscores, and dashes", "ERR_PROFILE_NAME", {
      profile: name,
    });
  }
}

function toPublicProfile(profile: RemoteProfileConfig): PublicProfile {
  return {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    auth: {
      hasPassword: Boolean(profile.password),
      hasPrivateKeyPath: Boolean(profile.privateKeyPath),
      tryDefaultPrivateKeys: profile.tryDefaultPrivateKeys,
      hasPassphrase: Boolean(profile.passphrase),
      agent: profile.agent,
      agentForward: profile.agentForward,
    },
    defaultRoot: profile.defaultRoot,
    roots: profile.roots,
    shell: profile.shell,
    hasInitCommand: Boolean(profile.initCommand),
    defaultTimeoutMs: profile.defaultTimeoutMs,
    maxOutputBytes: profile.maxOutputBytes,
    maxReadBytes: profile.maxReadBytes,
    fileCache: profile.fileCache,
  };
}
