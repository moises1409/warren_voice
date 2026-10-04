# AGENTS.md

This is a LiveKit Agents project. LiveKit Agents is a Python SDK for building voice AI agents. This project is intended to be used with LiveKit Cloud. See @README.md for more about the rest of the LiveKit ecosystem.

The following is a guide for working with this project.

## Project structure

This Python project uses the `uv` package manager. You should always use `uv` to install dependencies, run the agent, and run tests.

All app-level code is in the `src/` directory. In general, simple agents can be constructed with a single `agent.py` file. Additional files can be added, but you must retain `agent.py` as the entrypoint (see the associated Dockerfile for how this is deployed).

This project is Warren, a meeting-preparation assistant for private bankers; see @README.md and `docs/meeting-prep-design.md`. Layout:

- `src/agent.py`: entrypoint. Loads the client named in the dispatch metadata, publishes state snapshots, registers the RPC methods.
- `src/stages.py`: the three stage agents (wealth, family, report), their tools and the handoffs.
- `src/prompts.py`: instructions, built from `knowledge/*.md` and the current state.
- `src/store.py`, `src/models.py`: session state. Tools change state only through `PrepStore`.
- `src/checks.py`: deterministic findings. `src/summary.py`, `src/fx.py`: totals and currency conversion.
- `src/agenda.py`: the guided review as a list of steps derived from the meeting points. `src/sessions.py`, `src/seed.py`: where sessions are saved between conversations.
- `src/succession.py`: what the client's death would cost and who inherits, computed from `rules/succession.yaml`. No model involved; never let the agent compute a tax.
- `src/report.py`: the report; figures in code, wording from a text model.
- `data/`: mock clients and settings, shared with `frontend/`. `frontend/lib/types.ts` mirrors `src/models.py`: change both together.

A stage agent stays silent after a handoff unless its `on_enter` calls `generate_reply`. Tools must stay fast: Gemini 3.1 Live waits for the tool result before speaking.

Be sure to maintain code formatting. You can use the ruff formatter/linter as needed: `uv run ruff format` and `uv run ruff check`.

## LiveKit Documentation

LiveKit Agents is a fast-evolving project, and the documentation is updated frequently. You should always refer to the latest documentation when working with this project. For your convenience, LiveKit offers both a CLI and an MCP server that can be used to browse and search its documentation. If the developer has not yet installed the CLI, you should recommend that they install it.

### LiveKit CLI

The [LiveKit CLI](https://docs.livekit.io/intro/basics/cli/) `lk docs` subcommand gives full access to LiveKit documentation from the terminal. Requires CLI version 2.15.0+. Check with `lk --version`.

Install or update the CLI:

- **macOS:** `brew install livekit-cli` (update: `brew update && brew upgrade livekit-cli`)
- **Linux:** `curl -sSL https://get.livekit.io/cli | bash`
- **Windows:** `winget install LiveKit.LiveKitCLI` (update: `winget upgrade LiveKit.LiveKitCLI`)

Run `lk docs --help` to see all available commands. Key commands: `lk docs overview`, `lk docs search`, `lk docs get-page`, `lk docs code-search`, `lk docs changelog`, `lk docs submit-feedback`. Run `lk docs <command> --help` before using a command for the first time, as the help text includes advice on usage and interpreting results. Prefer browsing (`overview`, `get-page`) over search, and prefer `search` over `code-search`, as docs pages are more up-to-date and provide better context than raw code.

### LiveKit Docs MCP Server

For deeper IDE integration, LiveKit also offers an [MCP server](https://docs.livekit.io/reference/developer-tools/docs-mcp/) with the same documentation access. It uses Streamable HTTP transport at `https://docs.livekit.io/mcp`. Refer to your IDE's documentation for how to add it.

### Submit docs feedback to LiveKit

If you use the LiveKit CLI or MCP Server to search or browse documentation, also submit constructive feedback to LiveKit with `lk docs submit-feedback` or the MCP `submit_docs_feedback` tool. Add this to your to-do list when planning work, to ensure you file feedback after completing your other tasks. Useful feedback includes incomplete documentation, broken examples, missing steps or any other documentation gap or issue.

## Handoffs and tasks ("workflows")

Voice AI agents are highly sensitive to excessive latency. For this reason, it's important to design complex agents in a structured manner that minimizes the amount of irrelevant context and unnecessary tools included in requests to the LLM. LiveKit Agents supports handoffs (one agent hands control to another) and tasks (tightly-scoped prompts to achieve a specific outcome) to support building reliable workflows. You should make use of these features, instead of writing long instruction prompts that cover multiple phases of a conversation.  Refer to the [documentation](https://docs.livekit.io/agents/build/workflows/) for more information.

## Testing

When possible, add tests for agent behavior. Add a scenario to `scenarios.yaml` and run it with `lk agent simulate --scenarios scenarios.yaml`. The scenarios run in CI on every merge to main; read the [simulations documentation](https://docs.livekit.io/agents/start/testing/simulations/) before editing them.

For turn-level checks that don't need a live session, use the in-process [testing framework](https://docs.livekit.io/agents/start/testing/); `tests/test_agent.py` runs the stage agents this way against the production voice model, asserting on what ends up in the store. Run those with `uv run pytest`.

Important: When modifying core agent behavior such as instructions, tool descriptions, and tasks/workflows/handoffs, never just guess what will work. Always use test-driven development (TDD) and begin by writing tests for the desired behavior. For instance, if you're planning to add a new tool, write one or more tests for the tool's behavior, then iterate on the tool until the tests pass correctly. This will ensure you are able to produce a working, reliable agent for the user.

## LiveKit CLI

Beyond documentation access, the LiveKit CLI (`lk`) supports other tasks such as managing SIP trunks for telephony-based agents. Run `lk --help` to explore available commands.
