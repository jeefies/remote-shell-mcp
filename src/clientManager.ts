import type { AppConfig, RemoteClient } from "./types.js";
import { RemoteShellError } from "./errors.js";
import { SshRemoteClient } from "./remote/SshRemoteClient.js";

export class ClientManager {
  private readonly clients = new Map<string, RemoteClient>();

  constructor(private readonly configSource: AppConfig | (() => AppConfig)) {}

  get(profileName = this.config.defaultProfile): RemoteClient {
    const config = this.config;
    const profile = config.profiles[profileName];
    if (!profile) {
      throw new RemoteShellError("Unknown remote profile", "ERR_UNKNOWN_PROFILE", {
        profile: profileName,
        availableProfiles: Object.keys(config.profiles),
      });
    }

    const existing = this.clients.get(profileName);
    if (existing) {
      return existing;
    }

    const client = new SshRemoteClient(profileName, profile);
    this.clients.set(profileName, client);
    return client;
  }

  async invalidate(profileName: string): Promise<void> {
    const existing = this.clients.get(profileName);
    if (!existing) {
      return;
    }

    await existing.close();
    this.clients.delete(profileName);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.close()));
    this.clients.clear();
  }

  private get config(): AppConfig {
    return typeof this.configSource === "function" ? this.configSource() : this.configSource;
  }
}
