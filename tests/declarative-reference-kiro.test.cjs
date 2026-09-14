'use strict';

/**
 * Declarative reference host — Kiro (ADR-1239 EoS).
 *
 * Kiro (kiro.dev) is added as a pure declarative descriptor
 * (capabilities/kiro/capability.json): flat skills/ + flat agents/, each
 * kind naming its converter, hooksSurface:none, profile-marker install. No
 * runtime-keyed branch is introduced in bin/install.js — the only
 * runtime-keyed site is the `case 'kiro':` path-rewrite arm in
 * src/runtime-artifact-conversion.cts, the same boilerplate every sibling
 * (trae/codebuddy/zcode) carries.
 *
 * This test mirrors tests/declarative-reference-zcode.test.cjs: it (1)
 * classifies Kiro's profile via profileOf, (2) confirms the public declarative
 * adapter classifies it as declarative, (3) round-trips a real install proving
 * a gsd skill + agent surface is emitted in Kiro's documented shape, (4) proves
 * negotiation fails CLOSED on the undocumented dispatch sub-axes, (5) proves
 * the validator accepts the descriptor, and (6) pins the converter contract
 * against Kiro's documented skill/agent formats.
 *
 * Kiro format facts asserted here (from the Kiro "Agent Skills", "Custom
 * agents" and "CLI v3 agent config" reference pages, cited in the
 * host-integration capability matrix's kiro section):
 *   - skill `name` "Must match folder name. Lowercase letters, numbers, and
 *     hyphens only (max 64 chars)"; `description` "max 1024 chars".
 *   - "If the skill body contains `$ARGUMENTS` ... text after the slash
 *     command is substituted into them" — the placeholder is kept verbatim.
 *   - agents are Markdown with YAML frontmatter; tool tags are
 *     read/write/shell/web/subagent/todo_list/@mcp.
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');

const {
  profileOf,
  negotiateHostCapabilities,
  PROFILE_BASELINES,
  UNDOCUMENTED,
} = require('../gsd-core/bin/lib/host-integration.cjs');
const { validateCapability } = require('../gsd-core/bin/lib/capability-validator.cjs');
const { createDeclarativeAdapter } = require('../gsd-core/bin/lib/adapter-declarative.cjs');
const {
  convertClaudeCommandToKiroSkill,
  convertClaudeAgentToKiroAgent,
  convertClaudeToKiroMarkdown,
  convertKiroToolId,
} = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { cleanup } = require('./helpers.cjs');
const { walk, runMinimalInstall, BUILD_SCRIPT } = require('./helpers/install-shared.cjs');

const DESC = path.join(__dirname, '..', 'capabilities', 'kiro', 'capability.json');
const KIRO_CAP = JSON.parse(fs.readFileSync(DESC, 'utf8'));
const KIRO_AXES = KIRO_CAP.runtime.hostIntegration;
const { BUILD_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// hooks/dist is gitignored and built (mirrors golden-install-parity harness).
before(() => {
  throwIfFailed(
    runNode([BUILD_SCRIPT], { timeoutMs: BUILD_TIMEOUT_MS }),
    `node ${BUILD_SCRIPT}`,
  );
});

test('Kiro classifies as the declarative-cli reference profile (profileOf)', () => {
  assert.ok(KIRO_AXES && KIRO_AXES.embeddingMode, 'kiro descriptor declares hostIntegration axes');
  assert.equal(profileOf(KIRO_AXES), 'declarative-cli', 'Kiro is a Declarative-CLI host');
});

test('the public declarative adapter classifies Kiro as a declarative host', () => {
  const adapter = createDeclarativeAdapter({ runtime: 'kiro' });
  assert.equal(adapter.kind, 'declarative');
  assert.equal(adapter.runtime, 'kiro');
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.uninstall, 'function');
});

test('a real Kiro install emits flat skills/gsd-<name>/SKILL.md + flat Markdown agents and no hooks', () => {
  const { configDir, root } = runMinimalInstall({ runtime: 'kiro', scope: 'global' });
  try {
    const files = walk(configDir);
    assert.ok(files.length > 0, 'install must emit artifacts');

    const skillsDir = path.join(configDir, 'skills');
    assert.ok(fs.existsSync(skillsDir), 'skills/ directory must exist');
    const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('gsd-'));
    assert.ok(skillDirs.length > 0, 'skills/ must contain nested gsd-* skill directories');
    for (const dir of skillDirs) {
      const skillFile = path.join(skillsDir, dir.name, 'SKILL.md');
      assert.ok(fs.existsSync(skillFile), `${dir.name}/SKILL.md must exist`);
      const content = fs.readFileSync(skillFile, 'utf8');
      // Kiro Agent Skills reference: name must match the folder name; lowercase,
      // digits and hyphens only, ≤64 chars; description ≤1024 chars.
      const { frontmatter } = splitFrontmatter(content);
      assert.equal(frontmatter[0], `name: ${dir.name}`, `${dir.name}: frontmatter name must match the folder name`);
      assert.match(dir.name, /^[a-z0-9-]{1,64}$/, `${dir.name}: Kiro skill-name charset/length`);
      assert.ok(frontmatter[1].startsWith('description: '), `${dir.name}: SKILL.md must carry a single-line description`);
      assert.equal(frontmatter.length, 2, `${dir.name}: frontmatter is exactly name + description`);
      assert.ok(frontmatter[1].length <= 'description: '.length + 1024 + 2,
        `${dir.name}: description must fit Kiro's 1024-char limit`);
      assert.ok(!content.includes('~/.claude/gsd-core'),
        `${dir.name}: skill body still carries the Claude home literal`);
      assert.ok(!content.includes('/gsd:'),
        `${dir.name}: colon-style /gsd: mentions must be rewritten to /gsd-`);
    }

    const agentsDir = path.join(configDir, 'agents');
    assert.ok(fs.existsSync(agentsDir), 'agents/ directory must exist');
    const agentEntries = fs.readdirSync(agentsDir);
    const agentFiles = agentEntries.filter((f) => f.startsWith('gsd-') && f.endsWith('.json'));
    assert.ok(agentFiles.length > 0, 'agents/ must contain flat gsd-*.json legacy-JSON agents');
    assert.deepEqual(agentEntries.filter((f) => !f.endsWith('.json')), [],
      'agents/ must contain JSON only: no Markdown agents (3.x-only format) and no *.compact.* variants');
    assert.deepEqual(agentEntries.filter((f) => f.includes('.compact.')), [],
      'compact variants would register a second agent with the same name in Kiro');
    const seenNames = new Set();
    for (const agentFile of agentFiles) {
      const agent = JSON.parse(fs.readFileSync(path.join(agentsDir, agentFile), 'utf8'));
      assert.equal(`${agent.name}.json`, agentFile, `${agentFile}: JSON name must match the file stem`);
      assert.match(agent.name, /^[a-z0-9-]{1,64}$/, `${agentFile}: agent name charset`);
      assert.ok(!seenNames.has(agent.name), `${agentFile}: duplicate agent name ${agent.name}`);
      seenNames.add(agent.name);
      assert.equal(typeof agent.description, 'string');
      assert.ok(agent.description.length > 0, `${agentFile}: agent must carry a description`);
      assert.equal(typeof agent.prompt, 'string');
      assert.ok(agent.prompt.length > 0, `${agentFile}: agent prompt must be the inline converted body`);
      assert.ok(!('model' in agent) && !('color' in agent), `${agentFile}: Claude-only fields are not forwarded`);
      if ('tools' in agent) {
        assert.ok(Array.isArray(agent.tools) && agent.tools.length > 0, `${agentFile}: tools is a non-empty array when present`);
        for (const tool of agent.tools) {
          assert.match(tool, /^(fs_read|fs_write|execute_bash|grep|glob|web_fetch|web_search|todo_list|@[A-Za-z0-9_.-]+)$/,
            `${agentFile}: tool ids must be Kiro legacy ids or @<mcp-server>, never raw Claude tool names: ${tool}`);
        }
      }
    }

    // No commands kind: Kiro's slash surface IS the skill (`/gsd-<name>`).
    assert.ok(!fs.existsSync(path.join(configDir, 'commands')), 'kiro install must not emit a commands/ directory');
    // hooksSurface:none + skipSharedHooksInstall → nothing hook-shaped.
    assert.ok(!fs.existsSync(path.join(configDir, 'hooks')), 'kiro install must not emit a hooks/ directory');
    assert.ok(!fs.existsSync(path.join(configDir, 'settings.json')), 'kiro install must not write settings.json');
  } finally {
    cleanup(root);
  }
});

test('gsd-tools recognises the installed JSON agents (checkAgentsInstalled reports none missing)', () => {
  const { checkAgentsInstalled } = require('../gsd-core/bin/lib/agent-install-check.cjs');
  const { configDir, root } = runMinimalInstall({ runtime: 'kiro', scope: 'global' });
  const savedAgentsDir = process.env.GSD_AGENTS_DIR;
  try {
    // getAgentsDir honors GSD_AGENTS_DIR — point the roster check at the sandboxed install.
    process.env.GSD_AGENTS_DIR = path.join(configDir, 'agents');
    const status = checkAgentsInstalled('kiro');
    assert.deepEqual(status.missing_agents, [], 'every roster agent must resolve via its .json file');
    assert.deepEqual(status.incomplete_agents, [], 'manifest-tracked agent files are all present');
    assert.equal(status.agents_installed, true);
  } finally {
    if (savedAgentsDir === undefined) delete process.env.GSD_AGENTS_DIR; else process.env.GSD_AGENTS_DIR = savedAgentsDir;
    cleanup(root);
  }
});

test('a local Kiro install lands in ./.kiro with the same skill + agent shape', () => {
  const { configDir, root } = runMinimalInstall({ runtime: 'kiro', scope: 'local' });
  try {
    assert.equal(path.basename(configDir), '.kiro');
    assert.ok(fs.existsSync(path.join(configDir, 'skills', 'gsd-help', 'SKILL.md')), 'local skills/gsd-help/SKILL.md');
    assert.ok(fs.existsSync(path.join(configDir, 'agents')), 'local agents/');
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Converter contract — pinned against Kiro's documented formats.
// ---------------------------------------------------------------------------

test('convertClaudeCommandToKiroSkill keeps $ARGUMENTS verbatim and emits Kiro-valid frontmatter', () => {
  const command = [
    '---',
    'name: gsd:plan-phase',
    'description: Create a detailed phase plan',
    'argument-hint: "[phase]"',
    'color: blue',
    '---',
    '',
    'Plan phase $ARGUMENTS. Read CLAUDE.md, then run /gsd:discuss-phase.',
    'Use Bash(git status) and Edit(file). Claude Code loads .claude/skills/.',
  ].join('\n');

  const out = convertClaudeCommandToKiroSkill(command, 'gsd-plan-phase');

  const { frontmatter } = splitFrontmatter(out);
  assert.deepEqual(frontmatter, ['name: gsd-plan-phase', 'description: "Create a detailed phase plan"'],
    'frontmatter is name + quoted description only (Claude-only keys dropped)');
  assert.ok(out.includes('$ARGUMENTS'), 'Kiro substitutes $ARGUMENTS natively — the placeholder must survive');
  assert.ok(out.includes('/gsd-discuss-phase'), 'colon mentions become slash-hyphen');
  assert.ok(out.includes('.kiro/steering/gsd.md'), 'CLAUDE.md references point at the steering file');
  assert.ok(!/\bCLAUDE\.md\b/.test(out), 'no bare CLAUDE.md reference survives');
  assert.ok(out.includes('shell(git status)') && out.includes('write(file)'), 'Bash(/Edit( become Kiro tool names');
  assert.ok(out.includes('.kiro/skills/'), '.claude/skills/ becomes .kiro/skills/');
  assert.ok(!/\bClaude Code\b/.test(out), 'brand swap applied');
});

test('convertClaudeCommandToKiroSkill enforces Kiro skill-name and description limits', () => {
  const longDescription = 'x'.repeat(2000);
  const out = convertClaudeCommandToKiroSkill(`---\ndescription: ${longDescription}\n---\nbody`, 'gsd-' + 'a'.repeat(80));
  const { frontmatter } = splitFrontmatter(out);
  const name = frontmatter[0].slice('name: '.length);
  assert.ok(name.length <= 64, 'name truncated to Kiro\'s 64-char limit');
  assert.match(name, /^[a-z0-9-]+$/);
  const descriptionLine = frontmatter[1];
  assert.ok(descriptionLine.startsWith('description: "') && descriptionLine.endsWith('"'), 'description is a quoted scalar');
  const description = descriptionLine.slice('description: "'.length, -1);
  assert.ok(description.length <= 1024, 'description truncated to Kiro\'s 1024-char limit');
  assert.ok(description.endsWith('...'), 'truncation is marked');
});

test('convertClaudeAgentToKiroAgent emits a legacy-JSON agent with Kiro tool ids', () => {
  const agent = [
    '---',
    'name: gsd-planner',
    'description: Plans phases',
    'tools: Read, Write, Edit, Bash, Grep, Glob, WebFetch, Task, mcp__plugin_context7_context7__query-docs, AskUserQuestion',
    'model: opus',
    'color: green',
    '---',
    '',
    'You plan phases. Read CLAUDE.md first.',
  ].join('\n');

  const out = convertClaudeAgentToKiroAgent(agent);
  const parsed = JSON.parse(out);
  assert.deepEqual(Object.keys(parsed), ['name', 'description', 'prompt', 'tools'],
    'exactly name/description/prompt/tools — model/color are not forwarded (Kiro expects its own model ids)');
  assert.equal(parsed.name, 'gsd-planner');
  assert.equal(parsed.description, 'Plans phases');
  assert.deepEqual(parsed.tools,
    ['fs_read', 'fs_write', 'execute_bash', 'grep', 'glob', 'web_fetch', '@plugin_context7_context7'],
    'legacy ids deduplicated in first-seen order; Task/AskUserQuestion have no 2.x tool id and are dropped; MCP grants fold to @<server>');
  assert.ok(parsed.prompt.includes('.kiro/steering/gsd.md'), 'prompt (the converted body) has the instruction-file reference retargeted');
  assert.ok(!parsed.prompt.startsWith('\n'), 'prompt is trimmed');
});

test('convertClaudeAgentToKiroAgent omits tools: when the source agent declares none', () => {
  const out = convertClaudeAgentToKiroAgent('---\nname: gsd-x\ndescription: d\n---\nbody');
  const parsed = JSON.parse(out);
  assert.ok(!('tools' in parsed), 'no tools key → Kiro default toolkit, never a toolless agent');
  assert.equal(parsed.prompt, 'body');
});

test('convertClaudeAgentToKiroAgent stamps a resolved modelOverride as Kiro `model` and ignores the positional isGlobal form', () => {
  const src = '---\nname: gsd-planner\ndescription: d\nmodel: opus\n---\nbody';
  const stamped = JSON.parse(convertClaudeAgentToKiroAgent(src, { isAgent: true, modelOverride: 'gpt-5.6-terra' }));
  assert.equal(stamped.model, 'gpt-5.6-terra', 'the resolved override (catalog kiro tier default or a config override) becomes Kiro model');
  assert.deepEqual(Object.keys(stamped), ['name', 'description', 'prompt', 'model']);
  for (const bare of [undefined, true, { isAgent: true, modelOverride: null }, { isAgent: true, modelOverride: '' }]) {
    const parsed = JSON.parse(convertClaudeAgentToKiroAgent(src, bare));
    assert.ok(!('model' in parsed), `no resolved override → no model key (Claude alias "opus" is never forwarded); arg=${JSON.stringify(bare)}`);
  }
});

test('convertKiroToolId maps every Claude tool to a Kiro legacy tool id, @<server>, or null', () => {
  assert.equal(convertKiroToolId('Read'), 'fs_read');
  assert.equal(convertKiroToolId('Glob'), 'glob');
  assert.equal(convertKiroToolId('Grep'), 'grep');
  assert.equal(convertKiroToolId('NotebookEdit'), 'fs_write');
  assert.equal(convertKiroToolId('Bash'), 'execute_bash');
  assert.equal(convertKiroToolId('WebSearch'), 'web_search');
  assert.equal(convertKiroToolId('TodoWrite'), 'todo_list');
  assert.equal(convertKiroToolId('mcp__context7__query-docs'), '@context7');
  assert.equal(convertKiroToolId('mcp__plugin_context7_context7__*'), '@plugin_context7_context7', 'server names keep single underscores');
  assert.equal(convertKiroToolId('mcp__'), null, 'an MCP grant with no server name fails closed');
  assert.equal(convertKiroToolId('Agent'), null, 'no 2.x-documented subagent tool id');
  assert.equal(convertKiroToolId('AskUserQuestion'), null);
  assert.equal(convertKiroToolId('SomeFutureTool'), null, 'unknown tools fail closed to null');
});

test('convertClaudeToKiroMarkdown preserves .claude-plugin / .claudeignore tokens', () => {
  const out = convertClaudeToKiroMarkdown('see ~/.claude-plugin and .claudeignore and ~/.claude/x');
  assert.ok(out.includes('~/.claude-plugin'), '.claude-plugin untouched');
  assert.ok(out.includes('.claudeignore'), '.claudeignore untouched');
  assert.ok(out.includes('~/.kiro/x'), 'config-home path retargeted');
});

// ---------------------------------------------------------------------------
// Fail-closed negotiation + validator acceptance.
// ---------------------------------------------------------------------------

test('negotiateHostCapabilities never throws for kiro, even fully corrupted', () => {
  assert.doesNotThrow(() => negotiateHostCapabilities({}));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...KIRO_AXES, embeddingMode: UNDOCUMENTED }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...KIRO_AXES, embeddingMode: 'future-unknown' }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...KIRO_AXES, dispatch: 'corrupted-not-an-object' }));
});

test('a partial/empty kiro descriptor degrades to the safe floor, not the declarative-cli baseline', () => {
  const result = negotiateHostCapabilities({});
  assert.equal(result.effective.embeddingMode, 'declarative');
  assert.equal(result.effective.hookBus, 'none');
  assert.notDeepEqual(result.effective, PROFILE_BASELINES['declarative-cli']);
  assert.ok(result.warnings.length > 0);
});

test("kiro's undocumented dispatch sub-axes degrade to the most-restrictive known value", () => {
  assert.equal(KIRO_AXES.dispatch.nested, 'undocumented');
  assert.equal(KIRO_AXES.dispatch.maxDepth, 'undocumented');
  assert.equal(KIRO_AXES.dispatch.backgroundDispatch, 'undocumented');
  assert.equal(KIRO_AXES.dispatch.maxConcurrency, 'undocumented');
  assert.equal(KIRO_AXES.dispatch.namedDispatch, true, 'sanity: namedDispatch is documented');
  assert.equal(KIRO_AXES.dispatch.background, true, 'sanity: parallel sub-agents are documented');
  assert.equal(KIRO_AXES.dispatch.subagentToolkit, 'full', 'sanity: sub-agent toolkit is documented');

  const { effective, warnings } = negotiateHostCapabilities(KIRO_AXES);
  assert.equal(effective.dispatch.nested, false, 'undocumented nested must degrade to false');
  assert.equal(effective.dispatch.maxDepth, 0, 'undocumented maxDepth must degrade to 0');
  assert.equal(effective.dispatch.backgroundDispatch, false, 'undocumented backgroundDispatch must degrade to false');
  assert.equal(effective.dispatch.namedDispatch, true, 'documented namedDispatch is trusted');
  assert.equal(effective.dispatch.subagentToolkit, 'full', 'documented subagentToolkit is trusted');
  assert.ok(warnings.some((w) => w.includes('dispatch.nested') && w.includes('undocumented')));
  assert.ok(warnings.some((w) => w.includes('dispatch.backgroundDispatch')));
});

test('capabilities/kiro/capability.json validates — no errors', () => {
  const errors = validateCapability(KIRO_CAP, 'kiro');
  assert.deepEqual(errors, [], `validateCapability must return no errors, got: ${JSON.stringify(errors)}`);
});

function splitFrontmatter(markdown) {
  const lines = splitLines(markdown);
  assert.equal(lines[0], '---', 'frontmatter opens');
  const end = lines.indexOf('---', 1);
  assert.ok(end > 0, 'frontmatter closes');
  return { frontmatter: lines.slice(1, end), body: lines.slice(end + 1).join('\n') };
}
