// Keeps one ace-server per project running for the plugin: started in the background on the first edit, sent each
// edited file, asked within a time budget, so the caller never waits on a missing, slow or dead server.
import { type ArktsLsp, type StartOptions, startArktsLsp } from './client.js';
import { projectRootFor } from './project.js';

interface Server {
  /** Undefined when the server did not start. */
  started: Promise<ArktsLsp | undefined>;
  lsp?: ArktsLsp;
  /** Files edited while the server was starting. */
  unsent: Set<string>;
}

export class WarmLsp {
  private readonly servers = new Map<string, Server>();
  private readonly stopping = new AbortController();

  constructor(
    private readonly log: (message: string) => void,
    private readonly options: StartOptions = {},
    private readonly start = startArktsLsp,
  ) {}

  /** Sends the file's text on disk to its project's server, starting that server on the project's first edit. */
  edited(file: string): void {
    if (this.stopping.signal.aborted) {
      return;
    }
    const root = projectRootFor(file);
    const server = this.servers.get(root) ?? this.launch(root);
    if (server.lsp) {
      this.open(server.lsp, file);
    } else {
      server.unsent.add(file);
    }
  }

  /**
   * The answer of the file's server, which has every edit reported before this call. Undefined when the project has no
   * running server or the answer takes longer than budgetMs, counted from the call, startup included.
   */
  async ask<T>(file: string, budgetMs: number, query: (lsp: ArktsLsp) => Promise<T>): Promise<T | undefined> {
    const server = this.servers.get(projectRootFor(file));
    if (!server) {
      return undefined;
    }
    const answer = server.started.then((lsp) => lsp && query(lsp)).catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<undefined>((r) => {
      timer = setTimeout(() => r(undefined), budgetMs);
    });
    try {
      return await Promise.race([answer, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ends every server, also one still starting; later edits start none. */
  async stop(): Promise<void> {
    this.stopping.abort();
    await Promise.all([...this.servers.values()].map(async (s) => (await s.started)?.stop()));
  }

  private launch(root: string): Server {
    const server: Server = {
      unsent: new Set(),
      started: this.start(root, { ...this.options, signal: this.stopping.signal }).then(
        (lsp) => {
          server.lsp = lsp;
          for (const file of server.unsent) {
            this.open(lsp, file);
          }
          server.unsent.clear();
          this.log(`language server ready for ${root} (${lsp.protocol})`);
          return lsp;
        },
        (e: Error) => {
          if (!this.stopping.signal.aborted) {
            this.log(`no language server for ${root}: ${e.message}`);
          }
          return undefined;
        },
      ),
    };
    this.servers.set(root, server);
    return server;
  }

  /** A file deleted since its edit can't be read: the server drops its copy. */
  private open(lsp: ArktsLsp, file: string): void {
    try {
      lsp.open(file);
    } catch {
      lsp.close(file);
    }
  }
}
