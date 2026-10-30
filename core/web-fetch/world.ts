/** The `web-fetch` World's class: it mounts the tools and has no environment section of its own. */
import type { ToolDef, World, WorldHost } from 'cortico/core/types.ts';
import { webFetchTool, type WebFetchOptions } from './tools.ts';

export class WebFetchWorld implements World {
  readonly id = 'web-fetch';
  private readonly opts: WebFetchOptions;

  constructor(opts: WebFetchOptions) {
    this.opts = opts;
  }

  /** No environment section: the tool's description says when to use it. */
  envPromptVars(): Record<string, string> {
    return {};
  }

  tools(): ToolDef[] {
    return [webFetchTool(this.opts)];
  }

  async start(_host: WorldHost): Promise<void> {}

  async stop(): Promise<void> {}
}
