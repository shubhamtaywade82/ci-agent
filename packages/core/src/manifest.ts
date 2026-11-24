/**
 * Policy manifest (`.nemesis/ci-agent.yml`) types and defaults.
 *
 * The manifest is the per-repo contract: it is what makes the agent
 * repo-agnostic. Anything not covered by the manifest defaults to the
 * most conservative behavior (fail-closed, comment-only, no cloud
 * source exposure).
 */

export type Autonomy =
  | "comment" // review findings only
  | "issue" // create an issue
  | "draft-pr"; // branch + files + draft PR

export type DataClassification = "public" | "internal" | "proprietary";

export interface ManifestModes {
  review: {
    enabled: boolean;
    autonomy: Autonomy;
    maxChunks: number;
    maxInputTokens: number;
  };
  fix: {
    enabled: boolean;
    autonomy: Autonomy;
    optInLabel: string;
    maxAttempts: number;
    maxFiles: number;
    maxFileBytes: number;
    minConfidence: "high" | "medium" | "low";
  };
  scan: {
    enabled: boolean;
    schedule: "off" | "daily" | "weekly";
    autonomy: Autonomy;
    signals: string[];
  };
  triage: {
    enabled: boolean;
  };
}

export interface AgentManifest {
  version: 1;
  enabled: boolean;
  project: {
    name: string;
    type: "auto" | string;
    monorepo: "auto" | boolean;
  };
  toolchain: {
    adapter: "auto" | string;
    commands: {
      install?: string;
      verify?: string[];
      lint?: string;
      formatCheck?: string;
    };
  };
  modes: ManifestModes;
  policy: {
    autoMerge: boolean;
    requireHumanApproval: boolean;
    allowPaths: string[];
    denyPaths: string[];
  };
  dataPolicy: {
    classification: DataClassification;
    sendSourceToCloud: boolean;
    redactPaths: string[];
  };
  llm: {
    provider: string;
    hostEnv: string;
    apiKeyEnv: string;
    modelEnv: string;
  };
  audit: {
    format: "jsonl";
    uploadArtifact: boolean;
  };
}

export const DEFAULT_MANIFEST: AgentManifest = {
  version: 1,
  enabled: true,
  project: { name: "auto", type: "auto", monorepo: "auto" },
  toolchain: {
    adapter: "auto",
    commands: {},
  },
  modes: {
    review: { enabled: true, autonomy: "comment", maxChunks: 6, maxInputTokens: 30_000 },
    fix: {
      enabled: true,
      autonomy: "draft-pr",
      optInLabel: "nemesis:autofix",
      maxAttempts: 2,
      maxFiles: 5,
      maxFileBytes: 60_000,
      minConfidence: "medium",
    },
    scan: {
      enabled: true,
      schedule: "weekly",
      autonomy: "issue",
      signals: [
        "ci-failure",
        "static-analysis",
        "dependency-vulnerabilities",
        "coverage-gaps",
        "dead-code",
        "docs-drift",
        "performance-regression",
      ],
    },
    triage: { enabled: false },
  },
  policy: {
    autoMerge: false,
    requireHumanApproval: true,
    allowPaths: ["src/**", "tests/**", "docs/**"],
    denyPaths: [
      ".github/**",
      "**/*.lock",
      "**/package-lock.json",
      "**/pnpm-lock.yaml",
      "**/yarn.lock",
      "**/bun.lockb",
      "**/.env*",
      "**/*secret*",
      "**/migrations/**",
    ],
  },
  dataPolicy: {
    classification: "internal",
    sendSourceToCloud: true,
    redactPaths: ["**/.env*", "**/*secret*", "**/credentials*"],
  },
  llm: {
    provider: "ollama-cloud",
    hostEnv: "OLLAMA_HOST",
    apiKeyEnv: "OLLAMA_API_KEY",
    modelEnv: "OLLAMA_MODEL",
  },
  audit: { format: "jsonl", uploadArtifact: true },
};

/** Parse a manifest object (from YAML or JSON) into a validated manifest. */
export function parseManifest(input: unknown): AgentManifest {
  if (typeof input !== "object" || input === null) {
    throw new Error("manifest: expected an object at the document root");
  }
  const raw = input as Record<string, unknown>;
  if (raw.version !== 1) {
    throw new Error(`manifest: unsupported version ${JSON.stringify(raw.version)}, expected 1`);
  }

  const m: AgentManifest = structuredClone(DEFAULT_MANIFEST);

  // enabled
  if (typeof raw.enabled === "boolean") m.enabled = raw.enabled;

  // project
  if (raw.project !== undefined) {
    if (typeof raw.project !== "object" || raw.project === null || Array.isArray(raw.project)) {
      throw new Error("manifest: project must be an object");
    }
    const p = raw.project as Record<string, unknown>;
    if (p.name !== undefined && typeof p.name === "string") m.project.name = p.name;
    if (p.type !== undefined && typeof p.type === "string") m.project.type = p.type;
    if (p.monorepo !== undefined) {
      m.project.monorepo =
        p.monorepo === "auto" || typeof p.monorepo === "boolean" ? (p.monorepo as "auto" | boolean) : "auto";
    }
  }

  // toolchain
  if (raw.toolchain !== undefined) {
    if (typeof raw.toolchain !== "object" || raw.toolchain === null || Array.isArray(raw.toolchain)) {
      throw new Error("manifest: toolchain must be an object");
    }
    const t = raw.toolchain as Record<string, unknown>;
    if (t.adapter !== undefined && typeof t.adapter === "string") m.toolchain.adapter = t.adapter;
    if (t.commands !== undefined) {
      if (typeof t.commands !== "object" || t.commands === null || Array.isArray(t.commands)) {
        throw new Error("manifest: toolchain.commands must be an object");
      }
      const c = t.commands as Record<string, unknown>;
      const cmds = m.toolchain.commands;
      if (c.install !== undefined) {
        if (typeof c.install !== "string") throw new Error("manifest: toolchain.commands.install must be a string");
        cmds.install = c.install as never;
      }
      if (c.verify !== undefined) {
        if (
          !Array.isArray(c.verify) ||
          c.verify.some((v) => typeof v !== "string") ||
          c.verify.length === 0
        ) {
          throw new Error("manifest: toolchain.commands.verify must be a non-empty string array");
        }
        m.toolchain.commands.verify = c.verify as string[];
      }
      if (c.lint !== undefined) {
        if (typeof c.lint !== "string") throw new Error("manifest: toolchain.commands.lint must be a string");
        cmds.lint = c.lint as never;
      }
      if (c.formatCheck !== undefined) {
        if (typeof c.formatCheck !== "string") {
          throw new Error("manifest: toolchain.commands.formatCheck must be a string");
        }
        cmds.formatCheck = c.formatCheck as never;
      }
    }
  }

  // modes
  if (raw.modes !== undefined) {
    if (typeof raw.modes !== "object" || raw.modes === null || Array.isArray(raw.modes)) {
      throw new Error("manifest: modes must be an object");
    }
    const mo = raw.modes as Record<string, unknown>;
    for (const key of ["review", "fix", "scan", "triage"] as const) {
      const section = mo[key];
      if (section === undefined) continue;
      if (typeof section !== "object" || section === null || Array.isArray(section)) {
        throw new Error(`manifest: modes.${key} must be an object`);
      }
      const s = section as Record<string, unknown>;

      if (key === "review") {
        const r = s as Record<string, unknown>;
        if (r.enabled !== undefined) m.modes.review.enabled = requireBool(r.enabled, "modes.review.enabled");
        if (r.autonomy !== undefined) m.modes.review.autonomy = requireAutonomy(r.autonomy, "modes.review.autonomy");
        if (r.maxChunks !== undefined) {
          m.modes.review.maxChunks = requirePositiveInt(r.maxChunks, "modes.review.maxChunks");
        }
        if (r.maxInputTokens !== undefined) {
          m.modes.review.maxInputTokens = requirePositiveInt(r.maxInputTokens, "modes.review.maxInputTokens");
        }
      } else if (key === "fix") {
        if (s.enabled !== undefined) m.modes.fix.enabled = requireBool(s.enabled, "modes.fix.enabled");
        if (s.autonomy !== undefined) m.modes.fix.autonomy = requireAutonomy(s.autonomy, "modes.fix.autonomy");
        if (s.optInLabel !== undefined) {
          if (typeof s.optInLabel !== "string") throw new Error("manifest: modes.fix.optInLabel must be a string");
          m.modes.fix.optInLabel = s.optInLabel;
        }
        if (s.maxAttempts !== undefined) {
          m.modes.fix.maxAttempts = requirePositiveInt(s.maxAttempts, "modes.fix.maxAttempts");
        }
        if (s.maxFiles !== undefined) {
          m.modes.fix.maxFiles = requirePositiveInt(s.maxFiles, "modes.fix.maxFiles");
        }
        if (s.maxFileBytes !== undefined) {
          m.modes.fix.maxFileBytes = requirePositiveInt(s.maxFileBytes, "modes.fix.maxFileBytes");
        }
        if (s.minConfidence !== undefined) {
          if (!["high", "medium", "low"].includes(String(s.minConfidence))) {
            throw new Error("manifest: modes.fix.minConfidence must be one of high|medium|low");
          }
          m.modes.fix.minConfidence = s.minConfidence as "high" | "medium" | "low";
        }
      } else if (key === "scan") {
        if (s.enabled !== undefined) m.modes.scan.enabled = requireBool(s.enabled, "modes.scan.enabled");
        if (s.autonomy !== undefined) m.modes.scan.autonomy = requireAutonomy(s.autonomy, "modes.scan.autonomy");
        if (s.schedule !== undefined) {
          if (!["off", "daily", "weekly"].includes(String(s.schedule))) {
            throw new Error("manifest: modes.scan.schedule must be one of off|daily|weekly");
          }
          m.modes.scan.schedule = s.schedule as "off" | "daily" | "weekly";
        }
        if (s.signals !== undefined) {
          if (!Array.isArray(s.signals) || s.signals.some((v) => typeof v !== "string")) {
            throw new Error("manifest: modes.scan.signals must be a string array");
          }
          m.modes.scan.signals = s.signals as string[];
        }
      } else {
        if (s.enabled !== undefined) m.modes.triage.enabled = requireBool(s.enabled, "modes.triage.enabled");
      }
    }
  }

  // policy
  if (raw.policy !== undefined) {
    if (typeof raw.policy !== "object" || raw.policy === null || Array.isArray(raw.policy)) {
      throw new Error("manifest: policy must be an object");
    }
    const po = raw.policy as Record<string, unknown>;
    if (po.autoMerge !== undefined) {
      m.policy.autoMerge = requireBool(po.autoMerge, "policy.autoMerge");
      if (m.policy.autoMerge) {
        throw new Error("manifest: policy.autoMerge must be false — the agent never merges");
      }
    }
    if (po.requireHumanApproval !== undefined) {
      m.policy.requireHumanApproval = requireBool(po.requireHumanApproval, "policy.requireHumanApproval");
    }
    if (po.allowPaths !== undefined) {
      if (!Array.isArray(po.allowPaths) || po.allowPaths.some((v) => typeof v !== "string")) {
        throw new Error("manifest: policy.allowPaths must be a string array");
      }
      m.policy.allowPaths = po.allowPaths as string[];
    }
    if (po.denyPaths !== undefined) {
      if (!Array.isArray(po.denyPaths) || po.denyPaths.some((v) => typeof v !== "string")) {
        throw new Error("manifest: policy.denyPaths must be a string array");
      }
      m.policy.denyPaths = po.denyPaths as string[];
    }
  }

  // dataPolicy
  if (raw.dataPolicy !== undefined) {
    if (typeof raw.dataPolicy !== "object" || raw.dataPolicy === null || Array.isArray(raw.dataPolicy)) {
      throw new Error("manifest: dataPolicy must be an object");
    }
    const d = raw.dataPolicy as Record<string, unknown>;
    if (d.classification !== undefined) {
      if (!["public", "internal", "proprietary"].includes(String(d.classification))) {
        throw new Error("manifest: dataPolicy.classification must be public|internal|proprietary");
      }
      m.dataPolicy.classification = d.classification as DataClassification;
    }
    if (d.sendSourceToCloud !== undefined) {
      m.dataPolicy.sendSourceToCloud = requireBool(d.sendSourceToCloud, "dataPolicy.sendSourceToCloud");
    }
    if (d.redactPaths !== undefined) {
      if (!Array.isArray(d.redactPaths) || d.redactPaths.some((v) => typeof v !== "string")) {
        throw new Error("manifest: dataPolicy.redactPaths must be a string array");
      }
      m.dataPolicy.redactPaths = d.redactPaths as string[];
    }
    if (m.dataPolicy.classification === "proprietary" && m.dataPolicy.sendSourceToCloud) {
      throw new Error(
        "manifest: dataPolicy.proprietary with sendSourceToCloud=true requires explicit sendSourceToCloud=false — source must not reach a third party without sign-off",
      );
    }
  }

  // llm
  if (raw.llm !== undefined) {
    if (typeof raw.llm !== "object" || raw.llm === null || Array.isArray(raw.llm)) {
      throw new Error("manifest: llm must be an object");
    }
    const l = raw.llm as Record<string, unknown>;
    if (l.provider !== undefined && typeof l.provider === "string") m.llm.provider = l.provider;
    if (l.hostEnv !== undefined && typeof l.hostEnv === "string") m.llm.hostEnv = l.hostEnv;
    if (l.apiKeyEnv !== undefined && typeof l.apiKeyEnv === "string") m.llm.apiKeyEnv = l.apiKeyEnv;
    if (l.modelEnv !== undefined && typeof l.modelEnv === "string") m.llm.modelEnv = l.modelEnv;
  }

  // audit
  if (raw.audit !== undefined) {
    if (typeof raw.audit !== "object" || raw.audit === null || Array.isArray(raw.audit)) {
      throw new Error("manifest: audit must be an object");
    }
    const a = raw.audit as Record<string, unknown>;
    if (a.uploadArtifact !== undefined) {
      m.audit.uploadArtifact = requireBool(a.uploadArtifact, "audit.uploadArtifact");
    }
  }

  return m;
}

function requireBool(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw new Error(`manifest: ${field} must be a boolean`);
  return v;
}

function requireAutonomy(v: unknown, field: string): Autonomy {
  if (!["comment", "issue", "draft-pr"].includes(String(v))) {
    throw new Error(`manifest: ${field} must be one of comment|issue|draft-pr`);
  }
  return v as Autonomy;
}

function requirePositiveInt(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new Error(`manifest: ${field} must be a positive integer`);
  }
  return v;
}
