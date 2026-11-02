// The clients the join page lists (src/routes/spheres.ts): those that have published a report of the
// conformance suite's run against them, each with its report and, when it registers a scheme of its
// own, the link that opens an invitation in it (spec/sphere-api.md section 2.1). Any client that
// reads invite links joins with one; this list only saves people a step. A client is added here by
// a pull request that links its report.

export interface Client {
  /** Its name, as its people know it. */
  name: string;
  /** Where people get it: an https page. */
  page: string;
  /** Its published conformance report: an https page. */
  report: string;
  /** Its own URL scheme, when it registers one: `<scheme>://join/<host>#<fragment>` opens an invite link in it. */
  scheme?: string;
  /** Whether its scheme also opens a self-hosted server's claim link, `<scheme>://claim/<host>#<code>` (docs/self-host-docker.md). */
  claims?: boolean;
}

export const CLIENTS: readonly Client[] = [
  {
    name: "Oby",
    page: "https://github.com/obi-ai-bot/oby",
    report: "https://github.com/obi-ai-bot/oby-sphere/blob/dev/spec/conformance/reports/obid.json",
    scheme: "oby",
    claims: true,
  },
];
