---
type: Added
pr: 1
---
**Kiro (AWS) is now an installable runtime** — Kiro CLI and Kiro IDE can be targeted with `--kiro`, landing GSD skills at `~/.kiro/skills/gsd-<name>/SKILL.md` (invoked as `/gsd-<name>`, with Kiro's native `$ARGUMENTS` substitution) and legacy-JSON subagents at `~/.kiro/agents/gsd-<name>.json` (the agent format Kiro CLI 2.x and 3.x both read) whose Claude tool grants are folded onto Kiro's `fs_read`/`fs_write`/`execute_bash`/`grep`/`glob`/`web_fetch`/`web_search` tool ids. Project-instruction references point at the steering directory (`.kiro/steering/gsd.md`). Kiro ships as a declarative runtime descriptor (`capabilities/kiro/capability.json`) with no hook surface and no shared settings writes; tier-2 community support.
